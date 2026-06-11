"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { TrashIcon } from "@/components/icons";
import { ShipSelector, type Ship } from "@/components/escalacao/ship-selector";
import { useSendWhatsappPref, EnviarWhatsappToggle } from "@/lib/escala-whatsapp-pref";
import { SHIFT_PERIODS } from "@/types/database";
import type {
  JobFunction,
  Job,
  JobAllocation,
  Employee,
  ShiftPeriod,
  CostadoPeriodStatus,
} from "@/types/database";

const PERIOD_LABELS: Record<ShiftPeriod, string> = {
  "07-13": "07h às 13h",
  "13-19": "13h às 19h",
  "19-01": "19h às 01h",
  "01-07": "01h às 07h",
};

const PERIOD_TONES: Record<ShiftPeriod, string> = {
  "07-13": "border-amber-200 bg-amber-50/40",
  "13-19": "border-orange-200 bg-orange-50/40",
  "19-01": "border-indigo-200 bg-indigo-50/40",
  "01-07": "border-slate-200 bg-slate-50/40",
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function EscalacaoCostadoPage() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const role = profile?.role || "RH";
  const canEdit = hasPermission(role, "NAVIOS", "edit") || hasPermission(role, "EMBARQUE", "embarcar");
  const profileName = profile?.full_name || "Sistema";

  const [ships, setShips] = useState<Ship[]>([]);
  const [selectedShip, setSelectedShip] = useState<string>("");
  const [selectedDate, setSelectedDate] = useState<string>(todayISO());
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [functions, setFunctions] = useState<JobFunction[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [allocations, setAllocations] = useState<JobAllocation[]>([]);
  const [periodStatus, setPeriodStatus] = useState<CostadoPeriodStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const [addPeriod, setAddPeriod] = useState<ShiftPeriod | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [shipsRes, empRes, fnRes, jobsRes, allocsRes, marksRes] = await Promise.all([
        db.from("ships").select("*").in("status", ["AGENDADO", "EM_OPERACAO"]).order("arrival_date"),
        db.from("employees").select("id, name, role, status, sector").order("name"),
        db.from("job_functions").select("*").order("name"),
        db.from("jobs").select("*"),
        db.from("job_allocations").select("*, job_functions(name, unit), employees(name)").order("added_at", { ascending: true }),
        db.from("costado_period_status").select("*"),
      ]);
      // Costado tab shows only ships marked as Costado (services array includes "COSTADO").
      const allShips = (shipsRes.data as Ship[]) || [];
      setShips(allShips.filter((s) => (s.services || []).includes("COSTADO")));
      setEmployees((empRes.data as Employee[]) || []);
      setFunctions((fnRes.data as JobFunction[]) || []);
      setJobs((jobsRes.data as Job[]) || []);
      setAllocations((allocsRes.data as JobAllocation[]) || []);
      setPeriodStatus((marksRes.data as CostadoPeriodStatus[]) || []);
    } catch (err) {
      console.error("Load error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData, pathname]);

  useEffect(() => {
    if (ships.length > 0 && !selectedShip) {
      setSelectedShip(ships[0].id);
    }
  }, [ships, selectedShip]);

  const currentShip = ships.find((s) => s.id === selectedShip);
  const shipJob = useMemo(() => jobs.find((j) => j.ship_id === selectedShip) ?? null, [jobs, selectedShip]);

  const [view, setView] = useState<"escalacao" | "historico">("escalacao");

  // All ACTIVE Costado allocations for the selected ship (any date).
  const shipCostadoAllocations = useMemo(() => {
    if (!shipJob) return [] as JobAllocation[];
    return allocations.filter(
      (a) => a.job_id === shipJob.id
        && (a.kind || "EMBARQUE") === "COSTADO"
        && a.status === "ATIVO"
        && a.shift_date
        && a.shift_period,
    );
  }, [shipJob, allocations]);

  // Group active Costado allocations for the selected ship + date, by period.
  const allocationsByPeriod = useMemo(() => {
    const empty: Record<ShiftPeriod, JobAllocation[]> = {
      "07-13": [], "13-19": [], "19-01": [], "01-07": [],
    };
    for (const a of shipCostadoAllocations) {
      const shiftDate = a.shift_date!.slice(0, 10);
      if (shiftDate !== selectedDate) continue;
      const period = a.shift_period as ShiftPeriod;
      if (period in empty) empty[period].push(a);
    }
    return empty;
  }, [shipCostadoAllocations, selectedDate]);

  // Funcionarios em job_allocations ATIVAS em QUALQUER OUTRO job (excluindo
  // o job do navio Costado atual) com o tipo de operacao em que estao.
  // Aparecem no seletor desabilitados com badge Costado/Embarcado --
  // regra do RH: ninguem em duas operacoes ao mesmo tempo, mas a equipe
  // quer ver o nome pra saber por que nao da pra escalar.
  const otherJobOccupiedKind = useMemo(() => {
    const map = new Map<number, "EMBARQUE" | "COSTADO">();
    for (const a of allocations) {
      if (a.status !== "ATIVO") continue;
      if (a.employee_id == null) continue;
      if (shipJob && a.job_id === shipJob.id) continue;
      const k: "EMBARQUE" | "COSTADO" = a.kind === "COSTADO" ? "COSTADO" : "EMBARQUE";
      const prev = map.get(a.employee_id);
      if (!prev || k === "COSTADO") map.set(a.employee_id, k);
    }
    return map;
  }, [allocations, shipJob]);

  async function ensureJob(): Promise<string> {
    if (shipJob) return shipJob.id;
    if (!currentShip) throw new Error("Nenhum navio selecionado");
    const startDate = currentShip.arrival_date || todayISO();
    const insRes = await db.from("jobs").insert({
      name: currentShip.name,
      ship_id: currentShip.id,
      start_date: startDate,
      end_date: currentShip.departure_date,
      status: "ABERTO",
      port: currentShip.port,
      created_by: profileName,
    } as any);
    if (insRes.error) throw new Error(insRes.error.message);
    const { data } = await db.from("jobs").select("id").eq("ship_id", currentShip.id);
    return (data as Array<{ id: string }>)[0].id;
  }

  async function handleRemove(alloc: JobAllocation) {
    if (!confirm(`Remover ${alloc.employees?.name || "membro"} do turno ${alloc.shift_period}?`)) return;
    await db.from("job_allocations").update({
      status: "REMOVIDO",
      removed_by: profileName,
      removed_at: new Date().toISOString(),
      removal_reason: "Removido da escalação de costado",
    }).eq("id", alloc.id);
    loadData();
  }

  // Mark/unmark a (date, period) as "não requisitado" — toggles the row.
  async function togglePeriodMark(date: string, period: ShiftPeriod) {
    if (!shipJob) {
      // Need a job first; reuse ensureJob to create it.
      await ensureJob();
      return;
    }
    const existing = periodStatus.find(
      (p) => p.job_id === shipJob.id && p.shift_date.slice(0, 10) === date && p.shift_period === period,
    );
    if (existing) {
      await db.from("costado_period_status").delete().eq("id", existing.id);
    } else {
      await db.from("costado_period_status").insert({
        job_id: shipJob.id,
        shift_date: date,
        shift_period: period,
        status: "NAO_REQUISITADO",
        created_by: profileName,
      });
    }
    loadData();
  }

  // Period marks scoped to the current ship's job.
  const shipPeriodMarks = useMemo(
    () => (shipJob ? periodStatus.filter((p) => p.job_id === shipJob.id) : []),
    [shipJob, periodStatus],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-2">
          <span className="text-4xl animate-bounce">🚢</span>
          <span className="text-sm text-text-light animate-pulse">Carregando escalação...</span>
        </div>
      </div>
    );
  }

  if (ships.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-text">Escalação de Costado ⛏️</h1>
        <div className="bg-card rounded-xl shadow-sm border border-border p-8 text-center text-text-light">
          <span className="text-4xl block mb-3">🚢</span>
          <p className="font-medium text-text mb-1">Nenhum navio agendado ou em operação</p>
          <p className="text-sm">Cadastre navios na aba <strong>Navios</strong> para escalar a equipe.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-text">Escalação de Costado ⛏️</h1>

      <ShipSelector ships={ships} selectedShip={selectedShip} onSelect={setSelectedShip} />

      {/* In-page sub-tabs */}
      <div className="flex gap-1 border-b border-border">
        <button
          type="button"
          onClick={() => setView("escalacao")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
            view === "escalacao"
              ? "border-primary text-primary"
              : "border-transparent text-text-light hover:text-text"
          }`}
        >
          📅 Escalação do dia
        </button>
        <button
          type="button"
          onClick={() => setView("historico")}
          className={`px-4 py-2.5 text-sm font-medium border-b-2 transition ${
            view === "historico"
              ? "border-primary text-primary"
              : "border-transparent text-text-light hover:text-text"
          }`}
        >
          📋 Histórico ({shipCostadoAllocations.length})
        </button>
      </div>

      {!currentShip ? (
        <div className="text-center py-12 text-text-light">Selecione um navio para escalar.</div>
      ) : view === "escalacao" ? (
        <>
          <div>
            <label className="block text-xs font-semibold text-text-light uppercase tracking-wider mb-1.5">📅 Dia</label>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full md:w-64 bg-card border border-border rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-primary outline-none"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {SHIFT_PERIODS.map((period) => {
              const crew = allocationsByPeriod[period];
              return (
                <section key={period} className={`rounded-xl border ${PERIOD_TONES[period]} flex flex-col`}>
                  <header className="px-4 pt-3 pb-2 border-b border-border flex items-center justify-between">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-text-light font-semibold">Turno</p>
                      <h3 className="text-base font-bold text-text">{PERIOD_LABELS[period]}</h3>
                    </div>
                    <span className="text-xs px-2 py-1 rounded-full bg-white border border-border font-semibold text-text">
                      {crew.length}
                    </span>
                  </header>
                  <ul className="flex-1 divide-y divide-border/60 min-h-[60px]">
                    {crew.length === 0 ? (
                      <li className="px-4 py-6 text-center text-xs text-text-light italic">
                        Ninguém escalado neste turno
                      </li>
                    ) : (
                      crew.map((a, idx) => (
                        <li key={a.id} className="px-4 py-2 flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{idx + 1}. {a.employees?.name || "—"}</p>
                            <p className="text-[10px] text-text-light">{a.job_functions?.name || "—"}</p>
                          </div>
                          {canEdit && (
                            <button
                              onClick={() => handleRemove(a)}
                              className="p-1 text-danger hover:bg-red-50 rounded"
                              title="Remover"
                            >
                              <TrashIcon className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </li>
                      ))
                    )}
                  </ul>
                  {canEdit && (
                    <div className="px-3 pb-3 pt-2">
                      <Button size="sm" className="w-full" onClick={() => setAddPeriod(period)}>
                        + Adicionar
                      </Button>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      ) : (
        <HistoricoView
          allocations={shipCostadoAllocations}
          periodMarks={shipPeriodMarks}
          shipName={currentShip.name}
          canEdit={canEdit}
          onTogglePeriodMark={togglePeriodMark}
        />
      )}

      <AddCostadoCrewModal
        open={!!addPeriod}
        period={addPeriod}
        date={selectedDate}
        ship={currentShip || null}
        ensureJob={ensureJob}
        employees={employees}
        functions={functions}
        existingForPeriod={addPeriod ? allocationsByPeriod[addPeriod] : []}
        otherJobOccupiedKind={otherJobOccupiedKind}
        profileName={profileName}
        onClose={() => setAddPeriod(null)}
        onSaved={() => { setAddPeriod(null); loadData(); }}
      />
    </div>
  );
}

// ─── Histórico (per-employee aggregation for the whole ship) ────────────────

interface EmployeeSummary {
  employee_id: number;
  employee_name: string;
  function_name: string;
  shifts: { date: string; period: ShiftPeriod }[];
  total_shifts: number;
  unique_days: number;
}

function HistoricoView({
  allocations, periodMarks, shipName, canEdit, onTogglePeriodMark,
}: {
  allocations: JobAllocation[];
  periodMarks: CostadoPeriodStatus[];
  shipName: string;
  canEdit: boolean;
  onTogglePeriodMark: (date: string, period: ShiftPeriod) => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());

  // Set of `${date}|${period}` strings marked as não requisitado.
  const markedKeys = useMemo(() => {
    const s = new Set<string>();
    for (const m of periodMarks) {
      s.add(`${m.shift_date.slice(0, 10)}|${m.shift_period}`);
    }
    return s;
  }, [periodMarks]);
  const isMarked = (date: string, period: ShiftPeriod) => markedKeys.has(`${date}|${period}`);

  const todayISOStr = todayISO();
  const isPastDate = (date: string) => date < todayISOStr;

  const summary = useMemo(() => {
    const byEmp = new Map<number, EmployeeSummary>();
    for (const a of allocations) {
      if (!a.employee_id || !a.shift_date || !a.shift_period) continue;
      const id = a.employee_id;
      if (!byEmp.has(id)) {
        byEmp.set(id, {
          employee_id: id,
          employee_name: a.employees?.name || "—",
          function_name: a.job_functions?.name || "—",
          shifts: [],
          total_shifts: 0,
          unique_days: 0,
        });
      }
      byEmp.get(id)!.shifts.push({
        date: a.shift_date.slice(0, 10),
        period: a.shift_period as ShiftPeriod,
      });
    }
    for (const s of byEmp.values()) {
      s.total_shifts = s.shifts.length;
      s.unique_days = new Set(s.shifts.map((x) => x.date)).size;
      s.shifts.sort((a, b) => (a.date === b.date ? a.period.localeCompare(b.period) : a.date.localeCompare(b.date)));
    }
    return Array.from(byEmp.values()).sort((a, b) => b.total_shifts - a.total_shifts);
  }, [allocations]);

  // Date → period → list of allocations. Includes dates that have only NR marks
  // (so an entire day marked "não requisitado" still shows up in the history).
  const byDate = useMemo(() => {
    const map = new Map<string, Record<ShiftPeriod, JobAllocation[]>>();
    function ensure(date: string) {
      if (!map.has(date)) {
        map.set(date, { "07-13": [], "13-19": [], "19-01": [], "01-07": [] });
      }
    }
    for (const a of allocations) {
      if (!a.shift_date || !a.shift_period) continue;
      const date = a.shift_date.slice(0, 10);
      ensure(date);
      const period = a.shift_period as ShiftPeriod;
      if (period in map.get(date)!) map.get(date)![period].push(a);
    }
    for (const m of periodMarks) {
      ensure(m.shift_date.slice(0, 10));
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [allocations, periodMarks]);

  const totalShifts = summary.reduce((acc, s) => acc + s.total_shifts, 0);
  const totalUniqueDays = new Set(allocations.map((a) => a.shift_date?.slice(0, 10))).size;
  const totalPeople = summary.length;

  if (allocations.length === 0) {
    return (
      <div className="bg-card rounded-xl border border-border p-12 text-center text-text-light">
        <p className="text-3xl mb-2">📋</p>
        <p className="text-sm">Nenhuma escalação registrada para este navio ainda.</p>
      </div>
    );
  }

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleDate(date: string) {
    setExpandedDates((prev) => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-[10px] uppercase tracking-wider text-text-light font-semibold">Total de turnos</p>
          <p className="text-2xl font-bold text-text mt-1">{totalShifts}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-[10px] uppercase tracking-wider text-text-light font-semibold">Dias trabalhados</p>
          <p className="text-2xl font-bold text-text mt-1">{totalUniqueDays}</p>
        </div>
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-[10px] uppercase tracking-wider text-text-light font-semibold">Colaboradores</p>
          <p className="text-2xl font-bold text-text mt-1">{totalPeople}</p>
        </div>
      </div>

      {/* Por dia (movido pra cima) */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <header className="px-6 pt-4 pb-3 border-b border-border">
          <h2 className="text-base font-semibold text-text">Por dia · {shipName}</h2>
          <p className="text-xs text-text-light mt-0.5">
            Cada dia escalado, com os 4 períodos e quem estava em cada um. Marque períodos como <strong>não requisitado</strong> quando o navio não operou.
          </p>
        </header>
        <ul className="divide-y divide-border">
          {byDate.map(([date, byPeriod]) => {
            const isOpen = expandedDates.has(date);
            const past = isPastDate(date);
            // Period is "accounted for" if it has crew, is manually marked NR,
            // OR the day already passed (auto-NR — see request below the form).
            const isAccounted = (p: ShiftPeriod) =>
              byPeriod[p].length > 0 || isMarked(date, p) || past;
            const periodsAccounted = SHIFT_PERIODS.reduce(
              (acc, p) => acc + (isAccounted(p) ? 1 : 0),
              0,
            );
            return (
              <li key={date}>
                <button
                  type="button"
                  onClick={() => toggleDate(date)}
                  className="w-full px-6 py-3 flex items-center justify-between gap-3 hover:bg-gray-50 transition text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-base font-semibold tabular-nums">{date.split("-").reverse().join("/")}</span>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-text-light font-medium">
                      {periodsAccounted} de 4 {periodsAccounted === 1 ? "período" : "períodos"}
                    </span>
                  </div>
                  <span className="text-xs text-text-light">{isOpen ? "▲" : "▼"}</span>
                </button>
                {isOpen && (
                  <div className="px-6 pb-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                    {SHIFT_PERIODS.map((period) => {
                      const crew = byPeriod[period];
                      const marked = isMarked(date, period);
                      const hasCrew = crew.length > 0;
                      // Past + empty + no manual mark → treat as não requisitado (auto)
                      const autoNR = past && !hasCrew && !marked;
                      const showAsNR = marked || autoNR;
                      return (
                        <div
                          key={period}
                          className={`rounded-lg border p-3 ${showAsNR ? "border-gray-300 bg-gray-50/80" : PERIOD_TONES[period]}`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs font-bold text-text">{PERIOD_LABELS[period]}</p>
                            {showAsNR ? (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-700 font-semibold">
                                NÃO REQ.{autoNR ? " (auto)" : ""}
                              </span>
                            ) : (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white border border-border font-semibold">
                                {crew.length}
                              </span>
                            )}
                          </div>
                          {hasCrew ? (
                            <ul className="space-y-1">
                              {crew.map((a, idx) => (
                                <li key={a.id} className="text-xs">
                                  <span className="font-medium">{idx + 1}. {a.employees?.name || "—"}</span>
                                  <span className="ml-1 text-[10px] text-text-light">· {a.job_functions?.name || "—"}</span>
                                </li>
                              ))}
                            </ul>
                          ) : autoNR ? (
                            <p className="text-[11px] text-gray-600 italic">Período não requisitado · dia passou sem escala</p>
                          ) : marked ? (
                            <p className="text-[11px] text-gray-600 italic">Período não requisitado</p>
                          ) : (
                            <p className="text-[11px] text-text-light italic">Ninguém</p>
                          )}
                          {canEdit && !hasCrew && !past && (
                            <button
                              type="button"
                              onClick={() => onTogglePeriodMark(date, period)}
                              className="mt-2 w-full text-[10px] px-2 py-1 rounded bg-white border border-border hover:bg-gray-100 font-medium text-text-light"
                            >
                              {marked ? "Desmarcar" : "Marcar como não requisitado"}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {/* Por colaborador */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <header className="px-6 pt-4 pb-3 border-b border-border">
          <h2 className="text-base font-semibold text-text">Por colaborador · {shipName}</h2>
          <p className="text-xs text-text-light mt-0.5">Quantos turnos e dias cada um trabalhou. Os valores são preenchidos em <strong>Financeiro › Pagamento de Costado</strong>.</p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-border">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-semibold text-text-light">#</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-text-light">Funcionário</th>
                <th className="px-4 py-2 text-left text-xs font-semibold text-text-light">Função</th>
                <th className="px-4 py-2 text-center text-xs font-semibold text-text-light">Dias</th>
                <th className="px-4 py-2 text-center text-xs font-semibold text-text-light">Turnos</th>
                <th className="px-4 py-2 text-right text-xs font-semibold text-text-light w-20">Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s, idx) => {
                const isOpen = expanded.has(s.employee_id);
                return (
                  <FragmentRow
                    key={s.employee_id}
                    idx={idx + 1}
                    summary={s}
                    isOpen={isOpen}
                    onToggle={() => toggleExpand(s.employee_id)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function FragmentRow({
  idx, summary: s, isOpen, onToggle,
}: {
  idx: number;
  summary: EmployeeSummary;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-border last:border-0 hover:bg-gray-50">
        <td className="px-4 py-2 text-text-light tabular-nums">{idx}</td>
        <td className="px-4 py-2 font-medium">{s.employee_name}</td>
        <td className="px-4 py-2">
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
            {s.function_name}
          </span>
        </td>
        <td className="px-4 py-2 text-center font-bold tabular-nums">{s.unique_days}</td>
        <td className="px-4 py-2 text-center font-bold tabular-nums">{s.total_shifts}</td>
        <td className="px-4 py-2 text-right">
          <button
            onClick={onToggle}
            className="text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200 rounded font-medium"
          >
            {isOpen ? "▲ Ocultar" : "▼ Ver"}
          </button>
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-gray-50/60">
          <td colSpan={6} className="px-4 py-3">
            <p className="text-[10px] uppercase tracking-wider text-text-light font-semibold mb-2">
              Turnos trabalhados ({s.total_shifts})
            </p>
            <div className="flex flex-wrap gap-1.5">
              {s.shifts.map((sh, i) => (
                <span key={`${sh.date}-${sh.period}-${i}`} className="text-[11px] px-2 py-1 rounded-md bg-white border border-border font-mono">
                  {sh.date.split("-").reverse().join("/")} · {PERIOD_LABELS[sh.period]}
                </span>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Add Crew to Period Modal ───────────────────────────────────────────────

function AddCostadoCrewModal({
  open, period, date, ship, ensureJob, employees, existingForPeriod, otherJobOccupiedKind, profileName, onClose, onSaved,
}: {
  open: boolean;
  period: ShiftPeriod | null;
  date: string;
  ship: Ship | null;
  ensureJob: () => Promise<string>;
  employees: Employee[];
  // functions removido: Costado é valor fixo (função COSTADO única), não tem mais selector por funcionário.
  functions: JobFunction[];
  existingForPeriod: JobAllocation[];
  otherJobOccupiedKind: Map<number, "EMBARQUE" | "COSTADO">;
  profileName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // "Avisar no WhatsApp ao escalar?" — DESLIGADO por padrão. Por padrão salva a
  // escala sem postar no grupo; marcado, posta. Avisar é opt-in. Ver escala-whatsapp-pref.
  const { send: sendWhats, setSend: setSendWhats } = useSendWhatsappPref();
  // Costado sempre avisa SÓ no grupo do navio (a pedido do RH — o picker
  // anterior foi removido). DMs individuais ficam pro fluxo de Embarque,
  // onde fazem sentido. Aqui o grupo é específico do navio e todos os
  // escalados já são membros, então DM redundaria.
  // Também não tem mais seletor de função por funcionário: Costado é
  // pago por turno, valor fixo, igual pra todos — todos viram COSTADO.

  useEffect(() => {
    if (open) {
      setSearch("");
      setSelectedIds(new Set());
      setError("");
    }
  }, [open]);

  const allocatedIds = new Set(
    existingForPeriod.map((a) => a.employee_id).filter(Boolean) as number[]
  );

  const matches = employees
    // ATIVO e PENDENCIA aparecem (PENDENCIA é só sinal de doc vencida, o
    // funcionário ainda pode trabalhar). INATIVO/demitido fica fora.
    .filter((e) => e.status === "ATIVO" || e.status === "PENDENCIA")
    // Admin não escala — só entra em grupo de WhatsApp pela caixinha do form de Navio.
    .filter((e) => e.sector !== "ADMINISTRATIVO")
    .filter((e) => !allocatedIds.has(e.id))
    // Quem ja esta em outra operacao continua na lista, mas vai aparecer
    // desabilitado com badge Costado/Embarcado.
    .filter((e) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return e.name.toLowerCase().includes(q) || (e.role || "").toLowerCase().includes(q);
    });

  function toggleEmployee(emp: Employee) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(emp.id)) next.delete(emp.id);
      else next.add(emp.id);
      return next;
    });
  }

  function removeFromMulti(id: number) {
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!period || !ship) return;
    if (selectedIds.size === 0) { setError("Selecione ao menos um funcionário."); return; }
    setSaving(true);
    try {
      const jobId = await ensureJob();
      const now = new Date().toISOString();
      // Costado é pago por TURNO, valor único (não tem distinção por função
      // como Embarque tem). Pegamos a função "COSTADO" cadastrada em
      // Financeiro > Valores e usamos pra todo mundo. O rate sai do
      // default_rate dela (default R$ 100/turno, editável inline).
      const { data: costadoFnData } = await db
        .from("job_functions")
        .select("id, default_rate")
        .eq("name", "COSTADO")
        .limit(1);
      let costadoFn = (costadoFnData || [])[0] as { id: number; default_rate: string | number } | undefined;
      // Self-heal: se ninguém ainda abriu a aba Valores, cria a função na hora.
      if (!costadoFn) {
        const created = await db.from("job_functions").insert({
          name: "COSTADO",
          description: "Limpeza em costado — pago por turno de 6h. Valor fixo, igual pra todos os colaboradores.",
          default_rate: 100,
          unit: "TURNO",
          active: true,
        } as Record<string, unknown>);
        if (created.error) {
          setError(`Não consegui criar a função COSTADO automaticamente: ${created.error.message}`);
          setSaving(false);
          return;
        }
        const re = await db.from("job_functions").select("id, default_rate").eq("name", "COSTADO").limit(1);
        costadoFn = (re.data || [])[0] as { id: number; default_rate: string | number };
        if (!costadoFn) {
          setError("Função COSTADO foi criada mas não consegui ler — tente de novo.");
          setSaving(false);
          return;
        }
      }
      const ratePerTurno = Number(costadoFn.default_rate);
      for (const id of selectedIds) {
        await db.from("job_allocations").insert({
          job_id: jobId,
          function_id: costadoFn.id, // todo mundo entra como COSTADO
          employee_id: id,
          quantity: 1, // cada linha = 1 turno (data + período)
          rate: ratePerTurno, // valor fixo, único pra todos
          pluxee_value: 0,
          status: "ATIVO",
          kind: "COSTADO",
          shift_date: date,
          shift_period: period,
          added_by: profileName,
          added_at: now,
        });
      }
      // Fire-and-forget WhatsApp notification (DMs + group post). Errors don't
      // block the save — they're logged for the admin to check on the Conversas
      // side if a recipient claims they didn't get the message.
      if (sendWhats) fetch("/api/escalacao/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipId: ship.id,
          kind: "COSTADO",
          shiftDate: date,
          shiftPeriod: period,
          employeeIds: Array.from(selectedIds),
          // Costado avisa só no grupo do navio — DMs ficam pro Embarque.
          targets: "GROUP",
        }),
      }).catch((err) => console.warn("[escalacao] notify failed:", err));
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";
  const selectedList = Array.from(selectedIds).map((id) => employees.find((e) => e.id === id)).filter(Boolean) as Employee[];

  if (!period) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Adicionar ao turno ${PERIOD_LABELS[period]}`}
      maxWidth="max-w-2xl"
    >
      <form onSubmit={handleSave} className="space-y-4">
        <p className="text-xs text-text-light">
          Dia <strong className="text-text">{date.split("-").reverse().join("/")}</strong> · Navio{" "}
          <strong className="text-text">{ship?.name || "—"}</strong>
        </p>

        <div>
          <label className="block text-sm font-medium mb-1">
            Funcionários * <span className="text-xs text-text-light font-normal">(selecione vários)</span>
          </label>

          {selectedList.length > 0 && (
            <div className="mb-2 p-2 bg-emerald-50 border border-emerald-200 rounded-lg">
              <p className="text-[10px] font-semibold text-emerald-900 uppercase tracking-wider mb-2">
                {selectedList.length} {selectedList.length === 1 ? "selecionado" : "selecionados"} · todos entram como COSTADO (valor fixo por turno)
              </p>
              <div className="space-y-1.5 max-h-44 overflow-y-auto">
                {selectedList.map((emp) => (
                  <div key={emp.id} className="flex items-center gap-2 bg-white border border-emerald-100 rounded-md px-2 py-1.5">
                    <span className="flex-1 min-w-0 text-xs font-medium truncate">{emp.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-800 font-semibold shrink-0">
                      ⚓ COSTADO
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFromMulti(emp.id)}
                      className="text-xs text-red-600 hover:bg-red-50 rounded p-1"
                      title="Remover"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Digite o nome do funcionário..."
            className={inputCls}
            autoFocus
          />
          {otherJobOccupiedKind.size > 0 && (
            <p className="text-[10px] text-text-light mt-1">
              ℹ️ Colaboradores em <span className="italic">cinza</span> já estão em outra operação ativa.
            </p>
          )}
          <div className="mt-2 max-h-56 overflow-y-auto border border-border rounded-lg bg-card">
            {matches.length === 0 ? (
              <div className="px-3 py-3 text-xs text-text-light italic text-center">
                {search.trim() ? "Nenhum funcionário encontrado" : "Comece a digitar para filtrar..."}
              </div>
            ) : (
              matches.slice(0, 50).map((e) => {
                const checked = selectedIds.has(e.id);
                const occKind = otherJobOccupiedKind.get(e.id) || null;
                const isOccupied = !!occKind;
                return (
                  <label
                    key={e.id}
                    className={`flex items-center gap-2 px-3 py-2 border-b border-border last:border-0 transition ${
                      isOccupied
                        ? "bg-gray-50 cursor-not-allowed"
                        : checked
                          ? "bg-emerald-50 hover:bg-emerald-100 cursor-pointer"
                          : "hover:bg-blue-50 cursor-pointer"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isOccupied}
                      onChange={() => { if (!isOccupied) toggleEmployee(e); }}
                      className="w-4 h-4 accent-primary disabled:opacity-50"
                    />
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-medium truncate ${isOccupied ? "text-text-light" : ""}`}>{e.name}</p>
                      {e.role && <p className="text-[10px] text-text-light">{e.role}</p>}
                    </div>
                    {isOccupied && (
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0 ${
                        occKind === "COSTADO"
                          ? "bg-amber-100 text-amber-800"
                          : "bg-blue-100 text-blue-800"
                      }`}>
                        {occKind === "COSTADO" ? "Costado" : "Embarcado"}
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </div>
        </div>

        {/* Costado avisa SÓ no grupo do navio (sem DM, sem picker). Pedido
            do RH: o grupo é específico do navio, todos os escalados são
            membros, então a DM individual fica redundante. Picker antigo
            (Grupo+Privado / Só Grupo / Só Privado) foi removido. */}
        <div className="border-t border-border pt-3 space-y-2">
          <EnviarWhatsappToggle send={sendWhats} setSend={setSendWhats} />
          {sendWhats && (
            <p className="text-[11px] text-text-light bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
              📲 Avisará apenas o <strong>grupo do navio</strong> no WhatsApp. Sem DM individual.
            </p>
          )}
        </div>

        {error && (
          <p className="text-xs text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving || selectedIds.size === 0}>
            {saving ? "Salvando..." : selectedIds.size > 1 ? `Adicionar ${selectedIds.size}` : "Adicionar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
