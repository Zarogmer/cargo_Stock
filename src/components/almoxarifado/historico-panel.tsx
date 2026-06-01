"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { db } from "@/lib/db";
import { DataTable } from "@/components/ui/data-table";
import { formatDateTime, matchSearch, MOVEMENT_TYPE_LABELS } from "@/lib/utils";

// Histórico unificado de movimentações do Almoxarifado: entregas/devoluções de
// EPI e Uniforme (epi_movements / uniform_movements) + movimentações de
// Ferramentas/Maquinário (tool_movements). Filtro por tipo no topo.
type HistRow = Record<string, unknown> & {
  id: number;
  source: "EPI" | "Uniforme" | "Ferramentas" | "Maquinário";
  item_name: string;
  employee_name: string;
  movement_type: string;
  quantity: number | null;
  created_at: string;
};

const FILTERS = ["Todos", "EPI", "Uniforme", "Ferramentas", "Maquinário"] as const;

const SOURCE_COLORS: Record<HistRow["source"], string> = {
  EPI: "bg-blue-100 text-blue-700",
  Uniforme: "bg-purple-100 text-purple-700",
  Ferramentas: "bg-amber-100 text-amber-700",
  "Maquinário": "bg-teal-100 text-teal-700",
};

export function HistoricoPanel() {
  const pathname = usePathname();
  const [rows, setRows] = useState<HistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("Todos");

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [epiRes, uniRes, toolRes] = await Promise.all([
        db.from("epi_movements").select("*, epis(name)").order("created_at", { ascending: false }).limit(100),
        db.from("uniform_movements").select("*, uniforms(name)").order("created_at", { ascending: false }).limit(100),
        db.from("tool_movements").select("*, tools(name, asset_type)").order("created_at", { ascending: false }).limit(100),
      ]);

      const combined: HistRow[] = [];
      (epiRes.data || []).forEach((m: Record<string, unknown>) => {
        const epi = m.epis as Record<string, unknown> | null;
        combined.push({ ...m, item_name: (epi?.name as string) || "—", source: "EPI" } as HistRow);
      });
      (uniRes.data || []).forEach((m: Record<string, unknown>) => {
        const uni = m.uniforms as Record<string, unknown> | null;
        combined.push({ ...m, item_name: (uni?.name as string) || "—", source: "Uniforme" } as HistRow);
      });
      (toolRes.data || []).forEach((m: Record<string, unknown>) => {
        const tool = m.tools as Record<string, unknown> | null;
        const source = tool?.asset_type === "MAQUINARIO" ? "Maquinário" : "Ferramentas";
        combined.push({ ...m, item_name: (tool?.name as string) || "—", source } as HistRow);
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

  const filtered = rows.filter((h) => {
    const nameMatch = matchSearch(h.employee_name || "", search) || matchSearch(h.item_name || "", search);
    const typeMatch = filter === "Todos" || h.source === filter;
    return nameMatch && typeMatch;
  });

  const columns = [
    { key: "source", label: "Tipo", render: (h: HistRow) => <span className={`text-xs px-2 py-0.5 rounded-full ${SOURCE_COLORS[h.source]}`}>{h.source}</span> },
    { key: "item_name", label: "Item", render: (h: HistRow) => <span className="font-medium">{h.item_name}</span> },
    { key: "employee_name", label: "Responsável", render: (h: HistRow) => h.employee_name || "—" },
    { key: "movement_type", label: "Mov.", render: (h: HistRow) => MOVEMENT_TYPE_LABELS[h.movement_type] || h.movement_type },
    { key: "quantity", label: "Qtd", hideOnMobile: true, render: (h: HistRow) => (h.quantity != null ? String(h.quantity) : "—") },
    { key: "created_at", label: "Data", hideOnMobile: true, render: (h: HistRow) => <span className="text-xs text-text-light">{formatDateTime(h.created_at)}</span> },
  ];

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        {FILTERS.map((t) => (
          <button key={t} onClick={() => setFilter(t)}
            className={`px-3 py-1.5 text-xs rounded-full font-medium transition ${filter === t ? "bg-primary text-white" : "bg-gray-100 text-text-light hover:bg-gray-200"}`}>
            {t}
          </button>
        ))}
      </div>
      <DataTable
        columns={columns}
        data={filtered}
        loading={loading}
        keyExtractor={(h) => `${h.source}-${h.id}`}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por responsável ou item..."
      />
    </div>
  );
}
