"use client";

// Painel Financeiro — a "página que mostra tudo" pedida pela diretoria: os
// vencimentos num lugar só, sem precisar abrir aba por aba.
//   🚢 Pagamento de navios: navio em aberto vence 20 dias após o fim da operação
//      (mesmo padrão do modal Pagar em Pagamento de Navios).
//   📋 Contas a Pagar: o que está vencido, vence hoje e nos próximos dias.
//   🧾 Vales solicitados com saldo a descontar.
//   📑 Pra onde vai o dinheiro (seções da Demonstração Financeira).
//   🎯 Funcionários: digite o nome e veja os números do Controle de Funcionários.
// Restrito a FINANCEIRO_BANCO_ROLES (mesma régua do módulo bancário) — mostra
// contas, folha e gasto da empresa inteira.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { canAccessFinanceiroBanco } from "@/lib/rbac";
import { db } from "@/lib/db";
import { formatCurrency, matchSearch } from "@/lib/utils";
import { allocCountsAsWorked } from "@/lib/alloc-worked";
import { pickCostadoFunction } from "@/lib/jobUnits";
import { calcJobCost, prepareFinanceAllocations } from "@/lib/job-cost";
import { type Advance, type AdvanceDiscount, balanceOf, employeeBalance, openAdvances } from "@/lib/vales";
import { mergeSections, sectionShortLabel, type CustomSectionRow, type SectionOverrideRow } from "@/lib/statement-sections";
import type { Job, JobAllocation, JobAdjustment, JobFunction, Ship, Employee } from "@/types/database";
import type { PayableStatus } from "@/types/financeiro";

// Job vem com o navio aninhado (nome/status/porões do cadastro).
type JobRow = Job & { ships?: { name?: string | null; status?: string | null; holds_count?: number | null } | null };

interface InvoiceLite {
  id: string;
  description: string;
  amount: string;
  due_date: string | null;
  status: PayableStatus;
  statement_section: string | null;
  payment_date: string | null;
  created_at: string;
  payee_name: string | null;
  suppliers: { name: string } | null;
}

// Pagamento do navio vence 20 dias após o fim da operação (padrão do PayShipModal).
const SHIP_PAYMENT_DAYS = 20;

// ── Datas (strings YYYY-MM-DD, sem passar por timezone) ─────────────────────

function todayISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// Dias de hoje até a data (negativo = já passou).
function daysFromToday(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  const now = new Date();
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
}

function fmtBR(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function fmtBRShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}`;
}

// Chip de prazo: vencido (vermelho), hoje/próximos dias (âmbar), futuro (cinza).
function DueChip({ due }: { due: string | null }) {
  if (!due) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 whitespace-nowrap">sem data</span>;
  }
  const days = daysFromToday(due);
  if (days < 0) {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold whitespace-nowrap">
        vencido há {-days}d
      </span>
    );
  }
  if (days === 0) {
    return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold whitespace-nowrap">vence hoje</span>;
  }
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${days <= 7 ? "bg-amber-100 text-amber-800" : "bg-gray-100 text-gray-600"}`}>
      em {days}d
    </span>
  );
}

// Cabeçalho padrão das seções do painel, com link pra tela completa.
function SectionHeader({ emoji, title, hint, href, linkLabel }: {
  emoji: string; title: string; hint?: string; href: string; linkLabel?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-2 mb-3">
      <div>
        <h2 className="text-sm font-semibold text-text">{emoji} {title}</h2>
        {hint && <p className="text-[11px] text-text-light mt-0.5">{hint}</p>}
      </div>
      <Link href={href} className="text-xs text-primary hover:underline whitespace-nowrap">
        {linkLabel || "abrir"} →
      </Link>
    </div>
  );
}

export function PainelFinanceiroPage() {
  const { profile } = useAuth();
  const role = profile?.role || "FINANCEIRO";
  const canView = canAccessFinanceiroBanco(role);

  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [allocations, setAllocations] = useState<JobAllocation[]>([]);
  const [adjustments, setAdjustments] = useState<JobAdjustment[]>([]);
  const [functions, setFunctions] = useState<JobFunction[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [advDiscounts, setAdvDiscounts] = useState<AdvanceDiscount[]>([]);
  const [invoices, setInvoices] = useState<InvoiceLite[]>([]);
  const [customSections, setCustomSections] = useState<CustomSectionRow[]>([]);
  const [sectionOverrides, setSectionOverrides] = useState<SectionOverrideRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Busca do bloco Funcionários (o "digita o nome e vê o número").
  const [empSearch, setEmpSearch] = useState("");
  // Gasto por seção: mês atual ou ano inteiro.
  const [gastoPeriod, setGastoPeriod] = useState<"MES" | "ANO">("MES");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [fnRes, jbRes, alRes, adRes, shRes, emRes, srRes, avRes, adcRes, invRes, secRes] = await Promise.all([
        db.from("job_functions").select("*").order("name"),
        db.from("jobs").select("*, ships(name, status, holds_count)").order("start_date", { ascending: false }),
        db.from("job_allocations").select("*, job_functions(name, unit)"),
        db.from("job_adjustments").select("*"),
        db.from("ships").select("id, name, status, services").order("arrival_date", { ascending: false }).limit(50),
        db.from("employees").select("id, name, role, status, sector").order("name"),
        db.from("employee_function_rates").select("employee_id, function_id, rate"),
        db.from("employee_advances").select("*").order("advance_date", { ascending: false }),
        db.from("advance_discounts").select("*"),
        fetch("/api/financeiro/contas").then((r) => r.json()),
        fetch("/api/financeiro/statement-sections").then((r) => r.json()),
      ]);
      const allFunctions = (fnRes.data as JobFunction[]) || [];
      // Porões: job criado pela escalação nasce sem holds_count — cai no valor do
      // cadastro do navio, igual ao Financeiro (senão o custo por porão zera).
      const rawJobs = ((jbRes.data as JobRow[]) || []).map((j) =>
        j.holds_count == null && j.ships?.holds_count != null ? { ...j, holds_count: j.ships.holds_count } : j,
      );
      const emps = (emRes.data as Employee[]) || [];
      const srMap = new Map<string, number>();
      for (const r of (srRes.data || []) as { employee_id: number; function_id: number; rate: string | number }[]) {
        srMap.set(`${r.employee_id}-${r.function_id}`, Number(r.rate));
      }
      const shipsData = (shRes.data as Ship[]) || [];
      setFunctions(allFunctions);
      setJobs(rawJobs);
      setEmployees(emps);
      // Mesmo pipeline do Financeiro: cadastro aplicado + Raspagem/Pintura por porão.
      setAllocations(prepareFinanceAllocations(((alRes.data as JobAllocation[]) || []), emps, allFunctions, srMap, rawJobs, shipsData));
      setAdjustments((adRes.data as JobAdjustment[]) || []);
      setAdvances((avRes.data as Advance[]) || []);
      setAdvDiscounts((adcRes.data as AdvanceDiscount[]) || []);
      setInvoices(((invRes?.invoices as InvoiceLite[]) || []));
      setCustomSections(((secRes?.sections as CustomSectionRow[]) || []));
      setSectionOverrides(((secRes?.overrides as SectionOverrideRow[]) || []));
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  const today = todayISO();

  // ── 🚢 Navios em aberto com vencimento (fim da operação + 20 dias) ─────────
  const shipsDue = useMemo(() => {
    const list = jobs
      .filter((j) => j.status !== "FECHADO" && j.status !== "CANCELADO")
      .map((j) => {
        const end = j.end_date ? j.end_date.slice(0, 10) : null;
        const due = end ? addDaysISO(end, SHIP_PAYMENT_DAYS) : null;
        return {
          job: j,
          shipName: j.ships?.name || j.name,
          cost: calcJobCost(j, allocations, adjustments).total,
          due,
          days: due ? daysFromToday(due) : null,
        };
      })
      // Vencimento mais apertado primeiro; sem data de fim vai pro final.
      .sort((a, b) => (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99"));
    return {
      list,
      total: list.reduce((s, x) => s + x.cost, 0),
      overdue: list.filter((x) => x.days != null && x.days < 0),
    };
  }, [jobs, allocations, adjustments]);

  // ── 📋 Contas a Pagar por vencimento ───────────────────────────────────────
  const contas = useMemo(() => {
    const open = invoices.filter((i) => i.status !== "PAGO" && i.status !== "CANCELADO");
    const withDue = open.filter((i) => i.due_date);
    const sortAsc = (a: InvoiceLite, b: InvoiceLite) => (a.due_date || "").localeCompare(b.due_date || "");
    const overdue = withDue.filter((i) => i.due_date!.slice(0, 10) < today).sort(sortAsc);
    const dueToday = withDue.filter((i) => i.due_date!.slice(0, 10) === today).sort(sortAsc);
    const upcoming = withDue.filter((i) => i.due_date!.slice(0, 10) > today).sort(sortAsc);
    const noDue = open.filter((i) => !i.due_date);
    const sum = (l: InvoiceLite[]) => l.reduce((s, i) => s + Number(i.amount), 0);
    return {
      overdue, dueToday, upcoming, noDue,
      overdueTotal: sum(overdue), todayTotal: sum(dueToday), upcomingTotal: sum(upcoming),
      openTotal: sum(open),
    };
  }, [invoices, today]);

  // ── 🧾 Vales com saldo a descontar ─────────────────────────────────────────
  const vales = useMemo(() => {
    const empName = new Map(employees.map((e) => [e.id, e.name]));
    const open = openAdvances(advances, advDiscounts).map((a) => ({
      adv: a,
      name: empName.get(a.employee_id) || `#${a.employee_id}`,
      saldo: balanceOf(a, advDiscounts),
    }));
    const totalSaldo = open.reduce((s, x) => s + x.saldo, 0);
    const pessoas = new Set(open.map((x) => x.adv.employee_id)).size;
    return { open, totalSaldo, pessoas };
  }, [advances, advDiscounts, employees]);

  // ── 📑 Pra onde vai o dinheiro (seções da Demonstração) ────────────────────
  const mergedSections = useMemo(
    () => mergeSections(customSections, sectionOverrides),
    [customSections, sectionOverrides],
  );

  const gasto = useMemo(() => {
    const ymNow = today.slice(0, 7);
    const yearNow = today.slice(0, 4);
    const bySection = new Map<string, number>();
    let total = 0;
    for (const inv of invoices) {
      if (!inv.statement_section || inv.status === "CANCELADO") continue;
      // Mesma referência da Demonstração: pagamento > vencimento > criação.
      const ref = (inv.payment_date || inv.due_date || inv.created_at).slice(0, 10);
      if (gastoPeriod === "MES" ? ref.slice(0, 7) !== ymNow : ref.slice(0, 4) !== yearNow) continue;
      const v = Number(inv.amount);
      bySection.set(inv.statement_section, (bySection.get(inv.statement_section) || 0) + v);
      total += v;
    }
    const rows = [...bySection.entries()]
      .map(([key, value]) => ({ key, label: sectionShortLabel(key, mergedSections.byKey) || key, value }))
      .sort((a, b) => b.value - a.value);
    return { rows, total, max: rows[0]?.value || 0 };
  }, [invoices, gastoPeriod, today, mergedSections]);

  // ── 🎯 Funcionários (números do Controle, ano atual) ───────────────────────
  const empStats = useMemo(() => {
    const yearNow = new Date().getFullYear();
    const costadoFn = pickCostadoFunction(functions);
    const costadoRate = costadoFn ? Number(costadoFn.default_rate) : 0;
    const jobById = new Map(jobs.map((j) => [j.id, j]));
    interface Row {
      emp: Employee; ganho: number; poroes: number; turnos: number;
      ships: Set<string>; vale: number;
    }
    const map = new Map<number, Row>();
    for (const e of employees) {
      if ((e.status ?? "ATIVO") !== "ATIVO") continue;
      map.set(e.id, { emp: e, ganho: 0, poroes: 0, turnos: 0, ships: new Set(), vale: employeeBalance(e.id, advances, advDiscounts) });
    }
    const embarqueJobSeen = new Map<number, Set<string>>();
    for (const a of allocations) {
      if (!allocCountsAsWorked(a)) continue;
      if (a.employee_id == null) continue;
      if ((a.kind || "EMBARQUE") === "ADMINISTRATIVO") continue;
      const s = map.get(a.employee_id);
      if (!s) continue;
      const job = jobById.get(a.job_id);
      const dateStr = a.shift_date || job?.start_date || null;
      if (!dateStr || new Date(dateStr).getFullYear() !== yearNow) continue;
      const shipName = job?.ships?.name || job?.name || null;
      const extra = Number(a.extra_value || 0);
      if (a.kind === "COSTADO") {
        // Valor canônico do turno vem da função principal do Costado (Valores).
        const qty = Math.max(1, a.quantity);
        s.ganho += costadoRate * qty + extra;
        s.turnos += qty;
        if (shipName) s.ships.add(shipName);
      } else {
        const holds = Math.max(1, Number(job?.holds_count || 1));
        s.ganho += (Number(a.rate) + Number(a.service_extra_rate || 0)) * holds + extra;
        const seen = embarqueJobSeen.get(a.employee_id) || new Set<string>();
        if (!seen.has(a.job_id)) {
          s.poroes += holds;
          seen.add(a.job_id);
          embarqueJobSeen.set(a.employee_id, seen);
          if (shipName) s.ships.add(shipName);
        }
      }
    }
    return [...map.values()].sort((a, b) => b.ganho - a.ganho);
  }, [allocations, jobs, employees, functions, advances, advDiscounts]);

  const empVisible = useMemo(() => {
    const q = empSearch.trim();
    if (!q) return empStats.filter((s) => s.ganho > 0 || s.vale > 0).slice(0, 8);
    return empStats
      .filter((s) => matchSearch(s.emp.name, q) || matchSearch(s.emp.role || "", q))
      .slice(0, 30);
  }, [empStats, empSearch]);

  if (!canView) {
    return (
      <div className="max-w-7xl mx-auto">
        <p className="text-text-light">Você não tem acesso a este módulo.</p>
      </div>
    );
  }

  const upcomingShown = contas.upcoming.slice(0, 12);
  const valesShown = vales.open.slice(0, 12);
  const gastoShown = gasto.rows.slice(0, 9);
  const gastoOutras = gasto.rows.slice(9);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <h1 className="text-2xl font-bold text-text">Financeiro 💰</h1>
          <span className="text-text-light">›</span>
          <span className="text-lg font-semibold text-text-light">📊 Painel</span>
        </div>
        <p className="text-text-light text-sm mt-0.5">
          Visão geral — o que vence, quando pagar e pra onde o dinheiro vai
        </p>
      </div>

      {loadError && (
        <p className="text-sm text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          Erro ao carregar: {loadError}
        </p>
      )}

      {loading ? (
        <div className="bg-card border border-border rounded-xl p-8 text-center text-text-light text-sm">
          Carregando o painel...
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
              <p className="text-[10px] font-semibold text-blue-900 uppercase tracking-wider">🚢 Navios a pagar</p>
              <p className="text-xl font-bold text-blue-900 mt-1">{formatCurrency(shipsDue.total)}</p>
              <p className="text-[11px] text-blue-800 mt-0.5">{shipsDue.list.length} navio(s) em aberto</p>
            </div>
            <div className="bg-red-50 border border-red-100 rounded-xl p-4">
              <p className="text-[10px] font-semibold text-red-900 uppercase tracking-wider">⏰ Contas vencidas</p>
              <p className="text-xl font-bold text-red-700 mt-1">{formatCurrency(contas.overdueTotal)}</p>
              <p className="text-[11px] text-red-800 mt-0.5">{contas.overdue.length} título(s) atrasado(s)</p>
            </div>
            <div className="bg-amber-50 border border-amber-100 rounded-xl p-4">
              <p className="text-[10px] font-semibold text-amber-900 uppercase tracking-wider">📅 Vence hoje</p>
              <p className="text-xl font-bold text-amber-700 mt-1">{formatCurrency(contas.todayTotal)}</p>
              <p className="text-[11px] text-amber-800 mt-0.5">{contas.dueToday.length} título(s) hoje · {fmtBR(today)}</p>
            </div>
            <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4">
              <p className="text-[10px] font-semibold text-emerald-900 uppercase tracking-wider">🧾 Vales em aberto</p>
              <p className="text-xl font-bold text-emerald-800 mt-1">{formatCurrency(vales.totalSaldo)}</p>
              <p className="text-[11px] text-emerald-800 mt-0.5">{vales.pessoas} colaborador(es) com saldo</p>
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-4 items-start">
            {/* 🚢 Navios: vencimento do pagamento */}
            <div className="bg-card border border-border rounded-xl p-4">
              <SectionHeader
                emoji="🚢"
                title="Pagamento de Navios — vencimentos"
                hint={`Navio em aberto vence ${SHIP_PAYMENT_DAYS} dias após o fim da operação`}
                href="/financeiro?tab=navios"
                linkLabel="Pagamento de Navios"
              />
              {shipsDue.list.length === 0 ? (
                <p className="text-sm text-text-light">Nenhum navio com pagamento em aberto. 🎉</p>
              ) : (
                <ul className="divide-y divide-border">
                  {shipsDue.list.map(({ job, shipName, cost, due }) => (
                    <li key={job.id} className="py-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium text-text truncate">{shipName}</span>
                          <DueChip due={due} />
                        </div>
                        <p className="text-[11px] text-text-light">
                          {fmtBRShort(job.start_date)} → {job.end_date ? fmtBRShort(job.end_date) : "em operação"}
                          {due ? ` · pagar até ${fmtBR(due)}` : " · vencimento sai quando a operação terminar"}
                        </p>
                      </div>
                      <span className="text-sm font-semibold text-red-700 whitespace-nowrap">{formatCurrency(cost)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* 📋 Contas a Pagar por vencimento */}
            <div className="bg-card border border-border rounded-xl p-4">
              <SectionHeader
                emoji="📋"
                title="Contas a Pagar — quando pagar"
                hint="Títulos em aberto agrupados pelo vencimento"
                href="/financeiro/contas"
                linkLabel="Contas a Pagar"
              />
              {contas.overdue.length + contas.dueToday.length + contas.upcoming.length === 0 ? (
                <p className="text-sm text-text-light">Nenhum título em aberto com vencimento. 🎉</p>
              ) : (
                <div className="space-y-3">
                  {contas.overdue.length > 0 && (
                    <div>
                      <p className="text-[10px] font-semibold text-red-700 uppercase tracking-wider mb-1">
                        Vencidas · {formatCurrency(contas.overdueTotal)}
                      </p>
                      <ul className="divide-y divide-border">
                        {contas.overdue.map((i) => (
                          <li key={i.id} className="py-1.5 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm text-text truncate">{i.description}</span>
                                <DueChip due={i.due_date} />
                              </div>
                              <p className="text-[11px] text-text-light truncate">
                                {fmtBR(i.due_date)}{i.suppliers?.name || i.payee_name ? ` · ${i.suppliers?.name || i.payee_name}` : ""}
                              </p>
                            </div>
                            <span className="text-sm font-semibold text-red-700 whitespace-nowrap">{formatCurrency(Number(i.amount))}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {contas.dueToday.length > 0 && (
                    <div>
                      <p className="text-[10px] font-semibold text-amber-700 uppercase tracking-wider mb-1">
                        Hoje · {formatCurrency(contas.todayTotal)}
                      </p>
                      <ul className="divide-y divide-border">
                        {contas.dueToday.map((i) => (
                          <li key={i.id} className="py-1.5 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <span className="text-sm text-text truncate block">{i.description}</span>
                              {(i.suppliers?.name || i.payee_name) && (
                                <p className="text-[11px] text-text-light truncate">{i.suppliers?.name || i.payee_name}</p>
                              )}
                            </div>
                            <span className="text-sm font-semibold text-amber-700 whitespace-nowrap">{formatCurrency(Number(i.amount))}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {contas.upcoming.length > 0 && (
                    <div>
                      <p className="text-[10px] font-semibold text-text-light uppercase tracking-wider mb-1">
                        Próximos vencimentos · {formatCurrency(contas.upcomingTotal)}
                      </p>
                      <ul className="divide-y divide-border">
                        {upcomingShown.map((i) => (
                          <li key={i.id} className="py-1.5 flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm text-text truncate">{i.description}</span>
                                <DueChip due={i.due_date} />
                              </div>
                              <p className="text-[11px] text-text-light truncate">
                                {fmtBR(i.due_date)}{i.suppliers?.name || i.payee_name ? ` · ${i.suppliers?.name || i.payee_name}` : ""}
                              </p>
                            </div>
                            <span className="text-sm font-semibold text-text whitespace-nowrap">{formatCurrency(Number(i.amount))}</span>
                          </li>
                        ))}
                      </ul>
                      {contas.upcoming.length > upcomingShown.length && (
                        <p className="text-[11px] text-text-light mt-1">
                          + {contas.upcoming.length - upcomingShown.length} título(s) mais adiante — veja no Contas a Pagar.
                        </p>
                      )}
                    </div>
                  )}
                  {contas.noDue.length > 0 && (
                    <p className="text-[11px] text-text-light">
                      ⚠️ {contas.noDue.length} título(s) em aberto sem data de vencimento.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* 🧾 Vales solicitados */}
            <div className="bg-card border border-border rounded-xl p-4">
              <SectionHeader
                emoji="🧾"
                title="Vales — saldo a descontar"
                hint="Adiantamentos com saldo; o desconto acontece no pagamento do navio"
                href="/financeiro?tab=vales"
                linkLabel="Relatório de Vales"
              />
              {valesShown.length === 0 ? (
                <p className="text-sm text-text-light">Nenhum vale com saldo em aberto. 🎉</p>
              ) : (
                <>
                  <ul className="divide-y divide-border">
                    {valesShown.map(({ adv, name, saldo }) => (
                      <li key={adv.id} className="py-1.5 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <span className="text-sm text-text truncate block">{name}</span>
                          <p className="text-[11px] text-text-light truncate">
                            {fmtBR(adv.advance_date)} · pegou {formatCurrency(Number(adv.amount))}
                            {adv.origin ? ` · ${adv.origin}` : ""}
                          </p>
                        </div>
                        <span className="text-sm font-semibold text-red-700 whitespace-nowrap">{formatCurrency(saldo)}</span>
                      </li>
                    ))}
                  </ul>
                  {vales.open.length > valesShown.length && (
                    <p className="text-[11px] text-text-light mt-1">
                      + {vales.open.length - valesShown.length} vale(s) — veja no Relatório de Vales.
                    </p>
                  )}
                </>
              )}
            </div>

            {/* 📑 Pra onde vai o dinheiro */}
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-start justify-between gap-2 mb-3">
                <div>
                  <h2 className="text-sm font-semibold text-text">📑 Pra onde vai o dinheiro</h2>
                  <p className="text-[11px] text-text-light mt-0.5">
                    Gasto por seção da Demonstração Financeira · total {formatCurrency(gasto.total)}
                  </p>
                </div>
                <div className="flex items-center gap-2 whitespace-nowrap">
                  <div className="flex rounded-lg border border-border overflow-hidden">
                    {(["MES", "ANO"] as const).map((p) => (
                      <button
                        key={p}
                        onClick={() => setGastoPeriod(p)}
                        className={`px-2 py-1 text-[11px] font-medium transition ${
                          gastoPeriod === p ? "bg-primary text-white" : "bg-card text-text-light hover:text-text"
                        }`}
                      >
                        {p === "MES" ? "Mês atual" : "Ano"}
                      </button>
                    ))}
                  </div>
                  <Link href="/financeiro?tab=demonstracao" className="text-xs text-primary hover:underline">
                    Demonstração →
                  </Link>
                </div>
              </div>
              {gastoShown.length === 0 ? (
                <p className="text-sm text-text-light">
                  Nenhum gasto classificado em seção {gastoPeriod === "MES" ? "neste mês" : "neste ano"}.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {gastoShown.map((r) => (
                    <li key={r.key}>
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="text-text truncate">{r.label}</span>
                        <span className="font-semibold text-text whitespace-nowrap">{formatCurrency(r.value)}</span>
                      </div>
                      <div className="h-1.5 bg-gray-100 rounded-full mt-0.5">
                        <div
                          className="h-1.5 bg-primary/70 rounded-full"
                          style={{ width: `${gasto.max > 0 ? Math.max(3, Math.round((r.value / gasto.max) * 100)) : 0}%` }}
                        />
                      </div>
                    </li>
                  ))}
                  {gastoOutras.length > 0 && (
                    <li className="flex items-center justify-between gap-3 text-[11px] text-text-light pt-1">
                      <span>+ {gastoOutras.length} seção(ões) menores</span>
                      <span>{formatCurrency(gastoOutras.reduce((s, r) => s + r.value, 0))}</span>
                    </li>
                  )}
                </ul>
              )}
            </div>
          </div>

          {/* 🎯 Funcionários — busca com os números do Controle */}
          <div className="bg-card border border-border rounded-xl p-4">
            <SectionHeader
              emoji="🎯"
              title="Funcionários — números do ano"
              hint="Digite o nome pra puxar o resumo do Controle de Funcionários"
              href="/financeiro?tab=controle"
              linkLabel="Controle completo"
            />
            <input
              value={empSearch}
              onChange={(e) => setEmpSearch(e.target.value)}
              placeholder="🔎 Buscar colaborador por nome ou cargo..."
              className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40 mb-3"
            />
            {empVisible.length === 0 ? (
              <p className="text-sm text-text-light">
                {empSearch.trim() ? "Nenhum colaborador encontrado." : "Sem movimentação no ano."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wider text-text-light border-b border-border">
                      <th className="py-2 pr-3 font-semibold">Colaborador</th>
                      <th className="py-2 pr-3 font-semibold">Cargo</th>
                      <th className="py-2 pr-3 font-semibold text-right">Ganho no ano</th>
                      <th className="py-2 pr-3 font-semibold text-right">Porões</th>
                      <th className="py-2 pr-3 font-semibold text-right">Turnos</th>
                      <th className="py-2 pr-3 font-semibold text-right">Navios</th>
                      <th className="py-2 font-semibold text-right">Vale em aberto</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {empVisible.map((s) => (
                      <tr key={s.emp.id}>
                        <td className="py-2 pr-3 font-medium text-text whitespace-nowrap">{s.emp.name}</td>
                        <td className="py-2 pr-3 text-text-light whitespace-nowrap">{s.emp.role || "—"}</td>
                        <td className="py-2 pr-3 text-right font-semibold text-emerald-700 whitespace-nowrap">{formatCurrency(s.ganho)}</td>
                        <td className="py-2 pr-3 text-right text-text">{s.poroes || "—"}</td>
                        <td className="py-2 pr-3 text-right text-text">{s.turnos || "—"}</td>
                        <td className="py-2 pr-3 text-right text-text">{s.ships.size || "—"}</td>
                        <td className={`py-2 text-right font-semibold whitespace-nowrap ${s.vale > 0 ? "text-red-700" : "text-text-light"}`}>
                          {s.vale > 0 ? formatCurrency(s.vale) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!empSearch.trim() && (
                  <p className="text-[11px] text-text-light mt-2">
                    Mostrando os {empVisible.length} maiores ganhos do ano — use a busca pra achar qualquer um.
                  </p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
