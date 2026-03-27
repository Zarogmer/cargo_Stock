"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase-browser";
import { formatDateTime, MOVEMENT_TYPE_LABELS, CATEGORY_LABELS } from "@/lib/utils";

interface StockChartItem {
  name: string;
  quantity: number;
  default_quantity: number;
  category: string;
}

interface DashboardStats {
  totalStock: number;
  totalEmployees: number;
  totalTools: number;
  totalEpis: number;
}

interface RecentMovement {
  id: string;
  type: string;
  item_name: string;
  movement_type: string;
  quantity?: number;
  created_at: string;
  created_by: string;
}

interface DollarQuote {
  bid: string;
  ask: string;
  high: string;
  low: string;
  pctChange: string;
  timestamp: string;
}

export default function DashboardPage() {
  const { profile } = useAuth();
  const supabaseRef = useRef(createClient());
  const supabase = supabaseRef.current;
  const [stats, setStats] = useState<DashboardStats>({ totalStock: 0, totalEmployees: 0, totalTools: 0, totalEpis: 0 });
  const [movements, setMovements] = useState<RecentMovement[]>([]);
  const [dollar, setDollar] = useState<DollarQuote | null>(null);
  const [stockItems, setStockItems] = useState<StockChartItem[]>([]);
  const [shipsByMonth, setShipsByMonth] = useState<{ month: string; count: number }[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const [stockRes, stockFullRes, employeesRes, toolsRes, episRes] = await Promise.all([
        supabase.from("stock_items").select("id", { count: "exact", head: true }),
        supabase.from("stock_items").select("name, quantity, default_quantity, category, team"),
        supabase.from("employees").select("id", { count: "exact", head: true }),
        supabase.from("tools").select("id", { count: "exact", head: true }),
        supabase.from("epis").select("id", { count: "exact", head: true }),
      ]);

      setStats({
        totalStock: stockRes.count || 0,
        totalEmployees: employeesRes.count || 0,
        totalTools: toolsRes.count || 0,
        totalEpis: episRes.count || 0,
      });

      setStockItems((stockFullRes.data || []) as StockChartItem[]);

      // Load ships for monthly chart
      const shipsRes = await supabase.from("ships").select("arrival_date, created_at");
      const shipsData = shipsRes.data || [];
      const monthCounts: Record<string, number> = {};
      const now = new Date();
      // Last 6 months
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        monthCounts[key] = 0;
      }
      shipsData.forEach((s: any) => {
        const dateStr = s.arrival_date || s.created_at;
        if (!dateStr) return;
        const d = new Date(dateStr);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (key in monthCounts) monthCounts[key]++;
      });
      setShipsByMonth(Object.entries(monthCounts).map(([month, count]) => ({ month, count })));

      // Load recent movements from all sources
      const [stockMov, epiMov, toolMov] = await Promise.all([
        supabase.from("stock_movements").select("id, movement_type, quantity, created_at, created_by, stock_items(name)").order("created_at", { ascending: false }).limit(10),
        supabase.from("epi_movements").select("id, movement_type, quantity, created_at, created_by, epis(name)").order("created_at", { ascending: false }).limit(10),
        supabase.from("tool_movements").select("id, movement_type, created_at, created_by, tools(name)").order("created_at", { ascending: false }).limit(10),
      ]);

      const combined: RecentMovement[] = [];

      (stockMov.data || []).forEach((m: any) => {
        combined.push({
          id: `stock-${m.id}`, type: "Estoque", item_name: m.stock_items?.name || "—",
          movement_type: m.movement_type, quantity: m.quantity, created_at: m.created_at, created_by: m.created_by,
        });
      });
      (epiMov.data || []).forEach((m: any) => {
        combined.push({
          id: `epi-${m.id}`, type: "EPI", item_name: m.epis?.name || "—",
          movement_type: m.movement_type, quantity: m.quantity, created_at: m.created_at, created_by: m.created_by,
        });
      });
      (toolMov.data || []).forEach((m: any) => {
        combined.push({
          id: `tool-${m.id}`, type: "Equipamento", item_name: m.tools?.name || "—",
          movement_type: m.movement_type, created_at: m.created_at, created_by: m.created_by,
        });
      });

      combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setMovements(combined.slice(0, 20));
    } catch (err) {
      console.error("Dashboard load error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch dollar quote
  const fetchDollar = useCallback(async () => {
    try {
      const res = await fetch("https://economia.awesomeapi.com.br/json/last/USD-BRL");
      const data = await res.json();
      const usd = data.USDBRL;
      setDollar({
        bid: parseFloat(usd.bid).toFixed(2),
        ask: parseFloat(usd.ask).toFixed(2),
        high: parseFloat(usd.high).toFixed(2),
        low: parseFloat(usd.low).toFixed(2),
        pctChange: usd.pctChange,
        timestamp: usd.create_date,
      });
    } catch {
      console.error("Failed to fetch dollar quote");
    }
  }, []);

  useEffect(() => {
    loadDashboard();
    fetchDollar();
    // Refresh dollar every 5 minutes
    const interval = setInterval(fetchDollar, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadDashboard, fetchDollar]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-2">
          <span className="text-4xl animate-bounce">🚢</span>
          <span className="text-sm text-text-light animate-pulse">Carregando dashboard...</span>
        </div>
      </div>
    );
  }

  const greeting = getGreeting();
  const canSeeMovements = ["EXECUTIVO", "FINANCEIRO", "TECNOLOGIA"].includes(profile?.role || "");

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-text">{greeting}, {profile?.full_name} 👋</h1>
        <p className="text-text-light text-sm mt-0.5">
          {new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Itens no Estoque" value={stats.totalStock} icon="🛒" color="from-blue-500 to-blue-600" />
        <StatCard label="Colaboradores" value={stats.totalEmployees} icon="👷" color="from-emerald-500 to-emerald-600" />
        <StatCard label="Equipamentos" value={stats.totalTools} icon="🔧" color="from-amber-500 to-amber-600" />
        <StatCard label="EPIs" value={stats.totalEpis} icon="⛑️" color="from-purple-500 to-purple-600" />

        {/* Dollar Card */}
        <div className="col-span-2 lg:col-span-1 bg-gradient-to-br from-green-500 to-green-600 rounded-xl p-4 text-white shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-2xl">💵</span>
            {dollar && (
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                parseFloat(dollar.pctChange) >= 0 ? "bg-white/20" : "bg-red-400/30"
              }`}>
                {parseFloat(dollar.pctChange) >= 0 ? "▲" : "▼"} {dollar.pctChange}%
              </span>
            )}
          </div>
          <p className="text-2xl font-bold">
            {dollar ? `R$ ${dollar.bid}` : "—"}
          </p>
          <p className="text-green-100 text-xs mt-1">Dólar (USD/BRL)</p>
          {dollar && (
            <div className="flex gap-3 mt-2 text-xs text-green-100">
              <span>Min: R$ {dollar.low}</span>
              <span>Max: R$ {dollar.high}</span>
            </div>
          )}
        </div>
      </div>

      {/* Stock Charts - Embarque readiness per team */}
      {stockItems.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="bg-card rounded-xl shadow-sm border border-border p-5">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-3 h-3 rounded-full bg-blue-600"></span>
              <h2 className="font-semibold text-text">Equipe 1</h2>
            </div>
            <p className="text-xs text-text-light mb-4">Prontidão para embarque</p>
            <EmbarqueChart items={stockItems.filter((i) => (i as any).team === "EQUIPE_1")} />
          </div>
          <div className="bg-card rounded-xl shadow-sm border border-border p-5">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-3 h-3 rounded-full bg-purple-600"></span>
              <h2 className="font-semibold text-text">Equipe 2</h2>
            </div>
            <p className="text-xs text-text-light mb-4">Prontidão para embarque</p>
            <EmbarqueChart items={stockItems.filter((i) => (i as any).team === "EQUIPE_2")} />
          </div>
        </div>
      )}

      {/* Ships per Month Bar Chart */}
      {shipsByMonth.length > 0 && (
        <div className="bg-card rounded-xl shadow-sm border border-border p-5">
          <h2 className="font-semibold text-text mb-1">Navios por Mês</h2>
          <p className="text-xs text-text-light mb-4">Últimos 6 meses — baseado na data de chegada</p>
          <ShipsBarChart data={shipsByMonth} />
        </div>
      )}

      {/* Recent Movements - only for EXECUTIVO/FINANCEIRO/TECNOLOGIA */}
      {canSeeMovements && (
        <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-text">Movimentações Recentes</h2>
              <p className="text-xs text-text-light mt-0.5">Últimas 20 movimentações de estoque, EPI e equipamentos</p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50/80 border-b border-border">
                <tr>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-text-light uppercase tracking-wider">Módulo</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-text-light uppercase tracking-wider">Item</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-text-light uppercase tracking-wider hidden sm:table-cell">Tipo</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-text-light uppercase tracking-wider hidden md:table-cell">Qtd</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-text-light uppercase tracking-wider hidden md:table-cell">Data</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-text-light uppercase tracking-wider hidden lg:table-cell">Usuário</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {movements.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center text-text-light">
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-3xl">📋</span>
                        <p>Nenhuma movimentação registrada ainda</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  movements.map((m) => (
                    <tr key={m.id} className="hover:bg-gray-50/50 transition">
                      <td className="px-5 py-3">
                        <ModuleBadge type={m.type} />
                      </td>
                      <td className="px-5 py-3 font-medium text-text">{m.item_name}</td>
                      <td className="px-5 py-3 hidden sm:table-cell">
                        <span className="text-text-light">{MOVEMENT_TYPE_LABELS[m.movement_type] || m.movement_type}</span>
                      </td>
                      <td className="px-5 py-3 hidden md:table-cell font-medium">{m.quantity || "—"}</td>
                      <td className="px-5 py-3 hidden md:table-cell text-text-light text-xs">{formatDateTime(m.created_at)}</td>
                      <td className="px-5 py-3 hidden lg:table-cell text-text-light text-xs uppercase">{m.created_by}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Helper Components ---

function StatCard({ label, value, icon, color }: { label: string; value: number; icon: string; color: string }) {
  return (
    <div className={`bg-gradient-to-br ${color} rounded-xl p-4 text-white shadow-sm`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-2xl">{icon}</span>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      <p className="text-white/80 text-xs mt-1">{label}</p>
    </div>
  );
}

function ModuleBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    Estoque: "bg-blue-100 text-blue-700",
    EPI: "bg-purple-100 text-purple-700",
    Equipamento: "bg-amber-100 text-amber-700",
  };
  return (
    <span className={`inline-block px-2.5 py-1 text-xs rounded-full font-medium ${styles[type] || "bg-gray-100 text-gray-700"}`}>
      {type}
    </span>
  );
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

// --- Ships Bar Chart ---

function ShipsBarChart({ data }: { data: { month: string; count: number }[] }) {
  const maxCount = Math.max(...data.map((d) => d.count), 1);
  const monthNames: Record<string, string> = {
    "01": "Jan", "02": "Fev", "03": "Mar", "04": "Abr",
    "05": "Mai", "06": "Jun", "07": "Jul", "08": "Ago",
    "09": "Set", "10": "Out", "11": "Nov", "12": "Dez",
  };
  const chartHeight = 200;

  return (
    <div>
      <div className="flex">
        <div className="flex flex-col justify-between pr-2 text-right" style={{ height: chartHeight }}>
          <span className="text-[10px] text-text-light">{maxCount}</span>
          <span className="text-[10px] text-text-light">{Math.round(maxCount / 2)}</span>
          <span className="text-[10px] text-text-light">0</span>
        </div>
        <div className="flex-1 relative border-l border-b border-gray-200" style={{ height: chartHeight }}>
          <div className="flex items-end justify-around h-full px-2 gap-2">
            {data.map((d) => {
              const pct = maxCount > 0 ? (d.count / maxCount) * 100 : 0;
              return (
                <div key={d.month} className="flex-1 flex flex-col items-center justify-end h-full">
                  {d.count > 0 && (
                    <span className="text-[10px] font-bold text-blue-600 mb-1">{d.count}</span>
                  )}
                  <div
                    className="w-full max-w-[48px] bg-blue-500 rounded-t-md transition-all duration-700"
                    style={{ height: `${Math.max(pct, d.count > 0 ? 4 : 0)}%` }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex ml-8 mt-1">
        {data.map((d) => {
          const [, mm] = d.month.split("-");
          return (
            <div key={d.month} className="flex-1 text-center">
              <span className="text-[11px] text-text-light font-medium">{monthNames[mm] || mm}</span>
            </div>
          );
        })}
      </div>
      <div className="text-center text-xs text-text-light mt-3">
        Total: <strong className="text-text">{data.reduce((s, d) => s + d.count, 0)}</strong> navios nos últimos 6 meses
      </div>
    </div>
  );
}

// --- Embarque Chart ---

function EmbarqueChart({ items }: { items: StockChartItem[] }) {
  // Only items with a default_quantity set
  const withDefault = items.filter((i) => i.default_quantity > 0);
  if (withDefault.length === 0) {
    return <p className="text-center text-text-light text-sm py-8">Defina a &quot;Qtd Padrão&quot; nos itens do estoque</p>;
  }

  const totalDefault = withDefault.reduce((s, i) => s + i.default_quantity, 0);
  const totalCurrent = withDefault.reduce((s, i) => s + Math.min(i.quantity, i.default_quantity), 0);
  const totalFalta = totalDefault - totalCurrent;
  const pct = totalDefault > 0 ? Math.round((totalCurrent / totalDefault) * 100) : 0;

  // Items missing
  const missing = withDefault
    .filter((i) => i.quantity < i.default_quantity)
    .map((i) => ({ name: i.name, falta: i.default_quantity - i.quantity, category: i.category }))
    .sort((a, b) => b.falta - a.falta);

  // Donut
  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const r = 60;
  const strokeW = 16;
  const circumference = 2 * Math.PI * r;
  const filledLen = (pct / 100) * circumference;

  const color = pct >= 90 ? "#22c55e" : pct >= 60 ? "#f59e0b" : "#ef4444";

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      {/* Donut */}
      <div className="flex flex-col items-center gap-2 shrink-0">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e5e7eb" strokeWidth={strokeW} />
          <circle
            cx={cx} cy={cy} r={r} fill="none"
            stroke={color} strokeWidth={strokeW}
            strokeDasharray={`${filledLen} ${circumference - filledLen}`}
            strokeDashoffset={circumference / 4}
            strokeLinecap="round"
            style={{ transition: "stroke-dasharray 0.5s" }}
          />
          <text x={cx} y={cy - 6} textAnchor="middle" fontSize="22" fontWeight="bold" fill={color}>{pct}%</text>
          <text x={cx} y={cy + 12} textAnchor="middle" fontSize="10" fill="#9ca3af">pronto</text>
        </svg>
        <div className="text-center text-xs text-text-light">
          <span className="font-semibold text-text">{totalCurrent}</span> de <span className="font-semibold text-text">{totalDefault}</span> itens
          {totalFalta > 0 && <span className="text-danger ml-1">(falta {totalFalta})</span>}
        </div>
      </div>

      {/* Missing items list */}
      {missing.length > 0 ? (
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-text mb-2">Itens em falta para embarque:</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-48 overflow-y-auto">
            {missing.map((m, i) => (
              <div key={i} className="flex items-center justify-between bg-red-50 rounded-lg px-3 py-1.5">
                <span className="text-sm text-text truncate">{m.name}</span>
                <span className="text-xs font-bold text-danger shrink-0 ml-2">-{m.falta}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <span className="text-4xl block mb-2">✅</span>
            <p className="text-success font-semibold">Estoque completo para embarque!</p>
          </div>
        </div>
      )}
    </div>
  );
}
