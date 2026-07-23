"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { formatDate, formatDateTime, matchSearch, parseDecimalBR, formatQty, buildCodeMap, codeForName, normalize, unitSuffix } from "@/lib/utils";
import type { StockItem } from "@/types/database";

const STOCK_CATEGORIES = [
  { value: "SUPRIMENTOS", label: "Suprimentos" },
  { value: "CARNE", label: "Carne" },
  { value: "FEIRA", label: "Feira" },
];

// Unidades de medida do rancho. Carne normalmente é KG (peso), o resto varia
// (un, fardo, litro, caixa, pacote, dúzia, saco).
const STOCK_UNITS = [
  { value: "UN", label: "Unidade (un)" },
  { value: "KG", label: "Quilograma (kg)" },
  { value: "FARDO", label: "Fardo" },
  { value: "L", label: "Litro (L)" },
  { value: "CX", label: "Caixa (cx)" },
  { value: "PCT", label: "Pacote (pct)" },
  { value: "DZ", label: "Dúzia (dz)" },
  { value: "SACO", label: "Saco" },
];

// Abas do Rancho — mesmo modelo do resto do Almoxarifado (materiais-panel.tsx):
// "Disponível" é o galpão (linha EQUIPE_3, o estoque não separado) e cada equipe
// (EQUIPE_1/2/4) é o que já foi TRANSFERIDO pra ela. O botão "Transferir" move
// quantidade entre o galpão e as equipes — o total do alimento não muda, só a
// divisão. EQUIPE_4 = "Equipe Turbo".
//
// Internamente cada equipe ainda tem sua própria linha em stock_items (o embarque
// e o dashboard leem daí); "Disponível = galpão" e "alocado = linha da equipe".
type RanchoTeam = "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3" | "EQUIPE_4";
const DISPONIVEL: RanchoTeam = "EQUIPE_3";
const RANCHO_TEAM_TABS: { key: RanchoTeam; label: string; emoji: string; activeCls: string }[] = [
  { key: "EQUIPE_3", label: "Disponível", emoji: "📦", activeCls: "bg-teal-600 text-white shadow-md" },
  { key: "EQUIPE_1", label: "Equipe 1", emoji: "🚢", activeCls: "bg-blue-600 text-white shadow-md" },
  { key: "EQUIPE_2", label: "Equipe 2", emoji: "🚢", activeCls: "bg-purple-600 text-white shadow-md" },
  { key: "EQUIPE_4", label: "Equipe Turbo", emoji: "🔥", activeCls: "bg-orange-600 text-white shadow-md" },
];
// Só as equipes reais (sem o Disponível) — base da soma e dos destinos do Transferir.
const REAL_TEAMS: RanchoTeam[] = ["EQUIPE_1", "EQUIPE_2", "EQUIPE_4"];
function ranchoTeamLabel(t: string): string {
  return RANCHO_TEAM_TABS.find((x) => x.key === t)?.label || t;
}

const norm = (s: string) => (s || "").trim().toLowerCase();

// Painel de Rancho (comida/suprimentos por equipe, stock_items filtrados por
// EQUIPE_1/2/3/4) — corpo da antiga página /estoque, hoje renderizado como a aba
// "Rancho" do Almoxarifado. (O nome do componente segue EstoquePanel por
// histórico; a aba "Estoque" agora é o StockInventoryPanel.)
export function EstoquePanel() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("TODOS");
  // Disponível (EQUIPE_3) é a aba padrão — o galpão (estoque não separado).
  const [activeTeam, setActiveTeam] = useState<RanchoTeam>("EQUIPE_3");
  const [editItem, setEditItem] = useState<StockItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteItem, setDeleteItem] = useState<StockItem | null>(null);
  const [saving, setSaving] = useState(false);
  // Alimento cujo botão "Transferir" foi clicado — abre o modal de transferência.
  const [transferItem, setTransferItem] = useState<StockItem | null>(null);

  const role = profile?.role || "RH";
  const canCreate = hasPermission(role, "ESTOQUE", "create");
  const canEdit = hasPermission(role, "ESTOQUE", "edit");
  const canDelete = hasPermission(role, "ESTOQUE", "delete");
  const canBaixar = hasPermission(role, "ESTOQUE", "baixar");

  const loadItems = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      const { data, error } = await db
        .from("stock_items")
        .select("*")
        .order("updated_at", { ascending: false });
      if (error) {
        console.error("DB stock_items error:", error);
        setDbError(`${error.code}: ${error.message} — ${error.hint || ""}`);
      }
      setItems(data || []);
    } catch (err) {
      console.error("Erro ao carregar estoque:", err);
      setDbError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadItems();
  }, [loadItems, pathname]);

  const isMaster = activeTeam === DISPONIVEL;

  // Código derivado do nome (prefixo de iniciais + sequência), por item.
  const codeMap = useMemo(() => buildCodeMap(items, (i) => i.id, (i) => i.name), [items]);

  // Linha do galpão (EQUIPE_3) por nome — a "linha-mãe" do alimento (guarda o
  // Padrão único e o estoque Disponível).
  const galpaoByName = useMemo(() => {
    const m = new Map<string, StockItem>();
    for (const it of items) if (it.team === DISPONIVEL) m.set(norm(it.name), it);
    return m;
  }, [items]);

  // Linha de uma equipe real por nome (o que aquela equipe já tem separado).
  const teamRowByName = useMemo(() => {
    const m = new Map<string, Map<string, StockItem>>();
    for (const it of items) {
      if (!REAL_TEAMS.includes(it.team as RanchoTeam)) continue;
      const k = norm(it.name);
      if (!m.has(k)) m.set(k, new Map());
      m.get(k)!.set(it.team as string, it);
    }
    return m;
  }, [items]);

  const teamRow = useCallback(
    (name: string, team: RanchoTeam) =>
      team === DISPONIVEL ? galpaoByName.get(norm(name)) || null : teamRowByName.get(norm(name))?.get(team) || null,
    [galpaoByName, teamRowByName],
  );

  // Disponível (no galpão) por alimento.
  const disponivelQty = useCallback(
    (name: string) => Number(galpaoByName.get(norm(name))?.quantity) || 0,
    [galpaoByName],
  );
  // Quanto uma equipe real tem separado do alimento.
  const teamQty = useCallback(
    (name: string, team: RanchoTeam) => Number(teamRowByName.get(norm(name))?.get(team)?.quantity) || 0,
    [teamRowByName],
  );
  // Total do alimento = galpão + o que está com as equipes.
  const totalQty = useCallback(
    (name: string) => disponivelQty(name) + REAL_TEAMS.reduce((s, t) => s + teamQty(name, t), 0),
    [disponivelQty, teamQty],
  );
  // Linhas da aba Disponível: UNIÃO dos alimentos — a linha-mãe do galpão (EQUIPE_3)
  // + os que só existem em equipes (representante = 1ª linha achada). Deduplicado
  // por nome; a linha-mãe tem prioridade como representante.
  const totalRows = useMemo(() => {
    const byName = new Map<string, StockItem>();
    for (const it of items) if (it.team === DISPONIVEL) byName.set(norm(it.name), it);
    for (const it of items) {
      if (!REAL_TEAMS.includes(it.team as RanchoTeam)) continue;
      const k = norm(it.name);
      if (!byName.has(k)) byName.set(k, it);
    }
    return Array.from(byName.values());
  }, [items]);

  // No Disponível uma linha é "só das equipes" quando não tem linha-mãe (galpão).
  const isTeamOnly = useCallback(
    (i: StockItem) => isMaster && !galpaoByName.has(norm(i.name)),
    [isMaster, galpaoByName],
  );

  const baseItems = isMaster ? totalRows : items.filter((i) => i.team === activeTeam);
  const filteredItems = baseItems.filter((i) => {
    const matchesSearch =
      matchSearch(i.name, search) ||
      matchSearch(codeMap.get(i.id) || "", search);
    const matchesCategory =
      filterCategory === "TODOS" || i.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  function getCategoryLabel(cat: string) {
    return STOCK_CATEGORIES.find((c) => c.value === cat)?.label || cat;
  }

  function getCategoryColor(cat: string) {
    switch (cat) {
      case "CARNE":
      case "CARNES":
        return "bg-red-100 text-red-700";
      case "FEIRA":
        return "bg-green-100 text-green-700";
      case "SUPRIMENTOS":
      case "OUTROS":
        return "bg-purple-100 text-purple-700";
      default:
        return "bg-blue-100 text-blue-700";
    }
  }

  async function handleSave(formData: Partial<StockItem>) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    // Cadastro novo entra sempre no Disponível (galpão, EQUIPE_3) — as equipes se
    // servem por Transferir. Na edição mantém a equipe da própria linha.
    const team = editItem ? editItem.team : DISPONIVEL;
    const payload = { ...formData, updated_by: actor, team } as Record<string, unknown>;

    const today = new Date().toISOString().split("T")[0];
    const newQty = Number(formData.quantity);
    if (editItem) {
      await db.from("stock_items").update(payload).eq("id", editItem.id);
      // Mudou a quantidade na edição → registra no histórico (ajuste manual),
      // pra toda movimentação de estoque contar a história.
      if (Number.isFinite(newQty)) {
        const diff = newQty - editItem.quantity;
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
      }
      // Padrão é único por alimento: editando a linha-mãe do galpão, propaga o
      // default_quantity pras linhas das equipes (o embarque lê o Padrão da equipe).
      if (editItem.team === DISPONIVEL && Number.isFinite(Number(formData.default_quantity))) {
        const others = teamRowByName.get(norm(editItem.name));
        if (others) {
          for (const row of others.values()) {
            await db.from("stock_items")
              .update({ default_quantity: Number(formData.default_quantity), updated_by: actor } as Record<string, unknown>)
              .eq("id", row.id);
          }
        }
      }
    } else {
      const insRes = (await db.from("stock_items").insert(payload)) as { data: { id?: number } | { id?: number }[] | null };
      const created = Array.isArray(insRes.data) ? insRes.data[0] : insRes.data;
      if (created?.id && Number.isFinite(newQty) && newQty > 0) {
        await db.from("stock_movements").insert({
          stock_item_id: created.id,
          movement_type: "ENTRADA",
          quantity: newQty,
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
  // ↑ registra AJUSTE no histórico. O rancho tem quantidade decimal (ex.: 0,5 kg),
  // então a descida trava em 0 e registra só o que realmente saiu. Atualiza a
  // lista localmente (sem reload) pra cliques seguidos partirem do valor novo.
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
      notes: delta > 0 ? "Ajuste rápido no Rancho: +1 (seta)" : `Baixa rápida no Rancho: -${formatQty(moved)} (seta)`,
      created_by: actor,
    } as Record<string, unknown>);

    await db
      .from("stock_items")
      .update({ quantity: newQty, updated_by: actor } as Record<string, unknown>)
      .eq("id", item.id);
  }

  // Transfere `rawQty` de uma origem pra um destino (cada um: "EQUIPE_3"=Disponível
  // ou uma equipe). O total do alimento não muda — só a divisão. Move a quantidade
  // entre as linhas por equipe do stock_items; cria a linha do destino se faltar,
  // copiando nome/categoria/unidade/Padrão da linha-mãe do galpão.
  async function handleTransfer(item: StockItem, from: RanchoTeam, to: RanchoTeam, rawQty: number) {
    const avail = from === DISPONIVEL ? disponivelQty(item.name) : teamQty(item.name, from);
    const qty = Math.round(Math.min(Math.max(rawQty, 0), avail) * 1000) / 1000;
    if (qty <= 0 || from === to) { setTransferItem(null); return; }
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    try {
      const fromRow = teamRow(item.name, from);
      if (!fromRow) { setSaving(false); setTransferItem(null); return; }
      const newFrom = Math.round((Number(fromRow.quantity) - qty) * 1000) / 1000;
      await db.from("stock_items")
        .update({ quantity: Math.max(0, newFrom), updated_by: actor } as Record<string, unknown>)
        .eq("id", fromRow.id);

      const toRow = teamRow(item.name, to);
      if (toRow) {
        const newTo = Math.round((Number(toRow.quantity) + qty) * 1000) / 1000;
        await db.from("stock_items")
          .update({ quantity: newTo, updated_by: actor } as Record<string, unknown>)
          .eq("id", toRow.id);
      } else {
        // Cria a linha do destino a partir da linha-mãe (galpão) ou da origem.
        const mother = galpaoByName.get(norm(item.name)) || fromRow;
        await db.from("stock_items").insert({
          name: mother.name,
          category: mother.category,
          unit: mother.unit,
          quantity: qty,
          default_quantity: mother.default_quantity || 0,
          min_quantity: 0,
          team: to,
          updated_by: actor,
        } as Record<string, unknown>);
      }
      await loadItems();
    } finally {
      setSaving(false);
      setTransferItem(null);
    }
  }

  const columns = [
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
      key: "category",
      label: "Categoria",
      render: (i: StockItem) => (
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${getCategoryColor(i.category)}`}>
          {getCategoryLabel(i.category)}
        </span>
      ),
    },
    {
      key: "total",
      label: "Total",
      render: (i: StockItem) => {
        const tot = totalQty(i.name);
        return (
          <span className={`font-semibold ${tot <= 0 ? "text-text-light" : ""}`} title="Total do alimento (galpão + o que está com as equipes)">
            {formatQty(tot)} <span className="text-xs font-normal text-text-light">{unitSuffix(i.unit)}</span>
          </span>
        );
      },
    },
    {
      // Quantidade NA VISÃO atual: no "Disponível" é o que está no galpão (não
      // separado); numa aba de equipe é o que aquela equipe tem. O rótulo acompanha
      // a aba, como no resto do Almoxarifado.
      key: "quantity",
      label: isMaster ? "Disponível" : ranchoTeamLabel(activeTeam),
      render: (i: StockItem) => {
        const qty = isMaster ? disponivelQty(i.name) : Number(i.quantity) || 0;
        return (
          <span
            className={`font-semibold ${qty <= 0 ? "text-text-light" : "text-teal-700"}`}
            title={isMaster ? "No galpão (não separado pras equipes)" : `Separado para ${ranchoTeamLabel(activeTeam)}`}
          >
            {formatQty(qty)} <span className="text-xs font-normal text-text-light">{unitSuffix(i.unit)}</span>
          </span>
        );
      },
    },
    {
      key: "expiry_date",
      label: "Validade",
      hideOnMobile: true,
      render: (i: StockItem) => formatDate(i.expiry_date),
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
      render: (i: StockItem) => {
        const inViewQty = isMaster ? disponivelQty(i.name) : Number(i.quantity) || 0;
        return (
          <div className="flex items-center gap-1">
            {canEdit && (
              <button
                onClick={(e) => { e.stopPropagation(); setTransferItem(i); }}
                disabled={inViewQty <= 0}
                className="p-1.5 text-teal-600 hover:bg-teal-50 rounded disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                title={`Transferir de ${ranchoTeamLabel(activeTeam)} pra outra equipe/Disponível`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m4 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
              </button>
            )}
            {canEdit && !isTeamOnly(i) && (
              <button
                onClick={(e) => { e.stopPropagation(); handleQuickAdjust(i, 1); }}
                className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded"
                title={isMaster ? "Aumentar 1 no galpão" : "Aumentar 1"}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
              </button>
            )}
            {canBaixar && !isTeamOnly(i) && (
              <button
                onClick={(e) => { e.stopPropagation(); handleQuickAdjust(i, -1); }}
                disabled={i.quantity <= 0}
                className="p-1.5 text-amber-600 hover:bg-amber-50 rounded disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                title={isMaster ? "Baixar 1 do galpão" : "Baixar 1"}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              </button>
            )}
            {canEdit && !isTeamOnly(i) && (
              <button
                onClick={(e) => { e.stopPropagation(); setEditItem(i); setShowForm(true); }}
                className="p-1.5 text-primary hover:bg-blue-50 rounded"
                title="Editar"
              >
                <EditIcon />
              </button>
            )}
            {canDelete && !isTeamOnly(i) && (
              <button
                onClick={(e) => { e.stopPropagation(); setDeleteItem(i); }}
                className="p-1.5 text-danger hover:bg-red-50 rounded"
                title="Excluir"
              >
                <TrashIcon />
              </button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4">
      {dbError && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 font-mono break-all">
          ⚠️ Erro ao carregar dados: {dbError}
        </div>
      )}

      {/* Abas de visão: Disponível / Equipe 1 / Equipe 2 / Turbo (igual o resto do
          Almoxarifado). A aba filtra a tabela e é a ORIGEM do botão Transferir. */}
      <div className="flex gap-2 flex-wrap">
        {RANCHO_TEAM_TABS.map((t) => {
          const count = t.key === DISPONIVEL
            ? totalRows.filter((i) => disponivelQty(i.name) > 0).length
            : items.filter((i) => i.team === t.key && i.quantity > 0).length;
          return (
            <button
              key={t.key}
              onClick={() => setActiveTeam(t.key)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${activeTeam === t.key ? t.activeCls : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {t.emoji} {t.label}{count > 0 ? ` (${count})` : ""}
            </button>
          );
        })}
      </div>

      {/* Category filter */}
      <div className="flex flex-wrap gap-2">
        {[{ value: "TODOS", label: "Todos" }, ...STOCK_CATEGORIES].map((cat) => (
          <button
            key={cat.value}
            onClick={() => setFilterCategory(cat.value)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${filterCategory === cat.value ? "bg-primary text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      <DataTable
        columns={columns}
        data={filteredItems}
        loading={loading}
        keyExtractor={(i) => i.id}
        emptyMessage="Nenhum item encontrado"
        mobileCards
        onRowClick={canEdit ? (i) => { if (isTeamOnly(i)) return; setEditItem(i); setShowForm(true); } : undefined}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por nome ou código..."
        actions={
          canCreate ? (
            <Button onClick={() => { setEditItem(null); setShowForm(true); }} size="sm">
              <PlusIcon className="w-4 h-4" />
              Adicionar
            </Button>
          ) : undefined
        }
      />

      <StockFormModal
        open={showForm}
        onClose={() => { setShowForm(false); setEditItem(null); }}
        onSave={handleSave}
        item={editItem}
        saving={saving}
        itemCode={editItem ? codeMap.get(editItem.id) || null : null}
        allItems={items}
      />

      <TransferModal
        item={transferItem}
        source={activeTeam}
        code={transferItem ? codeMap.get(transferItem.id) || null : null}
        unit={transferItem?.unit || "UN"}
        disponivel={transferItem ? disponivelQty(transferItem.name) : 0}
        teamQtys={transferItem
          ? Object.fromEntries(REAL_TEAMS.map((t) => [t, teamQty(transferItem.name, t)]))
          : {}}
        onClose={() => setTransferItem(null)}
        onTransfer={handleTransfer}
        saving={saving}
      />

      <ConfirmDialog
        open={!!deleteItem}
        onClose={() => setDeleteItem(null)}
        onConfirm={handleDelete}
        title="Excluir Item"
        message={`Tem certeza que deseja excluir "${deleteItem?.name}"?`}
        confirmLabel="Excluir"
        loading={saving}
      />
    </div>
  );
}

// Modal de transferência: manda uma quantidade da ORIGEM (a aba atual) pra um
// DESTINO (outra equipe ou o Disponível). Disponível → equipe separa a comida;
// equipe → Disponível devolve; equipe → equipe passa direto entre elas.
function TransferModal({ item, source, code, unit, disponivel, teamQtys, onClose, onTransfer, saving }: {
  item: StockItem | null;
  source: RanchoTeam;
  code: string | null;
  unit: string;
  disponivel: number;
  teamQtys: Record<string, number>;
  onClose: () => void;
  onTransfer: (item: StockItem, from: RanchoTeam, to: RanchoTeam, qty: number) => void;
  saving: boolean;
}) {
  const qtyOf = (t: RanchoTeam) => (t === DISPONIVEL ? disponivel : (teamQtys[t] || 0));
  const avail = qtyOf(source);
  const destinos = RANCHO_TEAM_TABS.map((t) => t.key).filter((v) => v !== source);
  const [dest, setDest] = useState<RanchoTeam>(destinos[0]);
  const [qty, setQty] = useState("");

  // Ao (re)abrir, começa com tudo o que há na origem e o 1º destino.
  useEffect(() => {
    if (item) { setQty(formatQty(avail)); setDest(destinos[0]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, source]);

  if (!item) return null;
  const suffix = unitSuffix(unit);
  const parsed = parseDecimalBR(qty);
  const valid = parsed > 0 && parsed <= avail + 1e-9 && dest !== source;
  const leftover = valid ? Math.round((avail - parsed) * 1000) / 1000 : avail;
  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";

  return (
    <Modal open={!!item} onClose={onClose} title={`Transferir de ${ranchoTeamLabel(source)}`}>
      <form
        onSubmit={(e) => { e.preventDefault(); if (valid) onTransfer(item, source, dest, parsed); }}
        className="space-y-4"
      >
        <div className="rounded-lg border border-border bg-gray-50 px-3 py-2 text-sm">
          <p className="font-medium text-text">
            {item.name}
            {code && <span className="ml-2 font-mono text-xs text-text-light">{code}</span>}
          </p>
          <p className="text-xs text-text-light mt-0.5">
            Em <strong>{ranchoTeamLabel(source)}</strong>:{" "}
            <strong className="text-teal-700">{formatQty(avail)} {suffix}</strong>
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">Transferir para</label>
          <div className="flex gap-1 flex-wrap">
            {destinos.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDest(d)}
                className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
                  dest === d ? "bg-primary text-white border-primary" : "border-border text-text-light hover:bg-gray-50"
                }`}
              >
                {ranchoTeamLabel(d)}{qtyOf(d) > 0 ? ` (${formatQty(qtyOf(d))})` : ""}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">Quantidade</label>
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
                ? <>Ficam <strong>{formatQty(leftover)} {suffix}</strong> em {ranchoTeamLabel(source)}; vão <strong>{formatQty(parsed)} {suffix}</strong> pra {ranchoTeamLabel(dest)}.</>
                : <span className="text-amber-700">Informe um valor entre 1 e {formatQty(avail)}.</span>}
            </p>
            {avail > 0 && (
              <button
                type="button"
                onClick={() => setQty(formatQty(avail))}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                Tudo ({formatQty(avail)})
              </button>
            )}
          </div>
        </div>

        <div className="flex gap-3 justify-end pt-1">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={!valid || saving}>
            {saving ? "Transferindo..." : "Transferir"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function StockFormModal({ open, onClose, onSave, item, saving, itemCode, allItems = [] }: {
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<StockItem>) => void;
  item: StockItem | null;
  saving: boolean;
  // Código do item em edição e a lista do setor (base do código previsto no
  // cadastro novo) — mesmo destaque do Almoxarifado.
  itemCode?: string | null;
  allItems?: StockItem[];
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("SUPRIMENTOS");
  const [unit, setUnit] = useState("UN");
  // Strings para aceitar vírgula (ex.: "1,5"); convertidas no submit.
  const [quantity, setQuantity] = useState("");
  const [defaultQuantity, setDefaultQuantity] = useState("");
  const [expiryDate, setExpiryDate] = useState("");

  useEffect(() => {
    if (item) {
      setName(item.name);
      setCategory(item.category);
      setUnit(item.unit || "UN");
      setQuantity(formatQty(item.quantity));
      setDefaultQuantity(item.default_quantity ? formatQty(item.default_quantity) : "");
      setExpiryDate(item.expiry_date || "");
    } else {
      setName("");
      setCategory("SUPRIMENTOS");
      setUnit("UN");
      setQuantity("");
      setDefaultQuantity("");
      setExpiryDate("");
    }
  }, [item, open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name,
      category: category as StockItem["category"],
      unit,
      quantity: parseDecimalBR(quantity),
      default_quantity: parseDecimalBR(defaultQuantity),
      expiry_date: expiryDate || null,
      min_quantity: 0,
    });
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";

  // Código do item: na edição o que ele já tem; no cadastro novo o que vai ser
  // gerado a partir do nome. Fica em destaque ao lado do campo Nome.
  const trimmedName = name.trim();
  const previewCode = !item && trimmedName ? codeForName(allItems, (i) => i.id, (i) => i.name, trimmedName) : null;
  const shownCode = item ? itemCode : previewCode;
  const duplicate = !item && trimmedName
    ? allItems.find((i) => normalize(i.name) === normalize(trimmedName)) || null
    : null;

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Item" : "Novo Item"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
            <label className="block text-sm font-medium text-text">Nome *</label>
            {shownCode && (
              <span
                className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1"
                title={item ? "Código único deste item" : "Código que será gerado ao salvar"}
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
                ⚠️ Já existe <strong>{duplicate.name}</strong> aqui com o código{" "}
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
        <div>
          <label className="block text-sm font-medium text-text mb-1">Categoria</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
            {STOCK_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-text mb-1">Unidade de medida</label>
          <select value={unit} onChange={(e) => setUnit(e.target.value)} className={inputCls}>
            {STOCK_UNITS.map((u) => (
              <option key={u.value} value={u.value}>{u.label}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-text mb-1">Qtd Padrão</label>
            <input type="text" inputMode="decimal" value={defaultQuantity} onChange={(e) => setDefaultQuantity(e.target.value)} placeholder="Ex: 10 ou 1,5" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium text-text mb-1">{item && item.team !== DISPONIVEL ? "Qtd da equipe" : "Qtd no galpão"}</label>
            <input type="text" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Ex: 1,5" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium text-text mb-1">Validade</label>
            <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}
