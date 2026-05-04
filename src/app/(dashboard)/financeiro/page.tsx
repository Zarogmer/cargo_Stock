"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { Tabs } from "@/components/ui/tabs";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import type {
  JobFunction,
  JobFunctionRate,
  JobUnit,
  Job,
  JobAllocation,
  JobAdjustment,
  JobStatus,
  AdjustmentType,
  Ship,
  Employee,
} from "@/types/database";

// ─── Helpers ────────────────────────────────────────────────────────────────

const UNIT_LABELS: Record<JobUnit, string> = {
  POR_NAVIO: "por navio",
  POR_DIA: "por dia",
  POR_HORA: "por hora",
  POR_OPERACAO: "por operação",
};

const STATUS_LABELS: Record<JobStatus, string> = {
  ABERTO: "Aberto",
  EM_ANDAMENTO: "Em Andamento",
  VERIFICADO: "Verificado",
  FECHADO: "Fechado",
  CANCELADO: "Cancelado",
};

const STATUS_COLORS: Record<JobStatus, string> = {
  ABERTO: "bg-blue-100 text-blue-700",
  EM_ANDAMENTO: "bg-amber-100 text-amber-700",
  VERIFICADO: "bg-purple-100 text-purple-700",
  FECHADO: "bg-emerald-100 text-emerald-700",
  CANCELADO: "bg-red-100 text-red-700",
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function brl(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const v = typeof n === "number" ? n : parseFloat(String(n));
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function calcJobCost(job: Job, allocations: JobAllocation[], adjustments: JobAdjustment[]): {
  base: number;
  adj: number;
  total: number;
} {
  const jobAllocs = allocations.filter((a) => a.job_id === job.id);
  const jobAdjs = adjustments.filter((a) => a.job_id === job.id);
  const base = jobAllocs.reduce((sum, a) => sum + Number(a.rate) * a.quantity, 0);
  const adj = jobAdjs.reduce(
    (sum, a) => sum + (a.type === "ADICIONAL" ? Number(a.amount) : -Number(a.amount)),
    0
  );
  return { base, adj, total: base + adj };
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function FinanceiroPage() {
  const { profile } = useAuth();
  const role = profile?.role || "FINANCEIRO";
  const canEdit = hasPermission(role, "FINANCEIRO_MOD", "edit") || hasPermission(role, "FINANCEIRO_MOD", "create");

  const [functions, setFunctions] = useState<JobFunction[]>([]);
  const [rates, setRates] = useState<JobFunctionRate[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [allocations, setAllocations] = useState<JobAllocation[]>([]);
  const [adjustments, setAdjustments] = useState<JobAdjustment[]>([]);
  const [ships, setShips] = useState<Ship[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [fnRes, rtRes, jbRes, alRes, adRes, shRes, emRes] = await Promise.all([
      db.from("job_functions").select("*").order("name"),
      db.from("job_function_rates").select("*").order("valid_from", { ascending: false }),
      db.from("jobs").select("*, ships(name)").order("start_date", { ascending: false }),
      db.from("job_allocations").select("*, job_functions(name, unit), employees(name, bank_name, bank_agency, bank_account, bank_account_type)"),
      db.from("job_adjustments").select("*").order("created_at", { ascending: false }),
      db.from("ships").select("id, name, status").order("arrival_date", { ascending: false }).limit(50),
      db.from("employees").select("id, name, role, bank_name, bank_agency, bank_account, bank_account_type, status").order("name"),
    ]);
    setFunctions((fnRes.data as JobFunction[]) || []);
    setRates((rtRes.data as JobFunctionRate[]) || []);
    setJobs((jbRes.data as Job[]) || []);
    setAllocations((alRes.data as JobAllocation[]) || []);
    setAdjustments((adRes.data as JobAdjustment[]) || []);
    setShips((shRes.data as Ship[]) || []);
    setEmployees((emRes.data as Employee[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const kpis = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthJobs = jobs.filter((j) => new Date(j.start_date) >= monthStart);
    const totalCostMonth = monthJobs.reduce((s, j) => s + calcJobCost(j, allocations, adjustments).total, 0);
    const totalRevenueMonth = monthJobs.reduce((s, j) => s + Number(j.contract_value || 0), 0);
    return {
      activeFunctions: functions.filter((f) => f.active).length,
      openJobs: jobs.filter((j) => j.status === "ABERTO" || j.status === "EM_ANDAMENTO").length,
      monthCost: totalCostMonth,
      monthRevenue: totalRevenueMonth,
      monthProfit: totalRevenueMonth - totalCostMonth,
    };
  }, [functions, jobs, allocations, adjustments]);

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold text-text">Financeiro 💰</h1>
        <p className="text-text-light text-sm mt-0.5">
          Catálogo de funções, alocações de equipe e cálculo por trabalho
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="Funções Ativas" value={kpis.activeFunctions.toString()} accent="blue" />
        <KpiCard label="Trabalhos em Aberto" value={kpis.openJobs.toString()} accent="amber" />
        <KpiCard label="Custo do Mês" value={brl(kpis.monthCost)} accent="red" />
        <KpiCard label="Receita do Mês" value={brl(kpis.monthRevenue)} accent="emerald" />
        <KpiCard
          label={kpis.monthProfit >= 0 ? "Lucro do Mês" : "Prejuízo do Mês"}
          value={brl(kpis.monthProfit)}
          accent={kpis.monthProfit >= 0 ? "emerald" : "red"}
        />
      </div>

      <Tabs
        tabs={[
          {
            key: "funcoes",
            label: "💰 Funções e Valores",
            content: (
              <FuncoesTab
                functions={functions}
                rates={rates}
                allocations={allocations}
                canEdit={canEdit}
                onChange={loadAll}
                loading={loading}
              />
            ),
          },
          {
            key: "trabalhos",
            label: "🚢 Trabalhos",
            content: (
              <TrabalhosTab
                jobs={jobs}
                allocations={allocations}
                adjustments={adjustments}
                functions={functions}
                ships={ships}
                employees={employees}
                canEdit={canEdit}
                profileName={profile?.full_name || "Sistema"}
                onChange={loadAll}
                loading={loading}
              />
            ),
          },
          {
            key: "resumo",
            label: "📊 Resumo",
            content: (
              <ResumoTab
                jobs={jobs}
                allocations={allocations}
                adjustments={adjustments}
                functions={functions}
              />
            ),
          },
        ]}
      />
    </div>
  );
}

// ─── KPI Card ───────────────────────────────────────────────────────────────

function KpiCard({ label, value, accent }: { label: string; value: string; accent: "blue" | "amber" | "red" | "emerald" }) {
  const accentMap = {
    blue: "border-blue-200 bg-blue-50",
    amber: "border-amber-200 bg-amber-50",
    red: "border-red-200 bg-red-50",
    emerald: "border-emerald-200 bg-emerald-50",
  };
  return (
    <div className={`rounded-xl border p-3 ${accentMap[accent]}`}>
      <p className="text-[10px] font-semibold text-text-light uppercase tracking-wider">{label}</p>
      <p className="text-lg font-bold text-text mt-1">{value}</p>
    </div>
  );
}

// ─── FUNÇÕES TAB ────────────────────────────────────────────────────────────

// Inline editor: clicar no valor → vira input → salva ao perder foco/Enter.
function InlineRateEditor({ value, canEdit, onSave }: { value: number; canEdit: boolean; onSave: (n: number) => void | Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  function start() {
    if (!canEdit) return;
    setDraft(value.toString());
    setEditing(true);
  }

  async function commit() {
    const n = parseFloat(draft.replace(",", "."));
    if (Number.isFinite(n) && n !== value) {
      setSaving(true);
      await onSave(n);
      setSaving(false);
    }
    setEditing(false);
  }

  function cancel() {
    setDraft("");
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-emerald-700 font-semibold">R$</span>
        <input
          type="number"
          step="0.01"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") cancel();
          }}
          autoFocus
          disabled={saving}
          className="w-24 px-2 py-1 border-2 border-primary rounded text-sm font-semibold text-emerald-700 focus:outline-none"
        />
        {saving && <span className="text-[10px] text-text-light">salvando…</span>}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={start}
      disabled={!canEdit}
      className={`font-semibold text-emerald-700 ${canEdit ? "hover:bg-emerald-50 hover:text-emerald-800 cursor-pointer px-2 py-1 -mx-2 -my-1 rounded transition group" : ""}`}
      title={canEdit ? "Clique para editar" : ""}
    >
      {brl(value)}
      {canEdit && <span className="ml-1.5 text-[10px] text-text-light opacity-0 group-hover:opacity-100 transition">✏️</span>}
    </button>
  );
}

function FuncoesTab({
  functions, rates, allocations, canEdit, onChange, loading,
}: {
  functions: JobFunction[];
  rates: JobFunctionRate[];
  allocations: JobAllocation[];
  canEdit: boolean;
  onChange: () => void;
  loading: boolean;
}) {
  const [editFn, setEditFn] = useState<JobFunction | null>(null);
  const [showFnForm, setShowFnForm] = useState(false);
  const [historyFn, setHistoryFn] = useState<JobFunction | null>(null);
  const [deleteFn, setDeleteFn] = useState<JobFunction | null>(null);
  const [search, setSearch] = useState("");

  const allocCount = (fnId: number) =>
    allocations.filter((a) => a.function_id === fnId).reduce((s, a) => s + a.quantity, 0);

  const filtered = functions.filter((f) =>
    f.name.toLowerCase().includes(search.toLowerCase())
  );

  // Salva nova taxa diretamente (cria registro no histórico + atualiza default_rate)
  async function saveRateInline(fn: JobFunction, newValue: number) {
    if (!Number.isFinite(newValue) || newValue < 0) return;
    if (newValue === Number(fn.default_rate)) return; // sem mudança

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    // Encerra a taxa vigente (se houver)
    const openRates = rates.filter((r) => r.function_id === fn.id && !r.valid_until);
    for (const open of openRates) {
      await db.from("job_function_rates").update({ valid_until: yesterday }).eq("id", open.id);
    }
    // Cria nova taxa
    await db.from("job_function_rates").insert({
      function_id: fn.id,
      rate: newValue,
      valid_from: today,
      notes: "Atualizado inline",
    });
    // Atualiza default na função
    await db.from("job_functions").update({ default_rate: newValue }).eq("id", fn.id);
    onChange();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <input
          type="text"
          placeholder="Buscar função..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none w-64"
        />
        {canEdit && (
          <Button size="sm" onClick={() => { setEditFn(null); setShowFnForm(true); }}>
            <PlusIcon className="w-4 h-4" />Nova Função
          </Button>
        )}
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-900">
        💡 Esses são os <strong>valores médios padrão</strong> por função. De navio para navio podem ser ajustados,
        e a confirmação final dos valores é feita no <strong>Trabalho</strong> (em "Ajustar Valor por Função") antes do fechamento.
      </div>

      {loading ? (
        <p className="text-center text-text-light py-12">Carregando...</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 bg-card rounded-xl border border-border">
          <p className="text-3xl mb-2">💼</p>
          <p className="text-sm text-text-light">Nenhuma função encontrada</p>
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-gray-50">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-light uppercase tracking-wider">Função</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-light uppercase tracking-wider">Valor Padrão</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-light uppercase tracking-wider">Unidade</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-light uppercase tracking-wider">Alocações</th>
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-light uppercase tracking-wider">Status</th>
                <th className="px-4 py-2.5 text-right text-xs font-semibold text-text-light uppercase tracking-wider">Ações</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((f) => (
                <tr key={f.id} className="border-b border-border last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-2.5 font-medium">{f.name}</td>
                  <td className="px-4 py-2.5">
                    <InlineRateEditor
                      value={Number(f.default_rate)}
                      canEdit={canEdit}
                      onSave={(v) => saveRateInline(f, v)}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-text-light text-xs">{UNIT_LABELS[f.unit]}</td>
                  <td className="px-4 py-2.5 text-text-light text-xs">{allocCount(f.id)}× alocada(s)</td>
                  <td className="px-4 py-2.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${f.active ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"}`}>
                      {f.active ? "Ativa" : "Inativa"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex gap-1 justify-end">
                      <button
                        onClick={() => setHistoryFn(f)}
                        className="px-2 py-1 text-xs text-blue-700 hover:bg-blue-50 rounded transition"
                        title="Histórico de valores"
                      >
                        📈 Histórico
                      </button>
                      {canEdit && (
                        <>
                          <button onClick={() => { setEditFn(f); setShowFnForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded" title="Editar tudo">
                            <EditIcon />
                          </button>
                          <button onClick={() => setDeleteFn(f)} className="p-1.5 text-danger hover:bg-red-50 rounded" title="Excluir">
                            <TrashIcon />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <FunctionFormModal
        open={showFnForm}
        item={editFn}
        onClose={() => { setShowFnForm(false); setEditFn(null); }}
        onSaved={() => { setShowFnForm(false); setEditFn(null); onChange(); }}
      />

      <RateHistoryModal
        open={!!historyFn}
        fn={historyFn}
        rates={rates.filter((r) => r.function_id === historyFn?.id)}
        canEdit={canEdit}
        onClose={() => setHistoryFn(null)}
        onChange={onChange}
      />

      <ConfirmDialog
        open={!!deleteFn}
        onClose={() => setDeleteFn(null)}
        onConfirm={async () => {
          await db.from("job_functions").delete().eq("id", deleteFn!.id);
          setDeleteFn(null); onChange();
        }}
        title="Excluir Função"
        message={`Excluir "${deleteFn?.name}"? Alocações vinculadas perdem a referência.`}
      />
    </div>
  );
}

// ─── Function Form Modal ────────────────────────────────────────────────────

function FunctionFormModal({
  open, item, onClose, onSaved,
}: {
  open: boolean; item: JobFunction | null; onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultRate, setDefaultRate] = useState("");
  const [unit, setUnit] = useState<JobUnit>("POR_NAVIO");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) {
      setName(item.name);
      setDescription(item.description || "");
      setDefaultRate(item.default_rate.toString());
      setUnit(item.unit);
      setActive(item.active);
    } else {
      setName(""); setDescription(""); setDefaultRate(""); setUnit("POR_NAVIO"); setActive(true);
    }
  }, [item, open]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    const payload = {
      name: name.trim().toUpperCase(),
      description: description.trim() || null,
      default_rate: parseFloat(defaultRate) || 0,
      unit,
      active,
    };
    if (item) {
      await db.from("job_functions").update(payload).eq("id", item.id);
    } else {
      await db.from("job_functions").insert(payload);
    }
    setSaving(false);
    onSaved();
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Função" : "Nova Função"}>
      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Nome *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} placeholder="WAP, AJUDANTE, ESFREGÃO..." />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Descrição</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} placeholder="Opcional" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Valor Padrão (R$)</label>
            <input type="number" step="0.01" value={defaultRate} onChange={(e) => setDefaultRate(e.target.value)} className={inputCls} placeholder="0,00" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Unidade</label>
            <select value={unit} onChange={(e) => setUnit(e.target.value as JobUnit)} className={inputCls}>
              <option value="POR_NAVIO">Por Navio</option>
              <option value="POR_DIA">Por Dia</option>
              <option value="POR_HORA">Por Hora</option>
              <option value="POR_OPERACAO">Por Operação</option>
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 accent-primary" />
          <span className="text-sm">Função ativa</span>
        </label>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Rate History Modal ─────────────────────────────────────────────────────

function RateHistoryModal({
  open, fn, rates, canEdit, onClose, onChange,
}: {
  open: boolean; fn: JobFunction | null; rates: JobFunctionRate[]; canEdit: boolean; onClose: () => void; onChange: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [newRate, setNewRate] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setShowAdd(false);
      setNewRate("");
      setValidFrom(isoDate(new Date()));
      setNotes("");
    }
  }, [open]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!fn || !newRate || !validFrom) return;
    setSaving(true);

    // Close the currently-open rate (valid_until = day before new valid_from)
    const fromDate = new Date(validFrom);
    const closeDate = new Date(fromDate);
    closeDate.setDate(closeDate.getDate() - 1);
    const openRates = rates.filter((r) => !r.valid_until);
    for (const open of openRates) {
      await db.from("job_function_rates").update({ valid_until: isoDate(closeDate) }).eq("id", open.id);
    }

    await db.from("job_function_rates").insert({
      function_id: fn.id,
      rate: parseFloat(newRate),
      valid_from: validFrom,
      notes: notes.trim() || null,
    });

    // Update the function's default_rate to the new rate (current).
    await db.from("job_functions").update({ default_rate: parseFloat(newRate) }).eq("id", fn.id);

    setSaving(false);
    setShowAdd(false);
    onChange();
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";
  const sortedRates = [...rates].sort((a, b) => b.valid_from.localeCompare(a.valid_from));

  return (
    <Modal open={open} onClose={onClose} title={fn ? `Histórico — ${fn.name}` : ""} maxWidth="max-w-xl">
      {!fn ? null : (
        <div className="space-y-3">
          {canEdit && !showAdd && (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <PlusIcon className="w-4 h-4" />Adicionar Nova Taxa
            </Button>
          )}

          {showAdd && (
            <form onSubmit={handleAdd} className="bg-blue-50 rounded-lg p-3 space-y-3 border border-blue-200">
              <p className="text-xs font-semibold text-blue-900">Nova Taxa</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Novo valor (R$) *</label>
                  <input type="number" step="0.01" value={newRate} onChange={(e) => setNewRate(e.target.value)} required className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Válido a partir de *</label>
                  <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} required className={inputCls} />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Observação</label>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className={inputCls} placeholder="Motivo / contexto" />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="secondary" size="sm" type="button" onClick={() => setShowAdd(false)}>Cancelar</Button>
                <Button size="sm" type="submit" disabled={saving}>{saving ? "Salvando..." : "Aplicar"}</Button>
              </div>
              <p className="text-[10px] text-blue-700 italic">
                A taxa atual será encerrada automaticamente no dia anterior à data informada.
              </p>
            </form>
          )}

          {sortedRates.length === 0 ? (
            <div className="text-center py-8 text-text-light text-sm">
              Sem histórico — adicione a primeira taxa.
            </div>
          ) : (
            <div className="space-y-2">
              {sortedRates.map((r, idx) => (
                <div key={r.id} className={`rounded-lg p-3 border ${idx === 0 && !r.valid_until ? "border-emerald-300 bg-emerald-50" : "border-border bg-card"}`}>
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-bold text-lg text-emerald-700">{brl(r.rate)}</p>
                      <p className="text-xs text-text-light">
                        {r.valid_from} {r.valid_until ? `→ ${r.valid_until}` : "→ atual ✓"}
                      </p>
                      {r.notes && <p className="text-xs text-text mt-1 italic">"{r.notes}"</p>}
                    </div>
                    {idx === 0 && !r.valid_until && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-200 text-emerald-800 font-bold">VIGENTE</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// ─── TRABALHOS TAB ──────────────────────────────────────────────────────────

function TrabalhosTab({
  jobs, allocations, adjustments, functions, ships, employees, canEdit, profileName, onChange, loading,
}: {
  jobs: Job[];
  allocations: JobAllocation[];
  adjustments: JobAdjustment[];
  functions: JobFunction[];
  ships: Ship[];
  employees: Employee[];
  canEdit: boolean;
  profileName: string;
  onChange: () => void;
  loading: boolean;
}) {
  const [editJob, setEditJob] = useState<Job | null>(null);
  const [showJobForm, setShowJobForm] = useState(false);
  const [detailJob, setDetailJob] = useState<Job | null>(null);
  const [deleteJob, setDeleteJob] = useState<Job | null>(null);
  const [statusFilter, setStatusFilter] = useState<JobStatus | "TODOS">("TODOS");

  const filtered = jobs.filter((j) => statusFilter === "TODOS" || j.status === statusFilter);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          {(["TODOS", "ABERTO", "EM_ANDAMENTO", "VERIFICADO", "FECHADO", "CANCELADO"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs rounded-full font-medium transition ${
                statusFilter === s ? "bg-primary text-white" : "bg-gray-100 text-text-light hover:bg-gray-200"
              }`}
            >
              {s === "TODOS" ? "Todos" : STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => { setEditJob(null); setShowJobForm(true); }}>
            <PlusIcon className="w-4 h-4" />Novo Trabalho
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-center text-text-light py-12">Carregando...</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 bg-card rounded-xl border border-border">
          <p className="text-3xl mb-2">🚢</p>
          <p className="text-sm text-text-light">Nenhum trabalho encontrado</p>
        </div>
      ) : (
        <div className="grid gap-2">
          {filtered.map((j) => {
            const cost = calcJobCost(j, allocations, adjustments);
            const revenue = Number(j.contract_value || 0);
            const profit = revenue - cost.total;
            return (
              <div key={j.id} className="bg-card rounded-xl border border-border p-4 hover:shadow-md transition cursor-pointer" onClick={() => setDetailJob(j)}>
                <div className="flex flex-wrap justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold">{j.name}</h3>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[j.status]}`}>
                        {STATUS_LABELS[j.status]}
                      </span>
                      {j.ships?.name && <span className="text-xs text-text-light">⚓ {j.ships.name}</span>}
                    </div>
                    <p className="text-xs text-text-light mt-1">
                      {j.start_date} {j.end_date ? `→ ${j.end_date}` : "→ em aberto"}
                    </p>
                  </div>
                  <div className="flex gap-3 items-center text-xs flex-wrap">
                    <div>
                      <p className="text-text-light">Custo</p>
                      <p className="font-semibold text-red-700">{brl(cost.total)}</p>
                    </div>
                    <div>
                      <p className="text-text-light">Contrato</p>
                      <p className="font-semibold text-blue-700">{brl(revenue)}</p>
                    </div>
                    {revenue > 0 && (
                      <div>
                        <p className="text-text-light">Lucro</p>
                        <p className={`font-semibold ${profit >= 0 ? "text-emerald-700" : "text-red-700"}`}>{brl(profit)}</p>
                      </div>
                    )}
                    {canEdit && (
                      <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { setEditJob(j); setShowJobForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded">
                          <EditIcon />
                        </button>
                        <button onClick={() => setDeleteJob(j)} className="p-1.5 text-danger hover:bg-red-50 rounded">
                          <TrashIcon />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <JobFormModal
        open={showJobForm}
        item={editJob}
        ships={ships}
        profileName={profileName}
        onClose={() => { setShowJobForm(false); setEditJob(null); }}
        onSaved={() => { setShowJobForm(false); setEditJob(null); onChange(); }}
      />

      <JobDetailModal
        open={!!detailJob}
        job={detailJob}
        allocations={allocations.filter((a) => a.job_id === detailJob?.id)}
        adjustments={adjustments.filter((a) => a.job_id === detailJob?.id)}
        functions={functions}
        employees={employees}
        canEdit={canEdit}
        profileName={profileName}
        onClose={() => setDetailJob(null)}
        onChange={() => { onChange(); }}
      />

      <ConfirmDialog
        open={!!deleteJob}
        onClose={() => setDeleteJob(null)}
        onConfirm={async () => {
          await db.from("jobs").delete().eq("id", deleteJob!.id);
          setDeleteJob(null); onChange();
        }}
        title="Excluir Trabalho"
        message={`Excluir "${deleteJob?.name}"? As alocações e ajustes vinculados também serão removidos.`}
      />
    </div>
  );
}

// ─── Job Form Modal ─────────────────────────────────────────────────────────

function JobFormModal({
  open, item, ships, profileName, onClose, onSaved,
}: {
  open: boolean;
  item: Job | null;
  ships: Ship[];
  profileName: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [shipId, setShipId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [status, setStatus] = useState<JobStatus>("ABERTO");
  const [contractValue, setContractValue] = useState("");
  const [notes, setNotes] = useState("");
  // Metadata fechamento
  const [client, setClient] = useState("");
  const [supervisor, setSupervisor] = useState("");
  const [cargoType, setCargoType] = useState("");
  const [holdsCount, setHoldsCount] = useState("");
  const [port, setPort] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) {
      setName(item.name);
      setShipId(item.ship_id || "");
      setStartDate(item.start_date.slice(0, 10));
      setEndDate(item.end_date?.slice(0, 10) || "");
      setStatus(item.status);
      setContractValue(item.contract_value?.toString() || "");
      setNotes(item.notes || "");
      setClient(item.client || "");
      setSupervisor(item.supervisor || "");
      setCargoType(item.cargo_type || "");
      setHoldsCount(item.holds_count?.toString() || "");
      setPort(item.port || "");
    } else {
      setName(""); setShipId(""); setStartDate(isoDate(new Date()));
      setEndDate(""); setStatus("ABERTO"); setContractValue(""); setNotes("");
      setClient(""); setSupervisor(""); setCargoType(""); setHoldsCount(""); setPort("SANTOS");
    }
  }, [item, open]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !startDate) return;
    setSaving(true);
    const payload = {
      name: name.trim(),
      ship_id: shipId || null,
      start_date: startDate,
      end_date: endDate || null,
      status,
      contract_value: contractValue ? parseFloat(contractValue) : null,
      notes: notes.trim() || null,
      client: client.trim() || null,
      supervisor: supervisor.trim() || null,
      cargo_type: cargoType.trim() || null,
      holds_count: holdsCount ? parseInt(holdsCount) : null,
      port: port.trim() || null,
      created_by: profileName,
    };
    if (item) {
      await db.from("jobs").update(payload).eq("id", item.id);
    } else {
      await db.from("jobs").insert(payload);
    }
    setSaving(false);
    onSaved();
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";
  const sectionTitle = "text-xs font-semibold text-text-light uppercase tracking-wider mb-2";

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Trabalho" : "Novo Trabalho"} maxWidth="max-w-2xl">
      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <p className={sectionTitle}>Identificação</p>
          <div>
            <label className="block text-sm font-medium mb-1">Nome *</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} placeholder="10 - M/V LEO OCEAN - 31/03/26 ..." />
          </div>
          <div className="mt-3">
            <label className="block text-sm font-medium mb-1">Navio</label>
            <select value={shipId} onChange={(e) => setShipId(e.target.value)} className={inputCls}>
              <option value="">— Sem navio vinculado —</option>
              {ships.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>

        <div className="border-t border-border pt-3">
          <p className={sectionTitle}>Operação (cabeçalho do fechamento)</p>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium mb-1">Cliente</label><input type="text" value={client} onChange={(e) => setClient(e.target.value.toUpperCase())} className={inputCls} placeholder="DEEP" /></div>
            <div><label className="block text-sm font-medium mb-1">Supervisor</label><input type="text" value={supervisor} onChange={(e) => setSupervisor(e.target.value.toUpperCase())} className={inputCls} placeholder="ADELMO" /></div>
          </div>
          <div className="grid grid-cols-3 gap-4 mt-3">
            <div><label className="block text-sm font-medium mb-1">Carga</label><input type="text" value={cargoType} onChange={(e) => setCargoType(e.target.value.toUpperCase())} className={inputCls} placeholder="CARVÃO" /></div>
            <div><label className="block text-sm font-medium mb-1">Nº Porões</label><input type="number" value={holdsCount} onChange={(e) => setHoldsCount(e.target.value)} className={inputCls} placeholder="5" /></div>
            <div><label className="block text-sm font-medium mb-1">Porto</label><input type="text" value={port} onChange={(e) => setPort(e.target.value.toUpperCase())} className={inputCls} placeholder="SANTOS" /></div>
          </div>
        </div>

        <div className="border-t border-border pt-3">
          <p className={sectionTitle}>Período & Status</p>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium mb-1">Início *</label><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required className={inputCls} /></div>
            <div><label className="block text-sm font-medium mb-1">Fim</label><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} /></div>
          </div>
          <div className="grid grid-cols-2 gap-4 mt-3">
            <div>
              <label className="block text-sm font-medium mb-1">Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value as JobStatus)} className={inputCls}>
                <option value="ABERTO">Aberto</option>
                <option value="EM_ANDAMENTO">Em Andamento</option>
                <option value="VERIFICADO">Verificado</option>
                <option value="FECHADO">Fechado</option>
                <option value="CANCELADO">Cancelado</option>
              </select>
            </div>
            <div><label className="block text-sm font-medium mb-1">Valor do Contrato (R$)</label><input type="number" step="0.01" value={contractValue} onChange={(e) => setContractValue(e.target.value)} className={inputCls} placeholder="0,00" /></div>
          </div>
        </div>

        <div className="border-t border-border pt-3">
          <label className="block text-sm font-medium mb-1">Observações</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${inputCls} resize-none`} />
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Job Detail Modal (alocações + ajustes) ─────────────────────────────────

function JobDetailModal({
  open, job, allocations, adjustments, functions, employees, canEdit, profileName, onClose, onChange,
}: {
  open: boolean;
  job: Job | null;
  allocations: JobAllocation[];
  adjustments: JobAdjustment[];
  functions: JobFunction[];
  employees: Employee[];
  canEdit: boolean;
  profileName: string;
  onClose: () => void;
  onChange: () => void;
}) {
  const [showAddAlloc, setShowAddAlloc] = useState(false);
  const [allocEmp, setAllocEmp] = useState("");
  const [allocFn, setAllocFn] = useState("");
  const [allocDays, setAllocDays] = useState("1");
  const [allocRate, setAllocRate] = useState("");
  const [allocPluxee, setAllocPluxee] = useState("0");
  const [editAllocId, setEditAllocId] = useState<number | null>(null);

  const [showAddAdj, setShowAddAdj] = useState(false);
  const [adjType, setAdjType] = useState<AdjustmentType>("ADICIONAL");
  const [adjDesc, setAdjDesc] = useState("");
  const [adjAmt, setAdjAmt] = useState("");

  const [showCloseForm, setShowCloseForm] = useState(false);
  const [showFunctionForm, setShowFunctionForm] = useState(false);
  const [payrollValue, setPayrollValue] = useState("");

  const [exporting, setExporting] = useState<"none" | "fechamento" | "planilha">("none");

  useEffect(() => {
    if (open) {
      setShowAddAlloc(false); setShowAddAdj(false); setShowCloseForm(false);
      setShowFunctionForm(false);
      setAllocEmp(""); setAllocFn(""); setAllocDays("1"); setAllocRate(""); setAllocPluxee("0");
      setEditAllocId(null);
      setAdjType("ADICIONAL"); setAdjDesc(""); setAdjAmt("");
      setPayrollValue(job?.payroll_value?.toString() || "");
    }
  }, [open, job]);

  if (!job) return null;

  const cost = calcJobCost(job, allocations.map((a) => ({ ...a, job_id: job.id })), adjustments.map((a) => ({ ...a, job_id: job.id })));
  const revenue = Number(job.contract_value || 0);
  const profit = revenue - cost.total;
  const folhaValue = Number(job.payroll_value || 0);
  // Valor que precisamos = TOTAL - VALOR DA FOLHA (conforme fluxo do usuário)
  const liquidValue = cost.total - folhaValue;

  async function handleAddAlloc(e: React.FormEvent) {
    e.preventDefault();
    if (!allocFn || !allocRate) return;
    const payload = {
      function_id: parseInt(allocFn),
      employee_id: allocEmp ? parseInt(allocEmp) : null,
      quantity: parseInt(allocDays) || 1,
      rate: parseFloat(allocRate),
      pluxee_value: allocPluxee ? parseFloat(allocPluxee) : 0,
    };
    if (editAllocId) {
      await db.from("job_allocations").update(payload).eq("id", editAllocId);
    } else {
      await db.from("job_allocations").insert({ ...payload, job_id: job!.id });
    }
    setShowAddAlloc(false);
    setAllocEmp(""); setAllocFn(""); setAllocDays("1"); setAllocRate(""); setAllocPluxee("0");
    setEditAllocId(null);
    onChange();
  }

  function startEditAlloc(a: JobAllocation) {
    setEditAllocId(a.id);
    setAllocEmp(a.employee_id?.toString() || "");
    setAllocFn(a.function_id.toString());
    setAllocDays(a.quantity.toString());
    setAllocRate(a.rate.toString());
    setAllocPluxee((a.pluxee_value ?? 0).toString());
    setShowAddAlloc(true);
  }

  async function handleAddAdj(e: React.FormEvent) {
    e.preventDefault();
    if (!adjDesc.trim() || !adjAmt) return;
    await db.from("job_adjustments").insert({
      job_id: job!.id,
      type: adjType,
      description: adjDesc.trim(),
      amount: parseFloat(adjAmt),
    });
    setShowAddAdj(false);
    setAdjDesc(""); setAdjAmt("");
    onChange();
  }

  async function handleDeleteAlloc(id: number) {
    await db.from("job_allocations").delete().eq("id", id);
    onChange();
  }

  async function handleDeleteAdj(id: number) {
    await db.from("job_adjustments").delete().eq("id", id);
    onChange();
  }

  function pickEmployee(empIdStr: string) {
    setAllocEmp(empIdStr);
    if (!empIdStr) return;
    const emp = employees.find((e) => String(e.id) === empIdStr);
    if (!emp) return;
    // Auto-fill function from employee role
    const fn = functions.find((f) => f.name.toUpperCase() === (emp.role || "").toUpperCase());
    if (fn) {
      setAllocFn(String(fn.id));
      setAllocRate(fn.default_rate.toString());
    }
  }

  function pickFunction(fnIdStr: string) {
    setAllocFn(fnIdStr);
    const fn = functions.find((f) => f.id === parseInt(fnIdStr));
    if (fn) setAllocRate(fn.default_rate.toString());
  }

  // ── Workflow handlers ────────────────────────────────────────────────────
  async function handleVerify() {
    if (!confirm(`Confirmar verificação dos valores totais (${brl(cost.total)})?`)) return;
    await db.from("jobs").update({
      status: "VERIFICADO",
      verified_at: new Date().toISOString(),
      verified_by: profileName,
    }).eq("id", job!.id);
    onChange();
  }

  async function handleClose(e: React.FormEvent) {
    e.preventDefault();
    if (!payrollValue) return;
    await db.from("jobs").update({
      status: "FECHADO",
      payroll_value: parseFloat(payrollValue),
      closed_at: new Date().toISOString(),
      closed_by: profileName,
    }).eq("id", job!.id);
    setShowCloseForm(false);
    onChange();
  }

  async function handleReopen() {
    if (!confirm("Reabrir trabalho? Isso limpa a verificação e o fechamento.")) return;
    await db.from("jobs").update({
      status: "EM_ANDAMENTO",
      verified_at: null,
      verified_by: null,
      closed_at: null,
      closed_by: null,
    }).eq("id", job!.id);
    onChange();
  }

  // ── Export handlers ──────────────────────────────────────────────────────
  async function handleExportFechamento() {
    setExporting("fechamento");
    try {
      const XLSX = await import("xlsx");
      const aoa: (string | number)[][] = [];
      // Padding empty rows to match original (header at row 9-10)
      for (let i = 0; i < 9; i++) aoa.push([]);
      const headerLine = `${job!.name}${job!.holds_count ? ` - ${job!.holds_count} PORÕES` : ""}${job!.cargo_type ? ` - ${job!.cargo_type}` : ""}${job!.port ? ` - ${job!.port}` : ""}${job!.start_date ? ` - ${job!.start_date.slice(0, 10).split("-").reverse().join("/")}` : ""}`;
      aoa.push(["", "", headerLine]);
      aoa.push(["", "", `CLIENTE: ${job!.client || "—"}${job!.supervisor ? ` - SUPERVISOR ${job!.supervisor}` : ""}`]);
      aoa.push([]);
      aoa.push([]);
      aoa.push([]);
      aoa.push(["", "", "FUNCIONARIOS", "VALOR"]);
      let i = 1;
      for (const a of allocations) {
        const empName = a.employees?.name || a.job_functions?.name || `#${a.function_id}`;
        const subtotal = Number(a.rate) * a.quantity;
        aoa.push(["", i, empName, subtotal]);
        i++;
      }
      // Padding rows up to row 32
      while (aoa.length < 32) aoa.push(["", i++, "", ""]);
      aoa.push(["", i++, "MÃO DE OBRA", cost.base]);
      while (aoa.length < 41) aoa.push(["", i++, "", ""]);
      const adjTotal = adjustments.reduce(
        (s, a) => s + (a.type === "ADICIONAL" ? Number(a.amount) : -Number(a.amount)),
        0
      );
      aoa.push(["", i++, "DESPESAS DIVERSAS", adjTotal]);
      while (aoa.length < 44) aoa.push(["", i++, "", ""]);
      aoa.push(["", i++, "TOTAL GERAL", cost.total]);
      aoa.push([]);
      aoa.push([]);
      aoa.push([]);
      aoa.push([]);
      aoa.push(["", "", "CARGO SHIPS CLEANING LTDA."]);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "LIMPEZA");
      const safeName = (job!.name || "fechamento").replace(/[^a-zA-Z0-9_-]+/g, "_");
      XLSX.writeFile(wb, `Fechamento_${safeName}.xlsx`);
    } catch (err) {
      console.error(err);
      alert("Falha ao gerar XLSX. Veja o console.");
    } finally {
      setExporting("none");
    }
  }

  async function handleExportPlanilha() {
    setExporting("planilha");
    try {
      const XLSX = await import("xlsx");
      const aoa: (string | number)[][] = [];
      // Padding rows
      for (let i = 0; i < 2; i++) aoa.push([]);
      aoa.push(["", "", "", `PAGAMENTO EM ${job!.start_date.slice(0, 10).split("-").reverse().join("/")}`]);
      aoa.push([]);
      aoa.push([]);
      aoa.push(["", "", "FUNCIONÁRIOS", "", "", "", "", "", "", job!.client || ""]);
      aoa.push([
        "", "", " Limpeza de porão", "AGÊNCIA", "CONTA", "BANCO",
        "PAGTO PLUXEE", "PAGTO NA FOLHA", "DESCONTO GERAL",
        "Perda de Material", `MV 1: ${job!.name}`,
      ]);
      aoa.push([]);
      let i = 1;
      let totalPluxee = 0, totalFolha = 0, totalNavio = 0;
      for (const a of allocations) {
        const empName = a.employees?.name || a.job_functions?.name || `#${a.function_id}`;
        const bankName = a.employees?.bank_name || "";
        const bankAgency = a.employees?.bank_agency || "";
        const bankAccount = a.employees?.bank_account || "";
        const bankType = a.employees?.bank_account_type || "";
        const bank = bankType ? `${bankName}-${bankType}` : bankName;
        const subtotal = Number(a.rate) * a.quantity;
        const pluxee = Number(a.pluxee_value || 0);
        const folha = subtotal - pluxee;
        totalPluxee += pluxee;
        totalFolha += folha;
        totalNavio += subtotal;
        aoa.push([
          "", i, empName, bankAgency, bankAccount, bank,
          pluxee, folha, "", "", subtotal,
        ]);
        i++;
      }
      aoa.push([]);
      aoa.push(["", "", "TOTAL", "", "", "", totalPluxee, totalFolha, 0, 0, totalNavio]);
      aoa.push([]);
      aoa.push(["", "", "TOTAL PAGAMENTO DOS MVs s/ desconto:"]);
      aoa.push(["", "", "MV 1:", "", "", "TOTAIS:"]);
      aoa.push([totalNavio, "", "", "", "ADTO:", 0]);
      aoa.push(["PAGTO PLUXEE:", totalPluxee]);
      aoa.push(["PAGTO FOLHA:", totalFolha]);
      aoa.push(["PAGTO NAVIO:", totalNavio]);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "PLANILHA BASE");
      const safeName = (job!.name || "planilha").replace(/[^a-zA-Z0-9_-]+/g, "_");
      XLSX.writeFile(wb, `Planilha_${safeName}.xlsx`);
    } catch (err) {
      console.error(err);
      alert("Falha ao gerar XLSX. Veja o console.");
    } finally {
      setExporting("none");
    }
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";
  // Trabalho fica somente-leitura apenas após o último OK do gerente.
  // O verificador pode ajustar valores enquanto está em conferência (VERIFICADO).
  const isReadOnly = job.status === "FECHADO";

  return (
    <Modal open={open} onClose={onClose} title={job.name} maxWidth="max-w-4xl">
      <div className="space-y-4">
        {/* Header com cliente/supervisor/cargo/porões */}
        {(job.client || job.supervisor || job.cargo_type || job.holds_count) && (
          <div className="bg-gray-50 rounded-lg p-3 flex flex-wrap gap-3 text-xs">
            {job.client && <span><span className="text-text-light">Cliente:</span> <span className="font-semibold">{job.client}</span></span>}
            {job.supervisor && <span><span className="text-text-light">Supervisor:</span> <span className="font-semibold">{job.supervisor}</span></span>}
            {job.cargo_type && <span><span className="text-text-light">Carga:</span> <span className="font-semibold">{job.cargo_type}</span></span>}
            {job.holds_count != null && <span><span className="text-text-light">Porões:</span> <span className="font-semibold">{job.holds_count}</span></span>}
            {job.port && <span><span className="text-text-light">Porto:</span> <span className="font-semibold">{job.port}</span></span>}
            <span className="ml-auto">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[job.status]}`}>
                {STATUS_LABELS[job.status]}
              </span>
            </span>
          </div>
        )}

        {/* Resumo financeiro */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="text-[10px] font-semibold text-red-700 uppercase tracking-wider">Custo Operação</p>
            <p className="text-lg font-bold text-red-700">{brl(cost.total)}</p>
            <p className="text-[10px] text-red-600">Mão de obra {brl(cost.base)} {cost.adj !== 0 && (cost.adj > 0 ? "+" : "")}{cost.adj !== 0 ? brl(cost.adj) : ""}</p>
          </div>
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
            <p className="text-[10px] font-semibold text-blue-700 uppercase tracking-wider">Contrato</p>
            <p className="text-lg font-bold text-blue-700">{brl(revenue)}</p>
          </div>
          <div className={`rounded-lg border p-3 ${folhaValue > 0 ? "border-purple-200 bg-purple-50" : "border-gray-200 bg-gray-50"}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-wider ${folhaValue > 0 ? "text-purple-700" : "text-text-light"}`}>Valor da Folha</p>
            <p className={`text-lg font-bold ${folhaValue > 0 ? "text-purple-700" : "text-text-light"}`}>{folhaValue > 0 ? brl(folhaValue) : "—"}</p>
            <p className="text-[10px] text-text-light">contabilidade</p>
          </div>
          <div className={`rounded-lg border p-3 ${folhaValue > 0 ? (liquidValue >= 0 ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50") : "border-gray-200 bg-gray-50"}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-wider ${folhaValue > 0 ? (liquidValue >= 0 ? "text-emerald-700" : "text-red-700") : "text-text-light"}`}>Valor Líquido</p>
            <p className={`text-lg font-bold ${folhaValue > 0 ? (liquidValue >= 0 ? "text-emerald-700" : "text-red-700") : "text-text-light"}`}>{folhaValue > 0 ? brl(liquidValue) : "—"}</p>
            <p className="text-[10px] text-text-light">total − folha</p>
          </div>
        </div>

        {/* Audit trail */}
        {(job.verified_at || job.closed_at) && (
          <div className="bg-gray-50 border border-border rounded-lg p-3 space-y-1 text-xs">
            <p className="font-semibold text-text-light uppercase tracking-wider mb-1">📋 Auditoria</p>
            {job.verified_at && (
              <p>✓ <strong>Verificado</strong> por <span className="font-semibold">{job.verified_by}</span> em {formatDateTime(job.verified_at)}</p>
            )}
            {job.closed_at && (
              <p>🔒 <strong>Último OK</strong> por <span className="font-semibold">{job.closed_by}</span> em {formatDateTime(job.closed_at)}</p>
            )}
          </div>
        )}

        {/* Alocações */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-sm font-semibold">👥 Equipe Alocada ({allocations.length})</h3>
            {canEdit && !isReadOnly && !showAddAlloc && (
              <button onClick={() => setShowAddAlloc(true)} className="text-xs px-2 py-1 bg-primary text-white rounded hover:bg-primary-dark">
                + Adicionar Funcionário
              </button>
            )}
          </div>

          {showAddAlloc && (
            <form onSubmit={handleAddAlloc} className="bg-blue-50 rounded-lg p-3 mb-2 border border-blue-200 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium mb-1">Funcionário</label>
                  <select value={allocEmp} onChange={(e) => pickEmployee(e.target.value)} className={inputCls}>
                    <option value="">— sem nome (agregado) —</option>
                    {employees.filter((e) => e.status === "ATIVO").map((e) => (
                      <option key={e.id} value={e.id}>{e.name} {e.role ? `· ${e.role}` : ""}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Função *</label>
                  <select value={allocFn} onChange={(e) => pickFunction(e.target.value)} required className={inputCls}>
                    <option value="">Selecione...</option>
                    {functions.filter((f) => f.active).map((f) => (
                      <option key={f.id} value={f.id}>{f.name} ({brl(f.default_rate)})</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-medium mb-1">Dias *</label>
                  <input type="number" min={1} value={allocDays} onChange={(e) => setAllocDays(e.target.value)} required className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Valor Diário (R$) *</label>
                  <input type="number" step="0.01" value={allocRate} onChange={(e) => setAllocRate(e.target.value)} required className={inputCls} />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Pluxee (R$)</label>
                  <input type="number" step="0.01" value={allocPluxee} onChange={(e) => setAllocPluxee(e.target.value)} className={inputCls} placeholder="0,00" />
                </div>
              </div>
              {allocDays && allocRate && (
                <p className="text-xs text-blue-700">
                  Total: <strong>{brl((parseInt(allocDays) || 0) * (parseFloat(allocRate) || 0))}</strong>
                  {" "}({allocDays} {parseInt(allocDays) === 1 ? "dia" : "dias"} × {brl(allocRate)})
                </p>
              )}
              <div className="flex gap-2 justify-end">
                <Button variant="secondary" size="sm" type="button" onClick={() => { setShowAddAlloc(false); setEditAllocId(null); }}>Cancelar</Button>
                <Button size="sm" type="submit">{editAllocId ? "Salvar Alterações" : "Adicionar"}</Button>
              </div>
            </form>
          )}

          {allocations.length === 0 ? (
            <p className="text-xs text-text-light italic text-center py-4">Sem alocações.</p>
          ) : (
            <div className="bg-card border border-border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-border">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">#</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">Funcionário / Função</th>
                    <th className="px-3 py-2 text-center text-xs font-semibold text-text-light">Dias</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-text-light">Valor Diário</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-text-light">Total</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-text-light">Pluxee</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-text-light">Folha</th>
                    {canEdit && !isReadOnly && <th className="w-16"></th>}
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((a, idx) => {
                    const subtotal = Number(a.rate) * a.quantity;
                    const pluxee = Number(a.pluxee_value || 0);
                    const folha = subtotal - pluxee;
                    return (
                      <tr key={a.id} className="border-b border-border last:border-0 hover:bg-gray-50">
                        <td className="px-3 py-2 text-text-light">{idx + 1}</td>
                        <td className="px-3 py-2">
                          <p className="font-medium">{a.employees?.name || a.job_functions?.name || `#${a.function_id}`}</p>
                          {a.employees?.name && <p className="text-[10px] text-text-light">{a.job_functions?.name}</p>}
                        </td>
                        <td className="px-3 py-2 text-center">{a.quantity}</td>
                        <td className="px-3 py-2 text-right">{brl(a.rate)}</td>
                        <td className="px-3 py-2 text-right font-semibold">{brl(subtotal)}</td>
                        <td className="px-3 py-2 text-right text-amber-700">{brl(pluxee)}</td>
                        <td className="px-3 py-2 text-right text-purple-700">{brl(folha)}</td>
                        {canEdit && !isReadOnly && (
                          <td className="px-2 py-2">
                            <div className="flex gap-1 justify-end">
                              <button onClick={() => startEditAlloc(a)} className="p-1 text-primary hover:bg-blue-50 rounded" title="Editar">
                                <EditIcon className="w-3 h-3" />
                              </button>
                              <button onClick={() => handleDeleteAlloc(a.id)} className="p-1 text-danger hover:bg-red-50 rounded" title="Remover">
                                <TrashIcon className="w-3 h-3" />
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-gray-50 border-t-2 border-border font-semibold">
                  <tr>
                    <td colSpan={4} className="px-3 py-2 text-text-light text-right">TOTAL</td>
                    <td className="px-3 py-2 text-right">{brl(allocations.reduce((s, a) => s + Number(a.rate) * a.quantity, 0))}</td>
                    <td className="px-3 py-2 text-right text-amber-700">{brl(allocations.reduce((s, a) => s + Number(a.pluxee_value || 0), 0))}</td>
                    <td className="px-3 py-2 text-right text-purple-700">{brl(allocations.reduce((s, a) => s + Number(a.rate) * a.quantity - Number(a.pluxee_value || 0), 0))}</td>
                    {canEdit && !isReadOnly && <td></td>}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* Ajustes */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-sm font-semibold">🪙 Ajustes (Despesas Diversas)</h3>
            {canEdit && !isReadOnly && !showAddAdj && (
              <button onClick={() => setShowAddAdj(true)} className="text-xs px-2 py-1 bg-primary text-white rounded hover:bg-primary-dark">
                + Adicionar
              </button>
            )}
          </div>

          {showAddAdj && (
            <form onSubmit={handleAddAdj} className="bg-amber-50 rounded-lg p-3 mb-2 border border-amber-200 space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-xs font-medium mb-1">Tipo</label>
                  <select value={adjType} onChange={(e) => setAdjType(e.target.value as AdjustmentType)} className={inputCls}>
                    <option value="ADICIONAL">Adicional (+)</option>
                    <option value="REDUCAO">Redução (−)</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-xs font-medium mb-1">Descrição *</label>
                  <input type="text" value={adjDesc} onChange={(e) => setAdjDesc(e.target.value)} required className={inputCls} placeholder="Bônus por urgência" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Valor (R$) *</label>
                <input type="number" step="0.01" value={adjAmt} onChange={(e) => setAdjAmt(e.target.value)} required className={inputCls} placeholder="100,00" />
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="secondary" size="sm" type="button" onClick={() => setShowAddAdj(false)}>Cancelar</Button>
                <Button size="sm" type="submit">Adicionar</Button>
              </div>
            </form>
          )}

          {adjustments.length === 0 ? (
            <p className="text-xs text-text-light italic text-center py-2">Sem ajustes.</p>
          ) : (
            <div className="space-y-1">
              {adjustments.map((a) => (
                <div key={a.id} className={`flex justify-between items-center px-3 py-2 rounded-lg border ${
                  a.type === "ADICIONAL" ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"
                }`}>
                  <div>
                    <span className={`text-xs font-bold mr-2 ${a.type === "ADICIONAL" ? "text-emerald-700" : "text-red-700"}`}>
                      {a.type === "ADICIONAL" ? "+" : "−"}
                    </span>
                    <span className="text-sm">{a.description}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-semibold text-sm ${a.type === "ADICIONAL" ? "text-emerald-700" : "text-red-700"}`}>
                      {brl(a.amount)}
                    </span>
                    {canEdit && !isReadOnly && (
                      <button onClick={() => handleDeleteAdj(a.id)} className="p-1 text-danger hover:bg-red-100 rounded">
                        <TrashIcon className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Form de fechamento (gerente preenche valor da folha) */}
        {showCloseForm && (
          <form onSubmit={handleClose} className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-2">
            <p className="text-sm font-semibold text-emerald-900">🔒 Fazer Último OK</p>
            <p className="text-xs text-emerald-800">
              Preencha o <strong>Valor da Folha</strong> conforme retornado pela contabilidade.
              O Valor Líquido (Total − Folha) será calculado automaticamente.
            </p>
            <div>
              <label className="block text-xs font-medium mb-1">Valor da Folha (R$) *</label>
              <input type="number" step="0.01" value={payrollValue} onChange={(e) => setPayrollValue(e.target.value)} required className={inputCls} placeholder="0,00" autoFocus />
            </div>
            {payrollValue && (
              <p className="text-xs">
                Valor Líquido = <strong>{brl(cost.total - parseFloat(payrollValue))}</strong>
              </p>
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" size="sm" type="button" onClick={() => setShowCloseForm(false)}>Cancelar</Button>
              <Button size="sm" type="submit">🔒 Fechar Trabalho</Button>
            </div>
          </form>
        )}

        {job.notes && (
          <div className="border-t border-border pt-3">
            <p className="text-xs font-semibold text-text-light uppercase tracking-wider mb-1">Observações</p>
            <p className="text-sm italic">"{job.notes}"</p>
          </div>
        )}

        {/* Action bar */}
        <div className="border-t border-border pt-4 flex flex-wrap gap-2 justify-between">
          <div className="flex flex-wrap gap-2">
            {canEdit && job.status !== "FECHADO" && allocations.length > 0 && (
              <button
                onClick={() => setShowFunctionForm(true)}
                className="px-3 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
              >
                ⚖️ Ajustar Valor por Função
              </button>
            )}
            {canEdit && (job.status === "ABERTO" || job.status === "EM_ANDAMENTO") && allocations.length > 0 && (
              <button onClick={handleVerify} className="px-3 py-2 text-sm font-medium bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition">
                ✓ Verificar Valores
              </button>
            )}
            {canEdit && job.status === "VERIFICADO" && !showCloseForm && (
              <button onClick={() => setShowCloseForm(true)} className="px-3 py-2 text-sm font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition">
                🔒 Fazer Último OK
              </button>
            )}
            {canEdit && (job.status === "VERIFICADO" || job.status === "FECHADO") && (
              <button onClick={handleReopen} className="px-3 py-2 text-sm font-medium bg-gray-200 text-text rounded-lg hover:bg-gray-300 transition">
                ↺ Reabrir
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleExportFechamento}
              disabled={exporting !== "none"}
              className="px-3 py-2 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
            >
              {exporting === "fechamento" ? "Gerando..." : "📥 Exportar Fechamento"}
            </button>
            <button
              onClick={handleExportPlanilha}
              disabled={exporting !== "none"}
              className="px-3 py-2 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
            >
              {exporting === "planilha" ? "Gerando..." : "📥 Exportar Planilha Base"}
            </button>
          </div>
        </div>

        {/* Modal aninhado: Ajustar valor por função */}
        <FunctionRateModal
          open={showFunctionForm}
          allocations={allocations}
          functions={functions}
          onClose={() => setShowFunctionForm(false)}
          onSaved={() => { setShowFunctionForm(false); onChange(); }}
        />
      </div>
    </Modal>
  );
}

// ─── Function Rate Modal (ajusta dias + valor diário em massa por função) ───

function FunctionRateModal({
  open, allocations, functions, onClose, onSaved,
}: {
  open: boolean;
  allocations: JobAllocation[];
  functions: JobFunction[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<number, { function: JobFunction; allocs: JobAllocation[] }>();
    for (const a of allocations) {
      if (a.status !== "ATIVO") continue;
      const fn = functions.find((f) => f.id === a.function_id);
      if (!fn) continue;
      const existing = map.get(fn.id);
      if (existing) existing.allocs.push(a);
      else map.set(fn.id, { function: fn, allocs: [a] });
    }
    return Array.from(map.values()).sort((a, b) => a.function.name.localeCompare(b.function.name));
  }, [allocations, functions]);

  const [values, setValues] = useState<Record<number, { days: string; rate: string; pluxee: string }>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      const initial: Record<number, { days: string; rate: string; pluxee: string }> = {};
      for (const g of groups) {
        const firstDays = g.allocs[0]?.quantity ?? 0;
        const firstRate = Number(g.allocs[0]?.rate ?? 0);
        const firstPluxee = Number(g.allocs[0]?.pluxee_value ?? 0);
        const allSame = g.allocs.every(
          (a) =>
            a.quantity === firstDays &&
            Number(a.rate) === firstRate &&
            Number(a.pluxee_value || 0) === firstPluxee
        );
        initial[g.function.id] = {
          days: allSame && firstDays > 0 ? String(firstDays) : "",
          rate: allSame && firstRate > 0 ? String(firstRate) : String(g.function.default_rate),
          pluxee: allSame && firstPluxee > 0 ? String(firstPluxee) : "0",
        };
      }
      setValues(initial);
    }
  }, [open, groups]);

  function setField(fnId: number, field: "days" | "rate" | "pluxee", v: string) {
    setValues((prev) => ({ ...prev, [fnId]: { ...prev[fnId], [field]: v } }));
  }

  const grandTotal = groups.reduce((s, g) => {
    const v = values[g.function.id];
    if (!v) return s;
    return s + (parseInt(v.days) || 0) * (parseFloat(v.rate) || 0) * g.allocs.length;
  }, 0);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      for (const g of groups) {
        const v = values[g.function.id];
        if (!v) continue;
        const days = parseInt(v.days) || 0;
        const rate = parseFloat(v.rate) || 0;
        const pluxee = parseFloat(v.pluxee) || 0;
        if (days <= 0 && rate <= 0 && pluxee <= 0) continue;
        for (const a of g.allocs) {
          await db.from("job_allocations").update({
            quantity: days,
            rate: rate,
            pluxee_value: pluxee,
          }).eq("id", a.id);
        }
      }
      onSaved();
    } catch (err) {
      console.error(err);
      alert("Erro ao salvar: " + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full px-2 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title="⚖️ Ajustar Valor por Função" maxWidth="max-w-3xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-900">
          💡 Para cada função, informe os <strong>dias trabalhados</strong>, <strong>valor diário</strong> e <strong>Pluxee</strong>.
          Os valores serão aplicados a <strong>todos os membros</strong> dessa função.
          Diferenças individuais podem ser ajustadas depois (✏️ na linha).
        </div>

        {groups.length === 0 ? (
          <p className="text-center text-text-light text-sm py-6">Nenhuma equipe escalada ainda. Volte ao Embarque pra escalar.</p>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-12 gap-2 text-[10px] font-semibold text-text-light uppercase tracking-wider px-2">
              <div className="col-span-3">Função</div>
              <div className="col-span-1 text-center">Pessoas</div>
              <div className="col-span-2">Dias</div>
              <div className="col-span-2">Valor Diário</div>
              <div className="col-span-2">Pluxee</div>
              <div className="col-span-2 text-right">Total Grupo</div>
            </div>
            {groups.map((g) => {
              const v = values[g.function.id] || { days: "", rate: "", pluxee: "" };
              const perPerson = (parseInt(v.days) || 0) * (parseFloat(v.rate) || 0);
              const total = perPerson * g.allocs.length;
              return (
                <div key={g.function.id} className="grid grid-cols-12 gap-2 items-center bg-card border border-border rounded-lg p-2">
                  <div className="col-span-3">
                    <p className="font-semibold text-sm">{g.function.name}</p>
                    <p className="text-[10px] text-text-light truncate">
                      {g.allocs.map((a) => a.employees?.name?.split(" ")[0] || "—").slice(0, 3).join(", ")}
                      {g.allocs.length > 3 && ` +${g.allocs.length - 3}`}
                    </p>
                  </div>
                  <div className="col-span-1 text-center">
                    <span className="text-sm font-bold text-text">{g.allocs.length}</span>
                  </div>
                  <div className="col-span-2">
                    <input type="number" min={0} value={v.days} onChange={(e) => setField(g.function.id, "days", e.target.value)} className={inputCls} placeholder="0" />
                  </div>
                  <div className="col-span-2">
                    <input type="number" step="0.01" min={0} value={v.rate} onChange={(e) => setField(g.function.id, "rate", e.target.value)} className={inputCls} placeholder="0,00" />
                  </div>
                  <div className="col-span-2">
                    <input type="number" step="0.01" min={0} value={v.pluxee} onChange={(e) => setField(g.function.id, "pluxee", e.target.value)} className={inputCls} placeholder="0,00" />
                  </div>
                  <div className="col-span-2 text-right">
                    {perPerson > 0 ? (
                      <>
                        <p className="text-sm font-semibold text-emerald-700">{brl(total)}</p>
                        <p className="text-[10px] text-text-light">{brl(perPerson)}/pessoa</p>
                      </>
                    ) : (
                      <p className="text-xs text-text-light">—</p>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="bg-emerald-50 border-2 border-emerald-300 rounded-lg p-3 flex justify-between items-center mt-3">
              <p className="text-sm font-bold text-emerald-900">TOTAL DA OPERAÇÃO</p>
              <p className="text-xl font-bold text-emerald-700">{brl(grandTotal)}</p>
            </div>
          </div>
        )}

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving || groups.length === 0}>
            {saving ? "Aplicando..." : "💾 Salvar Valores"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── RESUMO TAB ─────────────────────────────────────────────────────────────

function ResumoTab({
  jobs, allocations, adjustments, functions,
}: {
  jobs: Job[];
  allocations: JobAllocation[];
  adjustments: JobAdjustment[];
  functions: JobFunction[];
}) {
  const closedJobs = jobs.filter((j) => j.status === "FECHADO");
  const totalRevenue = closedJobs.reduce((s, j) => s + Number(j.contract_value || 0), 0);
  const totalCost = closedJobs.reduce((s, j) => s + calcJobCost(j, allocations, adjustments).total, 0);
  const totalProfit = totalRevenue - totalCost;
  const margin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

  // Custo agregado por função
  const byFunction = new Map<number, { name: string; total: number; count: number }>();
  for (const a of allocations) {
    const fn = functions.find((f) => f.id === a.function_id);
    if (!fn) continue;
    const existing = byFunction.get(fn.id) || { name: fn.name, total: 0, count: 0 };
    existing.total += Number(a.rate) * a.quantity;
    existing.count += a.quantity;
    byFunction.set(fn.id, existing);
  }
  const fnRanking = Array.from(byFunction.values()).sort((a, b) => b.total - a.total);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Trabalhos Fechados" value={closedJobs.length.toString()} accent="blue" />
        <KpiCard label="Receita Total" value={brl(totalRevenue)} accent="emerald" />
        <KpiCard label="Custo Total" value={brl(totalCost)} accent="red" />
        <KpiCard
          label={totalProfit >= 0 ? "Lucro Total" : "Prejuízo Total"}
          value={`${brl(totalProfit)} (${margin.toFixed(1)}%)`}
          accent={totalProfit >= 0 ? "emerald" : "red"}
        />
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <h3 className="text-sm font-semibold mb-3">📊 Custo por Função (todas as alocações)</h3>
        {fnRanking.length === 0 ? (
          <p className="text-xs text-text-light italic">Ainda sem alocações registradas.</p>
        ) : (
          <div className="space-y-2">
            {fnRanking.map((r) => {
              const max = fnRanking[0].total;
              const pct = (r.total / max) * 100;
              return (
                <div key={r.name}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium">{r.name} <span className="text-text-light">({r.count}× alocada)</span></span>
                    <span className="font-semibold text-emerald-700">{brl(r.total)}</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
