"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { EditIcon, TrashIcon } from "@/components/icons";
import { formatDate } from "@/lib/utils";
import type {
  JobFunction,
  Job,
  JobAllocation,
  Employee,
  AllocationKind,
} from "@/types/database";

interface Ship {
  id: string;
  name: string;
  arrival_date: string | null;
  departure_date: string | null;
  port: string | null;
  status: string;
  assigned_team: string | null;
  services: string[] | null;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

interface CrewPageConfig {
  kind: AllocationKind;
  title: string;
  emoji: string;
}

export function EscalacaoCrewPage({ config }: { config: CrewPageConfig }) {
  const { profile } = useAuth();
  const pathname = usePathname();
  const role = profile?.role || "RH";
  const canEdit = hasPermission(role, "NAVIOS", "edit") || hasPermission(role, "EMBARQUE", "embarcar");
  const profileName = profile?.full_name || "Sistema";

  const [ships, setShips] = useState<Ship[]>([]);
  const [selectedShip, setSelectedShip] = useState<string>("");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [functions, setFunctions] = useState<JobFunction[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [allocations, setAllocations] = useState<JobAllocation[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [shipsRes, empRes, fnRes, jobsRes, allocsRes] = await Promise.all([
        db.from("ships").select("*").in("status", ["AGENDADO", "EM_OPERACAO"]).order("arrival_date"),
        db.from("employees").select("id, name, role, status, bank_name, bank_agency, bank_account, bank_account_type").order("name"),
        db.from("job_functions").select("*").order("name"),
        db.from("jobs").select("*"),
        db.from("job_allocations").select("*, job_functions(name, unit), employees(name, bank_name, bank_agency, bank_account, bank_account_type)").order("added_at", { ascending: true }),
      ]);
      // Embarque tab shows only ships that are NOT costado (services array doesn't include "COSTADO").
      const allShips = (shipsRes.data as Ship[]) || [];
      setShips(allShips.filter((s) => !(s.services || []).includes("COSTADO")));
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
  const shipAllocations = useMemo(
    () => (shipJob ? allocations.filter((a) => a.job_id === shipJob.id && (a.kind || "EMBARQUE") === config.kind) : []),
    [shipJob, allocations, config.kind]
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
        <h1 className="text-2xl font-bold text-text">{config.title} {config.emoji}</h1>
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
      <h1 className="text-2xl font-bold text-text">{config.title} {config.emoji}</h1>

      <ShipSelector
        ships={ships}
        selectedShip={selectedShip}
        onSelect={setSelectedShip}
      />

      <EscalacaoTab
        ship={currentShip || null}
        shipJob={shipJob}
        allocations={shipAllocations}
        employees={employees}
        functions={functions}
        canEdit={canEdit}
        profileName={profileName}
        kind={config.kind}
        onChange={loadData}
      />
    </div>
  );
}

// ─── SHIP SELECTOR ──────────────────────────────────────────────────────────

function ShipSelector({
  ships, selectedShip, onSelect,
}: {
  ships: Ship[];
  selectedShip: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const current = ships.find((s) => s.id === selectedShip);
  const filtered = ships.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.port || "").toLowerCase().includes(q);
  });

  function statusBadge(status: string) {
    return status === "AGENDADO"
      ? { cls: "bg-blue-100 text-blue-700", label: "Agendado", icon: "📅" }
      : status === "EM_OPERACAO"
        ? { cls: "bg-amber-100 text-amber-700", label: "Em Operação", icon: "⚓" }
        : { cls: "bg-gray-100 text-gray-700", label: status, icon: "🚢" };
  }

  return (
    <div ref={ref} className="relative">
      <label className="block text-xs font-semibold text-text-light uppercase tracking-wider mb-1.5">
        🚢 Navio
      </label>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full bg-card border border-border rounded-xl p-4 text-left hover:border-primary hover:shadow-md transition flex items-center gap-3 group"
      >
        {current ? (
          <>
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center text-2xl shrink-0">
              {statusBadge(current.status).icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-bold text-text text-base truncate">{current.name}</h3>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${statusBadge(current.status).cls}`}>
                  {statusBadge(current.status).label}
                </span>
              </div>
              <div className="flex flex-wrap gap-3 mt-1 text-xs text-text-light">
                {current.port && (
                  <span className="flex items-center gap-1">📍 {current.port}</span>
                )}
                {current.arrival_date && (
                  <span className="flex items-center gap-1">
                    🛬 <span className="text-text font-medium">{formatDate(current.arrival_date)}</span>
                  </span>
                )}
                {current.departure_date && (
                  <span className="flex items-center gap-1">
                    🛫 <span className="text-text font-medium">{formatDate(current.departure_date)}</span>
                  </span>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 text-text-light text-sm">Selecione um navio...</div>
        )}
        <svg className={`w-5 h-5 text-text-light transition shrink-0 ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 mt-2 w-full bg-card border border-border rounded-xl shadow-xl overflow-hidden">
          <div className="p-2 border-b border-border bg-gray-50">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍 Buscar navio ou porto..."
              autoFocus
              className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:ring-2 focus:ring-primary outline-none bg-white"
            />
          </div>
          <div className="max-h-80 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-text-light">
                Nenhum navio encontrado
              </div>
            ) : (
              filtered.map((s) => {
                const isCurrent = s.id === selectedShip;
                const sb = statusBadge(s.status);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => { onSelect(s.id); setOpen(false); setSearch(""); }}
                    className={`w-full text-left px-3 py-3 hover:bg-blue-50 transition flex items-center gap-3 border-b border-border last:border-0 ${
                      isCurrent ? "bg-primary/5" : ""
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl shrink-0 ${
                      isCurrent ? "bg-primary text-white" : "bg-gray-100"
                    }`}>
                      {sb.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm truncate">{s.name}</p>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase ${sb.cls}`}>
                          {sb.label}
                        </span>
                        {isCurrent && (
                          <span className="text-[10px] text-primary font-bold">✓ Selecionado</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 mt-0.5 text-[11px] text-text-light">
                        {s.port && <span>📍 {s.port}</span>}
                        {s.arrival_date && <span>🛬 {formatDate(s.arrival_date)}</span>}
                        {s.departure_date && <span>🛫 {formatDate(s.departure_date)}</span>}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <div className="px-3 py-2 bg-gray-50 border-t border-border text-[10px] text-text-light text-center">
            {ships.length} navio(s) disponível(eis) (Agendado / Em Operação)
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ESCALAÇÃO TAB ──────────────────────────────────────────────────────────

function EscalacaoTab({
  ship, shipJob, allocations, employees, functions, canEdit, profileName, kind, onChange,
}: {
  ship: Ship | null;
  shipJob: Job | null;
  allocations: JobAllocation[];
  employees: Employee[];
  functions: JobFunction[];
  canEdit: boolean;
  profileName: string;
  kind: AllocationKind;
  onChange: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [editAlloc, setEditAlloc] = useState<JobAllocation | null>(null);
  const [removeAlloc, setRemoveAlloc] = useState<JobAllocation | null>(null);
  const [view, setView] = useState<"escalacao" | "historico">("escalacao");

  const activeAllocs = allocations.filter((a) => a.status === "ATIVO");

  const byFunction = new Map<string, number>();
  for (const a of activeAllocs) {
    const fn = a.job_functions?.name || "—";
    byFunction.set(fn, (byFunction.get(fn) || 0) + 1);
  }

  if (!ship) {
    return <div className="text-center py-12 text-text-light">Selecione um navio acima para escalar a equipe.</div>;
  }

  async function ensureJob(): Promise<string> {
    if (shipJob) return shipJob.id;
    const startDate = ship!.arrival_date || new Date().toISOString().slice(0, 10);
    const insRes = await db.from("jobs").insert({
      name: ship!.name,
      ship_id: ship!.id,
      start_date: startDate,
      end_date: ship!.departure_date,
      status: "ABERTO",
      port: ship!.port,
      created_by: profileName,
    } as any);
    onChange();
    const { data } = await db.from("jobs").select("id").eq("ship_id", ship!.id);
    const jobs = data as Array<{ id: string }>;
    if (insRes.error) throw new Error(insRes.error.message);
    return jobs[0].id;
  }

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-xl border border-border p-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-2xl">👥</span>
          <div>
            <p className="text-xs text-text-light uppercase tracking-wider font-semibold">Equipe Escalada</p>
            <p className="text-xl font-bold text-text">{activeAllocs.length} {activeAllocs.length === 1 ? "membro" : "membros"}</p>
          </div>
        </div>
        {byFunction.size > 0 && (
          <div className="flex flex-wrap gap-1.5 ml-2">
            {Array.from(byFunction.entries()).map(([fn, count]) => (
              <span key={fn} className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-800 font-medium">
                {fn} ×{count}
              </span>
            ))}
          </div>
        )}
        <div className="ml-auto text-[10px] text-text-light italic max-w-md text-right">
          Os valores são preenchidos em <strong>Financeiro › Pagamento de Embarque</strong>.
        </div>
      </div>

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
          👥 Escalação atual
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
          📋 Histórico ({allocations.length})
        </button>
      </div>

      {view === "escalacao" ? (
        <>
          <div className="flex justify-end">
            {canEdit && (
              <Button size="sm" onClick={() => { setEditAlloc(null); setShowAdd(true); }}>
                + Adicionar Membro
              </Button>
            )}
          </div>

          {activeAllocs.length === 0 ? (
            <div className="bg-card rounded-xl border border-border p-12 text-center text-text-light">
              <p className="text-3xl mb-2">👥</p>
              <p className="text-sm">Nenhum membro escalado ainda.</p>
              {canEdit && <p className="text-xs mt-2">Clique em &quot;Adicionar Membro&quot; para começar.</p>}
            </div>
          ) : (
            <div className="bg-card rounded-xl border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-border">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">#</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">Funcionário</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">Função</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">Adicionado por</th>
                    {canEdit && <th className="px-3 py-2 text-right text-xs font-semibold text-text-light w-20">Ações</th>}
                  </tr>
                </thead>
                <tbody>
                  {activeAllocs.map((a, idx) => (
                    <tr key={a.id} className="border-b border-border last:border-0 hover:bg-gray-50">
                      <td className="px-3 py-2 text-text-light">{idx + 1}</td>
                      <td className="px-3 py-2">
                        <p className="font-medium">{a.employees?.name || "—"}</p>
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                          {a.job_functions?.name || "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-text-light">
                        {a.added_by || "—"}
                        {a.added_at && <span className="block text-[10px]">{formatDateTime(a.added_at)}</span>}
                      </td>
                      {canEdit && (
                        <td className="px-3 py-2">
                          <div className="flex gap-1 justify-end">
                            <button onClick={() => { setEditAlloc(a); setShowAdd(true); }} className="p-1 text-primary hover:bg-blue-50 rounded" title="Editar">
                              <EditIcon className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={() => setRemoveAlloc(a)} className="p-1 text-danger hover:bg-red-50 rounded" title="Remover">
                              <TrashIcon className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <EmbarqueHistoricoView allocations={allocations} shipName={ship.name} />
      )}

      <CrewFormModal
        open={showAdd}
        item={editAlloc}
        ensureJob={ensureJob}
        shipId={ship.id}
        employees={employees}
        functions={functions}
        existingAllocs={activeAllocs.filter((a) => a.id !== editAlloc?.id)}
        profileName={profileName}
        kind={kind}
        onClose={() => { setShowAdd(false); setEditAlloc(null); }}
        onSaved={() => { setShowAdd(false); setEditAlloc(null); onChange(); }}
      />

      <RemoveModal
        open={!!removeAlloc}
        target={removeAlloc}
        profileName={profileName}
        onClose={() => setRemoveAlloc(null)}
        onSaved={() => { setRemoveAlloc(null); onChange(); }}
      />
    </div>
  );
}

// ─── Crew Form Modal (add/edit member) ──────────────────────────────────────

function CrewFormModal({
  open, item, ensureJob, shipId, employees, functions, existingAllocs, profileName, kind, onClose, onSaved,
}: {
  open: boolean;
  item: JobAllocation | null;
  ensureJob: () => Promise<string>;
  shipId: string;
  employees: Employee[];
  functions: JobFunction[];
  existingAllocs: JobAllocation[];
  profileName: string;
  kind: AllocationKind;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState("");
  const [empId, setEmpId] = useState<string>("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [fnId, setFnId] = useState("");
  const [perEmpFn, setPerEmpFn] = useState<Map<number, string>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showQuickAdd, setShowQuickAdd] = useState(false);

  const isEditing = !!item;

  useEffect(() => {
    if (open) {
      if (item) {
        setEmpId(item.employee_id?.toString() || "");
        setFnId(item.function_id.toString());
        setSearch(item.employees?.name || "");
        setSelectedIds(new Set());
        setPerEmpFn(new Map());
      } else {
        setEmpId(""); setFnId(""); setSearch("");
        setSelectedIds(new Set());
        setPerEmpFn(new Map());
      }
      setError(""); setShowQuickAdd(false);
    }
  }, [open, item]);

  const allocatedIds = new Set(
    existingAllocs.filter((a) => a.id !== item?.id).map((a) => a.employee_id).filter(Boolean) as number[]
  );

  const matches = employees
    .filter((e) => e.status === "ATIVO")
    .filter((e) => !allocatedIds.has(e.id))
    .filter((e) => {
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return e.name.toLowerCase().includes(q) || (e.role || "").toLowerCase().includes(q);
    });

  const selectedEmp = empId ? employees.find((e) => String(e.id) === empId) : null;

  function findFnIdForRole(role: string | null): string {
    if (!role) return "";
    const fn = functions.find((f) => f.name.toUpperCase() === role.toUpperCase());
    return fn ? String(fn.id) : "";
  }

  function selectEmployee(emp: Employee) {
    setEmpId(String(emp.id));
    setSearch(emp.name);
    const guessed = findFnIdForRole(emp.role);
    if (guessed) setFnId(guessed);
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

  function clearSelection() {
    setEmpId(""); setSearch(""); setFnId("");
  }

  function removeFromMulti(id: number) {
    setSelectedIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    setPerEmpFn((m) => { const nm = new Map(m); nm.delete(id); return nm; });
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (isEditing) {
      if (!empId) { setError("Selecione um funcionário."); return; }
      if (!fnId) { setError("Selecione a função."); return; }
      setSaving(true);
      try {
        await db.from("job_allocations").update({
          function_id: parseInt(fnId),
          employee_id: parseInt(empId),
          quantity: item?.quantity ?? 0,
          rate: item?.rate ?? 0,
          pluxee_value: item?.pluxee_value ?? 0,
        }).eq("id", item!.id);
        onSaved();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSaving(false);
      }
      return;
    }

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
      const rows = Array.from(selectedIds).map((id) => ({
        job_id: jobId,
        function_id: parseInt(perEmpFn.get(id)!),
        employee_id: id,
        quantity: 0,
        rate: 0,
        pluxee_value: 0,
        status: "ATIVO",
        kind,
        added_by: profileName,
        added_at: now,
      }));
      for (const row of rows) {
        await db.from("job_allocations").insert(row);
      }
      // Fire-and-forget WhatsApp notification — only kicks in for EMBARQUE kind
      // here (COSTADO has its own modal in escalacao-costado-page that already
      // posts with shift info).
      if (kind === "EMBARQUE" && shipId) {
        fetch("/api/escalacao/notify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            shipId,
            kind: "EMBARQUE",
            employeeIds: Array.from(selectedIds),
          }),
        }).catch((err) => console.warn("[escalacao] notify failed:", err));
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleQuickAdded(newEmpId: number, newRole: string | null) {
    setShowQuickAdd(false);
    const { data } = await db.from("employees").select("id, name, role, status").eq("id", newEmpId);
    const fresh = (data as Employee[])?.[0];
    if (!fresh) return;
    if (isEditing) {
      setEmpId(String(fresh.id));
      setSearch(fresh.name);
      const guessed = findFnIdForRole(newRole);
      if (guessed) setFnId(guessed);
    } else {
      setSelectedIds((prev) => new Set(prev).add(fresh.id));
      const guessed = findFnIdForRole(newRole);
      if (guessed) setPerEmpFn((m) => new Map(m).set(fresh.id, guessed));
      setSearch("");
    }
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  const activeFunctions = functions.filter((f) => f.active);
  const selectedList = Array.from(selectedIds).map((id) => employees.find((e) => e.id === id)).filter(Boolean) as Employee[];

  return (
    <Modal open={open} onClose={onClose} title={isEditing ? "Editar Membro" : "Adicionar Membros à Equipe"} maxWidth="max-w-2xl">
      <form onSubmit={handleSave} className="space-y-4">
        {isEditing ? (
          <>
            <div>
              <label className="block text-sm font-medium mb-1">Funcionário *</label>
              {selectedEmp ? (
                <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5">
                  <div>
                    <p className="font-semibold text-emerald-900">{selectedEmp.name}</p>
                    {selectedEmp.role && <p className="text-xs text-emerald-700">{selectedEmp.role}</p>}
                  </div>
                  <button type="button" onClick={clearSelection} className="text-xs text-emerald-700 hover:text-emerald-900 underline">
                    Trocar
                  </button>
                </div>
              ) : (
                <>
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
                      matches.slice(0, 30).map((e) => (
                        <button
                          key={e.id}
                          type="button"
                          onClick={() => selectEmployee(e)}
                          className="w-full text-left px-3 py-2 hover:bg-blue-50 border-b border-border last:border-0 transition"
                        >
                          <p className="text-sm font-medium">{e.name}</p>
                          {e.role && <p className="text-[10px] text-text-light">{e.role}</p>}
                        </button>
                      ))
                    )}
                  </div>
                </>
              )}
            </div>

            {selectedEmp && (
              <div>
                <label className="block text-sm font-medium mb-1">Função *</label>
                <select value={fnId} onChange={(e) => setFnId(e.target.value)} required className={inputCls}>
                  <option value="">Selecione...</option>
                  {activeFunctions.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
            )}
          </>
        ) : (
          <>
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
              <button
                type="button"
                onClick={() => setShowQuickAdd(true)}
                className="mt-2 text-xs px-3 py-1.5 bg-primary/10 text-primary rounded-lg hover:bg-primary/20 font-medium transition"
              >
                ⊕ Cadastrar novo funcionário
              </button>
            </div>
          </>
        )}

        {error && (
          <p className="text-xs text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button
            type="submit"
            disabled={saving || (isEditing ? !empId : selectedIds.size === 0)}
          >
            {saving
              ? "Salvando..."
              : isEditing
                ? "Salvar"
                : selectedIds.size > 1
                  ? `Adicionar ${selectedIds.size} membros`
                  : "Adicionar"}
          </Button>
        </div>
      </form>

      <QuickAddEmployeeModal
        open={showQuickAdd}
        functions={functions}
        prefillName={search}
        profileName={profileName}
        onClose={() => setShowQuickAdd(false)}
        onAdded={handleQuickAdded}
      />
    </Modal>
  );
}

// ─── Quick Add Employee ─────────────────────────────────────────────────────

function QuickAddEmployeeModal({
  open, functions, prefillName, profileName, onClose, onAdded,
}: {
  open: boolean;
  functions: JobFunction[];
  prefillName: string;
  profileName: string;
  onClose: () => void;
  onAdded: (id: number, role: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [roleStr, setRoleStr] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setName(prefillName.trim()); setRoleStr(""); setPhone(""); setError("");
    }
  }, [open, prefillName]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    try {
      const insRes = await db.from("employees").insert({
        name: name.trim().toUpperCase(),
        role: roleStr.trim().toUpperCase() || null,
        phone: phone.trim() || null,
        status: "ATIVO",
        sector: "OPERACIONAL",
        updated_by: profileName,
      });
      if (insRes.error) {
        setError(insRes.error.message);
        return;
      }
      const { data } = await db.from("employees").select("id, role").eq("name", name.trim().toUpperCase()).order("id", { ascending: false }).limit(1);
      const fresh = (data as Array<{ id: number; role: string | null }>)?.[0];
      if (fresh) {
        onAdded(fresh.id, fresh.role);
      } else {
        onClose();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title="Cadastrar Novo Funcionário">
      <form onSubmit={handleSave} className="space-y-4">
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-900">
          💡 Cadastro rápido. Você pode completar os dados (CPF, banco, etc.) depois em <strong>Colaboradores</strong>.
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Nome *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required autoFocus className={inputCls} placeholder="Nome completo" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Função</label>
          <input
            type="text"
            value={roleStr}
            onChange={(e) => setRoleStr(e.target.value.toUpperCase())}
            list="quick-role-options"
            className={inputCls}
            placeholder="WAP, AJUDANTE, ESFREGÃO..."
          />
          <datalist id="quick-role-options">
            {functions.map((f) => <option key={f.id} value={f.name} />)}
          </datalist>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Telefone</label>
          <input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} placeholder="(13) 99999-9999" />
        </div>
        {error && <p className="text-xs text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Cadastrar e Selecionar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Remove Modal ───────────────────────────────────────────────────────────

function RemoveModal({
  open, target, profileName, onClose, onSaved,
}: {
  open: boolean;
  target: JobAllocation | null;
  profileName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [reason, setReason] = useState("");
  const [actualDays, setActualDays] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open && target) {
      setReason("");
      setActualDays(target.quantity.toString());
    }
  }, [open, target]);

  async function handleRemove(e: React.FormEvent) {
    e.preventDefault();
    if (!target || !reason.trim()) return;
    setSaving(true);
    await db.from("job_allocations").update({
      status: "REMOVIDO",
      quantity: parseInt(actualDays) || 0,
      removed_by: profileName,
      removed_at: new Date().toISOString(),
      removal_reason: reason.trim(),
    }).eq("id", target.id);
    setSaving(false);
    onSaved();
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";
  if (!target) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Remover ${target.employees?.name || "membro"}`}>
      <form onSubmit={handleRemove} className="space-y-4">
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs">
          <p className="font-semibold text-red-900 mb-1">⚠️ Remover do navio:</p>
          <p>{target.employees?.name || "—"} · {target.job_functions?.name}</p>
          <p className="text-[10px] text-red-700 mt-2">A alocação fica registrada no histórico, marcada como REMOVIDA.</p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Dias efetivamente trabalhados</label>
          <input type="number" min={0} value={actualDays} onChange={(e) => setActualDays(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Motivo da Remoção *</label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            className={inputCls}
            placeholder="Desistência, demissão..."
            list="reason-options"
          />
          <datalist id="reason-options">
            <option value="Desistência" />
            <option value="Doença" />
            <option value="Demissão" />
            <option value="Acidente" />
            <option value="Falta no embarque" />
            <option value="Reescalado em outro navio" />
          </datalist>
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving} variant="danger">{saving ? "Removendo..." : "Confirmar Remoção"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Histórico de Embarque ──────────────────────────────────────────────────

function EmbarqueHistoricoView({ allocations, shipName }: { allocations: JobAllocation[]; shipName: string }) {
  const sorted = useMemo(
    () => [...allocations].sort((a, b) => a.added_at.localeCompare(b.added_at)),
    [allocations],
  );

  if (sorted.length === 0) {
    return (
      <div className="bg-card rounded-xl border border-border p-12 text-center text-text-light">
        <p className="text-3xl mb-2">📋</p>
        <p className="text-sm">Nenhuma alocação registrada para este navio ainda.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <header className="px-6 pt-4 pb-3 border-b border-border">
          <h2 className="text-base font-semibold text-text">Histórico de Escalação · {shipName}</h2>
          <p className="text-xs text-text-light mt-0.5">
            Toda alocação feita neste navio, com a <strong>função que o colaborador exerceu aqui</strong> (pode diferir do cargo padrão do cadastro).
          </p>
        </header>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-border">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">#</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">Funcionário</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">Função no navio</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">Status</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">Adicionado</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">Removido</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((a, idx) => {
                const statusCls = a.status === "ATIVO"
                  ? "bg-emerald-100 text-emerald-700"
                  : a.status === "REMOVIDO"
                    ? "bg-red-100 text-red-700"
                    : "bg-amber-100 text-amber-700";
                return (
                  <tr key={a.id} className="border-b border-border last:border-0 hover:bg-gray-50">
                    <td className="px-3 py-2 text-text-light tabular-nums">{idx + 1}</td>
                    <td className="px-3 py-2 font-medium">{a.employees?.name || "—"}</td>
                    <td className="px-3 py-2">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                        {a.job_functions?.name || "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${statusCls}`}>
                        {a.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-text-light">
                      <span className="block">{a.added_by || "—"}</span>
                      <span className="text-[10px]">{formatDateTime(a.added_at)}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-text-light">
                      {a.removed_at ? (
                        <>
                          <span className="block">{a.removed_by || "—"}</span>
                          <span className="text-[10px]">{formatDateTime(a.removed_at)}</span>
                          {a.removal_reason && (
                            <span className="block text-[10px] italic">&quot;{a.removal_reason}&quot;</span>
                          )}
                        </>
                      ) : (
                        <span className="text-text-light/60">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
