"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { db } from "@/lib/db";
import { DataTable } from "@/components/ui/data-table";
import { formatDateTime, matchSearch, MOVEMENT_TYPE_LABELS } from "@/lib/utils";

// Histórico unificado de movimentações do Almoxarifado:
//   • stock_movements  → Estoque/Rancho/Ferramenta/Elétrica/Fluídos — inclui as
//     baixas de Embarque, os créditos de Retorno, as Quebras, as entradas de
//     Compras e os ajustes manuais (a coluna Detalhe conta a história).
//   • epi_movements / uniform_movements → entregas e devoluções.
//   • tool_movements   → empréstimos de Maquinário.
// Filtros: setor, tipo de movimento, origem (Embarque/Retorno/Quebra/...) e
// período — além da busca por texto.

type Source =
  | "Estoque" | "Rancho" | "Ferramenta" | "Elétrica" | "Fluídos"
  | "EPI" | "Uniforme" | "Maquinário";

type HistRow = Record<string, unknown> & {
  id: number;
  // Tabela de origem — desambigua ids repetidos entre tabelas na key da lista.
  _tbl: "stock" | "epi" | "uni" | "tool";
  source: Source;
  item_name: string;
  employee_name: string;
  movement_type: string;
  quantity: number | null;
  notes: string | null;
  origem: string;
  created_at: string;
};

const SOURCE_FILTERS: Array<"Todos" | Source> = [
  "Todos", "Estoque", "Rancho", "EPI", "Uniforme", "Maquinário", "Ferramenta", "Elétrica", "Fluídos",
];

const SOURCE_COLORS: Record<Source, string> = {
  Estoque: "bg-sky-100 text-sky-700",
  Rancho: "bg-green-100 text-green-700",
  Ferramenta: "bg-amber-100 text-amber-700",
  "Elétrica": "bg-yellow-100 text-yellow-700",
  "Fluídos": "bg-cyan-100 text-cyan-700",
  EPI: "bg-blue-100 text-blue-700",
  Uniforme: "bg-purple-100 text-purple-700",
  "Maquinário": "bg-teal-100 text-teal-700",
};

// Setor de um stock_item pelo sentinela em `team` (ver materiais-panel.tsx).
function stockSourceOf(team: string | null | undefined): Source {
  switch ((team || "").toUpperCase()) {
    case "FERRAMENTA": return "Ferramenta";
    case "ELETRICA": return "Elétrica";
    case "FLUIDOS": return "Fluídos";
    case "MAQUINARIO": return "Maquinário";
    case "EQUIPE_1":
    case "EQUIPE_2":
    case "EQUIPE_3":
    case "EQUIPE_4": return "Rancho";
    default: return "Estoque"; // GALPAO e legados
  }
}

// Origem da movimentação, derivada do prefixo da observação (é como cada fluxo
// assina o movimento). O que não bate com nenhum prefixo conhecido vira
// "Manual" (baixas/entradas feitas à mão nas abas do Almoxarifado).
function origemOf(notes: string | null | undefined): string {
  const n = (notes || "").trim();
  if (n.startsWith("Embarque")) return "Embarque";
  if (n.startsWith("Retorno")) return "Retorno";
  if (n.startsWith("Quebra")) return "Quebra";
  if (n.startsWith("Entrada via Solicita")) return "Compras";
  return "Manual";
}

const ORIGEM_COLORS: Record<string, string> = {
  Embarque: "bg-indigo-100 text-indigo-700",
  Retorno: "bg-emerald-100 text-emerald-700",
  Quebra: "bg-red-100 text-red-700",
  Compras: "bg-orange-100 text-orange-700",
  Manual: "bg-gray-100 text-gray-600",
};

const PERIOD_OPTIONS = [
  { value: "ALL", label: "Todo o período" },
  { value: "7", label: "Últimos 7 dias" },
  { value: "30", label: "Últimos 30 dias" },
  { value: "90", label: "Últimos 90 dias" },
] as const;

export function HistoricoPanel() {
  const pathname = usePathname();
  const [rows, setRows] = useState<HistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<(typeof SOURCE_FILTERS)[number]>("Todos");
  const [movFilter, setMovFilter] = useState<string>("ALL");
  const [origemFilter, setOrigemFilter] = useState<string>("ALL");
  const [periodFilter, setPeriodFilter] = useState<string>("ALL");

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [stockRes, epiRes, uniRes, toolRes] = await Promise.all([
        db.from("stock_movements").select("*, stock_items(name, team)").order("created_at", { ascending: false }).limit(300),
        db.from("epi_movements").select("*, epis(name)").order("created_at", { ascending: false }).limit(100),
        db.from("uniform_movements").select("*, uniforms(name)").order("created_at", { ascending: false }).limit(100),
        db.from("tool_movements").select("*, tools(name, asset_type)").order("created_at", { ascending: false }).limit(100),
      ]);

      const combined: HistRow[] = [];
      (stockRes.data || []).forEach((m: Record<string, unknown>) => {
        const item = m.stock_items as { name?: string; team?: string | null } | null;
        combined.push({
          ...m,
          _tbl: "stock",
          item_name: item?.name || "—",
          employee_name: (m.created_by as string) || "—",
          source: stockSourceOf(item?.team),
          notes: (m.notes as string) || null,
          origem: origemOf(m.notes as string),
        } as HistRow);
      });
      (epiRes.data || []).forEach((m: Record<string, unknown>) => {
        const epi = m.epis as Record<string, unknown> | null;
        combined.push({ ...m, _tbl: "epi", item_name: (epi?.name as string) || "—", source: "EPI", notes: (m.notes as string) || null, origem: "—" } as HistRow);
      });
      (uniRes.data || []).forEach((m: Record<string, unknown>) => {
        const uni = m.uniforms as Record<string, unknown> | null;
        combined.push({ ...m, _tbl: "uni", item_name: (uni?.name as string) || "—", source: "Uniforme", notes: (m.notes as string) || null, origem: "—" } as HistRow);
      });
      (toolRes.data || []).forEach((m: Record<string, unknown>) => {
        const tool = m.tools as Record<string, unknown> | null;
        const source: Source = tool?.asset_type === "ELETRICA" ? "Elétrica" : tool?.asset_type === "FERRAMENTA" ? "Ferramenta" : "Maquinário";
        combined.push({ ...m, _tbl: "tool", item_name: (tool?.name as string) || "—", source, notes: (m.notes as string) || null, origem: "—" } as HistRow);
      });
      combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setRows(combined);
    } catch (err) {
      console.error("load histórico error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll, pathname]);

  // Opções dos filtros a partir do que existe nos dados carregados.
  const movOptions = useMemo(
    () => [...new Set(rows.map((h) => h.movement_type).filter(Boolean))].sort(),
    [rows],
  );
  const origemOptions = useMemo(
    () => [...new Set(rows.map((h) => h.origem).filter((o) => o && o !== "—"))].sort(),
    [rows],
  );

  const filtered = rows.filter((h) => {
    const blob = [h.employee_name, h.item_name, h.notes].filter(Boolean).join(" ");
    if (search && !matchSearch(blob, search)) return false;
    if (filter !== "Todos" && h.source !== filter) return false;
    if (movFilter !== "ALL" && h.movement_type !== movFilter) return false;
    if (origemFilter !== "ALL" && h.origem !== origemFilter) return false;
    if (periodFilter !== "ALL") {
      const cutoff = Date.now() - Number(periodFilter) * 24 * 60 * 60 * 1000;
      if (new Date(h.created_at).getTime() < cutoff) return false;
    }
    return true;
  });

  const selectCls = "text-sm border border-border rounded-lg px-3 py-1.5 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40";

  const columns = [
    { key: "item_name", label: "Item", render: (h: HistRow) => <span className="font-medium">{h.item_name}</span> },
    { key: "source", label: "Setor", render: (h: HistRow) => <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${SOURCE_COLORS[h.source]}`}>{h.source}</span> },
    {
      key: "origem", label: "Origem", hideOnMobile: true,
      render: (h: HistRow) => h.origem === "—"
        ? <span className="text-xs text-text-light">—</span>
        : <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${ORIGEM_COLORS[h.origem] || "bg-gray-100 text-gray-600"}`}>{h.origem}</span>,
    },
    { key: "movement_type", label: "Mov.", render: (h: HistRow) => MOVEMENT_TYPE_LABELS[h.movement_type] || h.movement_type },
    { key: "quantity", label: "Qtd", render: (h: HistRow) => (h.quantity != null ? String(h.quantity) : "—") },
    {
      key: "notes", label: "Detalhe", hideOnMobile: true,
      render: (h: HistRow) => (
        <span className="text-xs text-text-light block max-w-[320px] truncate" title={h.notes || undefined}>
          {h.notes || "—"}
        </span>
      ),
    },
    { key: "employee_name", label: "Responsável", hideOnMobile: true, render: (h: HistRow) => h.employee_name || "—" },
    { key: "created_at", label: "Data", hideOnMobile: true, render: (h: HistRow) => <span className="text-xs text-text-light whitespace-nowrap">{formatDateTime(h.created_at)}</span> },
  ];

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-center">
        {SOURCE_FILTERS.map((t) => (
          <button key={t} onClick={() => setFilter(t)}
            className={`px-3 py-1.5 text-xs rounded-full font-medium transition ${filter === t ? "bg-primary text-white" : "bg-gray-100 text-text-light hover:bg-gray-200"}`}>
            {t}
          </button>
        ))}
      </div>
      <div className="flex gap-2 flex-wrap items-center">
        <select value={movFilter} onChange={(e) => setMovFilter(e.target.value)} className={selectCls}>
          <option value="ALL">Todos os movimentos</option>
          {movOptions.map((m) => <option key={m} value={m}>{MOVEMENT_TYPE_LABELS[m] || m}</option>)}
        </select>
        <select value={origemFilter} onChange={(e) => setOrigemFilter(e.target.value)} className={selectCls}>
          <option value="ALL">Todas as origens</option>
          {origemOptions.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <select value={periodFilter} onChange={(e) => setPeriodFilter(e.target.value)} className={selectCls}>
          {PERIOD_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
        <span className="text-xs text-text-light">{filtered.length} movimentação(ões)</span>
      </div>
      <DataTable
        columns={columns}
        data={filtered}
        loading={loading}
        keyExtractor={(h) => `${h._tbl}-${h.id}`}
        mobileCards
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por item, responsável, navio, detalhe..."
      />
    </div>
  );
}
