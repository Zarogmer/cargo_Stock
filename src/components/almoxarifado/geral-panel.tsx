"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission, canViewStockValue, type Module } from "@/lib/rbac";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { PlusIcon } from "@/components/icons";
import { matchSearch, parseDecimalBR, formatQty, formatCurrency, normalize } from "@/lib/utils";
import type { StockItem, MaterialTeamAllocation } from "@/types/database";

// Aba "Geral" do Almoxarifado: uma tabela única com TODOS os itens de todos os
// setores (materiais + rancho), mostrando onde cada um está (coluna Setor) e a
// divisão por equipe. Vale a relação Total = Disponível + Equipe 1 + Equipe 2 +
// Turbo nos dois modelos:
//   • Materiais (GALPAO/FLUIDOS/MAQUINARIO/FERRAMENTA/ELETRICA): Total =
//     stock_items.quantity; Disponível = Total − alocações; equipe =
//     material_team_allocations. Edita Total e cada equipe; Disponível é
//     calculado.
//   • Rancho (uma linha stock_items por equipe; EQUIPE_3 = galpão/Disponível):
//     Disponível = linha EQUIPE_3; equipe = linha da equipe; Total = soma. Edita
//     Disponível e cada equipe; Total é calculado.
// Cada célula editável grava UM valor absoluto no banco (previsível). Mudança de
// quantidade de estoque (Total de material, Disponível/equipe do rancho) também
// registra movimento no histórico; alocação de material não gera movimento
// (igual ao resto do Almoxarifado).

const MATERIAL_KINDS = ["GALPAO", "FLUIDOS", "MAQUINARIO", "FERRAMENTA", "ELETRICA"] as const;
const RANCHO_TEAMS = ["EQUIPE_1", "EQUIPE_2", "EQUIPE_3", "EQUIPE_4"] as const;
const DISPONIVEL_RANCHO = "EQUIPE_3";

// Ordem e rótulo dos setores (igual às abas: Utensílios, Rancho, Fluídos, ...).
const SETORES: { key: string; label: string; chip: string }[] = [
  { key: "GALPAO", label: "Utensílios", chip: "bg-slate-100 text-slate-700" },
  { key: "RANCHO", label: "Rancho", chip: "bg-amber-100 text-amber-800" },
  { key: "FLUIDOS", label: "Fluídos", chip: "bg-cyan-100 text-cyan-800" },
  { key: "MAQUINARIO", label: "Maquinário", chip: "bg-indigo-100 text-indigo-800" },
  { key: "FERRAMENTA", label: "Ferramenta", chip: "bg-orange-100 text-orange-800" },
  { key: "ELETRICA", label: "Elétrica", chip: "bg-purple-100 text-purple-800" },
];
const SETOR_INFO = new Map(SETORES.map((s, i) => [s.key, { ...s, order: i }]));

// Setor → módulo de permissão (edição). Rancho e materiais do galpão/fluídos
// usam ESTOQUE; os demais têm módulo próprio (ver materiais-panel.tsx).
const SETOR_MODULE: Record<string, Module> = {
  GALPAO: "ESTOQUE", FLUIDOS: "ESTOQUE", MAQUINARIO: "MAQUINARIO",
  FERRAMENTA: "FERRAMENTAS", ELETRICA: "ELETRICA", RANCHO: "ESTOQUE",
};

// Equipes reais (colunas). EQUIPE_4 = Turbo.
const TEAM_COLS: { key: "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_4"; label: string }[] = [
  { key: "EQUIPE_1", label: "Equipe 1" },
  { key: "EQUIPE_2", label: "Equipe 2" },
  { key: "EQUIPE_4", label: "Equipe Turbo" },
];

type TeamKey = "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_4";
type ColKey = "TOTAL" | "DISP" | TeamKey;
type TeamView = "TODOS" | "DISP" | TeamKey;
// Origem/destino de transferência: Disponível ou uma equipe (sem "Todos").
type XferView = "DISP" | TeamKey;

// Opções de origem/destino no modal Transferir (Geral é por equipe: manda de
// uma equipe/Disponível pra outra, valendo pra material e pro rancho).
const XFER_VIEWS: { key: XferView; label: string }[] = [
  { key: "DISP", label: "Disponível" },
  { key: "EQUIPE_1", label: "Equipe 1" },
  { key: "EQUIPE_2", label: "Equipe 2" },
  { key: "EQUIPE_4", label: "Equipe Turbo" },
];
const XFER_LABEL: Record<string, string> = Object.fromEntries(XFER_VIEWS.map((v) => [v.key, v.label]));

// Abas de visão por equipe (mesmo estilo do resto do Almoxarifado). "Todos" é o
// padrão (Geral = tudo); as demais filtram as linhas pra quem tem quantidade
// naquela equipe/Disponível. O setor já vem das abas de cima e da coluna Setor.
const VIEW_TABS: { key: TeamView; label: string; emoji: string; activeCls: string }[] = [
  { key: "TODOS", label: "Todos", emoji: "🗂️", activeCls: "bg-primary text-white shadow-md" },
  { key: "DISP", label: "Disponível", emoji: "📦", activeCls: "bg-teal-600 text-white shadow-md" },
  { key: "EQUIPE_1", label: "Equipe 1", emoji: "🚢", activeCls: "bg-blue-600 text-white shadow-md" },
  { key: "EQUIPE_2", label: "Equipe 2", emoji: "🚢", activeCls: "bg-purple-600 text-white shadow-md" },
  { key: "EQUIPE_4", label: "Equipe Turbo", emoji: "🔥", activeCls: "bg-orange-600 text-white shadow-md" },
];

interface Row {
  key: string;
  name: string;
  setor: string;      // sentinela (GALPAO/.../RANCHO)
  setorLabel: string;
  unit: string | null;
  total: number;
  disp: number;
  teams: Record<TeamKey, number>;
  // refs pra gravação
  kind: "MAT" | "RANCHO";
  matItem?: StockItem;
  ranchoRows?: Partial<Record<string, StockItem>>; // team -> linha
}

export function GeralPanel() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const [items, setItems] = useState<StockItem[]>([]);
  const [allocs, setAllocs] = useState<MaterialTeamAllocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [teamView, setTeamView] = useState<TeamView>("TODOS");
  const [saving, setSaving] = useState(false);
  // Linha cujo botão "Transferir" foi clicado — abre o modal de transferência.
  const [transferRow, setTransferRow] = useState<Row | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const role = profile?.role || "RH";
  const canSeeValue = canViewStockValue(role);
  const canEditSetor = useCallback(
    (setor: string) => hasPermission(role, SETOR_MODULE[setor] || "ESTOQUE", "edit"),
    [role],
  );
  // Setores em que o usuário pode CRIAR item (alimenta o seletor do "Adicionar").
  const creatableSetores = useMemo(
    () => SETORES.filter((s) => hasPermission(role, SETOR_MODULE[s.key] || "ESTOQUE", "create")),
    [role],
  );

  const loadItems = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      const { data, error } = await db.from("stock_items").select("*").order("name", { ascending: true });
      if (error) {
        console.error("DB stock_items error:", error);
        setDbError(`${error.code}: ${error.message} — ${error.hint || ""}`);
      }
      const list = (data as StockItem[]) || [];
      setItems(list);
      const matIds = list.filter((i) => MATERIAL_KINDS.includes(i.team as never)).map((i) => i.id);
      if (matIds.length > 0) {
        const { data: al } = await db.from("material_team_allocations").select("*").in("stock_item_id", matIds);
        setAllocs((al as MaterialTeamAllocation[]) || []);
      } else {
        setAllocs([]);
      }
    } catch (err) {
      console.error("Erro ao carregar itens:", err);
      setDbError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadItems(); }, [loadItems, pathname]);

  // Alocação por (item, equipe).
  const allocOf = useCallback(
    (id: number, team: string) =>
      allocs.filter((a) => a.stock_item_id === id && a.team === team).reduce((s, a) => s + (a.quantity || 0), 0),
    [allocs],
  );

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];

    // Materiais: uma linha por item.
    for (const it of items) {
      if (!MATERIAL_KINDS.includes(it.team as never)) continue;
      const e1 = allocOf(it.id, "EQUIPE_1");
      const e2 = allocOf(it.id, "EQUIPE_2");
      const e4 = allocOf(it.id, "EQUIPE_4");
      const total = Number(it.quantity) || 0;
      const disp = Math.max(0, +(total - (e1 + e2 + e4)).toFixed(3));
      out.push({
        key: `mat-${it.id}`, name: it.name, setor: it.team as string,
        setorLabel: SETOR_INFO.get(it.team as string)?.label || (it.team as string),
        unit: it.unit, total, disp, teams: { EQUIPE_1: e1, EQUIPE_2: e2, EQUIPE_4: e4 },
        kind: "MAT", matItem: it,
      });
    }

    // Rancho: agrupa por nome (linha-mãe EQUIPE_3 + linhas das equipes).
    const ranchoByName = new Map<string, Partial<Record<string, StockItem>>>();
    for (const it of items) {
      if (!RANCHO_TEAMS.includes(it.team as never)) continue;
      const k = normalize(it.name);
      if (!ranchoByName.has(k)) ranchoByName.set(k, {});
      ranchoByName.get(k)![it.team as string] = it;
    }
    for (const group of ranchoByName.values()) {
      const rep = group[DISPONIVEL_RANCHO] || group.EQUIPE_1 || group.EQUIPE_2 || group.EQUIPE_4;
      if (!rep) continue;
      const disp = Number(group[DISPONIVEL_RANCHO]?.quantity) || 0;
      const e1 = Number(group.EQUIPE_1?.quantity) || 0;
      const e2 = Number(group.EQUIPE_2?.quantity) || 0;
      const e4 = Number(group.EQUIPE_4?.quantity) || 0;
      out.push({
        key: `rancho-${rep.id}`, name: rep.name, setor: "RANCHO", setorLabel: "Rancho",
        unit: rep.unit, total: +(disp + e1 + e2 + e4).toFixed(3), disp,
        teams: { EQUIPE_1: e1, EQUIPE_2: e2, EQUIPE_4: e4 },
        kind: "RANCHO", ranchoRows: group,
      });
    }

    out.sort((a, b) => {
      const so = (SETOR_INFO.get(a.setor)?.order ?? 99) - (SETOR_INFO.get(b.setor)?.order ?? 99);
      return so !== 0 ? so : a.name.localeCompare(b.name, "pt-BR");
    });
    return out;
  }, [items, allocOf]);

  const filtered = rows.filter((r) => {
    if (teamView === "DISP" && r.disp <= 0) return false;
    if ((teamView === "EQUIPE_1" || teamView === "EQUIPE_2" || teamView === "EQUIPE_4") && r.teams[teamView] <= 0) return false;
    return matchSearch(r.name, search) || matchSearch(r.setorLabel, search);
  });

  const viewCount = (key: TeamView) =>
    key === "TODOS" ? rows.length
      : key === "DISP" ? rows.filter((r) => r.disp > 0).length
        : rows.filter((r) => r.teams[key] > 0).length;

  // ── Gravação de uma célula (valor absoluto) ───────────────────────────────
  async function commitEdit(row: Row, col: ColKey, value: number) {
    const abs = Math.max(0, Math.round(value * 1000) / 1000);
    const actor = profile?.full_name || "Sistema";
    const today = new Date().toISOString().split("T")[0];
    const logMove = async (stockItemId: number, from: number, to: number, ctx: string) => {
      const diff = +(to - from).toFixed(3);
      if (diff === 0) return;
      await db.from("stock_movements").insert({
        stock_item_id: stockItemId,
        movement_type: diff > 0 ? "AJUSTE" : "BAIXA",
        quantity: Math.abs(diff),
        movement_date: today,
        notes: `Aba Geral: ${ctx} ${from} → ${to}`,
        created_by: actor,
      } as Record<string, unknown>);
    };

    setSaving(true);
    try {
      if (row.kind === "MAT" && row.matItem) {
        const it = row.matItem;
        if (col === "TOTAL") {
          if (abs === row.total) return;
          await logMove(it.id, row.total, abs, "Total");
          await db.from("stock_items").update({ quantity: abs, updated_by: actor } as Record<string, unknown>).eq("id", it.id);
        } else if (col === "EQUIPE_1" || col === "EQUIPE_2" || col === "EQUIPE_4") {
          if (abs === row.teams[col]) return;
          const existing = allocs.find((a) => a.stock_item_id === it.id && a.team === col);
          if (existing) {
            await db.from("material_team_allocations").update({ quantity: abs, updated_by: actor } as Record<string, unknown>).eq("id", existing.id);
          } else if (abs > 0) {
            await db.from("material_team_allocations").insert({ stock_item_id: it.id, team: col, quantity: abs, updated_by: actor } as Record<string, unknown>);
          }
        }
        // DISP em material é calculado — não edita.
      } else if (row.kind === "RANCHO" && row.ranchoRows) {
        const team = col === "DISP" ? DISPONIVEL_RANCHO : col;
        if (team === "TOTAL") return; // Total do rancho é calculado
        const cur = col === "DISP" ? row.disp : row.teams[col as TeamKey];
        if (abs === cur) return;
        const existing = row.ranchoRows[team];
        if (existing) {
          await logMove(existing.id, Number(existing.quantity) || 0, abs, `${team === DISPONIVEL_RANCHO ? "Disponível" : team}`);
          await db.from("stock_items").update({ quantity: abs, updated_by: actor } as Record<string, unknown>).eq("id", existing.id);
        } else if (abs > 0) {
          // Cria a linha da equipe/galpão a partir de qualquer linha existente do alimento.
          const mother = row.ranchoRows[DISPONIVEL_RANCHO] || row.ranchoRows.EQUIPE_1 || row.ranchoRows.EQUIPE_2 || row.ranchoRows.EQUIPE_4;
          await db.from("stock_items").insert({
            name: mother?.name ?? row.name,
            category: mother?.category ?? "SUPRIMENTOS",
            unit: mother?.unit ?? "UN",
            quantity: abs,
            default_quantity: mother?.default_quantity ?? 0,
            min_quantity: 0,
            team,
            updated_by: actor,
          } as Record<string, unknown>);
        }
      }
      await loadItems();
    } finally {
      setSaving(false);
    }
  }

  // Quantidade atual de uma linha numa visão (Disponível ou equipe).
  const qtyOfView = (row: Row, v: XferView) => (v === "DISP" ? row.disp : row.teams[v]);

  // ── Transferência entre equipes/Disponível (não muda o Total) ─────────────
  // Material: Disponível é implícito (Total − alocações), então mover pra/de
  // Disponível é só ajustar a alocação da equipe. Rancho: cada equipe é uma
  // linha stock_items; move a quantidade entre elas (cria a linha se faltar).
  // Transferir é redistribuição, não movimento de estoque — não gera histórico.
  async function handleTransfer(row: Row, from: XferView, to: XferView, rawQty: number) {
    const avail = qtyOfView(row, from);
    const qty = Math.min(Math.max(rawQty, 0), avail);
    if (qty <= 0 || from === to) { setTransferRow(null); return; }
    const actor = profile?.full_name || "Sistema";
    setSaving(true);
    try {
      if (row.kind === "MAT" && row.matItem) {
        const it = row.matItem;
        const setMatAlloc = async (team: TeamKey, absQty: number) => {
          const clamped = Math.max(0, +absQty.toFixed(3));
          const existing = allocs.find((a) => a.stock_item_id === it.id && a.team === team);
          if (existing) {
            await db.from("material_team_allocations").update({ quantity: clamped, updated_by: actor } as Record<string, unknown>).eq("id", existing.id);
          } else if (clamped > 0) {
            await db.from("material_team_allocations").insert({ stock_item_id: it.id, team, quantity: clamped, updated_by: actor } as Record<string, unknown>);
          }
        };
        if (from !== "DISP") await setMatAlloc(from, row.teams[from] - qty);
        if (to !== "DISP") await setMatAlloc(to, row.teams[to] + qty);
      } else if (row.kind === "RANCHO" && row.ranchoRows) {
        const setRanchoQty = async (view: XferView, absQty: number) => {
          const team = view === "DISP" ? DISPONIVEL_RANCHO : view;
          const clamped = Math.max(0, +absQty.toFixed(3));
          const existing = row.ranchoRows![team];
          if (existing) {
            await db.from("stock_items").update({ quantity: clamped, updated_by: actor } as Record<string, unknown>).eq("id", existing.id);
          } else if (clamped > 0) {
            const mother = row.ranchoRows![DISPONIVEL_RANCHO] || row.ranchoRows!.EQUIPE_1 || row.ranchoRows!.EQUIPE_2 || row.ranchoRows!.EQUIPE_4;
            await db.from("stock_items").insert({
              name: mother?.name ?? row.name,
              category: mother?.category ?? "SUPRIMENTOS",
              unit: mother?.unit ?? "UN",
              quantity: clamped,
              default_quantity: mother?.default_quantity ?? 0,
              min_quantity: 0,
              team,
              updated_by: actor,
            } as Record<string, unknown>);
          }
        };
        await setRanchoQty(from, qtyOfView(row, from) - qty);
        await setRanchoQty(to, qtyOfView(row, to) + qty);
      }
      await loadItems();
    } finally {
      setSaving(false);
      setTransferRow(null);
    }
  }

  // ── Cadastro de item novo (Geral pergunta o setor) ────────────────────────
  // Material: 1 linha stock_items com team = setor; a quantidade entra no galpão
  // (Total, Disponível calculado). Rancho: 1 linha com team = EQUIPE_3 (a linha
  // Disponível/galpão do alimento). Registra ENTRADA no histórico.
  async function handleAdd(data: { setor: string; name: string; quantity: number; padrao: number; unitValue: number; notes: string | null }) {
    const actor = profile?.full_name || "Sistema";
    const today = new Date().toISOString().split("T")[0];
    setSaving(true);
    try {
      const isRancho = data.setor === "RANCHO";
      const payload: Record<string, unknown> = {
        name: data.name,
        quantity: data.quantity,
        notes: data.notes,
        updated_by: actor,
      };
      if (isRancho) {
        payload.category = "SUPRIMENTOS";
        payload.unit = "UN";
        payload.team = DISPONIVEL_RANCHO;
        payload.default_quantity = data.padrao;
        payload.min_quantity = 0;
      } else {
        payload.category = "OUTROS";
        payload.team = data.setor;
        payload.min_quantity = Math.round(data.padrao);
      }
      if (canSeeValue && data.unitValue > 0) payload.unit_value = data.unitValue;

      const insRes = (await db.from("stock_items").insert(payload)) as { data: { id?: number } | { id?: number }[] | null };
      const created = Array.isArray(insRes.data) ? insRes.data[0] : insRes.data;
      if (created?.id && data.quantity > 0) {
        await db.from("stock_movements").insert({
          stock_item_id: created.id,
          movement_type: "ENTRADA",
          quantity: data.quantity,
          movement_date: today,
          notes: "Cadastro do item na aba Geral",
          created_by: actor,
        } as Record<string, unknown>);
      }
      await loadItems();
    } finally {
      setSaving(false);
      setShowAdd(false);
    }
  }

  const editable = (row: Row, col: ColKey) => {
    if (!canEditSetor(row.setor)) return false;
    if (row.kind === "MAT") return col !== "DISP"; // Disponível calculado
    return col !== "TOTAL"; // Rancho: Total calculado
  };

  const cell = (row: Row, col: ColKey, value: number, strong = false) => {
    if (!editable(row, col)) {
      return <span className={`tabular-nums ${strong ? "font-semibold text-text" : "text-text-light"}`}>{formatQty(value)}</span>;
    }
    return <EditableNum value={value} onCommit={(v) => commitEdit(row, col, v)} disabled={saving} strong={strong} />;
  };

  // Colunas fixas + colunas de quantidade que dependem da aba: em "Todos" mostra
  // o quadro completo (Total/Disponível/equipes); numa aba específica mostra só a
  // quantidade daquela visão (uma coluna), igual aos painéis por setor.
  const baseCols = [
    { key: "name", label: "Item", render: (r: Row) => <span className="font-medium">{r.name}</span> },
    {
      key: "setor", label: "Setor",
      render: (r: Row) => {
        const chip = SETOR_INFO.get(r.setor)?.chip || "bg-gray-100 text-gray-700";
        return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${chip}`}>{r.setorLabel}</span>;
      },
    },
  ];
  const qtyCols =
    teamView === "TODOS"
      ? [
          { key: "total", label: "Total", render: (r: Row) => cell(r, "TOTAL", r.total, true) },
          { key: "disp", label: "Disponível", render: (r: Row) => cell(r, "DISP", r.disp) },
          ...TEAM_COLS.map((t) => ({
            key: t.key, label: t.label, render: (r: Row) => cell(r, t.key, r.teams[t.key]),
          })),
        ]
      : teamView === "DISP"
        ? [{ key: "disp", label: "Disponível", render: (r: Row) => cell(r, "DISP", r.disp, true) }]
        : [{
            key: teamView,
            label: VIEW_TABS.find((v) => v.key === teamView)?.label || teamView,
            render: (r: Row) => cell(r, teamView, r.teams[teamView], true),
          }];
  // Coluna de ação: botão Transferir (Geral é por equipe — manda de uma
  // equipe/Disponível pra outra). Só aparece pra quem pode editar aquele setor.
  const canEditAny = SETORES.some((s) => canEditSetor(s.key));
  const actionsCol = {
    key: "actions",
    label: "",
    className: "w-14",
    render: (r: Row) =>
      canEditSetor(r.setor) ? (
        <button
          onClick={(e) => { e.stopPropagation(); setTransferRow(r); }}
          disabled={r.total <= 0}
          className="p-1.5 text-teal-600 hover:bg-teal-50 rounded disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          title="Transferir entre equipes/Disponível"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m4 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
        </button>
      ) : null,
  };
  const columns = canEditAny ? [...baseCols, ...qtyCols, actionsCol] : [...baseCols, ...qtyCols];

  return (
    <div className="space-y-4">
      {dbError && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 font-mono break-all">
          ⚠️ Erro ao carregar dados: {dbError}
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        {VIEW_TABS.map((t) => {
          const count = viewCount(t.key);
          return (
            <button
              key={t.key}
              onClick={() => setTeamView(t.key)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${teamView === t.key ? t.activeCls : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {t.emoji} {t.label}{count > 0 ? ` (${count})` : ""}
            </button>
          );
        })}
      </div>

      <p className="text-xs text-text-light">
        <strong>Total</strong> = Disponível + Equipe 1 + Equipe 2 + Turbo. Em materiais o Disponível é calculado
        (Total − equipes); no Rancho o Total é calculado (soma). Clique numa célula pra editar.
      </p>

      <DataTable
        columns={columns}
        data={filtered}
        loading={loading}
        keyExtractor={(r) => r.key}
        emptyMessage="Nenhum item encontrado"
        mobileCards
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar item ou setor..."
        actions={creatableSetores.length > 0 ? (
          <Button onClick={() => setShowAdd(true)} size="sm">
            <PlusIcon className="w-4 h-4" />
            Adicionar
          </Button>
        ) : undefined}
      />

      <GeralTransferModal
        row={transferRow}
        initialFrom={teamView === "TODOS" || teamView === "DISP" ? "DISP" : teamView}
        onClose={() => setTransferRow(null)}
        onTransfer={handleTransfer}
        saving={saving}
      />

      <GeralAddModal
        open={showAdd}
        setores={creatableSetores}
        showValue={canSeeValue}
        allNames={rows.map((r) => ({ name: r.name, setor: r.setor }))}
        onClose={() => setShowAdd(false)}
        onSave={handleAdd}
        saving={saving}
      />
    </div>
  );
}

// Modal de transferência da aba Geral: manda uma quantidade de uma ORIGEM
// (Disponível ou equipe) pra um DESTINO. Vale pra material e rancho — o handler
// decide como gravar. A origem começa na aba de visão atual.
function GeralTransferModal({ row, initialFrom, onClose, onTransfer, saving }: {
  row: Row | null;
  initialFrom: XferView;
  onClose: () => void;
  onTransfer: (row: Row, from: XferView, to: XferView, qty: number) => void;
  saving: boolean;
}) {
  const [from, setFrom] = useState<XferView>(initialFrom);
  const [to, setTo] = useState<XferView>("DISP");
  const [qty, setQty] = useState("");

  const qtyOf = (r: Row, v: XferView) => (v === "DISP" ? r.disp : r.teams[v]);
  const avail = row ? qtyOf(row, from) : 0;

  // Ao (re)abrir: origem = aba atual; destino = primeira opção diferente da
  // origem; quantidade = tudo que há na origem.
  useEffect(() => {
    if (!row) return;
    const f = initialFrom;
    const firstTo = XFER_VIEWS.map((v) => v.key).find((k) => k !== f) || "DISP";
    setFrom(f);
    setTo(firstTo);
    setQty(formatQty(qtyOf(row, f)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row, initialFrom]);

  if (!row) return null;
  const parsed = parseDecimalBR(qty);
  const valid = parsed > 0 && parsed <= avail + 1e-9 && from !== to;
  const leftover = valid ? +(avail - parsed).toFixed(3) : avail;
  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";
  const destinos = XFER_VIEWS.map((v) => v.key).filter((k) => k !== from);

  const chip = (active: boolean) =>
    `px-3 py-1.5 rounded-lg border text-xs font-medium transition ${active ? "bg-primary text-white border-primary" : "border-border text-text-light hover:bg-gray-50"}`;

  return (
    <Modal open={!!row} onClose={onClose} title="Transferir entre equipes">
      <form
        onSubmit={(e) => { e.preventDefault(); if (valid) onTransfer(row, from, to, parsed); }}
        className="space-y-4"
      >
        <div className="rounded-lg border border-border bg-gray-50 px-3 py-2 text-sm">
          <p className="font-medium text-text">
            {row.name}
            <span className="ml-2 text-xs text-text-light">{row.setorLabel}</span>
          </p>
          <p className="text-xs text-text-light mt-0.5">Total do item {formatQty(row.total)}</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">De</label>
          <div className="flex gap-1 flex-wrap">
            {XFER_VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => { setFrom(v.key); if (to === v.key) setTo(XFER_VIEWS.map((x) => x.key).find((k) => k !== v.key) || "DISP"); }}
                className={chip(from === v.key)}
              >
                {v.label} ({formatQty(qtyOf(row, v.key))})
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">Para</label>
          <div className="flex gap-1 flex-wrap">
            {destinos.map((d) => (
              <button key={d} type="button" onClick={() => setTo(d)} className={chip(to === d)}>
                {XFER_LABEL[d]}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">Quantidade</label>
          <input type="text" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus className={inputCls} />
          <div className="mt-1.5 flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[11px] text-text-light">
              {valid
                ? <>Ficam <strong>{formatQty(leftover)}</strong> em {XFER_LABEL[from]}; vão <strong>{formatQty(parsed)}</strong> pra {XFER_LABEL[to]}.</>
                : <span className="text-amber-700">Informe um valor entre 1 e {formatQty(avail)}.</span>}
            </p>
            {avail > 0 && (
              <button type="button" onClick={() => setQty(formatQty(avail))} className="text-[11px] font-medium text-primary hover:underline">
                Tudo ({formatQty(avail)})
              </button>
            )}
          </div>
        </div>

        <div className="flex gap-3 justify-end pt-1">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={!valid || saving}>{saving ? "Transferindo..." : "Transferir"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// Modal de cadastro na aba Geral: como a Geral é por equipe (e não por setor), o
// primeiro campo é o SETOR — aí o item vai pro estoque certo (Utensílios,
// Rancho, Fluídos, ...). A quantidade entra no galpão/Disponível.
function GeralAddModal({ open, setores, showValue, allNames, onClose, onSave, saving }: {
  open: boolean;
  setores: { key: string; label: string }[];
  showValue: boolean;
  allNames: { name: string; setor: string }[];
  onClose: () => void;
  onSave: (data: { setor: string; name: string; quantity: number; padrao: number; unitValue: number; notes: string | null }) => void;
  saving: boolean;
}) {
  const [setor, setSetor] = useState(setores[0]?.key || "GALPAO");
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [padrao, setPadrao] = useState("");
  const [unitValue, setUnitValue] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (open) {
      setSetor(setores[0]?.key || "GALPAO");
      setName(""); setQuantity(""); setPadrao(""); setUnitValue(""); setNotes("");
    }
  }, [open, setores]);

  const trimmed = name.trim();
  const duplicate = trimmed
    ? allNames.find((n) => n.setor === setor && normalize(n.name) === normalize(trimmed)) || null
    : null;
  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    onSave({
      setor,
      name: trimmed,
      quantity: parseDecimalBR(quantity),
      padrao: parseDecimalBR(padrao),
      unitValue: parseDecimalBR(unitValue),
      notes: notes.trim() || null,
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="Novo item">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-text mb-1">Setor *</label>
          <select value={setor} onChange={(e) => setSetor(e.target.value)} className={inputCls}>
            {setores.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-text-light">Onde o item fica guardado no Almoxarifado — a quantidade entra no Disponível.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-text mb-1">Nome *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} />
          {duplicate && (
            <p className="mt-1 text-[11px] text-amber-700">
              ⚠️ Já existe <strong>{duplicate.name}</strong> nesse setor — confira antes de cadastrar de novo.
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text mb-1">Padrão <span className="text-text-light font-normal">(opcional)</span></label>
            <input type="text" inputMode="decimal" value={padrao} onChange={(e) => setPadrao(e.target.value)} placeholder="0 = sem padrão" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium text-text mb-1">Quantidade Atual</label>
            <input type="text" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Ex: 8" className={inputCls} />
          </div>
        </div>
        {showValue && (
          <div>
            <label className="block text-sm font-medium text-text mb-1">Valor Unitário <span className="text-text-light font-normal">(R$, opcional)</span></label>
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
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${inputCls} resize-none`} />
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving || !trimmed}>{saving ? "Salvando..." : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// Célula numérica editável: mostra o valor; ao clicar vira input; grava no blur
// ou Enter (Esc cancela). Aceita vírgula (parseDecimalBR).
function EditableNum({ value, onCommit, disabled, strong }: {
  value: number;
  onCommit: (v: number) => void;
  disabled: boolean;
  strong?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  function start() {
    if (disabled) return;
    setDraft(formatQty(value));
    setEditing(true);
  }
  function commit() {
    setEditing(false);
    const parsed = parseDecimalBR(draft);
    if (!Number.isFinite(parsed) || parsed === value) return;
    onCommit(parsed);
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={start}
        className={`tabular-nums text-left px-1.5 py-0.5 -mx-1.5 rounded hover:bg-primary/10 hover:ring-1 hover:ring-primary/30 transition ${strong ? "font-semibold text-text" : "text-teal-700"}`}
        title="Clique pra editar"
      >
        {formatQty(value)}
      </button>
    );
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      autoFocus
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
      }}
      className="w-16 px-1.5 py-0.5 border border-primary rounded text-sm tabular-nums focus:ring-2 focus:ring-primary outline-none"
    />
  );
}
