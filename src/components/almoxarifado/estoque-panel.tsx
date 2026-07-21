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
import { formatDate, formatDateTime, matchSearch, parseDecimalBR, formatQty, buildCodeMap, unitSuffix } from "@/lib/utils";
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

// Abas do Rancho. EQUIPE_3 = "Disponível" (ex-"Total"; lista-mãe: cadastra os
// alimentos e mostra a SOMA das quantidades das equipes — renomeada pra casar
// com o botão teal "Disponível" das outras abas do Almoxarifado). EQUIPE_1/2/4 =
// equipes reais, cada uma com suas próprias quantidades (cadastro livre).
// EQUIPE_4 = "Equipe Turbo" (equipe maior, leva mais comida — mesmos alimentos).
type RanchoTeam = "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3" | "EQUIPE_4";
const RANCHO_TEAM_TABS: { key: RanchoTeam; label: string; emoji: string; activeCls: string }[] = [
  { key: "EQUIPE_3", label: "Disponível", emoji: "🧮", activeCls: "bg-teal-600 text-white shadow-md" },
  { key: "EQUIPE_1", label: "Equipe 1", emoji: "🚢", activeCls: "bg-blue-600 text-white shadow-md" },
  { key: "EQUIPE_2", label: "Equipe 2", emoji: "🚢", activeCls: "bg-purple-600 text-white shadow-md" },
  { key: "EQUIPE_4", label: "Equipe Turbo", emoji: "🔥", activeCls: "bg-orange-600 text-white shadow-md" },
];
// Só as equipes reais (sem o Disponível) — base da soma e do "Preparar".
const REAL_TEAMS: RanchoTeam[] = ["EQUIPE_1", "EQUIPE_2", "EQUIPE_4"];
function ranchoTeamLabel(t: string): string {
  return RANCHO_TEAM_TABS.find((x) => x.key === t)?.label || t;
}
// Cor do selo (claro) de equipe mostrado por alimento na aba Disponível.
const RANCHO_TEAM_BADGE: Record<string, string> = {
  EQUIPE_1: "bg-blue-100 text-blue-700",
  EQUIPE_2: "bg-purple-100 text-purple-700",
  EQUIPE_4: "bg-orange-100 text-orange-700",
};

// Item já cadastrado nas equipes, oferecido no seletor de código ao cadastrar no
// Disponível (deduplicado por nome).
type CodeSourceItem = {
  id: number;
  name: string;
  category: string;
  unit: string;
  default_quantity: number;
  code: string;
  teams: RanchoTeam[];
};

// Painel de Rancho (comida/suprimentos por equipe, stock_items filtrados por
// EQUIPE_1/2/3) — corpo da antiga página /estoque, hoje renderizado como a aba
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
  // Disponível (EQUIPE_3) é a aba padrão — lista-mãe que mostra a soma das equipes.
  const [activeTeam, setActiveTeam] = useState<RanchoTeam>("EQUIPE_3");
  const [editItem, setEditItem] = useState<StockItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [deleteItem, setDeleteItem] = useState<StockItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPreparar, setShowPreparar] = useState(false);
  const [preparing, setPreparing] = useState(false);

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

  // Código derivado do nome (prefixo de iniciais + sequência), por item.
  const codeMap = useMemo(() => buildCodeMap(items, (i) => i.id, (i) => i.name), [items]);

  // Itens já cadastrados nas Equipes 1/2, deduplicados por nome — fonte do
  // seletor de código ao cadastrar um item no Disponível. O representante é a
  // Equipe 1 quando existe, pra o código casar com o que aparece na aba dela.
  const codeSourceItems = useMemo<CodeSourceItem[]>(() => {
    const norm = (s: string) => (s || "").trim().toLowerCase();
    const byName = new Map<string, CodeSourceItem>();
    const repTeam = new Map<string, string>();
    for (const it of items) {
      if (!REAL_TEAMS.includes(it.team as RanchoTeam)) continue;
      const team = it.team as RanchoTeam;
      const key = norm(it.name);
      const existing = byName.get(key);
      if (existing) {
        if (!existing.teams.includes(team)) existing.teams.push(team);
        // Equipe 1 vira o representante (código + atributos puxados).
        if (team === "EQUIPE_1" && repTeam.get(key) !== "EQUIPE_1") {
          existing.id = it.id;
          existing.category = it.category;
          existing.unit = it.unit || "UN";
          existing.default_quantity = it.default_quantity;
          existing.code = codeMap.get(it.id) || "";
          repTeam.set(key, "EQUIPE_1");
        }
      } else {
        byName.set(key, {
          id: it.id,
          name: it.name,
          category: it.category,
          unit: it.unit || "UN",
          default_quantity: it.default_quantity,
          code: codeMap.get(it.id) || "",
          teams: [team],
        });
        repTeam.set(key, team);
      }
    }
    return Array.from(byName.values())
      .map((v) => ({ ...v, teams: [...v.teams].sort() as RanchoTeam[] }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [items, codeMap]);

  // Soma das quantidades das equipes reais (1, 2 e Turbo) por nome — alimenta a
  // coluna "Soma" da aba Disponível (a lista-mãe mostra quanto há somado nas equipes).
  const teamSumByName = useMemo(() => {
    const norm = (s: string) => (s || "").trim().toLowerCase();
    const m = new Map<string, number>();
    for (const it of items) {
      if (!REAL_TEAMS.includes(it.team as RanchoTeam)) continue;
      m.set(norm(it.name), (m.get(norm(it.name)) || 0) + (Number(it.quantity) || 0));
    }
    return m;
  }, [items]);

  // Quais equipes têm cada alimento (por nome) — alimenta os selos "Equipe 1 / 2 /
  // Turbo" na aba Disponível, conforme quem realmente tem o produto.
  const teamsByName = useMemo(() => {
    const norm = (s: string) => (s || "").trim().toLowerCase();
    const m = new Map<string, Set<string>>();
    for (const it of items) {
      if (!REAL_TEAMS.includes(it.team as RanchoTeam)) continue;
      const k = norm(it.name);
      if (!m.has(k)) m.set(k, new Set());
      m.get(k)!.add(it.team as string);
    }
    return m;
  }, [items]);

  // Disponível (EQUIPE_3) é a lista-mãe: cadastro dos alimentos + soma das equipes.
  // Aqui não há "qtd atual" própria nem baixa — a quantidade é o somatório.
  const isMaster = activeTeam === "EQUIPE_3";

  // Linhas do Disponível: UNIÃO dos alimentos — os da lista-mãe (EQUIPE_3, editáveis)
  // + os que existem só nas equipes (representante = 1º item achado; só leitura
  // aqui, já que não estão na lista-mãe). Deduplicado por nome; a lista-mãe tem
  // prioridade como representante.
  const totalRows = useMemo(() => {
    const norm = (s: string) => (s || "").trim().toLowerCase();
    const byName = new Map<string, StockItem>();
    for (const it of items) if (it.team === "EQUIPE_3") byName.set(norm(it.name), it);
    for (const it of items) {
      if (!REAL_TEAMS.includes(it.team as RanchoTeam)) continue;
      const k = norm(it.name);
      if (!byName.has(k)) byName.set(k, it);
    }
    return Array.from(byName.values());
  }, [items]);

  // No Disponível uma linha é "só das equipes" quando não veio da lista-mãe (EQUIPE_3).
  const isTeamOnly = (i: StockItem) => isMaster && i.team !== "EQUIPE_3";

  const baseItems = isMaster ? totalRows : items.filter((i) => i.team === activeTeam);
  const filteredItems = baseItems.filter((i) => {
    const matchesSearch =
      matchSearch(i.name, search) ||
      matchSearch(codeMap.get(i.id) || "", search);
    const matchesCategory =
      filterCategory === "TODOS" || i.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  // Itens cadastrados no Disponível (lista-mãe, EQUIPE_3) — base do botão "Preparar".
  const reservaCount = items.filter((i) => i.team === "EQUIPE_3").length;

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
    const payload = { ...formData, updated_by: actor, team: activeTeam } as Record<string, unknown>;

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

  // "Preparar": copia os itens do Disponível (lista-mãe, EQUIPE_3) para a equipe
  // escolhida, usando a quantidade padrão de cada um. Casa por nome: item
  // existente na equipe é atualizado; o que falta é criado.
  async function handlePreparar(targetTeam: "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_4") {
    setPreparing(true);
    const actor = profile?.full_name || "Sistema";
    const reservaItems = items.filter((i) => i.team === "EQUIPE_3");
    const destItems = items.filter((i) => i.team === targetTeam);
    const norm = (s: string) => (s || "").trim().toLowerCase();
    for (const it of reservaItems) {
      const qty = it.default_quantity || 0;
      const existing = destItems.find((d) => norm(d.name) === norm(it.name));
      const payload = {
        name: it.name,
        category: it.category,
        unit: it.unit,
        quantity: qty,
        default_quantity: it.default_quantity,
        min_quantity: 0,
        team: targetTeam,
        updated_by: actor,
      } as Record<string, unknown>;
      if (existing) {
        await db.from("stock_items").update(payload).eq("id", existing.id);
      } else {
        await db.from("stock_items").insert(payload);
      }
    }
    setPreparing(false);
    setShowPreparar(false);
    loadItems();
  }

  const columns = [
    {
      key: "name",
      label: "Nome",
      render: (i: StockItem) => {
        // Na aba Disponível, mostra um selo por equipe que TEM esse alimento.
        const teams = isMaster ? teamsByName.get((i.name || "").trim().toLowerCase()) : null;
        return (
          <span className="font-medium">
            {i.name}
            {teams && REAL_TEAMS.filter((t) => teams.has(t)).map((t) => (
              <span key={t} className={`ml-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full align-middle ${RANCHO_TEAM_BADGE[t] || "bg-gray-100 text-gray-600"}`}>
                {ranchoTeamLabel(t)}
              </span>
            ))}
          </span>
        );
      },
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
      key: "default_quantity",
      label: "Padrão",
      render: (i: StockItem) => (
        <span className="text-text-light">
          {isTeamOnly(i)
            ? "—"
            : i.default_quantity ? `${formatQty(i.default_quantity)} ${unitSuffix(i.unit)}` : "—"}
        </span>
      ),
    },
    {
      key: "quantity",
      label: isMaster ? "Soma equipes" : "Qtd",
      render: (i: StockItem) => {
        // No Disponível, a quantidade é o somatório das equipes (por nome).
        if (isMaster) {
          const sum = teamSumByName.get((i.name || "").trim().toLowerCase()) || 0;
          return (
            <span className={`font-semibold ${sum <= 0 ? "text-danger" : "text-text"}`}>
              {formatQty(sum)} <span className="text-xs font-normal text-text-light">{unitSuffix(i.unit)}</span>
            </span>
          );
        }
        const def = i.default_quantity || 0;
        const isLow = def > 0 && i.quantity < def * 0.5;
        const isEmpty = i.quantity <= 0;
        return (
          <span className={`font-semibold ${isEmpty ? "text-danger" : isLow ? "text-amber-500" : "text-success"}`}>
            {formatQty(i.quantity)} <span className="text-xs font-normal text-text-light">{unitSuffix(i.unit)}</span>
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
      className: "w-24",
      render: (i: StockItem) => (
        <div className="flex items-center gap-1">
          {canEdit && !isMaster && (
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
          {canBaixar && !isMaster && (
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

      {/* Seletor de aba — Disponível primeiro (lista-mãe + soma das equipes). */}
      <div className="flex gap-2 flex-wrap">
        {RANCHO_TEAM_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTeam(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${activeTeam === t.key ? t.activeCls : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            {t.emoji} {t.label}
          </button>
        ))}
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
          <div className="flex items-center gap-2">
            {activeTeam === "EQUIPE_3" && canCreate && (
              <Button variant="secondary" size="sm" onClick={() => setShowPreparar(true)} disabled={reservaCount === 0}>
                📦 Preparar
              </Button>
            )}
            {canCreate && (
              <Button onClick={() => { setEditItem(null); setShowForm(true); }} size="sm">
                <PlusIcon className="w-4 h-4" />
                Adicionar
              </Button>
            )}
          </div>
        }
      />

      <StockFormModal
        open={showForm}
        onClose={() => { setShowForm(false); setEditItem(null); }}
        onSave={handleSave}
        item={editItem}
        saving={saving}
        team={activeTeam}
        sourceItems={codeSourceItems}
      />

      <PrepararModal
        open={showPreparar}
        onClose={() => setShowPreparar(false)}
        onConfirm={handlePreparar}
        count={reservaCount}
        saving={preparing}
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

function StockFormModal({ open, onClose, onSave, item, saving, team, sourceItems }: {
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<StockItem>) => void;
  item: StockItem | null;
  saving: boolean;
  team: RanchoTeam;
  sourceItems: CodeSourceItem[];
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("SUPRIMENTOS");
  const [unit, setUnit] = useState("UN");
  // Strings para aceitar vírgula (ex.: "1,5"); convertidas no submit.
  const [quantity, setQuantity] = useState("");
  const [defaultQuantity, setDefaultQuantity] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  // Item de origem escolhido no seletor de código (só no Disponível).
  const [sourceId, setSourceId] = useState("");

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
    setSourceId("");
  }, [item, open]);

  // Disponível (EQUIPE_3) é a lista-mãe: sem "qtd atual" própria (a quantidade é a
  // soma das equipes). Cadastra-se só nome, categoria, unidade e qtd padrão.
  const isMaster = team === "EQUIPE_3";
  // Ao cadastrar no Disponível, puxar um item já existente nas equipes pelo código
  // preenche nome, categoria, unidade e qtd padrão automaticamente.
  const showCodePicker = !item && isMaster && sourceItems.length > 0;
  const selectedSource = sourceItems.find((s) => String(s.id) === sourceId) || null;

  function handlePickSource(id: string) {
    setSourceId(id);
    const src = sourceItems.find((s) => String(s.id) === id);
    if (!src) return;
    setName(src.name);
    setCategory(src.category);
    setUnit(src.unit || "UN");
    setDefaultQuantity(src.default_quantity ? formatQty(src.default_quantity) : "");
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name,
      category: category as StockItem["category"],
      unit,
      // No Disponível a quantidade própria não é usada (mostra a soma das equipes).
      quantity: isMaster ? 0 : parseDecimalBR(quantity),
      default_quantity: parseDecimalBR(defaultQuantity),
      expiry_date: expiryDate || null,
      min_quantity: 0,
    });
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Item" : "Novo Item"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {showCodePicker && (
          <div className="rounded-lg border border-teal-200 bg-teal-50/60 p-3">
            <label className="block text-sm font-medium text-text mb-1">
              Puxar item já cadastrado (das equipes)
            </label>
            <select value={sourceId} onChange={(e) => handlePickSource(e.target.value)} className={inputCls}>
              <option value="">— Item novo (digitar manualmente) —</option>
              {sourceItems.map((s) => (
                <option key={s.id} value={s.id}>{s.code} · {s.name}</option>
              ))}
            </select>
            {selectedSource ? (
              <p className="text-[11px] text-text-light mt-1.5">
                <span className="font-mono">{selectedSource.code}</span> · {selectedSource.name} — já em{" "}
                {selectedSource.teams.map(ranchoTeamLabel).join(", ")}
                {selectedSource.default_quantity
                  ? ` · padrão ${formatQty(selectedSource.default_quantity)} ${unitSuffix(selectedSource.unit)}`
                  : ""}
              </p>
            ) : (
              <p className="text-[11px] text-text-light mt-1.5">
                Selecione um código das equipes para puxar nome, categoria e unidade — ou deixe em branco para cadastrar um item novo.
              </p>
            )}
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-text mb-1">Nome *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} />
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
          {selectedSource ? (
            // Item já cadastrado: unidade é fixa do produto, não se escolhe de novo
            // (evita trocar por acidente e ficar "arroz em un" quando é fardo).
            <div className={`${inputCls} bg-gray-100 text-text-light flex items-center justify-between`}>
              <span>{STOCK_UNITS.find((u) => u.value === unit)?.label ?? unit}</span>
              <span className="text-[11px]">definida no cadastro do item</span>
            </div>
          ) : (
            <select value={unit} onChange={(e) => setUnit(e.target.value)} className={inputCls}>
              {STOCK_UNITS.map((u) => (
                <option key={u.value} value={u.value}>{u.label}</option>
              ))}
            </select>
          )}
        </div>
        <div className={`grid ${isMaster ? "grid-cols-2" : "grid-cols-3"} gap-4`}>
          <div>
            <label className="block text-sm font-medium text-text mb-1">Qtd Padrão</label>
            <input type="text" inputMode="decimal" value={defaultQuantity} onChange={(e) => setDefaultQuantity(e.target.value)} placeholder="Ex: 10 ou 1,5" className={inputCls} />
          </div>
          {!isMaster && (
            <div>
              <label className="block text-sm font-medium text-text mb-1">Qtd Atual</label>
              <input type="text" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Ex: 1,5" className={inputCls} />
            </div>
          )}
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

// Modal do botão "Preparar" do Disponível: escolhe a equipe destino e copia os itens
// da lista-mãe com a quantidade padrão.
function PrepararModal({ open, onClose, onConfirm, count, saving }: {
  open: boolean;
  onClose: () => void;
  onConfirm: (team: "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_4") => void;
  count: number;
  saving: boolean;
}) {
  const [team, setTeam] = useState<"EQUIPE_1" | "EQUIPE_2" | "EQUIPE_4">("EQUIPE_1");

  useEffect(() => { if (open) setTeam("EQUIPE_1"); }, [open]);

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";

  return (
    <Modal open={open} onClose={onClose} title="Preparar suprimentos do Disponível">
      <div className="space-y-4">
        <p className="text-sm text-text-light">
          Copia os <strong>{count}</strong> {count === 1 ? "item" : "itens"} do Disponível para a equipe escolhida,
          usando a <strong>quantidade padrão</strong> de cada um. Itens com o mesmo nome na equipe são atualizados;
          os que faltam são criados.
        </p>
        <div>
          <label className="block text-sm font-medium text-text mb-1">Equipe destino</label>
          <select value={team} onChange={(e) => setTeam(e.target.value as "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_4")} className={inputCls}>
            <option value="EQUIPE_1">Equipe 1</option>
            <option value="EQUIPE_2">Equipe 2</option>
            <option value="EQUIPE_4">Equipe Turbo</option>
          </select>
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="button" onClick={() => onConfirm(team)} disabled={saving || count === 0}>
            {saving ? "Preparando..." : "Preparar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
