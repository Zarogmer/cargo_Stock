"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission, canViewStockValue, type Module } from "@/lib/rbac";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ImagePicker, ImageLightbox } from "@/components/ui/image-picker";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { formatDateTime, matchSearch, parseDecimalBR, formatQty, formatCurrency, buildCodeMap, codeForName, normalize } from "@/lib/utils";
import type { StockItem, MaterialTeamAllocation } from "@/types/database";

// Inventário genérico do Almoxarifado: itens com QUANTIDADE, mínimo, setinhas
// ↑/↓ (1 unidade por clique) e foto. Reaproveita a tabela `stock_items` usando o campo `team` como sentinela
// pra separar cada setor:
//   GALPAO     → aba "Estoque" (materiais do galpão)
//   FERRAMENTA → aba "Ferramenta"
//   ELETRICA   → aba "Elétrica"
//   FLUIDOS    → aba "Fluídos" (óleos, graxas, químicos, etc.)
//   MAQUINARIO → aba "Maquinário"
// (Rancho usa EQUIPE_1/2/3 e o Embarque filtra por equipe — todos ignoram estes
// sentinelas.) Estes setores NÃO usam categoria — cada um já é uma aba; só o
// Rancho mantém categoria. `category` é sempre OUTROS (enum fixo) e `location`
// fica sem uso aqui.
export type InventoryKind = "GALPAO" | "FERRAMENTA" | "ELETRICA" | "FLUIDOS" | "MAQUINARIO";

interface KindConfig {
  module: Module;
  singular: string;        // "Material", "Ferramenta", "Elétrica"
  newTitle: string;
  editTitle: string;
  emptyMsg: string;
  searchPlaceholder: string;
}

const KIND_CONFIG: Record<InventoryKind, KindConfig> = {
  GALPAO: {
    module: "ESTOQUE", singular: "Material", newTitle: "Novo Material", editTitle: "Editar Material",
    emptyMsg: "Nenhum material encontrado", searchPlaceholder: "Buscar por nome ou código...",
  },
  FERRAMENTA: {
    module: "FERRAMENTAS", singular: "Ferramenta", newTitle: "Nova Ferramenta", editTitle: "Editar Ferramenta",
    emptyMsg: "Nenhuma ferramenta encontrada", searchPlaceholder: "Buscar ferramenta...",
  },
  ELETRICA: {
    module: "ELETRICA", singular: "Item elétrico", newTitle: "Novo item elétrico", editTitle: "Editar item elétrico",
    emptyMsg: "Nenhum item encontrado", searchPlaceholder: "Buscar item elétrico...",
  },
  // Fluídos reaproveita as permissões do Estoque (mesma gestão dos materiais do
  // galpão). Sentinela próprio em stock_items.team = "FLUIDOS".
  FLUIDOS: {
    module: "ESTOQUE", singular: "Fluído", newTitle: "Novo Fluído", editTitle: "Editar Fluído",
    emptyMsg: "Nenhum fluído encontrado", searchPlaceholder: "Buscar fluído...",
  },
  MAQUINARIO: {
    module: "MAQUINARIO", singular: "Maquinário", newTitle: "Novo Maquinário", editTitle: "Editar Maquinário",
    emptyMsg: "Nenhum maquinário encontrado", searchPlaceholder: "Buscar maquinário...",
  },
};

// Equipes pra onde se transfere material. O estoque fica todo no "Disponível"
// (o total menos o que já foi alocado); o botão Transferir separa uma quantidade
// pra uma equipe. EQUIPE_4 = "Equipe Turbo" (mesma chave do Rancho).
type XferTeam = "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_4";
const XFER_TEAMS: { value: XferTeam; label: string; badgeCls: string }[] = [
  { value: "EQUIPE_1", label: "Equipe 1", badgeCls: "bg-blue-100 text-blue-700" },
  { value: "EQUIPE_2", label: "Equipe 2", badgeCls: "bg-purple-100 text-purple-700" },
  { value: "EQUIPE_4", label: "Equipe Turbo", badgeCls: "bg-orange-100 text-orange-700" },
];
const XFER_LABEL: Record<string, string> = Object.fromEntries(XFER_TEAMS.map((t) => [t.value, t.label]));

export function StockInventoryPanel({ kind }: { kind: InventoryKind }) {
  const cfg = KIND_CONFIG[kind];
  const TEAM = kind; // o sentinela em stock_items.team é o próprio kind
  const { profile } = useAuth();
  const pathname = usePathname();
  const [items, setItems] = useState<StockItem[]>([]);
  // Compras (código + descrição) pra mostrar os nomes alternativos com que o
  // mesmo item foi comprado no Controle de Compras — o código é único, então
  // ajuda a não duplicar o item quando a nota vem com outro nome.
  const [purchases, setPurchases] = useState<{ code: string | null; description: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editItem, setEditItem] = useState<StockItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteItem, setDeleteItem] = useState<StockItem | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Alocações por equipe: quanto de cada material está separado pra cada equipe.
  const [allocs, setAllocs] = useState<MaterialTeamAllocation[]>([]);
  // Item cujo botão "Transferir" foi clicado — abre o modal de alocação por equipe.
  const [transferItem, setTransferItem] = useState<StockItem | null>(null);

  const role = profile?.role || "RH";
  const canCreate = hasPermission(role, cfg.module, "create");
  const canEdit = hasPermission(role, cfg.module, "edit");
  const canDelete = hasPermission(role, cfg.module, "delete");
  const canBaixar = hasPermission(role, cfg.module, "baixar");
  // Valor do item é dado de gestão — quem não pode ver nem recebe a coluna do
  // /api/db, então aqui é só a parte visual da mesma regra.
  const canSeeValue = canViewStockValue(role);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      const { data, error } = await db
        .from("stock_items")
        .select("*")
        .eq("team", TEAM)
        .order("name", { ascending: true });
      if (error) {
        console.error("DB stock_items error:", error);
        setDbError(`${error.code}: ${error.message} — ${error.hint || ""}`);
      }
      setItems(data || []);
      // Alocações por equipe dos itens deste setor.
      const ids = (data || []).map((i) => i.id);
      if (ids.length > 0) {
        const { data: al } = await db
          .from("material_team_allocations")
          .select("*")
          .in("stock_item_id", ids);
        setAllocs((al as MaterialTeamAllocation[]) || []);
      } else {
        setAllocs([]);
      }
      // Best-effort: compras com código, pra cruzar os nomes alternativos.
      const { data: pos } = await db
        .from("purchase_orders")
        .select("code, description");
      setPurchases(
        ((pos as { code: string | null; description: string }[]) || []).filter((p) => p.code),
      );
    } catch (err) {
      console.error("Erro ao carregar itens:", err);
      setDbError(String(err));
    } finally {
      setLoading(false);
    }
  }, [TEAM]);

  useEffect(() => {
    loadItems();
  }, [loadItems, pathname]);

  // Código derivado do nome (prefixo de iniciais + sequência), por item.
  const codeMap = useMemo(() => buildCodeMap(items, (i) => i.id, (i) => i.name), [items]);

  // Nomes alternativos por código: distintas descrições de compra ligadas ao
  // mesmo código no Controle de Compras (normaliza p/ comparar sem caixa/acento).
  const altNamesByCode = useMemo(() => {
    const map = new Map<string, string[]>();
    const seen = new Map<string, Set<string>>();
    for (const po of purchases) {
      const code = (po.code || "").trim().toUpperCase();
      const desc = (po.description || "").trim();
      if (!code || !desc) continue;
      if (!map.has(code)) { map.set(code, []); seen.set(code, new Set()); }
      const key = normalize(desc);
      if (!seen.get(code)!.has(key)) { seen.get(code)!.add(key); map.get(code)!.push(desc); }
    }
    return map;
  }, [purchases]);

  // Nomes de compra do item em edição, tirando o próprio nome do item.
  const editItemAltNames = useMemo(() => {
    if (!editItem) return [];
    const code = (codeMap.get(editItem.id) || "").toUpperCase();
    return (altNamesByCode.get(code) || []).filter((n) => normalize(n) !== normalize(editItem.name));
  }, [editItem, codeMap, altNamesByCode]);

  const filteredItems = items.filter((i) =>
    matchSearch(i.name, search) || matchSearch(codeMap.get(i.id) || "", search),
  );

  // Total em R$ do que está listado (busca), pra bater com a tabela.
  const totalValue = useMemo(
    () => filteredItems.reduce((sum, i) => sum + (i.unit_value || 0) * i.quantity, 0),
    [filteredItems],
  );

  // Alocação por item: { EQUIPE_1: x, EQUIPE_2: y, EQUIPE_4: z } (só as > 0).
  const allocByItem = useMemo(() => {
    const map = new Map<number, Record<string, number>>();
    for (const a of allocs) {
      if (a.quantity <= 0) continue;
      const cur = map.get(a.stock_item_id) || {};
      cur[a.team] = (cur[a.team] || 0) + a.quantity;
      map.set(a.stock_item_id, cur);
    }
    return map;
  }, [allocs]);

  // Quanto de um item já está separado nas equipes (soma das alocações).
  const allocatedOf = useCallback(
    (id: number) => Object.values(allocByItem.get(id) || {}).reduce((s, n) => s + n, 0),
    [allocByItem],
  );
  // "Disponível" = total no galpão − o que já está com as equipes.
  const disponivelOf = useCallback(
    (item: StockItem) => Math.max(0, +(item.quantity - allocatedOf(item.id)).toFixed(3)),
    [allocatedOf],
  );

  // Define a alocação de UMA equipe pra um item (valor absoluto). O total do item
  // (stock_items.quantity) não muda — só muda a divisão entre Disponível e equipe.
  // Trava: a soma das alocações nunca passa do total.
  async function handleSetAllocation(item: StockItem, team: XferTeam, rawQty: number) {
    const others = allocatedOf(item.id) - (allocByItem.get(item.id)?.[team] || 0);
    const maxForTeam = Math.max(0, +(item.quantity - others).toFixed(3));
    const qty = Math.min(Math.max(rawQty, 0), maxForTeam);
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    try {
      const existing = allocs.find((a) => a.stock_item_id === item.id && a.team === team);
      if (existing) {
        await db.from("material_team_allocations")
          .update({ quantity: qty, updated_by: actor } as Record<string, unknown>)
          .eq("id", existing.id);
      } else if (qty > 0) {
        await db.from("material_team_allocations")
          .insert({ stock_item_id: item.id, team, quantity: qty, updated_by: actor } as Record<string, unknown>);
      }
      await loadItems();
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(formData: { name: string; quantity: number; min_quantity: number; unit_value: number; image_url: string | null; notes: string | null }) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const payload = {
      name: formData.name,
      quantity: formData.quantity,
      category: "OUTROS",
      team: TEAM,
      min_quantity: formData.min_quantity,
      image_url: formData.image_url,
      notes: formData.notes,
      updated_by: actor,
    } as Record<string, unknown>;
    // Só manda o valor quem pode vê-lo — senão um save de outro papel zeraria o
    // preço que ele nem enxerga. (O /api/db descarta o campo de qualquer forma.)
    if (canSeeValue) payload.unit_value = formData.unit_value;

    const today = new Date().toISOString().split("T")[0];
    if (editItem) {
      await db.from("stock_items").update(payload).eq("id", editItem.id);
      // Mudou a quantidade na edição → registra no histórico (ajuste manual),
      // pra toda movimentação de estoque contar a história.
      const diff = formData.quantity - editItem.quantity;
      if (diff !== 0) {
        await db.from("stock_movements").insert({
          stock_item_id: editItem.id,
          movement_type: "AJUSTE",
          quantity: Math.abs(diff),
          movement_date: today,
          notes: `Ajuste manual no Almoxarifado: ${diff > 0 ? "+" : "-"}${Math.abs(diff)} (edição do item)`,
          created_by: actor,
        } as Record<string, unknown>);
      }
    } else {
      const insRes = (await db.from("stock_items").insert(payload)) as { data: { id?: number } | { id?: number }[] | null };
      const created = Array.isArray(insRes.data) ? insRes.data[0] : insRes.data;
      if (created?.id && formData.quantity > 0) {
        await db.from("stock_movements").insert({
          stock_item_id: created.id,
          movement_type: "ENTRADA",
          quantity: formData.quantity,
          movement_date: today,
          notes: "Cadastro do item no Almoxarifado",
          created_by: actor,
        } as Record<string, unknown>);
      }
    }

    setSaving(false);
    setShowForm(false);
    setEditItem(null);
    loadItems();
  }

  async function handleDelete() {
    if (!deleteItem) return;
    setSaving(true);
    await db.from("stock_items").delete().eq("id", deleteItem.id);
    setSaving(false);
    setDeleteItem(null);
    loadItems();
  }

  // Setinhas ↑/↓ da tabela: 1 unidade por clique, sem modal. ↓ registra BAIXA e
  // ↑ registra AJUSTE no histórico. Quantidade decimal (ex.: 0,5) desce até 0 e
  // registra só o que realmente saiu. Atualiza a lista localmente (sem reload)
  // pra cliques seguidos partirem do valor novo e somarem certo.
  async function handleQuickAdjust(item: StockItem, delta: 1 | -1) {
    const newQty = Math.max(0, Math.round((item.quantity + delta) * 1000) / 1000);
    const moved = Math.round(Math.abs(newQty - item.quantity) * 1000) / 1000;
    if (moved === 0) return;
    const actor = profile?.full_name || "Sistema";
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, quantity: newQty, updated_at: new Date().toISOString() } : it)));

    await db.from("stock_movements").insert({
      stock_item_id: item.id,
      movement_type: delta > 0 ? "AJUSTE" : "BAIXA",
      quantity: moved,
      movement_date: new Date().toISOString().split("T")[0],
      notes: delta > 0 ? "Ajuste rápido no Almoxarifado: +1 (seta)" : `Baixa rápida no Almoxarifado: -${formatQty(moved)} (seta)`,
      created_by: actor,
    } as Record<string, unknown>);

    await db
      .from("stock_items")
      .update({ quantity: newQty, updated_by: actor } as Record<string, unknown>)
      .eq("id", item.id);
  }

  const columns = [
    {
      key: "image",
      label: "",
      className: "w-12",
      render: (i: StockItem) => i.image_url ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); setLightbox(i.image_url); }} className="shrink-0" title="Ver foto">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={i.image_url} alt={i.name} className="w-9 h-9 rounded object-cover border border-border" />
        </button>
      ) : (
        <div className="w-9 h-9 rounded bg-gray-100 border border-border flex items-center justify-center text-text-light" title="Sem foto">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
        </div>
      ),
    },
    {
      key: "name",
      label: "Nome",
      render: (i: StockItem) => <span className="font-medium">{i.name}</span>,
    },
    {
      key: "code",
      label: "Código",
      render: (i: StockItem) => <span className="font-mono text-xs text-text-light">{codeMap.get(i.id) || "—"}</span>,
    },
    {
      key: "quantity",
      label: "Total",
      render: (i: StockItem) => {
        const belowMin = i.min_quantity > 0 && i.quantity < i.min_quantity;
        const isEmpty = i.quantity <= 0;
        return (
          <span className={`font-semibold ${isEmpty || belowMin ? "text-danger" : ""}`} title={belowMin ? `Abaixo do mínimo (${formatQty(i.min_quantity)})` : undefined}>
            {formatQty(i.quantity)}
          </span>
        );
      },
    },
    {
      key: "disponivel",
      label: "Disponível",
      render: (i: StockItem) => {
        const disp = disponivelOf(i);
        return (
          <span className={`font-semibold ${disp <= 0 ? "text-text-light" : "text-teal-700"}`} title="No almoxarifado (total − o que está com as equipes)">
            {formatQty(disp)}
          </span>
        );
      },
    },
    {
      key: "por_equipe",
      label: "Com as equipes",
      render: (i: StockItem) => {
        const a = allocByItem.get(i.id) || {};
        const parts = XFER_TEAMS.filter((t) => (a[t.value] || 0) > 0);
        if (parts.length === 0) return <span className="text-text-light">—</span>;
        return (
          <span className="flex flex-wrap gap-1">
            {parts.map((t) => (
              <span key={t.value} className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium ${t.badgeCls}`} title={t.label}>
                {t.label.replace("Equipe ", "").replace("Equipe", "")}: {formatQty(a[t.value])}
              </span>
            ))}
          </span>
        );
      },
    },
    {
      key: "min_quantity",
      label: "Mín.",
      render: (i: StockItem) => (
        <span className="text-text-light text-sm">{i.min_quantity > 0 ? formatQty(i.min_quantity) : "—"}</span>
      ),
    },
    // Valor unitário e total da linha (qtd × valor) — só p/ gestão.
    ...(canSeeValue ? [
      {
        key: "unit_value",
        label: "Valor Un.",
        render: (i: StockItem) => (
          <span className="text-sm">{i.unit_value ? formatCurrency(i.unit_value) : <span className="text-text-light">—</span>}</span>
        ),
      },
      {
        key: "total_value",
        label: "Total",
        render: (i: StockItem) => (
          <span className="text-sm font-semibold">
            {i.unit_value ? formatCurrency(i.unit_value * i.quantity) : <span className="text-text-light font-normal">—</span>}
          </span>
        ),
      },
    ] : []),
    {
      key: "notes",
      label: "Obs",
      hideOnMobile: true,
      render: (i: StockItem) => i.notes ? (
        <span className="text-xs text-text-light max-w-[200px] truncate block" title={i.notes}>{i.notes}</span>
      ) : <span className="text-text-light">—</span>,
    },
    {
      key: "updated_at",
      label: "Atualizado",
      hideOnMobile: true,
      render: (i: StockItem) => (
        <span className="text-text-light text-xs">{formatDateTime(i.updated_at)}</span>
      ),
    },
    {
      key: "actions",
      label: "",
      className: "w-32",
      render: (i: StockItem) => (
        <div className="flex items-center gap-1">
          {canEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); setTransferItem(i); }}
              className="p-1.5 text-teal-600 hover:bg-teal-50 rounded"
              title="Transferir pra uma equipe"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m4 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
            </button>
          )}
          {canEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); handleQuickAdjust(i, 1); }}
              className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded"
              title="Aumentar 1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
              </svg>
            </button>
          )}
          {canBaixar && (
            <button
              onClick={(e) => { e.stopPropagation(); handleQuickAdjust(i, -1); }}
              disabled={i.quantity <= 0}
              className="p-1.5 text-amber-600 hover:bg-amber-50 rounded disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title="Baixar 1"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </button>
          )}
          {canEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); setEditItem(i); setShowForm(true); }}
              className="p-1.5 text-primary hover:bg-blue-50 rounded"
              title="Editar"
            >
              <EditIcon />
            </button>
          )}
          {canDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); setDeleteItem(i); }}
              className="p-1.5 text-danger hover:bg-red-50 rounded"
              title="Excluir"
            >
              <TrashIcon />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {dbError && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 font-mono break-all">
          ⚠️ Erro ao carregar dados: {dbError}
        </div>
      )}

      {(canSeeValue && totalValue > 0) && (
        <div className="flex justify-end">
          <span
            className="px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800"
            title="Soma de quantidade × valor unitário dos itens listados"
          >
            Total em estoque: <strong className="font-semibold">{formatCurrency(totalValue)}</strong>
          </span>
        </div>
      )}

      <DataTable
        columns={columns}
        data={filteredItems}
        loading={loading}
        keyExtractor={(i) => i.id}
        emptyMessage={cfg.emptyMsg}
        mobileCards
        onRowClick={canEdit ? (i) => { setEditItem(i); setShowForm(true); } : undefined}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder={cfg.searchPlaceholder}
        actions={canCreate ? (
          <Button onClick={() => { setEditItem(null); setShowForm(true); }} size="sm">
            <PlusIcon className="w-4 h-4" />
            Adicionar
          </Button>
        ) : undefined}
      />

      <MaterialFormModal
        open={showForm}
        onClose={() => { setShowForm(false); setEditItem(null); }}
        onSave={handleSave}
        item={editItem}
        itemCode={editItem ? codeMap.get(editItem.id) || null : null}
        // Cadastro novo: mostra o código que VAI ser gerado a partir do nome
        // digitado (mesma numeração da lista) e avisa se o nome já existe.
        allItems={items}
        altNames={editItemAltNames}
        newTitle={cfg.newTitle}
        editTitle={cfg.editTitle}
        showValue={canSeeValue}
        saving={saving}
      />

      <AllocationModal
        item={transferItem}
        code={transferItem ? codeMap.get(transferItem.id) || null : null}
        alloc={transferItem ? allocByItem.get(transferItem.id) || {} : {}}
        disponivel={transferItem ? disponivelOf(transferItem) : 0}
        onClose={() => setTransferItem(null)}
        onSetAllocation={handleSetAllocation}
        saving={saving}
      />

      <ConfirmDialog
        open={!!deleteItem}
        onClose={() => setDeleteItem(null)}
        onConfirm={handleDelete}
        title={`Excluir ${cfg.singular}`}
        message={`Tem certeza que deseja excluir "${deleteItem?.name}"?`}
        confirmLabel="Excluir"
        loading={saving}
      />

      <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}

// Modal de transferência por equipe: o estoque fica no "Disponível" (galpão) e
// aqui se separa uma quantidade pra uma equipe. Escolhe a equipe e digita quanto
// ela deve ter (valor absoluto): aumentar tira do Disponível, diminuir devolve.
// Trava no Disponível — não deixa separar mais do que existe.
function AllocationModal({ item, code, alloc, disponivel, onClose, onSetAllocation, saving }: {
  item: StockItem | null;
  code: string | null;
  alloc: Record<string, number>;
  disponivel: number;
  onClose: () => void;
  onSetAllocation: (item: StockItem, team: XferTeam, qty: number) => void;
  saving: boolean;
}) {
  const [team, setTeam] = useState<XferTeam>("EQUIPE_1");
  const [qty, setQty] = useState("");

  // Ao abrir (ou trocar de equipe), mostra o que a equipe já tem separado.
  useEffect(() => {
    if (item) setQty(formatQty(alloc[team] || 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, team]);

  if (!item) return null;
  const atual = alloc[team] || 0;
  // Teto pra esta equipe = o que ela já tem + o que sobra no Disponível.
  const maxForTeam = +(atual + disponivel).toFixed(3);
  const parsed = parseDecimalBR(qty);
  const valid = parsed >= 0 && parsed <= maxForTeam + 1e-9;
  const delta = valid ? +(parsed - atual).toFixed(3) : 0;
  const dispDepois = valid ? +(disponivel - delta).toFixed(3) : disponivel;
  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";

  return (
    <Modal open={!!item} onClose={onClose} title="Transferir pra equipe">
      <form
        onSubmit={(e) => { e.preventDefault(); if (valid && delta !== 0) onSetAllocation(item, team, parsed); }}
        className="space-y-4"
      >
        <div className="rounded-lg border border-border bg-gray-50 px-3 py-2 text-sm">
          <p className="font-medium text-text">
            {item.name}
            {code && <span className="ml-2 font-mono text-xs text-text-light">{code}</span>}
          </p>
          <p className="text-xs text-text-light mt-0.5">
            Total <strong>{formatQty(item.quantity)}</strong> · Disponível no galpão <strong className="text-teal-700">{formatQty(disponivel)}</strong>
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">Equipe</label>
          <div className="flex gap-1 flex-wrap">
            {XFER_TEAMS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTeam(t.value)}
                className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
                  team === t.value ? "bg-primary text-white border-primary" : "border-border text-text-light hover:bg-gray-50"
                }`}
              >
                {t.label}{(alloc[t.value] || 0) > 0 ? ` (${formatQty(alloc[t.value])})` : ""}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">Quantidade com a {XFER_LABEL[team]}</label>
          <input
            type="text"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            autoFocus
            className={inputCls}
          />
          <div className="mt-1.5 flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[11px] text-text-light">
              {valid
                ? delta === 0
                  ? <>Sem mudança ({formatQty(atual)} com a {XFER_LABEL[team]}).</>
                  : delta > 0
                    ? <>Separa <strong>+{formatQty(delta)}</strong> · Disponível fica <strong>{formatQty(dispDepois)}</strong>.</>
                    : <>Devolve <strong>{formatQty(-delta)}</strong> pro galpão · Disponível fica <strong>{formatQty(dispDepois)}</strong>.</>
                : <span className="text-amber-700">Valor entre 0 e {formatQty(maxForTeam)}.</span>}
            </p>
            {disponivel > 0 && (
              <button
                type="button"
                onClick={() => setQty(formatQty(maxForTeam))}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                Separar tudo ({formatQty(maxForTeam)})
              </button>
            )}
          </div>
        </div>

        <div className="flex gap-3 justify-end pt-1">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={!valid || delta === 0 || saving}>
            {saving ? "Salvando..." : "Confirmar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function MaterialFormModal({ open, onClose, onSave, item, itemCode, allItems = [], altNames = [], newTitle, editTitle, showValue, saving }: {
  open: boolean;
  onClose: () => void;
  onSave: (data: { name: string; quantity: number; min_quantity: number; unit_value: number; image_url: string | null; notes: string | null }) => void;
  item: StockItem | null;
  itemCode?: string | null;
  // Itens do setor — base do código previsto no cadastro novo.
  allItems?: StockItem[];
  // Nomes com que este mesmo item (mesmo código) foi comprado no Controle de Compras.
  altNames?: string[];
  newTitle: string;
  editTitle: string;
  // Só gestão edita o valor unitário (canViewStockValue).
  showValue: boolean;
  saving: boolean;
}) {
  const [name, setName] = useState("");
  // Strings para aceitar vírgula (ex.: "1,5"); convertidas no submit.
  const [quantity, setQuantity] = useState("");
  const [minQuantity, setMinQuantity] = useState("");
  const [unitValue, setUnitValue] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (item) {
      setName(item.name);
      setQuantity(formatQty(item.quantity));
      setMinQuantity(item.min_quantity ? formatQty(item.min_quantity) : "");
      setUnitValue(item.unit_value ? formatQty(item.unit_value) : "");
      setImageUrl(item.image_url || null);
      setNotes(item.notes || "");
    } else {
      setName("");
      setQuantity("");
      setMinQuantity("");
      setUnitValue("");
      setImageUrl(null);
      setNotes("");
    }
  }, [item, open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name,
      quantity: parseDecimalBR(quantity),
      // Mínimo é inteiro (coluna Int); arredonda caso digitem decimal.
      min_quantity: Math.round(parseDecimalBR(minQuantity)),
      unit_value: parseDecimalBR(unitValue),
      image_url: imageUrl,
      notes: notes.trim() || null,
    });
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";

  // Código do item. Na edição é o que ele já tem; no cadastro novo é o que vai
  // ser gerado a partir do nome digitado (mesma numeração da lista). Antes só
  // aparecia na edição, em cinza minúsculo ao lado do rótulo — passava batido.
  const trimmedName = name.trim();
  const previewCode = !item && trimmedName ? codeForName(allItems, (i) => i.id, (i) => i.name, trimmedName) : null;
  const shownCode = item ? itemCode : previewCode;
  // Nome novo que já existe no setor: o código gerado seria o do item existente
  // — provavelmente é cadastro duplicado.
  const duplicate = !item && trimmedName
    ? allItems.find((i) => normalize(i.name) === normalize(trimmedName)) || null
    : null;

  return (
    <Modal open={open} onClose={onClose} title={item ? editTitle : newTitle}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
            <label className="block text-sm font-medium text-text">Nome *</label>
            {shownCode && (
              <span
                className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1"
                title={item ? "Código único deste item no Almoxarifado" : "Código que será gerado ao salvar"}
              >
                <span className="text-[10px] font-semibold uppercase tracking-wide text-primary/70">
                  {item ? "Código" : "Código novo"}
                </span>
                <span className="font-mono text-sm font-bold text-primary">{shownCode}</span>
              </span>
            )}
          </div>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} />
          {!item && (
            duplicate ? (
              <p className="mt-1 text-[11px] text-amber-700">
                ⚠️ Já existe <strong>{duplicate.name}</strong> neste setor com o código{" "}
                <span className="font-mono">{shownCode}</span> — confira antes de cadastrar de novo.
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-text-light">
                {trimmedName
                  ? "O código sai do nome — muda se você mudar o nome."
                  : "Digite o nome para ver o código que será gerado."}
              </p>
            )
          )}
        </div>
        {item && altNames.length > 0 && (
          <div className="bg-blue-50/60 border border-blue-200 rounded-lg px-3 py-2">
            <p className="text-[11px] font-medium text-blue-900">
              🛒 Também comprado no Controle de Compras como (mesmo código <span className="font-mono">{itemCode}</span>):
            </p>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {altNames.map((n) => (
                <span key={n} className="text-[11px] px-2 py-0.5 rounded-full bg-white border border-blue-200 text-blue-800">{n}</span>
              ))}
            </div>
            <p className="text-[10px] text-blue-700/80 mt-1">Compras com esse código repõem este item — não crie um novo pra evitar duplicação.</p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text mb-1">Qtd Atual</label>
            <input type="text" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Ex: 8" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium text-text mb-1">Qtd Mínima <span className="text-text-light font-normal">(opcional)</span></label>
            <input type="text" inputMode="numeric" value={minQuantity} onChange={(e) => setMinQuantity(e.target.value)} placeholder="0 = sem mínimo" className={inputCls} />
          </div>
        </div>
        {showValue && (
          <div>
            <label className="block text-sm font-medium text-text mb-1">
              Valor Unitário <span className="text-text-light font-normal">(R$, opcional)</span>
            </label>
            <input type="text" inputMode="decimal" value={unitValue} onChange={(e) => setUnitValue(e.target.value)} placeholder="Ex: 24,90" className={inputCls} />
            {parseDecimalBR(unitValue) > 0 && parseDecimalBR(quantity) > 0 && (
              <p className="text-xs text-text-light mt-1">
                Total em estoque: <strong>{formatCurrency(parseDecimalBR(unitValue) * parseDecimalBR(quantity))}</strong>
              </p>
            )}
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-text mb-1">Observações <span className="text-text-light font-normal">(opcional)</span></label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Ex: specs técnicas, localização..." className={`${inputCls} resize-none`} />
        </div>
        <ImagePicker value={imageUrl} onChange={setImageUrl} label="Foto do produto (opcional)" />
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

