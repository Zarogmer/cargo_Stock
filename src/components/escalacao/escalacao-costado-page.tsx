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
import { SHIFT_PERIODS } from "@/types/database";
import type {
  JobFunction,
  Job,
  JobAllocation,
  Employee,
  ShiftPeriod,
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
  const [loading, setLoading] = useState(true);

  const [addPeriod, setAddPeriod] = useState<ShiftPeriod | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [shipsRes, empRes, fnRes, jobsRes, allocsRes] = await Promise.all([
        db.from("ships").select("*").in("status", ["AGENDADO", "EM_OPERACAO"]).order("arrival_date"),
        db.from("employees").select("id, name, role, status").order("name"),
        db.from("job_functions").select("*").order("name"),
        db.from("jobs").select("*"),
        db.from("job_allocations").select("*, job_functions(name, unit), employees(name)").order("added_at", { ascending: true }),
      ]);
      setShips((shipsRes.data as Ship[]) || []);
      setEmployees((empRes.data as Employee[]) || []);
      setFunctions((fnRes.data as JobFunction[]) || []);
      setJobs((jobsRes.data as Job[]) || []);
      setAllocations((allocsRes.data as JobAllocation[]) || []);
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

  // Group active Costado allocations for the selected ship + date, by period.
  const allocationsByPeriod = useMemo(() => {
    const empty: Record<ShiftPeriod, JobAllocation[]> = {
      "07-13": [], "13-19": [], "19-01": [], "01-07": [],
    };
    if (!shipJob) return empty;
    for (const a of allocations) {
      if (a.job_id !== shipJob.id) continue;
      if ((a.kind || "EMBARQUE") !== "COSTADO") continue;
      if (a.status !== "ATIVO") continue;
      if (!a.shift_date || !a.shift_period) continue;
      const shiftDate = a.shift_date.slice(0, 10);
      if (shiftDate !== selectedDate) continue;
      const period = a.shift_period as ShiftPeriod;
      if (period in empty) empty[period].push(a);
    }
    return empty;
  }, [shipJob, allocations, selectedDate]);

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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
        <div className="md:col-span-2">
          <ShipSelector ships={ships} selectedShip={selectedShip} onSelect={setSelectedShip} />
        </div>
        <div>
          <label className="block text-xs font-semibold text-text-light uppercase tracking-wider mb-1.5">📅 Dia</label>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => setSelectedDate(e.target.value)}
            className="w-full bg-card border border-border rounded-xl p-4 text-sm focus:ring-2 focus:ring-primary outline-none"
          />
        </div>
      </div>

      {!currentShip ? (
        <div className="text-center py-12 text-text-light">Selecione um navio para escalar.</div>
      ) : (
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
        profileName={profileName}
        onClose={() => setAddPeriod(null)}
        onSaved={() => { setAddPeriod(null); loadData(); }}
      />
    </div>
  );
}

// ─── Add Crew to Period Modal ───────────────────────────────────────────────

function AddCostadoCrewModal({
  open, period, date, ship, ensureJob, employees, functions, existingForPeriod, profileName, onClose, onSaved,
}: {
  open: boolean;
  period: ShiftPeriod | null;
  date: string;
  ship: Ship | null;
  ensureJob: () => Promise<string>;
  employees: Employee[];
  functions: JobFunction[];
  existingForPeriod: JobAllocation[];
  profileName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [perEmpFn, setPerEmpFn] = useState<Map<number, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setSearch("");
      setSelectedIds(new Set());
      setPerEmpFn(new Map());
      setError("");
    }
  }, [open]);

  const allocatedIds = new Set(
    existingForPeriod.map((a) => a.employee_id).filter(Boolean) as number[]
  );

  const matches = employees
    .filter((e) => e.status === "ATIVO")
    .filter((e) => !allocatedIds.has(e.id))
    .filter((e) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return e.name.toLowerCase().includes(q) || (e.role || "").toLowerCase().includes(q);
    });

  function findFnIdForRole(role: string | null): string {
    if (!role) return "";
    const fn = functions.find((f) => f.name.toUpperCase() === role.toUpperCase());
    return fn ? String(fn.id) : "";
  }

  function toggleEmployee(emp: Employee) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(emp.id)) {
        next.delete(emp.id);
        setPerEmpFn((m) => { const nm = new Map(m); nm.delete(emp.id); return nm; });
      } else {
        next.add(emp.id);
        const guessed = findFnIdForRole(emp.role);
        if (guessed) setPerEmpFn((m) => { const nm = new Map(m); nm.set(emp.id, guessed); return nm; });
      }
      return next;
    });
  }

  function removeFromMulti(id: number) {
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    setPerEmpFn((m) => { const nm = new Map(m); nm.delete(id); return nm; });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!period || !ship) return;
    if (selectedIds.size === 0) { setError("Selecione ao menos um funcionário."); return; }
    const missingFn = Array.from(selectedIds).filter((id) => !perEmpFn.get(id));
    if (missingFn.length > 0) {
      const names = missingFn.map((id) => employees.find((e) => e.id === id)?.name).filter(Boolean).join(", ");
      setError(`Defina a função para: ${names}`);
      return;
    }
    setSaving(true);
    try {
      const jobId = await ensureJob();
      const now = new Date().toISOString();
      for (const id of selectedIds) {
        await db.from("job_allocations").insert({
          job_id: jobId,
          function_id: parseInt(perEmpFn.get(id)!),
          employee_id: id,
          quantity: 0,
          rate: 0,
          pluxee_value: 0,
          status: "ATIVO",
          kind: "COSTADO",
          shift_date: date,
          shift_period: period,
          added_by: profileName,
          added_at: now,
        });
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";
  const activeFunctions = functions.filter((f) => f.active);
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
                {selectedList.length} {selectedList.length === 1 ? "selecionado" : "selecionados"}
              </p>
              <div className="space-y-1.5 max-h-44 overflow-y-auto">
                {selectedList.map((emp) => {
                  const curFn = perEmpFn.get(emp.id) || "";
                  const fnMissing = !curFn;
                  return (
                    <div key={emp.id} className="flex items-center gap-2 bg-white border border-emerald-100 rounded-md px-2 py-1.5">
                      <span className="flex-1 min-w-0 text-xs font-medium truncate">{emp.name}</span>
                      <select
                        value={curFn}
                        onChange={(ev) => setPerEmpFn((m) => new Map(m).set(emp.id, ev.target.value))}
                        className={`text-xs px-2 py-1 border rounded ${fnMissing ? "border-red-300 bg-red-50" : "border-border"}`}
                      >
                        <option value="">Função...</option>
                        {activeFunctions.map((f) => (
                          <option key={f.id} value={f.id}>{f.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => removeFromMulti(emp.id)}
                        className="text-xs text-red-600 hover:bg-red-50 rounded p-1"
                        title="Remover"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
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
          <div className="mt-2 max-h-56 overflow-y-auto border border-border rounded-lg bg-card">
            {matches.length === 0 ? (
              <div className="px-3 py-3 text-xs text-text-light italic text-center">
                {search.trim() ? "Nenhum funcionário encontrado" : "Comece a digitar para filtrar..."}
              </div>
            ) : (
              matches.slice(0, 50).map((e) => {
                const checked = selectedIds.has(e.id);
                return (
                  <label
                    key={e.id}
                    className={`flex items-center gap-2 px-3 py-2 border-b border-border last:border-0 cursor-pointer transition ${
                      checked ? "bg-emerald-50 hover:bg-emerald-100" : "hover:bg-blue-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleEmployee(e)}
                      className="w-4 h-4 accent-primary"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{e.name}</p>
                      {e.role && <p className="text-[10px] text-text-light">{e.role}</p>}
                    </div>
                  </label>
                );
              })
            )}
          </div>
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
