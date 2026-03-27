"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase-browser";
import { formatDateTime, MOVEMENT_TYPE_LABELS, CATEGORY_LABELS } from "@/lib/utils";

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
  const [loading, setLoading] = useState(true);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const [stockRes, employeesRes, toolsRes, episRes] = await Promise.all([
        supabase.from("stock_items").select("id", { count: "exact", head: true }),
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
          <svg className="animate-spin h-8 w-8 text-primary" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-sm text-text-light">Carregando dashboard...</span>
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
