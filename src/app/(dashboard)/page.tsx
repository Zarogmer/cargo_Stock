"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { formatDateTime, MOVEMENT_TYPE_LABELS, CATEGORY_LABELS } from "@/lib/utils";

interface StockChartItem {
  name: string;
  quantity: number;
  default_quantity: number;
  category: string;
  team: string | null;
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
  detail?: string;
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
  const pathname = usePathname();

  const [stats, setStats] = useState<DashboardStats>({ totalStock: 0, totalEmployees: 0, totalTools: 0, totalEpis: 0 });
  const [movements, setMovements] = useState<RecentMovement[]>([]);
  const [dollar, setDollar] = useState<DollarQuote | null>(null);
  const [stockItems, setStockItems] = useState<StockChartItem[]>([]);
  const [shipsByMonth, setShipsByMonth] = useState<{ month: string; count: number }[]>([]);
  const [recentPurchases, setRecentPurchases] = useState<{ id: string; tool_name: string; quantity: number; requested_by: string; responded_by: string; updated_at: string }[]>([]);
  const [loading, setLoading] = useState(true);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const [stockRes, stockFullRes, employeesRes, toolsRes, episRes] = await Promise.all([
        db.from("stock_items").select("id", { count: "exact", head: true }),
        db.from("stock_items").select("name, quantity, default_quantity, category, team"),
        db.from("employees").select("id", { count: "exact", head: true }),
        db.from("tools").select("id", { count: "exact", head: true }),
        db.from("epis").select("id", { count: "exact", head: true }),
      ]);

      setStats({
        totalStock: stockRes.count || 0,
        totalEmployees: employeesRes.count || 0,
        totalTools: toolsRes.count || 0,
        totalEpis: episRes.count || 0,
      });

      setStockItems((stockFullRes.data || []) as StockChartItem[]);

      // Load ships for monthly chart (Jan-Dec of current year)
      const shipsRes = await db.from("ships").select("departure_date, created_at");
      const shipsData = shipsRes.data || [];
      const year = new Date().getFullYear();
      const monthCounts: Record<string, number> = {};
      for (let m = 1; m <= 12; m++) {
        monthCounts[`${year}-${String(m).padStart(2, "0")}`] = 0;
      }
      shipsData.forEach((s: any) => {
        const dateStr = s.departure_date || s.created_at;
        if (!dateStr) return;
        const d = new Date(dateStr);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (key in monthCounts) monthCounts[key]++;
      });
      setShipsByMonth(Object.entries(monthCounts).map(([month, count]) => ({ month, count })));

      // Load recent movements from ALL sources
      const [stockMov, epiMov, toolMov, requestsMov, shipsMov, empMov, loginMov] = await Promise.all([
        db.from("stock_movements").select("id, movement_type, quantity, created_at, created_by, stock_items(name)").order("created_at", { ascending: false }).limit(10),
        db.from("epi_movements").select("id, movement_type, quantity, created_at, created_by, epis(name)").order("created_at", { ascending: false }).limit(10),
        db.from("tool_movements").select("id, movement_type, created_at, created_by, tools(name)").order("created_at", { ascending: false }).limit(10),
        db.from("tool_requests").select("id, tool_name, status, notes, created_at, requested_by").order("created_at", { ascending: false }).limit(10),
        db.from("ships").select("id, name, status, created_at, assigned_team").order("created_at", { ascending: false }).limit(10),
        db.from("employees").select("id, name, team, created_at").order("created_at", { ascending: false }).limit(10),
        db.from("login_logs").select("id, full_name, email, event_type, created_at").order("created_at", { ascending: false }).limit(10),
      ]);

      const combined: RecentMovement[] = [];

      (stockMov.data || []).forEach((m: any) => {
        combined.push({
          id: `stock-${m.id}`, type: "Estoque", item_name: m.stock_items?.name || "—",
          movement_type: m.movement_type, created_at: m.created_at, created_by: m.created_by,
        });
      });
      (epiMov.data || []).forEach((m: any) => {
        combined.push({
          id: `epi-${m.id}`, type: "EPI", item_name: m.epis?.name || "—",
          movement_type: m.movement_type, created_at: m.created_at, created_by: m.created_by,
        });
      });
      (toolMov.data || []).forEach((m: any) => {
        combined.push({
          id: `tool-${m.id}`, type: "Equipamento", item_name: m.tools?.name || "—",
          movement_type: m.movement_type, created_at: m.created_at, created_by: m.created_by,
        });
      });
      (requestsMov.data || []).forEach((m: any) => {
        const statusLabel = m.status === "APROVADO" ? "Aprovada" : m.status === "REJEITADO" ? "Rejeitada" : "Pendente";
        combined.push({
          id: `req-${m.id}`, type: "Solicitação", item_name: m.tool_name || "—",
          movement_type: m.status, created_at: m.created_at, created_by: m.requested_by || "—",
          detail: statusLabel,
        });
      });
      (shipsMov.data || []).forEach((m: any) => {
        combined.push({
          id: `ship-${m.id}`, type: "Navio", item_name: m.name || "—",
          movement_type: m.status || "CADASTRO", created_at: m.created_at, created_by: m.assigned_team || "—",
          detail: m.status,
        });
      });
      (empMov.data || []).forEach((m: any) => {
        const teamLabel = m.team === "EQUIPE_1" ? "Equipe 1" : m.team === "EQUIPE_2" ? "Equipe 2" : m.team === "EQUIPE_3" ? "Equipe 3" : m.team === "COSTADO" ? "Costado" : "Sem equipe";
        combined.push({
          id: `emp-${m.id}`, type: "Colaborador", item_name: m.name || "—",
          movement_type: "CADASTRO", created_at: m.created_at, created_by: teamLabel,
          detail: teamLabel,
        });
      });
      (loginMov.data || []).forEach((m: any) => {
        combined.push({
          id: `login-${m.id}`, type: "Acesso", item_name: m.full_name || "—",
          movement_type: m.event_type, created_at: m.created_at, created_by: m.full_name || "—",
          detail: m.event_type === "LOGIN" ? "Entrou no sistema" : "Saiu do sistema",
        });
      });

      combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setMovements(combined.slice(0, 30));

      // Load recent purchases (COMPRADO status)
      const purchasesRes = await db
        .from("tool_requests")
        .select("id, tool_name, quantity, requested_by, responded_by, updated_at")
        .eq("status", "COMPRADO")
        .order("updated_at", { ascending: false })
        .limit(10);
      setRecentPurchases((purchasesRes.data as any[]) || []);
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
    // pathname forces reload when navigating back to dashboard
  }, [loadDashboard, fetchDollar, pathname]);

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
  const allowedEmails = ["chico@cargostock.local", "sandra@cargostock.local", "guigui12306@gmail.com"];
  const canSeeMovements = allowedEmails.includes(profile?.email || "");

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-text">
            {greeting}, {profile?.full_name?.split(" ")[0] || profile?.full_name}
          </h1>
          <p className="text-text-light text-sm mt-1 capitalize">
            {new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </p>
        </div>
        <DollarTicker dollar={dollar} />
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Itens no Estoque" value={stats.totalStock} icon="🛒" tone="blue" href="/estoque" />
        <StatCard label="RH" value={stats.totalEmployees} icon="👷" tone="emerald" href="/colaboradores" />
        <StatCard label="Equipamentos" value={stats.totalTools} icon="🔧" tone="amber" href="/equipamentos" />
        <StatCard label="EPIs" value={stats.totalEpis} icon="⛑️" tone="violet" href="/colaboradores?tab=epi" />
      </div>

      {/* Embarque readiness — both teams in one card */}
      {stockItems.length > 0 && (
        <section className="bg-card rounded-2xl border border-border overflow-hidden">
          <header className="px-6 pt-5 pb-4 border-b border-border">
            <h2 className="text-base font-semibold text-text">Prontidão para embarque</h2>
            <p className="text-xs text-text-light mt-0.5">Comparativo de estoque entre equipes</p>
          </header>
          <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-border">
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-600" />
                <span className="text-xs font-semibold uppercase tracking-wider text-text-light">Equipe 1</span>
              </div>
              <EmbarqueChart items={stockItems.filter((i) => i.team === "EQUIPE_1")} />
            </div>
            <div className="p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-1.5 h-1.5 rounded-full bg-violet-600" />
                <span className="text-xs font-semibold uppercase tracking-wider text-text-light">Equipe 2</span>
              </div>
              <EmbarqueChart items={stockItems.filter((i) => i.team === "EQUIPE_2")} />
            </div>
          </div>
        </section>
      )}

      {/* Ships per Month Bar Chart */}
      {shipsByMonth.length > 0 && (
        <section className="bg-card rounded-2xl border border-border p-6">
          <header className="mb-5">
            <h2 className="text-base font-semibold text-text">Navios por mês</h2>
            <p className="text-xs text-text-light mt-0.5">
              {new Date().getFullYear()} · baseado na data de saída
            </p>
          </header>
          <ShipsBarChart data={shipsByMonth} />
        </section>
      )}

      {/* Recent Purchases */}
      {recentPurchases.length > 0 && (
        <section className="bg-card rounded-2xl border border-border overflow-hidden">
          <header className="px-6 pt-5 pb-4 border-b border-border flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-text">Compras recentes</h2>
              <p className="text-xs text-text-light mt-0.5">
                Solicitações marcadas como compradas
              </p>
            </div>
            <Link
              href="/solicitacoes"
              className="text-xs font-medium text-primary hover:text-primary-dark whitespace-nowrap"
            >
              Ver todas →
            </Link>
          </header>
          <ul className="divide-y divide-border">
            {recentPurchases.map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-4 px-6 py-3 hover:bg-gray-50/60 transition"
              >
                <div className="w-9 h-9 rounded-lg bg-blue-50 text-primary flex items-center justify-center shrink-0 text-xs font-semibold tabular-nums">
                  ×{p.quantity}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text truncate">
                    {p.tool_name}
                  </p>
                  <p className="text-xs text-text-light">
                    {p.responded_by} · {formatDateTime(p.updated_at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Recent Movements - only for chico, sandra, guilherme */}
      {canSeeMovements && (
        <section className="bg-card rounded-2xl border border-border overflow-hidden">
          <header className="px-6 pt-5 pb-4 border-b border-border">
            <h2 className="text-base font-semibold text-text">Movimentações recentes</h2>
            <p className="text-xs text-text-light mt-0.5">
              Últimas 30 movimentações do sistema
            </p>
          </header>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50/80 border-b border-border">
                <tr>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-text-light uppercase tracking-wider whitespace-nowrap">Módulo</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-text-light uppercase tracking-wider whitespace-nowrap">Item</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-text-light uppercase tracking-wider whitespace-nowrap">Tipo</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-text-light uppercase tracking-wider whitespace-nowrap">Data</th>
                  <th className="px-5 py-3 text-left text-xs font-semibold text-text-light uppercase tracking-wider whitespace-nowrap">Usuário</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {movements.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-12 text-center text-text-light">
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-3xl">📋</span>
                        <p>Nenhuma movimentação registrada ainda</p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  movements.map((m) => (
                    <tr key={m.id} className="hover:bg-gray-50/50 transition">
                      <td className="px-5 py-3 whitespace-nowrap">
                        <ModuleBadge type={m.type} />
                      </td>
                      <td className="px-5 py-3 font-medium text-text whitespace-nowrap">{m.item_name}</td>
                      <td className="px-5 py-3 whitespace-nowrap">
                        {m.type === "Acesso" ? (
                          <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${
                            m.movement_type === "LOGIN" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                          }`}>
                            {m.movement_type === "LOGIN" ? "Entrou" : "Saiu"}
                          </span>
                        ) : (
                          <span className="text-text-light">{MOVEMENT_TYPE_LABELS[m.movement_type] || m.detail || m.movement_type}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-text-light text-xs whitespace-nowrap">{formatDateTime(m.created_at)}</td>
                      <td className="px-5 py-3 text-text-light text-xs uppercase whitespace-nowrap">{m.created_by}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// --- Helper Components ---

type StatTone = "blue" | "emerald" | "amber" | "violet";

const STAT_TONE: Record<StatTone, { chip: string; accent: string }> = {
  blue:    { chip: "bg-blue-50 text-blue-600",       accent: "bg-blue-500" },
  emerald: { chip: "bg-emerald-50 text-emerald-600", accent: "bg-emerald-500" },
  amber:   { chip: "bg-amber-50 text-amber-600",     accent: "bg-amber-500" },
  violet:  { chip: "bg-violet-50 text-violet-600",   accent: "bg-violet-500" },
};

function StatCard({
  label, value, icon, tone, href,
}: {
  label: string;
  value: number;
  icon: string;
  tone: StatTone;
  href: string;
}) {
  const t = STAT_TONE[tone];
  return (
    <Link
      href={href}
      className="group relative bg-card rounded-2xl border border-border p-5 hover:border-text/15 hover:shadow-[0_1px_3px_rgba(15,23,42,0.05),0_1px_2px_rgba(15,23,42,0.04)] transition-shadow"
    >
      <span className={`absolute left-0 top-5 bottom-5 w-[3px] rounded-r-full ${t.accent} opacity-0 group-hover:opacity-100 transition-opacity`} />
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-text-light">{label}</p>
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-sm ${t.chip}`}>
          <span aria-hidden>{icon}</span>
        </div>
      </div>
      <p className="text-3xl font-semibold tracking-tight text-text mt-3 tabular-nums">{value}</p>
    </Link>
  );
}

function DollarTicker({ dollar }: { dollar: DollarQuote | null }) {
  if (!dollar) {
    return (
      <div className="flex items-center gap-2 text-xs text-text-light">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-pulse" />
        <span>Carregando cotação...</span>
      </div>
    );
  }
  const pct = parseFloat(dollar.pctChange);
  const positive = pct >= 0;
  return (
    <div className="inline-flex items-baseline gap-3 self-start sm:self-end">
      <div className="flex items-baseline gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-light">USD</span>
        <span className="text-base font-semibold text-text tabular-nums">R$ {dollar.bid}</span>
      </div>
      <span
        className={`inline-flex items-center gap-1 text-[11px] font-medium tabular-nums ${
          positive ? "text-emerald-600" : "text-red-600"
        }`}
      >
        <span>{positive ? "▲" : "▼"}</span>
        {Math.abs(pct).toFixed(2)}%
      </span>
      <span className="hidden md:inline text-[11px] text-text-light tabular-nums">
        L {dollar.low} · H {dollar.high}
      </span>
    </div>
  );
}

function ModuleBadge({ type }: { type: string }) {
  const styles: Record<string, string> = {
    Estoque: "bg-blue-100 text-blue-700",
    EPI: "bg-purple-100 text-purple-700",
    Equipamento: "bg-amber-100 text-amber-700",
    "Solicitação": "bg-orange-100 text-orange-700",
    Navio: "bg-cyan-100 text-cyan-700",
    Colaborador: "bg-green-100 text-green-700",
    Acesso: "bg-indigo-100 text-indigo-700",
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
  const chartHeight = 220;
  const total = data.reduce((s, d) => s + d.count, 0);
  const yTicks = [maxCount, Math.round(maxCount / 2), 0];

  return (
    <div>
      <div className="flex gap-3">
        {/* Y-axis */}
        <div
          className="flex flex-col justify-between text-right text-[11px] text-text-light tabular-nums select-none"
          style={{ height: chartHeight }}
        >
          {yTicks.map((t) => <span key={t}>{t}</span>)}
        </div>

        {/* Chart area with horizontal gridlines */}
        <div className="flex-1 relative" style={{ height: chartHeight }}>
          <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
            {yTicks.map((_, i) => (
              <div key={i} className="border-t border-border/70" />
            ))}
          </div>

          <div className="relative flex items-end h-full gap-1.5">
            {data.map((d) => {
              const pct = maxCount > 0 ? (d.count / maxCount) * 100 : 0;
              const minPx = d.count > 0 ? 6 : 0;
              return (
                <div key={d.month} className="flex-1 flex flex-col items-center justify-end h-full group">
                  <div
                    className="w-full max-w-[44px] bg-primary/85 group-hover:bg-primary rounded-t-md transition-all duration-500 relative"
                    style={{ height: `max(${pct}%, ${minPx}px)` }}
                  >
                    {d.count > 0 && (
                      <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[11px] font-semibold text-text tabular-nums opacity-0 group-hover:opacity-100 transition-opacity">
                        {d.count}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* X-axis */}
      <div className="flex gap-1.5 mt-2 pl-[34px]">
        {data.map((d) => {
          const [, mm] = d.month.split("-");
          const isCurrent = mm === String(new Date().getMonth() + 1).padStart(2, "0");
          return (
            <div key={d.month} className="flex-1 text-center">
              <span
                className={`text-[11px] tabular-nums ${
                  isCurrent ? "font-semibold text-text" : "text-text-light"
                }`}
              >
                {monthNames[mm] || mm}
              </span>
            </div>
          );
        })}
      </div>

      <p className="text-xs text-text-light mt-4">
        <span className="font-semibold text-text tabular-nums">{total}</span> {total === 1 ? "navio" : "navios"} em {new Date().getFullYear()}
      </p>
    </div>
  );
}

// --- Embarque Chart ---

function EmbarqueChart({ items }: { items: StockChartItem[] }) {
  const withDefault = items.filter((i) => i.default_quantity > 0);
  if (withDefault.length === 0) {
    return (
      <p className="text-sm text-text-light py-6">
        Defina a &quot;Qtd Padrão&quot; nos itens do estoque para acompanhar a prontidão.
      </p>
    );
  }

  const totalDefault = withDefault.reduce((s, i) => s + i.default_quantity, 0);
  const totalCurrent = withDefault.reduce((s, i) => s + Math.min(i.quantity, i.default_quantity), 0);
  const totalFalta = totalDefault - totalCurrent;
  const pct = totalDefault > 0 ? Math.round((totalCurrent / totalDefault) * 100) : 0;

  const missing = withDefault
    .filter((i) => i.quantity < i.default_quantity)
    .map((i) => ({ name: i.name, falta: i.default_quantity - i.quantity }))
    .sort((a, b) => b.falta - a.falta);

  // Donut
  const size = 132;
  const cx = size / 2;
  const cy = size / 2;
  const r = 52;
  const strokeW = 10;
  const circumference = 2 * Math.PI * r;
  const filledLen = (pct / 100) * circumference;

  const color = pct >= 90 ? "#10b981" : pct >= 60 ? "#f59e0b" : "#ef4444";

  return (
    <div className="flex flex-col sm:flex-row gap-6 items-center sm:items-start">
      {/* Donut */}
      <div className="flex flex-col items-center shrink-0">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="#e2e8f0" strokeWidth={strokeW} />
          <circle
            cx={cx} cy={cy} r={r} fill="none"
            stroke={color} strokeWidth={strokeW}
            strokeDasharray={`${filledLen} ${circumference - filledLen}`}
            strokeDashoffset={circumference / 4}
            strokeLinecap="round"
            style={{ transition: "stroke-dasharray 0.5s" }}
          />
          <text x={cx} y={cy + 2} textAnchor="middle" fontSize="22" fontWeight="600" fill="#0f172a" className="tabular-nums">
            {pct}%
          </text>
          <text x={cx} y={cy + 18} textAnchor="middle" fontSize="9" fill="#64748b" letterSpacing="1">
            PRONTO
          </text>
        </svg>
        <p className="text-xs text-text-light mt-2 tabular-nums">
          <span className="font-semibold text-text">{totalCurrent}</span> / {totalDefault} itens
        </p>
      </div>

      {/* Missing list / success */}
      <div className="flex-1 min-w-0 w-full">
        {missing.length > 0 ? (
          <>
            <div className="flex items-baseline justify-between mb-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-text-light">Em falta</p>
              <p className="text-[11px] text-danger tabular-nums font-medium">−{totalFalta} itens</p>
            </div>
            <ul className="divide-y divide-border max-h-44 overflow-y-auto">
              {missing.map((m, i) => (
                <li key={i} className="flex items-center justify-between py-1.5">
                  <span className="text-sm text-text truncate pr-2">{m.name}</span>
                  <span className="text-xs text-danger tabular-nums font-medium shrink-0">−{m.falta}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="h-full min-h-[120px] flex items-center justify-center text-center px-2">
            <div>
              <div className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto mb-2 text-base">
                ✓
              </div>
              <p className="text-sm font-medium text-emerald-700">Estoque completo</p>
              <p className="text-xs text-text-light mt-0.5">Pronto para embarcar</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
