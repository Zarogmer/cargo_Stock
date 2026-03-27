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
  const [loading, setLoading] = useState(true);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const [stockRes, stockFullRes, employeesRes, toolsRes, episRes] = await Promise.all([
        supabase.from("stock_items").select("id", { count: "exact", head: true }),
        supabase.from("stock_items").select("name, quantity, default_quantity, category"),
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

      {/* Stock Charts */}
      {stockItems.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Category Distribution Pie */}
          <div className="bg-card rounded-xl shadow-sm border border-border p-5">
            <h2 className="font-semibold text-text mb-4">Estoque por Categoria</h2>
            <PieChart data={getCategoryData(stockItems)} />
          </div>

          {/* Stock Level - Items below default */}
          <div className="bg-card rounded-xl shadow-sm border border-border p-5">
            <h2 className="font-semibold text-text mb-4">Nível de Estoque</h2>
            <PieChart data={getStockLevelData(stockItems)} />
          </div>
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

// --- Pie Chart ---
interface PieSlice {
  label: string;
  value: number;
  color: string;
}

function getCategoryData(items: StockChartItem[]): PieSlice[] {
  const cats: Record<string, number> = {};
  items.forEach((i) => {
    const cat = i.category || "OUTROS";
    cats[cat] = (cats[cat] || 0) + i.quantity;
  });
  const colorMap: Record<string, string> = {
    SUPRIMENTOS: "#8b5cf6",
    CARNE: "#ef4444",
    FEIRA: "#22c55e",
    OUTROS: "#6b7280",
  };
  const labelMap: Record<string, string> = {
    SUPRIMENTOS: "Suprimentos",
    CARNE: "Carne",
    FEIRA: "Feira",
    OUTROS: "Outros",
  };
  return Object.entries(cats).map(([k, v]) => ({
    label: labelMap[k] || k,
    value: v,
    color: colorMap[k] || "#6b7280",
  }));
}

function getStockLevelData(items: StockChartItem[]): PieSlice[] {
  let ok = 0;
  let low = 0;
  let empty = 0;
  items.forEach((i) => {
    const def = i.default_quantity || 0;
    if (i.quantity <= 0) empty++;
    else if (def > 0 && i.quantity < def * 0.5) low++;
    else ok++;
  });
  return [
    { label: "Em Estoque", value: ok, color: "#22c55e" },
    { label: "Estoque Baixo", value: low, color: "#f59e0b" },
    { label: "Esgotado", value: empty, color: "#ef4444" },
  ].filter((s) => s.value > 0);
}

function PieChart({ data }: { data: PieSlice[] }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) {
    return <p className="text-center text-text-light text-sm py-8">Sem dados</p>;
  }

  // Build SVG pie chart
  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const r = 60;
  let startAngle = -90;

  const slices = data.map((slice) => {
    const pct = slice.value / total;
    const angle = pct * 360;
    const endAngle = startAngle + angle;

    const startRad = (startAngle * Math.PI) / 180;
    const endRad = (endAngle * Math.PI) / 180;

    const x1 = cx + r * Math.cos(startRad);
    const y1 = cy + r * Math.sin(startRad);
    const x2 = cx + r * Math.cos(endRad);
    const y2 = cy + r * Math.sin(endRad);

    const largeArc = angle > 180 ? 1 : 0;

    const pathD = angle >= 359.99
      ? `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy}`
      : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} Z`;

    startAngle = endAngle;

    return { ...slice, pathD, pct };
  });

  return (
    <div className="flex flex-col sm:flex-row items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        {slices.map((s, i) => (
          <path key={i} d={s.pathD} fill={s.color} stroke="white" strokeWidth="2" />
        ))}
        {/* Center hole for donut effect */}
        <circle cx={cx} cy={cy} r={30} fill="white" />
        <text x={cx} y={cy - 4} textAnchor="middle" className="text-xs font-bold fill-gray-700" fontSize="14">
          {total}
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" className="fill-gray-400" fontSize="9">
          itens
        </text>
      </svg>

      <div className="flex flex-col gap-2">
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-sm text-text">
              {s.label}: <strong>{s.value}</strong>
              <span className="text-text-light ml-1">({(s.pct * 100).toFixed(0)}%)</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
