"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { Tabs } from "@/components/ui/tabs";
import { EditIcon, TrashIcon } from "@/components/icons";
import { formatDate } from "@/lib/utils";
import type {
  StockItem,
  JobFunction,
  Job,
  JobAllocation,
  Employee,
} from "@/types/database";

// ─── Types ──────────────────────────────────────────────────────────────────

interface Ship {
  id: string;
  name: string;
  arrival_date: string | null;
  departure_date: string | null;
  port: string | null;
  status: string;
  assigned_team: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function brl(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const v = typeof n === "number" ? n : parseFloat(String(n));
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function EmbarquePage() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const role = profile?.role || "RH";
  const canEmbarcar = hasPermission(role, "EMBARQUE", "embarcar");
  const canEdit = hasPermission(role, "NAVIOS", "edit") || hasPermission(role, "EMBARQUE", "embarcar");
  const profileName = profile?.full_name || "Sistema";

  const [ships, setShips] = useState<Ship[]>([]);
  const [selectedShip, setSelectedShip] = useState<string>("");
  const [selectedTeam, setSelectedTeam] = useState<"EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3">("EQUIPE_1");
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [functions, setFunctions] = useState<JobFunction[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [allocations, setAllocations] = useState<JobAllocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmEmbark, setConfirmEmbark] = useState(false);
  const [embarking, setEmbarking] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [shipsRes, stockRes, empRes, fnRes, jobsRes, allocsRes] = await Promise.all([
        db.from("ships").select("*").in("status", ["AGENDADO", "EM_OPERACAO"]).order("arrival_date"),
        db.from("stock_items").select("*").order("name"),
        db.from("employees").select("id, name, role, status, bank_name, bank_agency, bank_account, bank_account_type").order("name"),
        db.from("job_functions").select("*").order("name"),
        db.from("jobs").select("*"),
        db.from("job_allocations").select("*, job_functions(name, unit), employees(name, bank_name, bank_agency, bank_account, bank_account_type)").order("added_at", { ascending: true }),
      ]);
      setShips((shipsRes.data as Ship[]) || []);
      setStockItems(stockRes.data || []);
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
      if (ships[0].assigned_team) {
        setSelectedTeam(ships[0].assigned_team as "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3");
      }
    }
  }, [ships, selectedShip]);

  const currentShip = ships.find((s) => s.id === selectedShip);
  const shipJob = useMemo(() => jobs.find((j) => j.ship_id === selectedShip) ?? null, [jobs, selectedShip]);
  const shipAllocations = useMemo(
    () => (shipJob ? allocations.filter((a) => a.job_id === shipJob.id) : []),
    [shipJob, allocations]
  );

  // Filter stock items by selected team
  const teamItems = stockItems
    .filter((i) => (i as any).team === selectedTeam)
    .filter((i) => (i as any).default_quantity > 0);

  // Calculate readiness
  const totalDefault = teamItems.reduce((s, i) => s + ((i as any).default_quantity || 0), 0);
  const totalCurrent = teamItems.reduce((s, i) => s + Math.min(i.quantity, (i as any).default_quantity || 0), 0);
  const pct = totalDefault > 0 ? Math.round((totalCurrent / totalDefault) * 100) : 0;
  const allReady = totalCurrent >= totalDefault && totalDefault > 0;

  // Items with status
  const itemsWithStatus = teamItems.map((item) => {
    const def = (item as any).default_quantity || 0;
    const current = item.quantity;
    const falta = Math.max(0, def - current);
    const ready = current >= def;
    return { ...item, default_quantity: def, falta, ready };
  });

  const readyCount = itemsWithStatus.filter((i) => i.ready).length;
  const missingCount = itemsWithStatus.filter((i) => !i.ready).length;

  async function handleEmbarcar() {
    if (!currentShip) return;
    setEmbarking(true);
    const actor = profile?.full_name || "Sistema";

    for (const item of itemsWithStatus) {
      if (item.quantity <= 0) continue;
      const toConsume = Math.min(item.quantity, item.default_quantity);
      await db.from("stock_movements").insert({
        stock_item_id: item.id,
        movement_type: "BAIXA",
        quantity: toConsume,
        movement_date: new Date().toISOString().split("T")[0],
        notes: `Embarque: ${currentShip.name} (${selectedTeam})`,
        created_by: actor,
      } as any);
      await db.from("stock_items").update({
        quantity: item.quantity - toConsume,
        updated_by: actor,
      } as any).eq("id", item.id);
    }

    if (currentShip.status === "AGENDADO") {
      await db.from("ships").update({ status: "EM_OPERACAO" } as any).eq("id", selectedShip);
    }

    setEmbarking(false);
    setConfirmEmbark(false);
    loadData();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-2">
          <span className="text-4xl animate-bounce">🚢</span>
          <span className="text-sm text-text-light animate-pulse">Carregando embarque...</span>
        </div>
      </div>
    );
  }

  if (ships.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-text">Embarque</h1>
        <div className="bg-card rounded-xl shadow-sm border border-border p-8 text-center text-text-light">
          <span className="text-4xl block mb-3">🚢</span>
          <p className="font-medium text-text mb-1">Nenhum navio agendado ou em operação</p>
          <p className="text-sm">Cadastre navios na aba <strong>Navios</strong> para preparar embarques.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-text">Embarque ⚓</h1>

      {/* Ship selector */}
      <ShipSelector
        ships={ships}
        selectedShip={selectedShip}
        onSelect={setSelectedShip}
      />

      {/* Tabs */}
      <Tabs
        tabs={[
          {
            key: "escalacao",
            label: "👥 Escalação de Equipe",
            content: (
              <EscalacaoTab
                ship={currentShip || null}
                shipJob={shipJob}
                allocations={shipAllocations}
                employees={employees}
                functions={functions}
                canEdit={canEdit}
                profileName={profileName}
                onChange={loadData}
              />
            ),
          },
          {
            key: "estoque",
            label: "📦 Estoque para Embarque",
            content: (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-2 items-end justify-between">
                  <div className="flex gap-2 items-center">
                    <span className="text-xs text-text-light font-semibold uppercase tracking-wider">Equipe (estoque):</span>
                    <select
                      value={selectedTeam}
                      onChange={(e) => setSelectedTeam(e.target.value as any)}
                      className="px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                    >
                      <option value="EQUIPE_1">Equipe 1</option>
                      <option value="EQUIPE_2">Equipe 2</option>
                      <option value="EQUIPE_3">Equipe 3</option>
                    </select>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className={`text-sm font-bold px-3 py-1.5 rounded-full ${
                      allReady ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                    }`}>
                      {pct}% pronto
                    </span>
                    <span className="text-xs text-text-light">
                      {readyCount} prontos · {missingCount} com falta · {totalCurrent}/{totalDefault} itens
                    </span>
                    {canEmbarcar && teamItems.length > 0 && (
                      <Button size="sm" variant="warning" onClick={() => setConfirmEmbark(true)}>
                        ⚓ Embarcar
                      </Button>
                    )}
                  </div>
                </div>

                <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 border-b border-border">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-semibold text-text-light uppercase">Item</th>
                          <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Categoria</th>
                          <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Padrão</th>
                          <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Em Estoque</th>
                          <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {itemsWithStatus.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="px-4 py-12 text-center text-text-light">
                              <span className="text-3xl block mb-2">📦</span>
                              Nenhum item com quantidade padrão definida
                            </td>
                          </tr>
                        ) : (
                          itemsWithStatus.map((item) => (
                            <tr key={item.id} className={`hover:bg-gray-50 ${!item.ready ? "bg-red-50/40" : ""}`}>
                              <td className="px-4 py-3 font-medium">{item.name}</td>
                              <td className="px-4 py-3 text-center">
                                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                                  {item.category === "CARNE" ? "Carne" : item.category === "FEIRA" ? "Feira" : "Suprimentos"}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-center text-text-light">{item.default_quantity}</td>
                              <td className={`px-4 py-3 text-center font-bold ${!item.ready ? "text-danger" : "text-success"}`}>
                                {item.quantity}
                              </td>
                              <td className="px-4 py-3 text-center">
                                {item.ready ? (
                                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">✓ Pronto</span>
                                ) : (
                                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">Falta {item.falta}</span>
                                )}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ),
          },
        ]}
      />

      <ConfirmDialog
        open={confirmEmbark}
        onClose={() => setConfirmEmbark(false)}
        onConfirm={handleEmbarcar}
        title="Confirmar Embarque"
        message={`Embarcar ${selectedTeam} no navio "${currentShip?.name}"? As quantidades padrão serão retiradas do estoque desta equipe.`}
        confirmLabel="⚓ Confirmar Embarque"
        variant="warning"
        loading={embarking}
      />
    </div>
  );
}

// ─── SHIP SELECTOR (dropdown customizado) ───────────────────────────────────

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

  // Fecha ao clicar fora
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
        🚢 Navio em Operação
      </label>

      {/* Trigger button */}
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

      {/* Dropdown */}
      {open && (
        <div className="absolute z-30 mt-2 w-full bg-card border border-border rounded-xl shadow-xl overflow-hidden">
          {/* Search */}
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

          {/* List */}
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

          {/* Footer */}
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
  ship, shipJob, allocations, employees, functions, canEdit, profileName, onChange,
}: {
  ship: Ship | null;
  shipJob: Job | null;
  allocations: JobAllocation[];
  employees: Employee[];
  functions: JobFunction[];
  canEdit: boolean;
  profileName: string;
  onChange: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [editAlloc, setEditAlloc] = useState<JobAllocation | null>(null);
  const [substituteAlloc, setSubstituteAlloc] = useState<JobAllocation | null>(null);
  const [removeAlloc, setRemoveAlloc] = useState<JobAllocation | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Active members are status=ATIVO. Removed/Substituted only show in history.
  const activeAllocs = allocations.filter((a) => a.status === "ATIVO");

  // Agrupa por função pra resumir a equipe
  const byFunction = new Map<string, number>();
  for (const a of activeAllocs) {
    const fn = a.job_functions?.name || "—";
    byFunction.set(fn, (byFunction.get(fn) || 0) + 1);
  }

  if (!ship) {
    return <div className="text-center py-12 text-text-light">Selecione um navio acima para escalar a equipe.</div>;
  }

  // ── Auto-create job if first allocation ─────────────────────────────────
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
    // Reload to get the new job id; the callback will re-fetch.
    onChange();
    // We need the job id to insert the allocation immediately.
    // Re-query to grab it.
    const { data } = await db.from("jobs").select("id").eq("ship_id", ship!.id);
    const jobs = data as Array<{ id: string }>;
    if (insRes.error) throw new Error(insRes.error.message);
    return jobs[0].id;
  }

  return (
    <div className="space-y-4">
      {/* Resumo da equipe (sem valores) */}
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
          Valores e dias trabalhados são preenchidos no <strong>Financeiro</strong> ao final do trabalho.
        </div>
      </div>

      {/* Header actions */}
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={() => setShowHistory(!showHistory)}
            className="px-3 py-1.5 text-xs font-medium bg-gray-100 text-text rounded-lg hover:bg-gray-200 transition"
          >
            📋 Histórico ({allocations.length})
          </button>
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => { setEditAlloc(null); setShowAdd(true); }}>
            + Adicionar Membro
          </Button>
        )}
      </div>

      {/* Active team members */}
      {activeAllocs.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-12 text-center text-text-light">
          <p className="text-3xl mb-2">👥</p>
          <p className="text-sm">Nenhum membro escalado ainda.</p>
          {canEdit && <p className="text-xs mt-2">Clique em "Adicionar Membro" para começar.</p>}
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
                {canEdit && <th className="px-3 py-2 text-right text-xs font-semibold text-text-light w-24">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {activeAllocs.map((a, idx) => {
                const isReplacement = a.replaces_id != null;
                return (
                  <tr key={a.id} className="border-b border-border last:border-0 hover:bg-gray-50">
                    <td className="px-3 py-2 text-text-light">{idx + 1}</td>
                    <td className="px-3 py-2">
                      <div>
                        <p className="font-medium">{a.employees?.name || "—"}</p>
                        {isReplacement && <span className="text-[10px] text-amber-700">↻ substituto</span>}
                      </div>
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
                          <button onClick={() => setSubstituteAlloc(a)} className="p-1 text-amber-700 hover:bg-amber-50 rounded" title="Substituir">
                            🔄
                          </button>
                          <button onClick={() => setRemoveAlloc(a)} className="p-1 text-danger hover:bg-red-50 rounded" title="Remover">
                            <TrashIcon className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* History */}
      {showHistory && (
        <HistoryTimeline allocations={allocations} />
      )}

      {/* Add / Edit Member Modal */}
      <CrewFormModal
        open={showAdd}
        item={editAlloc}
        ensureJob={ensureJob}
        employees={employees}
        functions={functions}
        existingAllocs={activeAllocs.filter((a) => a.id !== editAlloc?.id)}
        profileName={profileName}
        onClose={() => { setShowAdd(false); setEditAlloc(null); }}
        onSaved={() => { setShowAdd(false); setEditAlloc(null); onChange(); }}
      />

      {/* Substitute Modal */}
      <SubstituteModal
        open={!!substituteAlloc}
        target={substituteAlloc}
        employees={employees}
        existingAllocs={activeAllocs}
        profileName={profileName}
        onClose={() => setSubstituteAlloc(null)}
        onSaved={() => { setSubstituteAlloc(null); onChange(); }}
      />

      {/* Remove Modal */}
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
//
// Form simplificado: só pede Funcionário + Função.
// Dias e Valor Diário são preenchidos depois, em massa por função, no
// "Finalizar Trabalho".

function CrewFormModal({
  open, item, ensureJob, employees, functions, existingAllocs, profileName, onClose, onSaved,
}: {
  open: boolean;
  item: JobAllocation | null;
  ensureJob: () => Promise<string>;
  employees: Employee[];
  functions: JobFunction[];
  existingAllocs: JobAllocation[];
  profileName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState("");
  const [empId, setEmpId] = useState<string>("");
  const [fnId, setFnId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showQuickAdd, setShowQuickAdd] = useState(false);

  useEffect(() => {
    if (open) {
      if (item) {
        setEmpId(item.employee_id?.toString() || "");
        setFnId(item.function_id.toString());
        setNotes(item.notes || "");
        setSearch(item.employees?.name || "");
      } else {
        setEmpId(""); setFnId(""); setNotes(""); setSearch("");
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

  function selectEmployee(emp: Employee) {
    setEmpId(String(emp.id));
    setSearch(emp.name);
    const fn = functions.find((f) => f.name.toUpperCase() === (emp.role || "").toUpperCase());
    if (fn) setFnId(String(fn.id));
  }

  function clearSelection() {
    setEmpId(""); setSearch(""); setFnId("");
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!empId) { setError("Selecione ou cadastre um funcionário."); return; }
    if (!fnId) { setError("Selecione a função."); return; }

    setSaving(true);
    try {
      const payload = {
        function_id: parseInt(fnId),
        employee_id: parseInt(empId),
        quantity: item?.quantity ?? 0, // dias = 0 até finalizar
        rate: item?.rate ?? 0, // valor diário = 0 até finalizar
        pluxee_value: item?.pluxee_value ?? 0,
        notes: notes.trim() || null,
      };
      if (item) {
        await db.from("job_allocations").update(payload).eq("id", item.id);
      } else {
        const jobId = await ensureJob();
        await db.from("job_allocations").insert({
          ...payload,
          job_id: jobId,
          status: "ATIVO",
          added_by: profileName,
          added_at: new Date().toISOString(),
        });
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
    if (fresh) {
      setEmpId(String(fresh.id));
      setSearch(fresh.name);
      if (newRole) {
        const fn = functions.find((f) => f.name.toUpperCase() === newRole.toUpperCase());
        if (fn) setFnId(String(fn.id));
      }
    }
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Membro" : "Adicionar Membro à Equipe"}>
      <form onSubmit={handleSave} className="space-y-4">
        {/* Funcionário (busca) */}
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
              <button
                type="button"
                onClick={() => setShowQuickAdd(true)}
                className="mt-2 text-xs px-3 py-1.5 bg-primary/10 text-primary rounded-lg hover:bg-primary/20 font-medium transition"
              >
                ⊕ Cadastrar novo funcionário
              </button>
            </>
          )}
        </div>

        {/* Função (auto-preenchida do cadastro, override possível) */}
        {selectedEmp && (
          <div>
            <label className="block text-sm font-medium mb-1">Função *</label>
            <select value={fnId} onChange={(e) => setFnId(e.target.value)} required className={inputCls}>
              <option value="">Selecione...</option>
              {functions.filter((f) => f.active).map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
            <p className="text-[10px] text-text-light mt-1">
              {selectedEmp.role
                ? <>Sugerido pelo cadastro: <strong>{selectedEmp.role}</strong></>
                : <em>Funcionário sem função padrão cadastrada.</em>}
            </p>
          </div>
        )}

        {/* Aviso sobre dias e valor */}
        {selectedEmp && !item && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-900">
            💡 Os <strong>dias trabalhados</strong> e o <strong>valor diário</strong> são preenchidos
            ao final do trabalho — em massa por função no botão <strong>🏁 Finalizar</strong>.
          </div>
        )}

        {/* Observações */}
        {selectedEmp && (
          <div>
            <label className="block text-sm font-medium mb-1">Observações</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${inputCls} resize-none`} />
          </div>
        )}

        {error && (
          <p className="text-xs text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>
        )}

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving || !empId}>{saving ? "Salvando..." : item ? "Salvar" : "Adicionar"}</Button>
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

// ─── Quick Add Employee (cadastro rápido inline) ────────────────────────────

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
      // Re-query the freshly created employee by name
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

// ─── Substitute Modal ───────────────────────────────────────────────────────

function SubstituteModal({
  open, target, employees, existingAllocs, profileName, onClose, onSaved,
}: {
  open: boolean;
  target: JobAllocation | null;
  employees: Employee[];
  existingAllocs: JobAllocation[];
  profileName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [newEmpId, setNewEmpId] = useState("");
  const [reason, setReason] = useState("");
  const [actualDays, setActualDays] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open && target) {
      setNewEmpId("");
      setReason("");
      setActualDays(target.quantity.toString());
      setError("");
    }
  }, [open, target]);

  async function handleSubstitute(e: React.FormEvent) {
    e.preventDefault();
    if (!target || !newEmpId || !reason.trim()) {
      setError("Selecione o substituto e informe o motivo.");
      return;
    }
    if (existingAllocs.some((a) => a.id !== target.id && String(a.employee_id) === newEmpId)) {
      setError("Esse funcionário já está escalado.");
      return;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      // Mark target as SUBSTITUIDO with adjusted days and reason
      await db.from("job_allocations").update({
        status: "SUBSTITUIDO",
        quantity: parseInt(actualDays) || 0,
        removed_by: profileName,
        removed_at: now,
        removal_reason: reason.trim(),
      }).eq("id", target.id);

      // Create new allocation as ATIVO with replaces_id
      await db.from("job_allocations").insert({
        job_id: target.job_id,
        function_id: target.function_id,
        employee_id: parseInt(newEmpId),
        quantity: 1, // novo começa com 1, ajusta depois
        rate: target.rate,
        pluxee_value: 0,
        status: "ATIVO",
        replaces_id: target.id,
        added_by: profileName,
        added_at: now,
      });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";
  if (!target) return null;

  return (
    <Modal open={open} onClose={onClose} title={`Substituir ${target.employees?.name || "membro"}`}>
      <form onSubmit={handleSubstitute} className="space-y-4">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs">
          <p className="font-semibold text-amber-900 mb-1">⚠️ Você vai substituir:</p>
          <p>{target.employees?.name || "—"} · {target.job_functions?.name} · {brl(target.rate)}/dia</p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Substituto *</label>
          <select value={newEmpId} onChange={(e) => setNewEmpId(e.target.value)} required className={inputCls}>
            <option value="">Selecione...</option>
            {employees
              .filter((e) => e.status === "ATIVO" && e.id !== target.employee_id)
              .map((e) => (
                <option key={e.id} value={e.id}>{e.name} {e.role ? `· ${e.role}` : ""}</option>
              ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Dias trabalhados pelo original</label>
          <input type="number" min={0} value={actualDays} onChange={(e) => setActualDays(e.target.value)} className={inputCls} />
          <p className="text-[10px] text-text-light mt-1">Coloque 0 se não trabalhou nenhum dia. Os dias do substituto você ajusta depois.</p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Motivo *</label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            className={inputCls}
            placeholder="Desistência, doença, atraso..."
            list="reason-options"
          />
          <datalist id="reason-options">
            <option value="Desistência" />
            <option value="Doença" />
            <option value="Atraso" />
            <option value="Falta" />
            <option value="Demissão" />
            <option value="Acidente" />
          </datalist>
        </div>
        {error && <p className="text-xs text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Confirmar Substituição"}</Button>
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
          <p>{target.employees?.name || "—"} · {target.job_functions?.name} · {brl(target.rate)}/dia</p>
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

// ─── History Timeline ───────────────────────────────────────────────────────

interface TimelineEvent {
  at: string;
  type: "added" | "removed" | "substituted_out" | "substituted_in";
  by: string;
  description: string;
  reason?: string;
}

function HistoryTimeline({ allocations }: { allocations: JobAllocation[] }) {
  const events: TimelineEvent[] = [];
  for (const a of allocations) {
    events.push({
      at: a.added_at,
      type: a.replaces_id ? "substituted_in" : "added",
      by: a.added_by || "—",
      description: `${a.employees?.name || "—"} (${a.job_functions?.name || "—"}) entrou na equipe`,
    });
    if (a.removed_at) {
      events.push({
        at: a.removed_at,
        type: a.status === "SUBSTITUIDO" ? "substituted_out" : "removed",
        by: a.removed_by || "—",
        description: `${a.employees?.name || "—"} (${a.job_functions?.name || "—"}) ${a.status === "SUBSTITUIDO" ? "foi substituído" : "foi removido"}`,
        reason: a.removal_reason || undefined,
      });
    }
  }
  events.sort((a, b) => b.at.localeCompare(a.at));

  if (events.length === 0) {
    return <div className="text-center py-8 text-text-light text-xs">Sem histórico ainda.</div>;
  }

  const ICONS: Record<TimelineEvent["type"], string> = {
    added: "✅",
    removed: "❌",
    substituted_out: "🔄",
    substituted_in: "↻",
  };
  const COLORS: Record<TimelineEvent["type"], string> = {
    added: "border-emerald-200 bg-emerald-50",
    removed: "border-red-200 bg-red-50",
    substituted_out: "border-amber-200 bg-amber-50",
    substituted_in: "border-blue-200 bg-blue-50",
  };

  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <h3 className="text-sm font-semibold mb-3">📋 Histórico Completo da Equipe</h3>
      <div className="space-y-2">
        {events.map((e, idx) => (
          <div key={idx} className={`rounded-lg border p-2 text-xs ${COLORS[e.type]}`}>
            <div className="flex justify-between gap-2">
              <div>
                <span className="mr-2">{ICONS[e.type]}</span>
                <span>{e.description}</span>
                {e.reason && <span className="text-text-light italic"> — "{e.reason}"</span>}
              </div>
              <div className="text-text-light text-[10px] whitespace-nowrap">
                {formatDateTime(e.at)} por <strong>{e.by}</strong>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
