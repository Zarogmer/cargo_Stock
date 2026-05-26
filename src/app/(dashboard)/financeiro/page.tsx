"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
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
  Ship,
  Employee,
} from "@/types/database";

// ─── Helpers ────────────────────────────────────────────────────────────────

const UNIT_LABELS: Record<JobUnit, string> = {
  MENSALISTA: "Mensalista",
  PORAO: "Porão",
  POR_NAVIO: "Porão",
  POR_DIA: "Mensalista",
  POR_HORA: "Mensalista",
  POR_OPERACAO: "Porão",
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

// Formata datas dos Jobs (start_date/end_date) que vêm do Postgres como
// ISO ("2026-05-26T00:00:00.000Z") ou string plana ("2026-05-26"). Usamos
// só os 10 primeiros caracteres pra evitar shift de timezone na exibição.
function formatJobDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const parts = iso.slice(0, 10).split("-");
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  return `${d}/${m}/${y}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Categorias estruturadas de despesa, usadas no fechamento. A ordem aqui é
// também a ordem em que aparecem na exportação Excel.
const EXPENSE_CATEGORIES = [
  { value: "COMPRAS",            label: "Compras" },
  { value: "QUIMICA",            label: "Química" },
  { value: "MATERIAL_DANIFICADO", label: "Material danificado" },
  { value: "AJUDA_DE_CUSTO",     label: "Ajuda de custo" },
  { value: "ALIMENTACAO",        label: "Alimentação" },
  { value: "RESTAURANTE",        label: "Jantar/Restaurante" },
  { value: "OUTROS",             label: "Outros" },
] as const;
type ExpenseCategory = typeof EXPENSE_CATEGORIES[number]["value"];

function categoryLabel(cat: string | null | undefined): string {
  if (!cat) return "Outros";
  return EXPENSE_CATEGORIES.find((c) => c.value === cat)?.label || cat;
}

// Pagamentos:
//   EMBARQUE: rate (valor/porão) × holds_count × quantidade alocada.
//   COSTADO:  rate (valor/hora) × 6 × quantidade (cada quantidade = 1 turno de 6h).
const HOURS_PER_SHIFT = 6;
function calcAllocBase(a: JobAllocation, holdsCount: number | null): number {
  const k = a.kind || "EMBARQUE";
  const qty = a.quantity;
  const rate = Number(a.rate);
  const extra = Number(a.extra_value || 0);
  if (k === "EMBARQUE") {
    const holds = Math.max(1, Number(holdsCount || 1));
    return rate * holds * qty + extra;
  }
  if (k === "COSTADO") {
    return rate * HOURS_PER_SHIFT * qty + extra;
  }
  return rate * qty + extra;
}

function calcJobCost(job: Job, allocations: JobAllocation[], adjustments: JobAdjustment[]): {
  base: number;     // soma dos pagamentos base + rateios
  adj: number;      // ajustes (adicionais menos reduções)
  total: number;
} {
  const jobAllocs = allocations.filter((a) => a.job_id === job.id);
  const jobAdjs = adjustments.filter((a) => a.job_id === job.id);
  const base = jobAllocs.reduce((sum, a) => sum + calcAllocBase(a, job.holds_count), 0);
  const adj = jobAdjs.reduce(
    (sum, a) => sum + (a.type === "ADICIONAL" ? Number(a.amount) : -Number(a.amount)),
    0
  );
  return { base, adj, total: base + adj };
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function FinanceiroPage() {
  const { profile } = useAuth();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") || "funcoes";
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
      db.from("ships").select("id, name, status, services").order("arrival_date", { ascending: false }).limit(50),
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

  const financeiroTabs = [
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
      key: "embarque",
      label: "🚢 Pagamento de Embarque",
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
      key: "costado",
      label: "⚓ Pagamento de Costado",
      content: (
        <CostadoTab
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
      key: "documentos",
      label: "📄 Documentos",
      content: <DocumentosPlaceholder />,
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
  ];

  const activeTabLabel = financeiroTabs.find((t) => t.key === initialTab)?.label;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <h1 className="text-2xl font-bold text-text">Financeiro 💰</h1>
          {activeTabLabel && (
            <>
              <span className="text-text-light">›</span>
              <span className="text-lg font-semibold text-text-light">{activeTabLabel}</span>
            </>
          )}
        </div>
        <p className="text-text-light text-sm mt-0.5">
          Catálogo de funções, pagamentos e documentos
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard label="Funções Ativas" value={kpis.activeFunctions.toString()} accent="blue" />
        <KpiCard label="Pagamentos Abertos" value={kpis.openJobs.toString()} accent="amber" />
        <KpiCard label="Custo do Mês" value={brl(kpis.monthCost)} accent="red" />
        <KpiCard label="Receita do Mês" value={brl(kpis.monthRevenue)} accent="emerald" />
        <KpiCard
          label={kpis.monthProfit >= 0 ? "Lucro do Mês" : "Prejuízo do Mês"}
          value={brl(kpis.monthProfit)}
          accent={kpis.monthProfit >= 0 ? "emerald" : "red"}
        />
      </div>

      <Tabs tabs={financeiroTabs} defaultTab={initialTab} hideHeader />
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
  const [ratesFn, setRatesFn] = useState<JobFunction | null>(null);
  const [search, setSearch] = useState("");

  // Count distinct allocations (records), not the sum of worked days. With the
  // new Escalação flow records are inserted with quantity=0 and the days are
  // filled in at finalization; counting records is what matters for delete
  // safety because the FK constraint cares about row presence, not values.
  const allocCount = (fnId: number) =>
    allocations.filter((a) => a.function_id === fnId).length;

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
        e a confirmação final dos valores é feita no <strong>Pagamento de Embarque</strong> (em "Ajustar Valor por Função") antes de fechar.
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
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex gap-1 justify-end">
                      <button onClick={() => setRatesFn(f)} className="p-1.5 text-amber-700 hover:bg-amber-50 rounded" title="Valores especiais por funcionário">
                        <span className="text-base leading-none">👤</span>
                      </button>
                      {canEdit && (
                        <>
                          <button onClick={() => { setEditFn(f); setShowFnForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded" title="Editar tudo">
                            <EditIcon />
                          </button>
                          {f.active ? (
                            <button onClick={() => setDeleteFn(f)} className="p-1.5 text-danger hover:bg-red-50 rounded" title="Excluir ou desativar">
                              <TrashIcon />
                            </button>
                          ) : (
                            <button onClick={() => setDeleteFn(f)} className="px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50 rounded font-medium" title="Reativar">
                              ↻ Reativar
                            </button>
                          )}
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

      <EmployeeRatesModal
        open={!!ratesFn}
        fn={ratesFn}
        canEdit={canEdit}
        onClose={() => setRatesFn(null)}
      />

      <ConfirmDialog
        open={!!deleteFn}
        onClose={() => setDeleteFn(null)}
        onConfirm={async () => {
          if (!deleteFn) return;
          // Three modes derived from current state:
          //   - inactive            → reactivate (set active=true)
          //   - active + has allocs → soft delete (set active=false)
          //   - active + no allocs  → hard delete
          if (!deleteFn.active) {
            const res = await db.from("job_functions").update({ active: true }).eq("id", deleteFn.id);
            if (res.error) { alert(`Não consegui reativar: ${res.error.message}`); return; }
          } else if (allocCount(deleteFn.id) > 0) {
            const res = await db.from("job_functions").update({ active: false }).eq("id", deleteFn.id);
            if (res.error) { alert(`Não consegui desativar: ${res.error.message}`); return; }
          } else {
            const res = await db.from("job_functions").delete().eq("id", deleteFn.id);
            if (res.error) {
              alert(`Não consegui excluir: ${res.error.message}\n\nProvavelmente há alocações antigas referenciando esta função. Tente desativar em vez de excluir.`);
              return;
            }
          }
          setDeleteFn(null); onChange();
        }}
        title={
          !deleteFn ? ""
          : !deleteFn.active ? "Reativar Função"
          : allocCount(deleteFn.id) > 0 ? "Desativar Função"
          : "Excluir Função"
        }
        message={
          !deleteFn ? ""
          : !deleteFn.active
            ? `Reativar "${deleteFn.name}"? Ela vai voltar a aparecer nos dropdowns.`
            : allocCount(deleteFn.id) > 0
              ? `"${deleteFn.name}" tem ${allocCount(deleteFn.id)} alocação(ões) registrada(s) — não dá pra excluir sem perder histórico. Posso desativar (some dos dropdowns, dados ficam no banco). Continuar?`
              : `Excluir "${deleteFn.name}"?`
        }
        confirmLabel={
          !deleteFn ? "Confirmar"
          : !deleteFn.active ? "Reativar"
          : allocCount(deleteFn.id) > 0 ? "Desativar"
          : "Excluir"
        }
        variant={deleteFn && !deleteFn.active ? "primary" : "danger"}
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
  const [unit, setUnit] = useState<JobUnit>("PORAO");
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
      setName(""); setDescription(""); setDefaultRate(""); setUnit("PORAO"); setActive(true);
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
              <option value="MENSALISTA">Mensalista</option>
              <option value="PORAO">Porão</option>
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

// ─── EMPLOYEE RATES MODAL ──────────────────────────────────────────────────
// Permite cadastrar um valor especial pra um funcionário específico nesta
// função (override do default_rate). Usado pra funcionários antigos que
// recebem um pouco a mais — a allocation nova já entra com esse valor.
function EmployeeRatesModal({
  open, fn, canEdit, onClose,
}: {
  open: boolean;
  fn: JobFunction | null;
  canEdit: boolean;
  onClose: () => void;
}) {
  const [employees, setEmployees] = useState<{ id: number; name: string; status: string | null }[]>([]);
  const [overrides, setOverrides] = useState<Record<number, { id?: number; rate: string }>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open || !fn) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      const [empRes, rateRes] = await Promise.all([
        db.from("employees").select("id, name, status").order("name"),
        db.from("employee_function_rates").select("*").eq("function_id", fn!.id),
      ]);
      if (cancelled) return;
      const emps = ((empRes.data as { id: number; name: string; status: string | null }[]) || [])
        .filter((e) => e.status !== "INATIVO");
      setEmployees(emps);
      const map: Record<number, { id?: number; rate: string }> = {};
      for (const r of (rateRes.data || []) as { id: number; employee_id: number; rate: string | number }[]) {
        map[r.employee_id] = { id: r.id, rate: String(r.rate) };
      }
      setOverrides(map);
      setSearch("");
      setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  }, [open, fn]);

  function setRate(empId: number, value: string) {
    setOverrides((prev) => ({ ...prev, [empId]: { ...(prev[empId] || {}), rate: value } }));
  }

  async function handleSave() {
    if (!fn) return;
    setSaving(true);
    try {
      for (const emp of employees) {
        const o = overrides[emp.id];
        const raw = (o?.rate ?? "").toString().trim();
        const hasValue = raw !== "" && Number(raw) > 0;
        if (hasValue) {
          // upsert
          if (o?.id) {
            await db.from("employee_function_rates").update({ rate: Number(raw) }).eq("id", o.id);
          } else {
            await db.from("employee_function_rates").insert({
              employee_id: emp.id,
              function_id: fn.id,
              rate: Number(raw),
            });
          }
        } else if (o?.id) {
          // Sem valor → remove o override (volta ao padrão)
          await db.from("employee_function_rates").delete().eq("id", o.id);
        }
      }
      onClose();
    } catch (err) {
      alert("Erro ao salvar: " + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const filtered = employees.filter((e) =>
    e.name.toLowerCase().includes(search.toLowerCase())
  );
  const overrideCount = Object.values(overrides).filter((o) => o.rate && Number(o.rate) > 0).length;
  const inputCls = "w-32 px-2 py-1 border border-border rounded text-sm text-right focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title={fn ? `Valores especiais — ${fn.name}` : ""} maxWidth="max-w-2xl">
      {!fn ? null : (
        <div className="space-y-3">
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900">
            💡 Defina um valor especial pra funcionários que ganham diferente do padrão (
            <strong>{brl(fn.default_rate)}</strong>). Deixe em branco pra usar o padrão.
            {overrideCount > 0 && <span className="ml-1 font-semibold">· {overrideCount} override(s) ativos.</span>}
          </div>

          <input
            type="text"
            placeholder="Buscar funcionário..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
          />

          {loading ? (
            <p className="text-center text-text-light py-8 text-sm">Carregando...</p>
          ) : filtered.length === 0 ? (
            <p className="text-center text-text-light py-8 text-sm">Nenhum funcionário encontrado.</p>
          ) : (
            <div className="border border-border rounded-lg overflow-hidden max-h-96 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">Funcionário</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-text-light">Valor especial (R$)</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((emp) => {
                    const o = overrides[emp.id];
                    const hasOverride = !!o && o.rate && Number(o.rate) > 0;
                    return (
                      <tr key={emp.id} className="border-b border-border last:border-0 hover:bg-gray-50">
                        <td className="px-3 py-2">
                          {emp.name}
                          {hasOverride && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-200 text-amber-900 font-bold">ESPECIAL</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={o?.rate ?? ""}
                            onChange={(e) => setRate(emp.id, e.target.value)}
                            placeholder={String(Number(fn.default_rate).toFixed(2))}
                            disabled={!canEdit}
                            className={inputCls}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex gap-2 justify-end pt-2 border-t border-border">
            <Button variant="secondary" type="button" onClick={onClose}>Fechar</Button>
            {canEdit && (
              <Button type="button" onClick={handleSave} disabled={saving || loading}>
                {saving ? "Salvando..." : "Salvar"}
              </Button>
            )}
          </div>
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
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Embarque tab excludes Costado ships (those have services=["COSTADO"]).
  const costadoShipIds = new Set(
    ships.filter((s) => (s.services || []).includes("COSTADO")).map((s) => s.id)
  );
  const embarqueJobs = jobs.filter((j) => !j.ship_id || !costadoShipIds.has(j.ship_id));
  const filtered = embarqueJobs.filter((j) => statusFilter === "TODOS" || j.status === statusFilter);

  async function handleSyncShips() {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/financeiro/jobs/backfill", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setSyncMessage(`✅ ${body.created} pagamento(s) criado(s), ${body.skipped} já existia(m).`);
      onChange();
    } catch (err) {
      setSyncMessage(`❌ ${(err as Error).message}`);
    } finally {
      setSyncing(false);
      // auto-clear the toast after a few seconds
      setTimeout(() => setSyncMessage(null), 5000);
    }
  }

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
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={handleSyncShips}
              disabled={syncing}
              title="Cria Pagamento para todo navio que ainda não tem um"
            >
              {syncing ? "Sincronizando..." : "🔄 Sincronizar navios"}
            </Button>
            <Button size="sm" onClick={() => { setEditJob(null); setShowJobForm(true); }}>
              <PlusIcon className="w-4 h-4" />Novo Pagamento
            </Button>
          </div>
        )}
      </div>

      {syncMessage && (
        <p className="text-xs px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 text-blue-800">
          {syncMessage}
        </p>
      )}

      {loading ? (
        <p className="text-center text-text-light py-12">Carregando...</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 bg-card rounded-xl border border-border">
          <p className="text-3xl mb-2">🚢</p>
          <p className="text-sm text-text-light">Nenhum pagamento encontrado</p>
        </div>
      ) : (
        <div className="grid gap-2">
          {filtered.map((j) => {
            // Only Embarque allocations contribute to cost in this tab.
            const embarqueAllocs = allocations.filter((a) => (a.kind || "EMBARQUE") === "EMBARQUE");
            const cost = calcJobCost(j, embarqueAllocs, adjustments);
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
                      {formatJobDate(j.start_date)} {j.end_date ? `→ ${formatJobDate(j.end_date)}` : "→ em aberto"}
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
        allocations={allocations.filter((a) => a.job_id === detailJob?.id && (a.kind || "EMBARQUE") === "EMBARQUE")}
        adjustments={adjustments.filter((a) => a.job_id === detailJob?.id)}
        functions={functions}
        employees={employees}
        canEdit={canEdit}
        profileName={profileName}
        kindFilter="EMBARQUE"
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
        title="Excluir Pagamento"
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
    <Modal open={open} onClose={onClose} title={item ? "Editar Pagamento" : "Novo Pagamento"} maxWidth="max-w-2xl">
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
          <p className={sectionTitle}>Operação (cabeçalho do pagamento)</p>
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
  open, job, allocations, adjustments, functions, employees, canEdit, profileName, kindFilter, onClose, onChange,
}: {
  open: boolean;
  job: Job | null;
  allocations: JobAllocation[];
  adjustments: JobAdjustment[];
  functions: JobFunction[];
  employees: Employee[];
  canEdit: boolean;
  profileName: string;
  // When set, people come from Escalação (read-only); modal only edits financial layer.
  kindFilter?: "EMBARQUE" | "COSTADO";
  onClose: () => void;
  onChange: () => void;
}) {
  // Embarque: rate (valor/porão) × holds × qty. Costado: rate (valor/hora) × 6 × qty.
  // When kindFilter is set, allocations are managed in Escalação (this modal doesn't add/remove people).
  const peopleReadOnly = !!kindFilter;
  const holdsMultiplier =
    kindFilter === "EMBARQUE" ? Math.max(1, Number(job?.holds_count || 1))
    : kindFilter === "COSTADO" ? HOURS_PER_SHIFT
    : 1;
  const rateLabel = kindFilter === "EMBARQUE" ? "Valor/Porão" : kindFilter === "COSTADO" ? "Valor/Hora" : "Valor Diário";
  const multiplierLabel = kindFilter === "EMBARQUE" ? "Porões" : kindFilter === "COSTADO" ? "Horas" : null;
  const qtyLabel = kindFilter === "COSTADO" ? "Turnos" : "Qtd";
  const [showAddAlloc, setShowAddAlloc] = useState(false);
  const [allocEmp, setAllocEmp] = useState("");
  const [allocFn, setAllocFn] = useState("");
  const [allocDays, setAllocDays] = useState("1");
  const [allocRate, setAllocRate] = useState("");
  const [allocPluxee, setAllocPluxee] = useState("0");
  const [editAllocId, setEditAllocId] = useState<number | null>(null);

  const [showAddAdj, setShowAddAdj] = useState(false);
  const [adjCategory, setAdjCategory] = useState<ExpenseCategory>("COMPRAS");
  const [adjDesc, setAdjDesc] = useState("");
  const [adjAmt, setAdjAmt] = useState("");

  // Rateio: distribute the no-show person's pay among the rest of the same role.
  const [showRateio, setShowRateio] = useState(false);
  const [rateioFnId, setRateioFnId] = useState<string>("");
  const [rateioMissing, setRateioMissing] = useState<string>("1");
  const [rateioSaving, setRateioSaving] = useState(false);

  const [showCloseForm, setShowCloseForm] = useState(false);
  const [showFunctionForm, setShowFunctionForm] = useState(false);
  const [payrollValue, setPayrollValue] = useState("");

  const [exporting, setExporting] = useState<"none" | "fechamento" | "planilha">("none");

  useEffect(() => {
    if (open) {
      setShowAddAlloc(false); setShowAddAdj(false); setShowCloseForm(false);
      setShowFunctionForm(false); setShowRateio(false);
      setAllocEmp(""); setAllocFn(""); setAllocDays("1"); setAllocRate(""); setAllocPluxee("0");
      setEditAllocId(null);
      setAdjCategory("COMPRAS"); setAdjDesc(""); setAdjAmt("");
      setRateioFnId(""); setRateioMissing("1");
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
      type: "REDUCAO",
      category: adjCategory,
      description: adjDesc.trim(),
      amount: parseFloat(adjAmt),
    });
    setShowAddAdj(false);
    setAdjDesc(""); setAdjAmt("");
    onChange();
  }

  // Rateio: divides (rate × dias) × missingCount equally among the allocations
  // of the chosen function, persisting on extra_value with an explanatory reason.
  async function handleApplyRateio() {
    const fnId = parseInt(rateioFnId, 10);
    const missing = parseInt(rateioMissing, 10);
    if (!fnId || !missing || missing < 1) return;
    const fnAllocs = allocations.filter((a) => a.function_id === fnId && a.status === "ATIVO");
    if (fnAllocs.length === 0) return;

    // Reference rate/days: take the most common (or the first) row.
    const refRate = Number(fnAllocs[0].rate);
    const refDays = fnAllocs[0].quantity;
    const missingPay = refRate * refDays * missing;
    const perPerson = +(missingPay / fnAllocs.length).toFixed(2);
    const fnName = functions.find((f) => f.id === fnId)?.name || `Função ${fnId}`;
    const reason = `Rateio: ${missing} ${fnName} faltou(aram), valor (${brl(refRate * refDays)} × ${missing}) dividido entre ${fnAllocs.length}`;

    setRateioSaving(true);
    try {
      for (const a of fnAllocs) {
        const current = Number(a.extra_value || 0);
        await db.from("job_allocations").update({
          extra_value: current + perPerson,
          extra_reason: reason,
        }).eq("id", a.id);
      }
      setShowRateio(false);
      setRateioFnId(""); setRateioMissing("1");
      onChange();
    } finally {
      setRateioSaving(false);
    }
  }

  // Strip the extra_value from each allocation of a given function (undo rateio).
  async function handleClearRateio(fnId: number) {
    if (!confirm("Remover o rateio aplicado a essa função?")) return;
    const fnAllocs = allocations.filter((a) => a.function_id === fnId && a.status === "ATIVO" && Number(a.extra_value || 0) > 0);
    for (const a of fnAllocs) {
      await db.from("job_allocations").update({
        extra_value: 0,
        extra_reason: null,
      }).eq("id", a.id);
    }
    onChange();
  }

  // Export the closing as an Excel file matching the user's template layout.
  async function handleExportFechamentoXlsx() {
    setExporting("fechamento");
    try {
      const params = new URLSearchParams({ jobId: job!.id });
      const res = await fetch(`/api/financeiro/jobs/export-fechamento?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeName = (job!.name || "fechamento").replace(/[^a-z0-9-_ ]/gi, "_").slice(0, 80);
      a.download = `Fechamento_${safeName}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(`Falha ao exportar: ${(err as Error).message}`);
    } finally {
      setExporting("none");
    }
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
    if (!confirm("Reabrir pagamento? Isso limpa a verificação e o status fechado.")) return;
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
  // Fechamento fica somente-leitura apenas após o último OK do gerente.
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

        {/* Quick actions row — export Excel sits here so the user can grab the
            closing as a spreadsheet at any point regardless of status. */}
        <div className="flex flex-wrap gap-2 justify-end">
          <Button
            size="sm"
            variant="secondary"
            type="button"
            onClick={handleExportFechamentoXlsx}
            disabled={exporting !== "none"}
            title="Baixar o fechamento como planilha Excel"
          >
            {exporting === "fechamento" ? "Gerando..." : "📥 Exportar Excel"}
          </Button>
        </div>

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
          <div className="flex justify-between items-center mb-2 gap-2 flex-wrap">
            <div>
              <h3 className="text-sm font-semibold">👥 Equipe Alocada ({allocations.length})</h3>
              {peopleReadOnly && (
                <p className="text-[10px] text-text-light mt-0.5">
                  Lista gerenciada na Escalação{kindFilter === "EMBARQUE" ? " de Embarque" : " de Costado"} — aqui edita-se só o financeiro.
                </p>
              )}
            </div>
            <div className="flex gap-2">
              {canEdit && !isReadOnly && !showRateio && allocations.length > 0 && (
                <button onClick={() => setShowRateio(true)} className="text-xs px-2 py-1 bg-amber-600 text-white rounded hover:bg-amber-700" title="Distribuir o pagamento de quem faltou entre os que foram">
                  ⚖️ Aplicar Rateio
                </button>
              )}
              {canEdit && !isReadOnly && !peopleReadOnly && !showAddAlloc && (
                <button onClick={() => setShowAddAlloc(true)} className="text-xs px-2 py-1 bg-primary text-white rounded hover:bg-primary-dark">
                  + Adicionar Funcionário
                </button>
              )}
            </div>
          </div>

          {showRateio && (() => {
            // Per-function summary inside the rateio form — shows the user
            // how many people are in each role so they can pick which one
            // needs the rateio.
            const fnGroups = new Map<number, JobAllocation[]>();
            for (const a of allocations) {
              if (a.status !== "ATIVO") continue;
              if (!fnGroups.has(a.function_id)) fnGroups.set(a.function_id, []);
              fnGroups.get(a.function_id)!.push(a);
            }
            const fnId = parseInt(rateioFnId, 10);
            const groupAllocs = fnId ? (fnGroups.get(fnId) || []) : [];
            const refRate = groupAllocs[0] ? Number(groupAllocs[0].rate) : 0;
            const refDays = groupAllocs[0]?.quantity || 0;
            const missing = parseInt(rateioMissing, 10) || 0;
            const present = groupAllocs.length;
            const missingPay = refRate * refDays * missing;
            const perPerson = present > 0 ? missingPay / present : 0;
            return (
              <form onSubmit={(e) => { e.preventDefault(); handleApplyRateio(); }} className="bg-amber-50 rounded-lg p-3 mb-2 border border-amber-200 space-y-2">
                <p className="text-xs text-amber-900 font-medium">
                  ⚖️ Rateio — divide o pagamento de quem faltou entre os que foram da mesma função.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">Função *</label>
                    <select value={rateioFnId} onChange={(e) => setRateioFnId(e.target.value)} required className={inputCls}>
                      <option value="">Selecione...</option>
                      {Array.from(fnGroups.entries()).map(([id, grp]) => {
                        const fn = functions.find((f) => f.id === id);
                        return (
                          <option key={id} value={id}>
                            {fn?.name || `Função ${id}`} ({grp.length} {grp.length === 1 ? "pessoa" : "pessoas"})
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Quantos faltaram *</label>
                    <input type="number" min={1} value={rateioMissing} onChange={(e) => setRateioMissing(e.target.value)} required className={inputCls} />
                  </div>
                </div>
                {fnId > 0 && present > 0 && missing > 0 && (
                  <div className="bg-white border border-amber-300 rounded-lg p-2 text-xs space-y-0.5">
                    <p>Pagamento de referência: <strong>{brl(refRate)} × {refDays} dia{refDays === 1 ? "" : "s"} = {brl(refRate * refDays)}</strong></p>
                    <p>Valor de quem faltou: <strong>{brl(refRate * refDays)} × {missing} = {brl(missingPay)}</strong></p>
                    <p>Dividido entre {present} {present === 1 ? "pessoa presente" : "pessoas presentes"}: <strong className="text-emerald-700">+ {brl(perPerson)} por pessoa</strong></p>
                  </div>
                )}
                <div className="flex gap-2 justify-between flex-wrap">
                  {fnId > 0 && allocations.some((a) => a.function_id === fnId && Number(a.extra_value || 0) > 0) && (
                    <Button variant="secondary" size="sm" type="button" onClick={() => handleClearRateio(fnId)}>
                      Limpar rateio anterior dessa função
                    </Button>
                  )}
                  <div className="flex gap-2 ml-auto">
                    <Button variant="secondary" size="sm" type="button" onClick={() => setShowRateio(false)} disabled={rateioSaving}>Cancelar</Button>
                    <Button size="sm" type="submit" disabled={rateioSaving || !fnId || !missing}>
                      {rateioSaving ? "Aplicando..." : "Aplicar Rateio"}
                    </Button>
                  </div>
                </div>
              </form>
            );
          })()}

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
            <p className="text-xs text-text-light italic text-center py-4">
              {peopleReadOnly ? "Nenhuma alocação na Escalação para este navio." : "Sem alocações."}
            </p>
          ) : (
            <div className="bg-card border border-border rounded-lg overflow-x-auto">
              {kindFilter === "EMBARQUE" && (
                <div className="px-3 py-2 bg-blue-50 border-b border-blue-200 text-[11px] text-blue-900">
                  💡 Pagamento Embarque = <strong>Valor/Porão</strong> × <strong>{holdsMultiplier} porão{holdsMultiplier === 1 ? "" : "ões"}</strong> × <strong>Qtd</strong>
                </div>
              )}
              {kindFilter === "COSTADO" && (
                <div className="px-3 py-2 bg-cyan-50 border-b border-cyan-200 text-[11px] text-cyan-900">
                  💡 Pagamento Costado = <strong>Valor/Hora</strong> × <strong>{HOURS_PER_SHIFT}h por turno</strong> × <strong>nº de turnos</strong>
                </div>
              )}
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-border">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">#</th>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-text-light">Funcionário / Função</th>
                    <th className="px-3 py-2 text-center text-xs font-semibold text-text-light">{qtyLabel}</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-text-light">{rateLabel}</th>
                    {multiplierLabel && (
                      <th className="px-3 py-2 text-center text-xs font-semibold text-text-light">{multiplierLabel}</th>
                    )}
                    <th className="px-3 py-2 text-right text-xs font-semibold text-text-light">Base</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-text-light" title="Rateio aplicado">Extra</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-text-light">Total</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-text-light">Pluxee</th>
                    <th className="px-3 py-2 text-right text-xs font-semibold text-text-light">Folha</th>
                    {canEdit && !isReadOnly && !peopleReadOnly && <th className="w-16"></th>}
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((a, idx) => {
                    const subtotal = Number(a.rate) * a.quantity * holdsMultiplier;
                    const extra = Number(a.extra_value || 0);
                    const pluxee = Number(a.pluxee_value || 0);
                    const folha = subtotal + extra - pluxee;
                    return (
                      <tr key={a.id} className="border-b border-border last:border-0 hover:bg-gray-50">
                        <td className="px-3 py-2 text-text-light">{idx + 1}</td>
                        <td className="px-3 py-2">
                          <p className="font-medium">{a.employees?.name || a.job_functions?.name || `#${a.function_id}`}</p>
                          {a.employees?.name && <p className="text-[10px] text-text-light">{a.job_functions?.name}</p>}
                          {extra > 0 && a.extra_reason && (
                            <p className="text-[10px] text-amber-700 italic mt-0.5" title={a.extra_reason}>
                              ⚖️ {a.extra_reason}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-center">{a.quantity}</td>
                        <td className="px-3 py-2 text-right">{brl(a.rate)}</td>
                        {multiplierLabel && (
                          <td className="px-3 py-2 text-center text-text-light">× {holdsMultiplier}</td>
                        )}
                        <td className="px-3 py-2 text-right">{brl(subtotal)}</td>
                        <td className="px-3 py-2 text-right text-amber-700">{extra > 0 ? `+ ${brl(extra)}` : "—"}</td>
                        <td className="px-3 py-2 text-right font-semibold text-emerald-700">{brl(subtotal + extra)}</td>
                        <td className="px-3 py-2 text-right text-amber-700">{brl(pluxee)}</td>
                        <td className="px-3 py-2 text-right text-purple-700">{brl(folha)}</td>
                        {canEdit && !isReadOnly && !peopleReadOnly && (
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
                  {(() => {
                    const baseTotal = allocations.reduce((s, a) => s + Number(a.rate) * a.quantity * holdsMultiplier, 0);
                    const extraTotal = allocations.reduce((s, a) => s + Number(a.extra_value || 0), 0);
                    const pluxeeTotal = allocations.reduce((s, a) => s + Number(a.pluxee_value || 0), 0);
                    const labelColSpan = multiplierLabel ? 5 : 4;
                    return (
                      <tr>
                        <td colSpan={labelColSpan} className="px-3 py-2 text-text-light text-right">TOTAL</td>
                        <td className="px-3 py-2 text-right">{brl(baseTotal)}</td>
                        <td className="px-3 py-2 text-right text-amber-700">{brl(extraTotal)}</td>
                        <td className="px-3 py-2 text-right text-emerald-700">{brl(baseTotal + extraTotal)}</td>
                        <td className="px-3 py-2 text-right text-amber-700">{brl(pluxeeTotal)}</td>
                        <td className="px-3 py-2 text-right text-purple-700">{brl(baseTotal + extraTotal - pluxeeTotal)}</td>
                        {canEdit && !isReadOnly && !peopleReadOnly && <td></td>}
                      </tr>
                    );
                  })()}
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
              <div>
                <label className="block text-xs font-medium mb-1">Categoria *</label>
                <select value={adjCategory} onChange={(e) => setAdjCategory(e.target.value as ExpenseCategory)} className={inputCls}>
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Valor (R$) *</label>
                <input type="number" step="0.01" value={adjAmt} onChange={(e) => setAdjAmt(e.target.value)} required className={inputCls} placeholder="100,00" />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Descrição *</label>
                <input type="text" value={adjDesc} onChange={(e) => setAdjDesc(e.target.value)} required className={inputCls} placeholder="Detergente, sabão, etc." />
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
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`text-xs font-bold ${a.type === "ADICIONAL" ? "text-emerald-700" : "text-red-700"}`}>
                        {a.type === "ADICIONAL" ? "+" : "−"}
                      </span>
                      <span className="text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-white border border-current/20 text-text-light">
                        {categoryLabel(a.category)}
                      </span>
                      <span className="text-sm">{a.description}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
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
              <Button size="sm" type="submit">🔒 Fechar Definitivo</Button>
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
        <KpiCard label="Fechamentos Concluídos" value={closedJobs.length.toString()} accent="blue" />
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

// ─── FATURAR TAB ────────────────────────────────────────────────────────────

function FaturarTab({
  jobs, allocations, loading,
}: {
  jobs: Job[];
  allocations: JobAllocation[];
  loading: boolean;
}) {
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [search, setSearch] = useState("");

  // Apenas fechamentos com alocações fazem sentido para faturar
  const billable = useMemo(
    () => jobs.filter((j) => allocations.some((a) => a.job_id === j.id && a.status === "ATIVO")),
    [jobs, allocations]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return billable;
    return billable.filter(
      (j) =>
        j.name.toLowerCase().includes(q) ||
        j.ships?.name?.toLowerCase().includes(q) ||
        j.client?.toLowerCase().includes(q)
    );
  }, [billable, search]);

  return (
    <div className="space-y-3">
      <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-900">
        🧾 Selecione um fechamento para gerar a planilha de pagamento. Você poderá importar o PDF da
        <strong> Relação de Líquidos</strong> da contabilidade para preencher a coluna <strong>PAGTO NA FOLHA</strong> automaticamente.
      </div>

      <input
        type="text"
        placeholder="Buscar fechamento, navio, cliente..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none w-full max-w-md"
      />

      {loading ? (
        <p className="text-center text-text-light py-12">Carregando...</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 bg-card rounded-xl border border-border">
          <p className="text-3xl mb-2">🧾</p>
          <p className="text-sm text-text-light">
            {billable.length === 0
              ? "Nenhum fechamento com equipe alocada. Aloque equipe na aba Fechamento."
              : "Nenhum fechamento encontrado."}
          </p>
        </div>
      ) : (
        <div className="grid gap-2">
          {filtered.map((j) => {
            const jobAllocs = allocations.filter((a) => a.job_id === j.id && a.status === "ATIVO");
            const total = jobAllocs.reduce((s, a) => s + Number(a.rate) * a.quantity, 0);
            return (
              <button
                key={j.id}
                onClick={() => setSelectedJob(j)}
                className="bg-card rounded-xl border border-border p-4 hover:shadow-md hover:border-primary transition cursor-pointer text-left"
              >
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
                      {j.client && <>Cliente: <strong>{j.client}</strong> · </>}
                      {jobAllocs.length} funcionário(s) · {formatJobDate(j.start_date)}
                      {j.end_date ? ` → ${formatJobDate(j.end_date)}` : ""}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-text-light text-[10px]">Total Alocado</p>
                    <p className="font-semibold text-emerald-700">{brl(total)}</p>
                    <span className="text-[10px] text-primary">🧾 Faturar →</span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <FaturamentoModal
        open={!!selectedJob}
        job={selectedJob}
        allocations={allocations.filter((a) => a.job_id === selectedJob?.id && a.status === "ATIVO")}
        onClose={() => setSelectedJob(null)}
      />
    </div>
  );
}

// ─── Faturamento helpers ────────────────────────────────────────────────────

type FaturamentoRow = {
  allocId: number;
  name: string;
  agencia: string;
  conta: string;
  banco: string;
  pluxee: number;
  folha: number;
  desconto: number;
  perda: number;
  navio: number;
};

function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseBrlNumber(s: string): number {
  // "1.234,56" → 1234.56  ;  "395,65" → 395.65
  const cleaned = s.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// Reconstrói linhas a partir dos itens do pdfjs (que vêm fragmentados),
// agrupando pelo Y aproximado e ordenando por X dentro da linha.
function reconstructLinesFromPdfItems(items: { str: string; transform: number[] }[]): string[] {
  type Item = { str: string; x: number; y: number };
  const rows = new Map<number, Item[]>();
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = Math.round(it.transform[5]);
    // tolerância de Y: arredonda em janelas de 2pt para juntar fragmentos da mesma linha
    const yKey = Math.round(y / 2) * 2;
    if (!rows.has(yKey)) rows.set(yKey, []);
    rows.get(yKey)!.push({ str: it.str, x, y });
  }
  // ordena Y desc (PDF é bottom-up) e X asc (esquerda → direita)
  const orderedY = Array.from(rows.keys()).sort((a, b) => b - a);
  return orderedY.map((y) => {
    const line = rows.get(y)!.sort((a, b) => a.x - b.x);
    return line.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim();
  });
}

function parseLiquidosPdf(lines: string[]): { name: string; value: number }[] {
  // Padrão típico de cada linha:
  //   "94 ADINAELSON FERREIRA DE SOUZA   449172466    395,65"
  //   "66 MATHEUS OLIVEIRA SUPPA DOS SA  548548158    463,19"
  // - inicia com código (1+ dígitos)
  // - nome em maiúsculas (com possíveis espaços)
  // - identidade alfanumérica
  // - valor com vírgula
  const out: { name: string; value: number }[] = [];
  const re = /^(\d{1,5})\s+([A-ZÁÊÍÔÚÃÕÇÂÉÓÀ' .-]+?)\s+([0-9.\-X]{4,})\s+([\d.]+,\d{2})$/i;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Pula linhas óbvias de cabeçalho/rodapé
    if (/^(empregados|empresa|cnpj|cálculo|calculo|competência|competencia|relação|relacao|código|codigo|santos|responsável|responsavel|total da empresa|estagiários|contribuintes|página|pagina)/i.test(line)) {
      continue;
    }
    const m = line.match(re);
    if (m) {
      const name = m[2].replace(/\s+/g, " ").trim();
      const value = parseBrlNumber(m[4]);
      if (name.length >= 3 && value > 0) {
        out.push({ name, value });
      }
    }
  }
  return out;
}

function findBestPdfMatch(
  allocName: string,
  pdfEntries: { name: string; value: number }[],
  used: Set<number>
): { idx: number; entry: { name: string; value: number } } | null {
  const target = normalizeName(allocName);
  if (!target) return null;

  // 1) match exato
  for (let i = 0; i < pdfEntries.length; i++) {
    if (used.has(i)) continue;
    if (normalizeName(pdfEntries[i].name) === target) return { idx: i, entry: pdfEntries[i] };
  }
  // 2) PDF é prefixo do alocado (truncamento no relatório)
  for (let i = 0; i < pdfEntries.length; i++) {
    if (used.has(i)) continue;
    const pdfNorm = normalizeName(pdfEntries[i].name);
    if (pdfNorm.length >= 6 && target.startsWith(pdfNorm)) return { idx: i, entry: pdfEntries[i] };
  }
  // 3) alocado é prefixo do PDF
  for (let i = 0; i < pdfEntries.length; i++) {
    if (used.has(i)) continue;
    const pdfNorm = normalizeName(pdfEntries[i].name);
    if (target.length >= 6 && pdfNorm.startsWith(target)) return { idx: i, entry: pdfEntries[i] };
  }
  // 4) Mesmo primeiro nome + último sobrenome significativo
  const targetParts = target.split(" ");
  if (targetParts.length >= 2) {
    const first = targetParts[0];
    const last = targetParts[targetParts.length - 1];
    for (let i = 0; i < pdfEntries.length; i++) {
      if (used.has(i)) continue;
      const pdfNorm = normalizeName(pdfEntries[i].name);
      const pdfParts = pdfNorm.split(" ");
      if (pdfParts.length >= 2 && pdfParts[0] === first) {
        const pdfLast = pdfParts[pdfParts.length - 1];
        // último sobrenome bate, OU é prefixo (para casos de truncamento)
        if (pdfLast === last || last.startsWith(pdfLast) || pdfLast.startsWith(last)) {
          return { idx: i, entry: pdfEntries[i] };
        }
      }
    }
  }
  return null;
}

function formatBankLabel(name: string | null, type: string | null): string {
  if (!name) return "";
  const cleanName = name.toUpperCase();
  if (!type) return cleanName;
  const tMap: Record<string, string> = {
    POUPANCA: "POUPANÇA",
    CONTA_SAL: "Salário",
    DIGITAL: "Digital",
    CORRENTE: "",
  };
  const suffix = tMap[type] ?? type;
  return suffix ? `${cleanName}-${suffix}` : cleanName;
}

function formatDateBR(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = iso.slice(0, 10).split("-");
  if (d.length !== 3) return "";
  return `${d[2]}/${d[1]}/${d[0].slice(2)}`;
}

// ─── Faturamento Modal ──────────────────────────────────────────────────────

function FaturamentoModal({
  open, job, allocations, onClose,
}: {
  open: boolean;
  job: Job | null;
  allocations: JobAllocation[];
  onClose: () => void;
}) {
  const [rows, setRows] = useState<FaturamentoRow[]>([]);
  const [paymentDate, setPaymentDate] = useState("");
  const [pdfStatus, setPdfStatus] = useState<{
    kind: "idle" | "parsing" | "done" | "error";
    msg?: string;
    matched?: number;
    total?: number;
    unmatchedPdf?: { name: string; value: number }[];
  }>({ kind: "idle" });
  const [exporting, setExporting] = useState(false);

  // (Re)carrega linhas quando abrir
  useEffect(() => {
    if (!open || !job) return;
    const initial: FaturamentoRow[] = allocations.map((a) => {
      const e = a.employees;
      const subtotal = Number(a.rate) * a.quantity;
      const pluxee = Number(a.pluxee_value || 0);
      return {
        allocId: a.id,
        name: e?.name || a.job_functions?.name || `#${a.function_id}`,
        agencia: e?.bank_agency || "",
        conta: e?.bank_account || "",
        banco: formatBankLabel(e?.bank_name ?? null, e?.bank_account_type ?? null),
        pluxee,
        folha: 0, // será preenchido pelo PDF ou manualmente
        desconto: 0,
        perda: 0,
        navio: subtotal,
      };
    });
    setRows(initial);
    setPaymentDate(job.end_date?.slice(0, 10) || job.start_date.slice(0, 10) || "");
    setPdfStatus({ kind: "idle" });
  }, [open, job, allocations]);

  if (!open || !job) return null;

  function updateRow(idx: number, patch: Partial<FaturamentoRow>) {
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  async function handlePdfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite re-upload do mesmo arquivo
    if (!file) return;
    setPdfStatus({ kind: "parsing", msg: "Lendo PDF…" });
    try {
      const buf = await file.arrayBuffer();
      const pdfjs: typeof import("pdfjs-dist") = await import("pdfjs-dist");
      // Configura worker (servido em /pdf.worker.min.mjs)
      (pdfjs as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
        "/pdf.worker.min.mjs";
      const doc = await pdfjs.getDocument({ data: buf }).promise;
      const allLines: string[] = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const items = content.items as { str: string; transform: number[] }[];
        const lines = reconstructLinesFromPdfItems(items);
        allLines.push(...lines);
      }
      const entries = parseLiquidosPdf(allLines);
      if (entries.length === 0) {
        setPdfStatus({
          kind: "error",
          msg: "Nenhum registro reconhecido. Confira se é a 'Relação Geral dos Líquidos'.",
        });
        return;
      }

      // Match com as linhas atuais
      const used = new Set<number>();
      let matched = 0;
      const next = rows.map((r) => {
        const m = findBestPdfMatch(r.name, entries, used);
        if (m) {
          used.add(m.idx);
          matched++;
          return { ...r, folha: m.entry.value };
        }
        return r;
      });
      setRows(next);
      const unmatched = entries.filter((_, i) => !used.has(i));
      setPdfStatus({
        kind: "done",
        matched,
        total: entries.length,
        unmatchedPdf: unmatched,
      });
    } catch (err) {
      console.error(err);
      setPdfStatus({
        kind: "error",
        msg: "Falha ao ler PDF: " + (err as Error).message,
      });
    }
  }

  async function handleExportExcel() {
    setExporting(true);
    try {
      const XLSX = await import("xlsx");
      const aoa: (string | number | null)[][] = [];
      const dateLabel = paymentDate
        ? formatDateBR(paymentDate)
        : formatDateBR(job!.start_date);

      // Linha 1: título de pagamento (mesclado visualmente; aqui só posicionamos)
      aoa.push([null, null, null, null, `PAGAMENTO EM ${dateLabel}`]);
      aoa.push([]);
      aoa.push([]);
      // Cabeçalho de coluna K com cliente
      aoa.push([null, null, null, null, null, null, null, null, null, null, job!.client || ""]);

      // Cabeçalho principal
      aoa.push([
        null,
        null,
        "FUNCIONÁRIOS",
        "AGÊNCIA",
        "CONTA",
        "ITAÚ/SANTANDER",
        "PAGTO PLUXEE",
        "PAGTO NA FOLHA",
        "DESCONTO GERAL",
        "Perda de Material",
        `MV 1: ${job!.name}${
          job!.start_date || job!.end_date
            ? ` ${formatDateBR(job!.start_date)}${
                job!.end_date ? ` a ${formatDateBR(job!.end_date)}` : ""
              }`
            : ""
        }${dateLabel ? ` - VENCTO: ${dateLabel}` : ""}`,
      ]);
      aoa.push([
        null,
        null,
        "Limpeza de porão\nPAGAMENTO:",
      ]);

      let totalPluxee = 0,
        totalFolha = 0,
        totalDesconto = 0,
        totalPerda = 0,
        totalNavio = 0;

      rows.forEach((r, idx) => {
        aoa.push([
          null,
          idx + 1,
          r.name,
          r.agencia,
          r.conta,
          r.banco,
          r.pluxee || 0,
          r.folha || 0,
          r.desconto || 0,
          r.perda || 0,
          r.navio || 0,
        ]);
        totalPluxee += r.pluxee || 0;
        totalFolha += r.folha || 0;
        totalDesconto += r.desconto || 0;
        totalPerda += r.perda || 0;
        totalNavio += r.navio || 0;
      });

      // Linha em branco antes do TOTAL
      aoa.push([]);
      aoa.push([
        null,
        null,
        null,
        null,
        null,
        "TOTAL",
        totalPluxee,
        totalFolha,
        totalDesconto,
        totalPerda,
        totalNavio,
      ]);

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      // Larguras de colunas amigáveis
      ws["!cols"] = [
        { wch: 4 },
        { wch: 4 },
        { wch: 36 },
        { wch: 9 },
        { wch: 12 },
        { wch: 16 },
        { wch: 13 },
        { wch: 14 },
        { wch: 14 },
        { wch: 16 },
        { wch: 38 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "PAGAMENTO");
      const safeName = (job!.name || "pagamento").replace(/[^a-zA-Z0-9_-]+/g, "_");
      const dateForFile = (paymentDate || job!.start_date).slice(0, 10);
      XLSX.writeFile(wb, `${dateForFile}_${safeName}.xlsx`);
    } catch (err) {
      console.error(err);
      alert("Falha ao gerar XLSX: " + (err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  const totals = rows.reduce(
    (acc, r) => {
      acc.pluxee += r.pluxee || 0;
      acc.folha += r.folha || 0;
      acc.desconto += r.desconto || 0;
      acc.perda += r.perda || 0;
      acc.navio += r.navio || 0;
      return acc;
    },
    { pluxee: 0, folha: 0, desconto: 0, perda: 0, navio: 0 }
  );

  const titleStr = `🧾 Faturar — ${job.name}`;
  const inputCls =
    "w-full px-2 py-1 border border-border rounded text-xs focus:ring-2 focus:ring-primary outline-none text-right";

  return (
    <Modal open={open} onClose={onClose} title={titleStr} maxWidth="max-w-7xl">
      <div className="space-y-4">
        {/* Cabeçalho */}
        <div className="bg-gray-50 rounded-lg p-3 grid grid-cols-1 md:grid-cols-4 gap-3 text-xs">
          <div>
            <p className="text-text-light text-[10px] uppercase tracking-wider">Cliente</p>
            <p className="font-semibold">{job.client || "—"}</p>
          </div>
          <div>
            <p className="text-text-light text-[10px] uppercase tracking-wider">Navio / Operação</p>
            <p className="font-semibold">{job.ships?.name || job.name}</p>
          </div>
          <div>
            <p className="text-text-light text-[10px] uppercase tracking-wider">Período</p>
            <p className="font-semibold">
              {formatDateBR(job.start_date)}
              {job.end_date ? ` → ${formatDateBR(job.end_date)}` : ""}
            </p>
          </div>
          <div>
            <label className="text-text-light text-[10px] uppercase tracking-wider block">
              Data do Pagamento
            </label>
            <input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              className="mt-0.5 w-full px-2 py-1 border border-border rounded text-xs focus:ring-2 focus:ring-primary outline-none"
            />
          </div>
        </div>

        {/* PDF importer */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2">
          <div className="flex flex-wrap gap-2 items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-blue-900">📄 Importar Relação de Líquidos (PDF)</p>
              <p className="text-[11px] text-blue-800">
                O sistema lerá o PDF da contabilidade e preencherá <strong>PAGTO NA FOLHA</strong> casando pelo nome.
              </p>
            </div>
            <label className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition cursor-pointer">
              {pdfStatus.kind === "parsing" ? "Lendo…" : "Selecionar PDF"}
              <input
                type="file"
                accept="application/pdf"
                onChange={handlePdfUpload}
                disabled={pdfStatus.kind === "parsing"}
                className="hidden"
              />
            </label>
          </div>

          {pdfStatus.kind === "done" && (
            <div className="text-[11px] space-y-1">
              <p className="text-emerald-800">
                ✓ Casados <strong>{pdfStatus.matched}</strong> de <strong>{pdfStatus.total}</strong> registros do PDF.
              </p>
              {pdfStatus.unmatchedPdf && pdfStatus.unmatchedPdf.length > 0 && (
                <details className="text-amber-800">
                  <summary className="cursor-pointer">
                    ⚠ {pdfStatus.unmatchedPdf.length} sem match (clique para ver e preencher manualmente)
                  </summary>
                  <ul className="mt-1 ml-4 list-disc">
                    {pdfStatus.unmatchedPdf.map((u, i) => (
                      <li key={i}>
                        {u.name} — <strong>{brl(u.value)}</strong>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {pdfStatus.kind === "error" && (
            <p className="text-[11px] text-red-800">{pdfStatus.msg}</p>
          )}
        </div>

        {/* Tabela editável */}
        <div className="overflow-x-auto bg-card border border-border rounded-lg">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 border-b border-border">
              <tr>
                <th className="px-2 py-2 text-left font-semibold text-text-light">#</th>
                <th className="px-2 py-2 text-left font-semibold text-text-light">FUNCIONÁRIOS</th>
                <th className="px-2 py-2 text-left font-semibold text-text-light">AGÊNCIA</th>
                <th className="px-2 py-2 text-left font-semibold text-text-light">CONTA</th>
                <th className="px-2 py-2 text-left font-semibold text-text-light">BANCO</th>
                <th className="px-2 py-2 text-right font-semibold text-text-light">PAGTO PLUXEE</th>
                <th className="px-2 py-2 text-right font-semibold text-text-light">PAGTO NA FOLHA</th>
                <th className="px-2 py-2 text-right font-semibold text-text-light">DESCONTO</th>
                <th className="px-2 py-2 text-right font-semibold text-text-light">PERDA MATERIAL</th>
                <th className="px-2 py-2 text-right font-semibold text-text-light">NAVIO ({job.client || "TOTAL"})</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr key={r.allocId} className="border-b border-border last:border-0 hover:bg-gray-50">
                  <td className="px-2 py-1 text-text-light">{idx + 1}</td>
                  <td className="px-2 py-1 font-medium whitespace-nowrap">{r.name}</td>
                  <td className="px-2 py-1 text-text-light">{r.agencia || "—"}</td>
                  <td className="px-2 py-1 text-text-light">{r.conta || "—"}</td>
                  <td className="px-2 py-1 text-text-light">{r.banco || "—"}</td>
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      step="0.01"
                      value={r.pluxee || ""}
                      onChange={(e) => updateRow(idx, { pluxee: parseFloat(e.target.value) || 0 })}
                      className={inputCls}
                      placeholder="0,00"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      step="0.01"
                      value={r.folha || ""}
                      onChange={(e) => updateRow(idx, { folha: parseFloat(e.target.value) || 0 })}
                      className={`${inputCls} ${r.folha > 0 ? "bg-emerald-50 border-emerald-300" : ""}`}
                      placeholder="0,00"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      step="0.01"
                      value={r.desconto || ""}
                      onChange={(e) => updateRow(idx, { desconto: parseFloat(e.target.value) || 0 })}
                      className={inputCls}
                      placeholder="0,00"
                    />
                  </td>
                  <td className="px-1 py-1">
                    <input
                      type="number"
                      step="0.01"
                      value={r.perda || ""}
                      onChange={(e) => updateRow(idx, { perda: parseFloat(e.target.value) || 0 })}
                      className={inputCls}
                      placeholder="0,00"
                    />
                  </td>
                  <td className="px-2 py-1 text-right font-semibold text-emerald-700">{brl(r.navio)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 border-t-2 border-border font-semibold">
              <tr>
                <td colSpan={5} className="px-2 py-2 text-right text-text-light">TOTAL</td>
                <td className="px-2 py-2 text-right text-amber-700">{brl(totals.pluxee)}</td>
                <td className="px-2 py-2 text-right text-purple-700">{brl(totals.folha)}</td>
                <td className="px-2 py-2 text-right text-red-700">{brl(totals.desconto)}</td>
                <td className="px-2 py-2 text-right text-red-700">{brl(totals.perda)}</td>
                <td className="px-2 py-2 text-right text-emerald-700">{brl(totals.navio)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" type="button" onClick={onClose}>
            Fechar
          </Button>
          <Button type="button" onClick={handleExportExcel} disabled={exporting || rows.length === 0}>
            {exporting ? "Gerando…" : "📥 Gerar Planilha de Pagamento"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─── COSTADO TAB ────────────────────────────────────────────────────────────

function CostadoTab({
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
  const [detailJob, setDetailJob] = useState<Job | null>(null);
  const [statusFilter, setStatusFilter] = useState<JobStatus | "TODOS">("TODOS");

  // Costado jobs = jobs whose ship is marked as Costado OR that have any COSTADO allocation.
  const costadoShipIds = new Set(
    ships.filter((s) => (s.services || []).includes("COSTADO")).map((s) => s.id)
  );
  const jobsWithCostadoAlloc = new Set(
    allocations.filter((a) => a.kind === "COSTADO").map((a) => a.job_id)
  );
  const costadoJobs = jobs.filter(
    (j) => (j.ship_id && costadoShipIds.has(j.ship_id)) || jobsWithCostadoAlloc.has(j.id),
  );
  const filtered = costadoJobs.filter((j) => statusFilter === "TODOS" || j.status === statusFilter);

  // For job cards, compute Costado-only cost (filter allocs to kind=COSTADO).
  function costadoCost(job: Job) {
    const allocs = allocations.filter((a) => a.job_id === job.id && a.kind === "COSTADO");
    const adjs = adjustments.filter((a) => a.job_id === job.id);
    const base = allocs.reduce((s, a) => s + calcAllocBase(a, job.holds_count), 0);
    const adj = adjs.reduce((s, a) => s + (a.type === "ADICIONAL" ? Number(a.amount) : -Number(a.amount)), 0);
    return base + adj;
  }

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
      </div>

      {loading ? (
        <p className="text-center text-text-light py-12">Carregando...</p>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 bg-card rounded-xl border border-border">
          <p className="text-3xl mb-2">⚓</p>
          <p className="text-sm text-text-light">Nenhum pagamento de Costado encontrado.</p>
          <p className="text-xs text-text-light mt-1">
            Crie um navio marcado como <strong>Costado</strong> e aloque a equipe na Escalação de Costado.
          </p>
        </div>
      ) : (
        <div className="grid gap-2">
          {filtered.map((j) => {
            const total = costadoCost(j);
            const allocs = allocations.filter((a) => a.job_id === j.id && a.kind === "COSTADO");
            const shifts = allocs.reduce((s, a) => s + a.quantity, 0);
            const hours = shifts * HOURS_PER_SHIFT;
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
                      {formatJobDate(j.start_date)} {j.end_date ? `→ ${formatJobDate(j.end_date)}` : "→ em aberto"} · {allocs.length} aloc. · {shifts} turnos · {hours}h
                    </p>
                  </div>
                  <div className="flex gap-3 items-center text-xs flex-wrap">
                    <div>
                      <p className="text-text-light">Custo Costado</p>
                      <p className="font-semibold text-red-700">{brl(total)}</p>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <JobDetailModal
        open={!!detailJob}
        job={detailJob}
        allocations={allocations.filter((a) => a.job_id === detailJob?.id && a.kind === "COSTADO")}
        adjustments={adjustments.filter((a) => a.job_id === detailJob?.id)}
        functions={functions}
        employees={employees}
        canEdit={canEdit}
        profileName={profileName}
        kindFilter="COSTADO"
        onClose={() => setDetailJob(null)}
        onChange={() => { onChange(); }}
      />
    </div>
  );
}

// ─── PLACEHOLDERS (fase 5) ──────────────────────────────────────────────────

function DocumentosPlaceholder() {
  // Sub-abas pensadas (não implementadas ainda): Folha de Pagamento, Recibos,
  // Resumo Mensal, etc. Padrão será o mesmo de RH › Documentos (sub-tabs por ?doc=…).
  const sketches = [
    { icon: "💵", label: "Folha de Pagamento", desc: "Planilha consolidada para envio à contabilidade." },
    { icon: "🧾", label: "Recibos", desc: "Geração de recibo por colaborador." },
    { icon: "📊", label: "Resumo Mensal", desc: "Relatório financeiro do mês." },
  ];
  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <div className="text-3xl">📄</div>
          <div>
            <h3 className="font-semibold text-blue-900">Documentos — em desenvolvimento</h3>
            <p className="text-sm text-blue-800 mt-0.5">
              Geração de planilhas e relatórios financeiros. Vai seguir o mesmo padrão de
              {" "}<strong>RH › Documentos</strong> (sub-abas por tipo de documento).
            </p>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {sketches.map((s) => (
          <div key={s.label} className="bg-white border border-dashed border-border rounded-xl p-4 text-center opacity-70">
            <div className="text-3xl mb-2">{s.icon}</div>
            <p className="font-semibold text-sm">{s.label}</p>
            <p className="text-xs text-text-light mt-1">{s.desc}</p>
            <p className="text-[10px] uppercase tracking-wider font-semibold text-amber-700 mt-3">Em breve</p>
          </div>
        ))}
      </div>
    </div>
  );
}
