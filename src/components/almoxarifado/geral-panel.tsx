"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission, type Module } from "@/lib/rbac";
import { DataTable } from "@/components/ui/data-table";
import { matchSearch, parseDecimalBR, formatQty, normalize } from "@/lib/utils";
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

  const role = profile?.role || "RH";
  const canEditSetor = useCallback(
    (setor: string) => hasPermission(role, SETOR_MODULE[setor] || "ESTOQUE", "edit"),
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
  const columns = [...baseCols, ...qtyCols];

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
      />
    </div>
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
