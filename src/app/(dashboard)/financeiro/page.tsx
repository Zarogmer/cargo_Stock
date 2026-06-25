"use client";

// Polyfill Uint8Array.prototype.toHex / fromHex / setFromHex usado pelo
// pdfjs-dist v5. Esses métodos só existem em Chromium 140+ (Electron 37+).
// O app desktop hoje roda Electron 33 (Chromium ~130) e quebra com
// "a.toHex is not a function" ao importar PDF. No browser comum os métodos
// já existem nativamente, então a checagem typeof torna o polyfill um
// no-op fora do desktop. Mantém-se aqui pra não precisar republicar o
// instalador toda vez que o pdfjs subir uma versão.
if (typeof window !== "undefined") {
  const U8 = Uint8Array.prototype as Uint8Array & {
    toHex?: () => string;
    setFromHex?: (s: string) => { read: number; written: number };
  };
  if (typeof U8.toHex !== "function") {
    Object.defineProperty(U8, "toHex", {
      value: function (this: Uint8Array): string {
        let out = "";
        for (let i = 0; i < this.length; i++) out += this[i].toString(16).padStart(2, "0");
        return out;
      },
      writable: true,
      configurable: true,
    });
  }
  if (typeof U8.setFromHex !== "function") {
    Object.defineProperty(U8, "setFromHex", {
      value: function (this: Uint8Array, s: string): { read: number; written: number } {
        const len = Math.min(this.length, Math.floor(s.length / 2));
        for (let i = 0; i < len; i++) this[i] = parseInt(s.substr(i * 2, 2), 16);
        return { read: len * 2, written: len };
      },
      writable: true,
      configurable: true,
    });
  }
  const U8c = Uint8Array as typeof Uint8Array & { fromHex?: (s: string) => Uint8Array };
  if (typeof U8c.fromHex !== "function") {
    Object.defineProperty(U8c, "fromHex", {
      value: function (s: string): Uint8Array {
        if (s.length % 2 !== 0) throw new SyntaxError("Hex string must have an even length");
        const bytes = new Uint8Array(s.length / 2);
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(s.substr(i * 2, 2), 16);
        return bytes;
      },
      writable: true,
      configurable: true,
    });
  }
}

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { Tabs } from "@/components/ui/tabs";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { DocumentosTab } from "./documentos-tab";
import { GerarPluxeeButton } from "./gerar-pluxee-button";
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
  TURNO: "Turno (Costado)",
};

// Fluxo simplificado: tudo que não foi pago aparece como "Em Andamento" (cobre
// também os legados ABERTO e VERIFICADO). FECHADO = "Pago".
const STATUS_LABELS: Record<JobStatus, string> = {
  ABERTO: "Em Andamento",
  EM_ANDAMENTO: "Em Andamento",
  VERIFICADO: "Em Andamento",
  FECHADO: "Pago",
  CANCELADO: "Cancelado",
};

const STATUS_COLORS: Record<JobStatus, string> = {
  ABERTO: "bg-amber-100 text-amber-700",
  EM_ANDAMENTO: "bg-amber-100 text-amber-700",
  VERIFICADO: "bg-amber-100 text-amber-700",
  FECHADO: "bg-emerald-100 text-emerald-700",
  CANCELADO: "bg-red-100 text-red-700",
};

// Situação operacional do navio (espelha a aba Navios). Mostrada no Financeiro
// pra acompanhar Agendado/Em Operação/Concluído sem precisar fechar o navio.
const SHIP_STATUS_LABELS: Record<string, string> = {
  AGENDADO: "Agendado",
  EM_OPERACAO: "Em Operação",
  CONCLUIDO: "Concluído",
  CANCELADO: "Cancelado",
};
const SHIP_STATUS_COLORS: Record<string, string> = {
  AGENDADO: "bg-blue-100 text-blue-700",
  EM_OPERACAO: "bg-amber-100 text-amber-700",
  CONCLUIDO: "bg-emerald-100 text-emerald-700",
  CANCELADO: "bg-red-100 text-red-700",
};

function shipStatusOf(job: Job): string | null {
  return (job as Job & { ships?: { status?: string | null } }).ships?.status ?? null;
}

// Badge da situação operacional do navio.
function ShipStatusBadge({ status }: { status?: string | null }) {
  if (!status) return null;
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SHIP_STATUS_COLORS[status] || "bg-gray-100 text-gray-600"}`} title="Situação do navio">
      {SHIP_STATUS_LABELS[status] || status}
    </span>
  );
}

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
//   EMBARQUE: rate (valor/porão) × holds_count, por funcionário (qty não importa).
//   COSTADO:  rate (valor/turno) × quantidade — cada linha = 1 turno (data + período).
//             O valor/turno já inclui adicional noturno quando aplicável; o cálculo
//             é feito na Escalação de Costado a partir de costado_function_rates
//             (hourly_rate × 6h × (1 + bonus se noturno)).
const HOURS_PER_SHIFT = 6;
// Períodos noturnos recebem o adicional configurado em costado_function_rates.
const COSTADO_NIGHT_SHIFT_PERIODS: ReadonlyArray<string> = ["19-01", "01-07"];
function calcAllocBase(a: JobAllocation, holdsCount: number | null): number {
  const k = a.kind || "EMBARQUE";
  const qty = a.quantity;
  const rate = Number(a.rate);
  const extra = Number(a.extra_value || 0);
  if (k === "EMBARQUE") {
    const holds = Math.max(1, Number(holdsCount || 1));
    return rate * holds + extra;
  }
  if (k === "COSTADO") {
    return rate * qty + extra;
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

// EMBARQUE: faz a função e o valor de cada escala virem SEMPRE do cadastro do
// colaborador (cargo em RH › Colaboradores + valor especial/padrão da função),
// e não de um snapshot gravado na alocação. Assim todo navio reflete o cadastro
// atual, sem valor "preso" por navio. Não grava nada — ajusta só em memória, na
// leitura, então não reescreve histórico. Costado fica de fora: lá todos entram
// na função fixa "COSTADO" (valor único definido em Valores).
function applyCadastroToAllocations(
  allocs: JobAllocation[],
  employees: Employee[],
  functions: JobFunction[],
  specialRates: Map<string, number>,
): JobAllocation[] {
  const empById = new Map<number, Employee>(employees.map((e) => [e.id, e]));
  const fnByName = new Map<string, JobFunction>(
    functions.map((f) => [f.name.trim().toUpperCase(), f]),
  );
  return allocs.map((a) => {
    if ((a.kind || "EMBARQUE") !== "EMBARQUE" || a.employee_id == null) return a;
    const role = (empById.get(a.employee_id)?.role || "").trim().toUpperCase();
    if (!role) return a;
    const fn = fnByName.get(role);
    if (!fn) return a;
    const special = specialRates.get(`${a.employee_id}-${fn.id}`);
    const rate = special != null ? special : Number(fn.default_rate);
    if (!Number.isFinite(rate)) return a;
    return { ...a, function_id: fn.id, rate, job_functions: { name: fn.name, unit: fn.unit } };
  });
}

// Fecha o navio a partir do Financeiro: marca CONCLUIDO + data de saída (igual
// à aba Navios) e, diferente do Navios, grava o Valor do Contrato no pagamento.
function CloseShipModal({
  job, onClose, onClosed,
}: {
  job: Job | null;
  onClose: () => void;
  onClosed: () => void;
}) {
  const [closeDate, setCloseDate] = useState(isoDate(new Date()));
  const [contractValue, setContractValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (job) {
      setCloseDate(job.end_date?.slice(0, 10) || isoDate(new Date()));
      setContractValue(job.contract_value != null ? String(job.contract_value) : "");
      setErr(null);
    }
  }, [job]);

  if (!job) return null;

  async function handleConfirm() {
    if (!job!.ship_id) { setErr("Este pagamento não está ligado a um navio."); return; }
    setSaving(true);
    setErr(null);
    try {
      const cv = contractValue.trim() === "" ? null : parseFloat(contractValue.replace(",", "."));
      const shipRes = await db.from("ships").update({ status: "CONCLUIDO", departure_date: closeDate }).eq("id", job!.ship_id);
      if (shipRes.error) throw new Error(shipRes.error.message);
      // Fecha a ponta dos pagamentos do navio e grava o contrato neste pagamento.
      await db.from("jobs").update({ end_date: closeDate }).eq("ship_id", job!.ship_id);
      await db.from("jobs").update({ contract_value: cv }).eq("id", job!.id);
      onClosed();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";
  return (
    <Modal open={!!job} onClose={onClose} title={`Fechar navio · ${job.ships?.name || job.name}`} maxWidth="max-w-md">
      <div className="space-y-4">
        <p className="text-xs text-text-light">
          Marca o navio como <strong>Concluído</strong> e registra a Data de Saída (igual ao botão da aba
          Navios). A diferença aqui é que você também grava o <strong>Valor do Contrato</strong> deste pagamento.
        </p>
        <div>
          <label className="block text-sm font-medium mb-1">Data de Saída *</label>
          <input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Valor do Contrato (R$)</label>
          <input type="number" step="0.01" value={contractValue} onChange={(e) => setContractValue(e.target.value)} placeholder="0,00" className={inputCls} />
          <p className="text-[11px] text-text-light mt-1">Quanto o cliente paga pela operação. Pode deixar em branco e preencher depois.</p>
        </div>
        {err && <p className="text-xs text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="button" onClick={handleConfirm} disabled={saving || !closeDate}>
            {saving ? "Fechando..." : "🏁 Fechar Navio"}
          </Button>
        </div>
      </div>
    </Modal>
  );
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
  // Map<"empId-fnId", rate> — overrides do employee_function_rates carregados
  // junto com o resto, pra que qualquer modal já tenha o lookup pronto e
  // não dependa de fetch assíncrono ao abrir o form (evita race condition).
  const [specialRates, setSpecialRates] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [fnRes, rtRes, jbRes, alRes, adRes, shRes, emRes, srRes] = await Promise.all([
      db.from("job_functions").select("*").order("name"),
      db.from("job_function_rates").select("*").order("valid_from", { ascending: false }),
      db.from("jobs").select("*, ships(name, status)").order("start_date", { ascending: false }),
      db.from("job_allocations").select("*, job_functions(name, unit), employees(name, bank_name, bank_agency, bank_account, bank_account_type)"),
      db.from("job_adjustments").select("*").order("created_at", { ascending: false }),
      db.from("ships").select("id, name, status, services").order("arrival_date", { ascending: false }).limit(50),
      db.from("employees").select("id, name, role, cpf, birth_date, bank_name, bank_agency, bank_account, bank_account_type, status").order("name"),
      db.from("employee_function_rates").select("employee_id, function_id, rate"),
    ]);
    let allFunctions = (fnRes.data as JobFunction[]) || [];
    // Auto-cria a função COSTADO (valor fixo por turno) na primeira vez que
    // a aba carrega — Costado é pago por turno de 6h, valor único pra todos.
    // R$ 100 é o default; o usuário ajusta inline depois.
    const hasCostado = allFunctions.some((f) => f.name.trim().toUpperCase() === "COSTADO");
    if (!hasCostado) {
      const created = await db.from("job_functions").insert({
        name: "COSTADO",
        description: "Limpeza em costado — pago por turno de 6h. Valor fixo, igual pra todos os colaboradores.",
        default_rate: 100,
        unit: "TURNO",
        active: true,
      } as Record<string, unknown>);
      if (!created.error) {
        // Re-busca pra pegar o id real do registro inserido.
        const re = await db.from("job_functions").select("*").order("name");
        allFunctions = (re.data as JobFunction[]) || allFunctions;
      }
    }
    setFunctions(allFunctions);
    setRates((rtRes.data as JobFunctionRate[]) || []);
    setJobs((jbRes.data as Job[]) || []);
    const emps = (emRes.data as Employee[]) || [];
    setEmployees(emps);
    const srMap = new Map<string, number>();
    for (const r of (srRes.data || []) as { employee_id: number; function_id: number; rate: string | number }[]) {
      srMap.set(`${r.employee_id}-${r.function_id}`, Number(r.rate));
    }
    setSpecialRates(srMap);
    // Função e valor de embarque vêm sempre do cadastro do colaborador — todo
    // navio reflete o cadastro atual (ver applyCadastroToAllocations).
    const rawAllocs = (alRes.data as JobAllocation[]) || [];
    setAllocations(applyCadastroToAllocations(rawAllocs, emps, allFunctions, srMap));
    setAdjustments((adRes.data as JobAdjustment[]) || []);
    setShips((shRes.data as Ship[]) || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Garante que todo navio apareça no Financeiro sem precisar fechar: se houver
  // navio sem Pagamento, cria os faltantes uma vez (mesmo backfill do botão
  // "Sincronizar navios"). Idempotente; roda só com permissão de edição.
  const didAutoSync = useRef(false);
  useEffect(() => {
    if (loading || didAutoSync.current || !canEdit) return;
    const linked = new Set(jobs.map((j) => j.ship_id).filter(Boolean) as string[]);
    if (!ships.some((s) => !linked.has(s.id))) return;
    didAutoSync.current = true;
    (async () => {
      try {
        const res = await fetch("/api/financeiro/jobs/backfill", { method: "POST" });
        if (res.ok) loadAll();
      } catch { /* silencioso — o botão "Sincronizar navios" continua disponível */ }
    })();
  }, [loading, ships, jobs, canEdit, loadAll]);

  // ── KPIs ──────────────────────────────────────────────────────────────────

  const kpis = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthJobs = jobs.filter((j) => new Date(j.start_date) >= monthStart);
    const totalCostMonth = monthJobs.reduce((s, j) => s + calcJobCost(j, allocations, adjustments).total, 0);
    const totalRevenueMonth = monthJobs.reduce((s, j) => s + Number(j.contract_value || 0), 0);
    return {
      activeFunctions: functions.filter((f) => f.active).length,
      // "Em Andamento" cobre todos os status que não são Pago (FECHADO) nem Cancelado.
      openJobs: jobs.filter((j) => j.status !== "FECHADO" && j.status !== "CANCELADO").length,
      monthCost: totalCostMonth,
      monthRevenue: totalRevenueMonth,
      monthProfit: totalRevenueMonth - totalCostMonth,
    };
  }, [functions, jobs, allocations, adjustments]);

  const financeiroTabs = [
    {
      key: "funcoes",
      label: "💰 Valores",
      content: (
        <FuncoesTab
          functions={functions}
          rates={rates}
          allocations={allocations}
          employees={employees}
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
          specialRates={specialRates}
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
          specialRates={specialRates}
          canEdit={canEdit}
          profileName={profile?.full_name || "Sistema"}
          onChange={loadAll}
          loading={loading}
        />
      ),
    },
    {
      key: "controle",
      label: "🎯 Controle",
      content: (
        <ControleTab
          jobs={jobs}
          allocations={allocations}
          adjustments={adjustments}
          functions={functions}
          ships={ships}
          employees={employees}
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
    {
      key: "documentos",
      label: "📄 Documentos",
      content: (
        <DocumentosTab
          jobs={jobs}
          allocations={allocations}
          employees={employees}
          canEdit={canEdit}
          profileName={profile?.full_name || "Sistema"}
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

// ─── Custo Base por Porão ──────────────────────────────────────────────────
// Calcula quanto sai um porão considerando a equipe padrão:
// 4 ajudantes + 4 esfregão + 4 wap + 1 maquinista + 1 supervisor + 1 cozinheiro.
// Headcounts são editáveis pra simular variações (nem sempre escala completa),
// e ficam persistidos no localStorage. Mensalistas (analista RH etc.) não
// entram na conta — porão é só Embarque por produção.

const POR_PORAO_UNITS: ReadonlyArray<JobUnit> = ["PORAO", "POR_NAVIO", "POR_OPERACAO"];

const DEFAULT_HEADCOUNTS_BY_NAME: Record<string, number> = {
  AJUDANTE: 4,
  ESFREGAO: 4,
  "ESFREGÃO": 4,
  WAP: 4,
  MAQUINISTA: 1,
  SUPERVISOR: 1,
  COZINHEIRO: 1,
};

const HEADCOUNTS_STORAGE_KEY = "financeiro:porao-headcounts";

function defaultHeadcountForName(name: string): number {
  const key = name.trim().toUpperCase();
  return DEFAULT_HEADCOUNTS_BY_NAME[key] ?? 0;
}

function CustoPorPoraoPanel({ functions }: { functions: JobFunction[] }) {
  // Só funções de porão e ativas entram aqui.
  const poraoFns = useMemo(
    () => functions.filter((f) => f.active && POR_PORAO_UNITS.includes(f.unit)),
    [functions],
  );

  // headcounts[fnId] = qty selecionada. Inicializa a partir do localStorage,
  // com fallback nos defaults da equipe padrão.
  const [headcounts, setHeadcounts] = useState<Record<number, number>>({});
  const [collapsed, setCollapsed] = useState(false);

  // Seed inicial: mistura defaults com valores salvos. Roda toda vez que a
  // lista de funções muda (após criar/excluir função nova).
  useEffect(() => {
    let saved: Record<string, number> = {};
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(HEADCOUNTS_STORAGE_KEY) : null;
      if (raw) saved = JSON.parse(raw) as Record<string, number>;
    } catch {
      saved = {};
    }
    const next: Record<number, number> = {};
    for (const f of poraoFns) {
      const fromSaved = saved[String(f.id)];
      next[f.id] = Number.isFinite(fromSaved) ? Number(fromSaved) : defaultHeadcountForName(f.name);
    }
    setHeadcounts(next);
  }, [poraoFns]);

  function updateQty(fnId: number, qtyRaw: string) {
    const n = Math.max(0, Math.floor(parseFloat(qtyRaw.replace(",", ".")) || 0));
    setHeadcounts((prev) => {
      const next = { ...prev, [fnId]: n };
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(HEADCOUNTS_STORAGE_KEY, JSON.stringify(next));
        }
      } catch {
        // localStorage cheio / privado — silencioso.
      }
      return next;
    });
  }

  function resetDefaults() {
    const next: Record<number, number> = {};
    for (const f of poraoFns) next[f.id] = defaultHeadcountForName(f.name);
    setHeadcounts(next);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(HEADCOUNTS_STORAGE_KEY, JSON.stringify(next));
      }
    } catch {
      // ignore
    }
  }

  const totalHeadcount = poraoFns.reduce((acc, f) => acc + (headcounts[f.id] ?? 0), 0);
  const totalCost = poraoFns.reduce(
    (acc, f) => acc + Number(f.default_rate) * (headcounts[f.id] ?? 0),
    0,
  );

  if (poraoFns.length === 0) return null;

  return (
    <div className="bg-amber-50/50 border border-amber-200 rounded-xl">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-amber-50 transition rounded-xl"
      >
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-amber-900">💰 Custo Base por Porão</span>
          <span className="text-xs text-amber-800">
            {totalHeadcount} {totalHeadcount === 1 ? "pessoa" : "pessoas"} · <strong>{brl(totalCost)}</strong> / porão
          </span>
        </div>
        <span className="text-amber-700 text-xs">{collapsed ? "▾ Expandir" : "▴ Recolher"}</span>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 space-y-2">
          <p className="text-[11px] text-amber-900/80 leading-snug">
            Equipe padrão por porão: <strong>4 ajudantes</strong> + <strong>4 esfregão</strong> + <strong>4 WAP</strong> + <strong>1 maquinista</strong> + <strong>1 supervisor</strong> + <strong>1 cozinheiro</strong>.
            Ajuste a quantidade pra simular outras formações. Mensalistas (analista RH etc.) não entram.
          </p>

          <div className="bg-white border border-amber-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-amber-50/70 border-b border-amber-200">
                <tr>
                  <th className="px-3 py-2 text-left text-[10px] font-semibold text-amber-900 uppercase tracking-wider">Função</th>
                  <th className="px-3 py-2 text-center text-[10px] font-semibold text-amber-900 uppercase tracking-wider w-20">Qtde</th>
                  <th className="px-3 py-2 text-right text-[10px] font-semibold text-amber-900 uppercase tracking-wider">Valor un.</th>
                  <th className="px-3 py-2 text-right text-[10px] font-semibold text-amber-900 uppercase tracking-wider">Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {poraoFns.map((f) => {
                  const qty = headcounts[f.id] ?? 0;
                  const rate = Number(f.default_rate);
                  const sub = qty * rate;
                  return (
                    <tr key={f.id} className="border-b border-amber-100 last:border-0">
                      <td className="px-3 py-1.5 font-medium text-text">{f.name}</td>
                      <td className="px-3 py-1.5 text-center">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={qty}
                          onChange={(e) => updateQty(f.id, e.target.value)}
                          className="w-14 px-1.5 py-0.5 border border-amber-200 rounded text-center text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right text-text-light text-xs">{brl(rate)}</td>
                      <td className="px-3 py-1.5 text-right font-semibold text-emerald-700">{brl(sub)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-amber-50 border-t-2 border-amber-200">
                <tr>
                  <td className="px-3 py-2 text-xs font-semibold text-amber-900 uppercase tracking-wider">Total por porão</td>
                  <td className="px-3 py-2 text-center font-semibold text-amber-900">{totalHeadcount}</td>
                  <td className="px-3 py-2"></td>
                  <td className="px-3 py-2 text-right font-bold text-emerald-800">{brl(totalCost)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-amber-800/80 italic">
              Quantidades ficam salvas no seu navegador. Use como base — nem todo navio escala equipe cheia.
            </p>
            <button
              type="button"
              onClick={resetDefaults}
              className="text-[10px] font-semibold text-amber-900 hover:bg-amber-100 px-2 py-1 rounded transition"
            >
              ↺ Resetar pra equipe padrão
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function FuncoesTab({
  functions, rates, allocations, employees, canEdit, onChange, loading,
}: {
  functions: JobFunction[];
  rates: JobFunctionRate[];
  allocations: JobAllocation[];
  employees: Employee[];
  canEdit: boolean;
  onChange: () => void;
  loading: boolean;
}) {
  const [editFn, setEditFn] = useState<JobFunction | null>(null);
  const [showFnForm, setShowFnForm] = useState(false);
  const [historyFn, setHistoryFn] = useState<JobFunction | null>(null);
  const [deleteFn, setDeleteFn] = useState<JobFunction | null>(null);
  const [ratesFn, setRatesFn] = useState<JobFunction | null>(null);
  // Função cujo elenco de colaboradores está aberto no modal de listagem.
  const [viewEmpsFn, setViewEmpsFn] = useState<JobFunction | null>(null);
  const [search, setSearch] = useState("");

  // Count distinct allocations (records), not the sum of worked days. With the
  // new Escalação flow records are inserted with quantity=0 and the days are
  // filled in at finalization; counting records is what matters for delete
  // safety because the FK constraint cares about row presence, not values.
  const allocCount = (fnId: number) =>
    allocations.filter((a) => a.function_id === fnId).length;

  // Conta colaboradores ATIVOS cuja função (role) bate com o nome da função.
  // Comparação case-insensitive e ignora INATIVO/PENDENCIA.
  const employeeCount = (fnName: string) => {
    const target = fnName.trim().toUpperCase();
    return employees.filter(
      (e) => (e.status ?? "ATIVO") === "ATIVO" && (e.role || "").trim().toUpperCase() === target,
    ).length;
  };

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
                <th className="px-4 py-2.5 text-left text-xs font-semibold text-text-light uppercase tracking-wider">Colaboradores</th>
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
                  <td className="px-4 py-2.5 text-text-light text-xs">
                    {(() => {
                      // Costado é uma atividade, não uma role — qualquer
                      // colaborador operacional pode ser escalado. Mostra
                      // total de ativos em vez do match por role (que daria 0).
                      const isCostado = f.name.trim().toUpperCase() === "COSTADO";
                      if (isCostado) {
                        const totalActive = employees.filter((e) => (e.status ?? "ATIVO") === "ATIVO").length;
                        return (
                          <span className="inline-flex items-center gap-1 text-indigo-700">
                            <span>🌍 Qualquer um — </span>
                            <strong className="text-text">{totalActive}</strong>
                            <span>ativos no sistema</span>
                          </span>
                        );
                      }
                      const n = employeeCount(f.name);
                      if (n === 0) return <span className="text-text-light/60">— nenhum cadastrado</span>;
                      return (
                        <button
                          type="button"
                          onClick={() => setViewEmpsFn(f)}
                          className="inline-flex items-center gap-1 px-2 py-1 -mx-2 -my-1 rounded hover:bg-blue-50 hover:text-primary transition cursor-pointer"
                          title="Ver lista de colaboradores"
                        >
                          <strong className="text-text">{n}</strong>
                          <span>{n === 1 ? "colaborador" : "colaboradores"}</span>
                          <span className="text-[10px] opacity-60">▸</span>
                        </button>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex gap-1 justify-end">
                      {/* Valores especiais por funcionário NÃO se aplicam a
                          COSTADO — Costado é valor fixo único, igual pra todos.
                          Só funções de Embarque podem ter override por pessoa. */}
                      {f.name.trim().toUpperCase() !== "COSTADO" && (
                        <button onClick={() => setRatesFn(f)} className="p-1.5 text-amber-700 hover:bg-amber-50 rounded" title="Valores especiais por funcionário">
                          <span className="text-base leading-none">👤</span>
                        </button>
                      )}
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

      {/* Custo Base por Porão — simulador embaixo da lista pra calcular
          quanto sai um porão com base nos valores configurados acima. */}
      <CustoPorPoraoPanel functions={functions} />

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
        onChange={onChange}
      />

      <EmployeesByFunctionModal
        fn={viewEmpsFn}
        employees={employees}
        onClose={() => setViewEmpsFn(null)}
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
      setDefaultRate(Number(item.default_rate).toFixed(2).replace(".", ","));
      setUnit(item.unit);
      setActive(item.active);
    } else {
      setName(""); setDescription(""); setDefaultRate(""); setUnit("PORAO"); setActive(true);
    }
  }, [item, open]);

  function handleRateBlur() {
    const raw = defaultRate.replace(/\./g, "").replace(",", ".");
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) { setDefaultRate(""); return; }
    setDefaultRate(n.toFixed(2).replace(".", ","));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    const rateNum = parseFloat(defaultRate.replace(/\./g, "").replace(",", ".")) || 0;
    const payload = {
      name: name.trim().toUpperCase(),
      description: description.trim() || null,
      default_rate: rateNum,
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
            <input type="text" inputMode="decimal" value={defaultRate} onChange={(e) => setDefaultRate(e.target.value.replace(/[^\d.,]/g, ""))} onBlur={handleRateBlur} className={inputCls} placeholder="0,00" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Unidade</label>
            <select value={unit} onChange={(e) => setUnit(e.target.value as JobUnit)} className={inputCls}>
              <option value="PORAO">Porão (Embarque)</option>
              <option value="TURNO">Turno (Costado)</option>
              <option value="MENSALISTA">Mensalista</option>
            </select>
          </div>
        </div>
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

// ─── EMPLOYEES BY FUNCTION MODAL ───────────────────────────────────────────
// Lista, em modo somente-leitura, os colaboradores cujo role bate com a
// função selecionada. Permite filtrar por status e busca por nome, e tem
// atalho pra abrir a aba Colaboradores filtrada pela função.
function EmployeesByFunctionModal({
  fn, employees, onClose,
}: {
  fn: JobFunction | null;
  employees: Employee[];
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ATIVO" | "TODOS">("ATIVO");

  // Lista de colaboradores cuja `role` bate com o nome da função (case-insensitive).
  const list = useMemo(() => {
    if (!fn) return [];
    const target = fn.name.trim().toUpperCase();
    return employees
      .filter((e) => (e.role || "").trim().toUpperCase() === target)
      .filter((e) => (statusFilter === "ATIVO" ? (e.status ?? "ATIVO") === "ATIVO" : true))
      .filter((e) => {
        if (!search.trim()) return true;
        return e.name.toLowerCase().includes(search.toLowerCase());
      })
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [fn, employees, search, statusFilter]);

  function statusBadge(status: Employee["status"]) {
    const s = status ?? "ATIVO";
    const cls =
      s === "ATIVO" ? "bg-emerald-100 text-emerald-700"
      : s === "INATIVO" ? "bg-gray-100 text-gray-600"
      : "bg-amber-100 text-amber-700"; // PENDENCIA
    return (
      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${cls}`}>
        {s}
      </span>
    );
  }

  return (
    <Modal
      open={!!fn}
      onClose={onClose}
      title={fn ? `Colaboradores · ${fn.name}` : ""}
      maxWidth="max-w-2xl"
    >
      {fn && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              placeholder="Buscar por nome..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 min-w-[180px] px-3 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
            />
            <div className="flex gap-1 text-xs">
              {(["ATIVO", "TODOS"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={`px-2.5 py-1.5 rounded-lg border transition font-medium ${
                    statusFilter === s
                      ? "bg-primary text-white border-primary"
                      : "border-border text-text-light hover:bg-gray-50"
                  }`}
                >
                  {s === "ATIVO" ? "Só ativos" : "Todos"}
                </button>
              ))}
            </div>
          </div>

          <div className="text-xs text-text-light">
            {list.length === 0 ? "Nenhum colaborador" : `${list.length} ${list.length === 1 ? "colaborador" : "colaboradores"}`}
            {" "}cuja função (role) é <strong className="text-text">{fn.name}</strong>.
          </div>

          <div className="border border-border rounded-xl divide-y divide-border max-h-[55vh] overflow-y-auto">
            {list.length === 0 ? (
              <p className="px-3 py-6 text-xs text-text-light italic text-center">
                Nenhum colaborador com essa função.
                {statusFilter === "ATIVO" && " Tente trocar pra \"Todos\" pra ver inativos."}
              </p>
            ) : (
              list.map((e) => (
                <div key={e.id} className="px-3 py-2 flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    <span className="text-xs font-semibold text-primary">
                      {e.name.charAt(0).toUpperCase()}
                    </span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate flex items-center gap-2">
                      {e.name}
                      {statusBadge(e.status)}
                    </p>
                    <p className="text-[10px] text-text-light">
                      {e.team || <span className="italic">sem equipe</span>}
                      {e.phone && <> · <span className="font-mono">{e.phone}</span></>}
                      {e.sector && <> · {e.sector}</>}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-between pt-1">
            <a
              href="/colaboradores"
              className="text-xs text-primary hover:underline"
            >
              Abrir aba Colaboradores →
            </a>
            <Button variant="secondary" onClick={onClose}>Fechar</Button>
          </div>
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
  open, fn, canEdit, onClose, onChange,
}: {
  open: boolean;
  fn: JobFunction | null;
  canEdit: boolean;
  onClose: () => void;
  onChange?: () => void;
}) {
  const [employees, setEmployees] = useState<{ id: number; name: string; status: string | null; role: string | null }[]>([]);
  // Por padrão a lista mostra só os funcionários DESTA função (cargo base de
  // Colaboradores); marcar este checkbox revela todos — pra quando um navio
  // escala alguém numa função diferente da dele. Reinicia desmarcado ao abrir.
  const [showAll, setShowAll] = useState(false);
  const [overrides, setOverrides] = useState<Record<number, { id?: number; rate: string }>>({});
  // Snapshot dos rates carregados do banco — usado pra detectar quais funcionários
  // realmente mudaram no Save (e só sincronizar as alocações que precisam).
  const [originalRates, setOriginalRates] = useState<Record<number, number>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [savedToast, setSavedToast] = useState<string | null>(null);

  const loadRates = useCallback(async () => {
    if (!fn) return;
    setLoading(true);
    const [empRes, rateRes] = await Promise.all([
      db.from("employees").select("id, name, status, role").order("name"),
      db.from("employee_function_rates").select("*").eq("function_id", fn!.id),
    ]);
    // Carrega TODOS os ativos (com o cargo base de Colaboradores). A lista filtra
    // por padrão só os DESTA função; o checkbox "mostrar todos" revela o resto.
    // Pré-popula overrides pra todos, então alternar a visão não recarrega e o
    // Save cobre quem tem valor especial mesmo sem estar visível. Inativos fora.
    const emps = ((empRes.data as { id: number; name: string; status: string | null; role: string | null }[]) || [])
      .filter((e) => e.status !== "INATIVO");
    setEmployees(emps);
    const defaultStr = Number(fn.default_rate).toFixed(2).replace(".", ",");
    // Pré-popula TODOS os funcionários com o valor padrão. Quem tiver override
    // no banco recebe esse valor por cima. Assim a lista vira "editável direto".
    const map: Record<number, { id?: number; rate: string }> = {};
    const origs: Record<number, number> = {};
    for (const e of emps) {
      map[e.id] = { rate: defaultStr };
    }
    for (const r of (rateRes.data || []) as { id: number; employee_id: number; rate: string | number }[]) {
      map[r.employee_id] = { id: r.id, rate: Number(r.rate).toFixed(2).replace(".", ",") };
      origs[r.employee_id] = Number(r.rate);
    }
    setOverrides(map);
    setOriginalRates(origs);
    setLoading(false);
  }, [fn]);

  useEffect(() => {
    if (!open || !fn) return;
    setSearch("");
    setShowAll(false);
    setSavedToast(null);
    loadRates();
  }, [open, fn, loadRates]);

  function setRate(empId: number, value: string) {
    setOverrides((prev) => ({ ...prev, [empId]: { ...(prev[empId] || {}), rate: value } }));
  }

  function formatRateOnBlur(empId: number) {
    setOverrides((prev) => {
      const cur = prev[empId];
      if (!cur) return prev;
      const raw = (cur.rate ?? "").toString().trim().replace(",", ".");
      if (raw === "") return prev;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return prev;
      return { ...prev, [empId]: { ...cur, rate: n.toFixed(2).replace(".", ",") } };
    });
  }

  async function handleSave() {
    if (!fn) return;
    setSaving(true);
    setSavedToast(null);
    let changedCount = 0;
    const errors: string[] = [];
    try {
      // Jobs em aberto (não-FECHADO/CANCELADO) recebem o novo rate nas
      // alocações desse funcionário/função, pra que pagamentos abertos
      // reflitam imediatamente o "valor do funcionário".
      const { data: openJobs } = await db
        .from("jobs")
        .select("id")
        .in("status", ["ABERTO", "EM_ANDAMENTO", "VERIFICADO"]);
      const openJobIds = ((openJobs as { id: number }[]) || []).map((j) => j.id);
      const defaultRateLocal = Number(fn.default_rate);

      for (const emp of employees) {
        const o = overrides[emp.id];
        const raw = (o?.rate ?? "").toString().trim().replace(",", ".");
        const num = Number(raw);
        const hasValue = raw !== "" && Number.isFinite(num) && num > 0;
        const orig = originalRates[emp.id];
        const wasOverride = orig != null;
        // Considera "override" apenas quando o valor difere do padrão.
        // Igual ao padrão (ou em branco) → remove override do banco.
        const isOverride = hasValue && num !== defaultRateLocal;

        if (!wasOverride && !isOverride) continue;

        if (isOverride) {
          if (o?.id) {
            if (orig !== num) {
              const res = await db.from("employee_function_rates").update({ rate: num }).eq("id", o.id);
              if (res?.error) errors.push(`${emp.name}: ${res.error.message}`);
              else changedCount++;
            }
          } else {
            const res = await db.from("employee_function_rates").insert({
              employee_id: emp.id,
              function_id: fn.id,
              rate: num,
            });
            if (res?.error) errors.push(`${emp.name}: ${res.error.message}`);
            else changedCount++;
          }
          if (openJobIds.length > 0) {
            await db.from("job_allocations").update({ rate: num })
              .eq("employee_id", emp.id)
              .eq("function_id", fn.id)
              .in("job_id", openJobIds);
          }
        } else if (o?.id) {
          // Valor voltou pro padrão (ou foi apagado) → remove o override.
          const res = await db.from("employee_function_rates").delete().eq("id", o.id);
          if (res?.error) errors.push(`${emp.name}: ${res.error.message}`);
          else changedCount++;
          if (openJobIds.length > 0) {
            await db.from("job_allocations").update({ rate: defaultRateLocal })
              .eq("employee_id", emp.id)
              .eq("function_id", fn.id)
              .in("job_id", openJobIds);
          }
        }
      }
      // Recarrega os dados pra o usuário ver imediatamente os valores que ficaram salvos.
      await loadRates();
      onChange?.();
      if (errors.length > 0) {
        setSavedToast(`⚠️ ${errors.length} erro(s) ao salvar: ${errors.slice(0, 3).join("; ")}${errors.length > 3 ? "…" : ""}`);
      } else {
        setSavedToast(`✓ ${changedCount === 0 ? "Sem alterações pendentes." : `${changedCount} valor(es) salvos com sucesso.`}`);
      }
    } catch (err) {
      setSavedToast("❌ Erro ao salvar: " + (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Por padrão lista só os funcionários cujo cargo base é esta função; o checkbox
  // "mostrar todos" libera o resto (navio escalando alguém em outra função).
  const fnTarget = (fn?.name || "").trim().toUpperCase();
  const filtered = employees.filter((e) => {
    if (!showAll && (e.role || "").trim().toUpperCase() !== fnTarget) return false;
    return e.name.toLowerCase().includes(search.toLowerCase());
  });
  const defaultRate = Number(fn?.default_rate || 0);
  const overrideCount = Object.values(overrides).filter((o) => {
    const n = Number((o.rate || "").toString().replace(",", "."));
    return n > 0 && n !== defaultRate;
  }).length;

  return (
    <Modal open={open} onClose={onClose} title={fn ? `Valores especiais — ${fn.name}` : ""} maxWidth="max-w-2xl">
      {!fn ? null : (
        <div className="space-y-3">
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900 space-y-1">
            <p>
              💡 Cada funcionário começa com o valor padrão da função (
              <strong>{brl(fn.default_rate)}</strong>). Altere direto na linha quem ganha diferente —
              fica destacado em <strong>amarelo</strong> quando recebe a mais.
              {overrideCount > 0 && <span className="ml-1 font-semibold">· {overrideCount} com valor especial.</span>}
            </p>
            <p className="text-amber-800">
              ↻ Mudanças se aplicam também a alocações em pagamentos <strong>em aberto</strong>.
            </p>
          </div>

          <input
            type="text"
            placeholder="Buscar funcionário..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
          />

          {/* Por padrão só os da função; marcar revela todos os funcionários. */}
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="w-4 h-4 accent-primary"
            />
            <span className="text-text-light">
              Mostrar <strong className="text-text">todos os funcionários</strong> (de outras funções).
              {" "}Por padrão, só os de <strong className="text-text">{fn.name}</strong>.
            </span>
          </label>

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
                    <th className="px-3 py-2 text-right text-xs font-semibold text-text-light">Valor (R$)</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((emp) => {
                    const o = overrides[emp.id];
                    const rawText = (o?.rate ?? "").toString();
                    const num = Number(rawText.replace(",", "."));
                    const hasNumber = rawText.trim() !== "" && Number.isFinite(num) && num > 0;
                    // Destaque amarelo quando recebe MAIS que o padrão.
                    const receivesMore = hasNumber && num > defaultRate;
                    const rowBg = receivesMore ? "bg-amber-50 hover:bg-amber-100" : "hover:bg-gray-50";
                    const inputStyle = receivesMore
                      ? "border-amber-400 bg-amber-100 text-amber-900 font-semibold"
                      : "border-border text-text";
                    return (
                      <tr key={emp.id} className={`border-b border-border last:border-0 ${rowBg}`}>
                        <td className="px-3 py-2">
                          {emp.name}
                          {receivesMore && (
                            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded font-bold bg-amber-300 text-amber-900">
                              + {brl(num - defaultRate)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={o?.rate ?? ""}
                            onChange={(e) => setRate(emp.id, e.target.value)}
                            onBlur={() => formatRateOnBlur(emp.id)}
                            disabled={!canEdit}
                            className={`w-32 px-2 py-1 border-2 rounded text-sm text-right focus:ring-2 focus:ring-primary outline-none transition-colors ${inputStyle}`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {savedToast && (
            <div className={`text-xs px-3 py-2 rounded-lg border ${savedToast.startsWith("✓") ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-amber-50 border-amber-200 text-amber-900"}`}>
              {savedToast}
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
  jobs, allocations, adjustments, functions, ships, employees, specialRates, canEdit, profileName, onChange, loading,
}: {
  jobs: Job[];
  allocations: JobAllocation[];
  adjustments: JobAdjustment[];
  functions: JobFunction[];
  ships: Ship[];
  employees: Employee[];
  specialRates: Map<string, number>;
  canEdit: boolean;
  profileName: string;
  onChange: () => void;
  loading: boolean;
}) {
  const [editJob, setEditJob] = useState<Job | null>(null);
  const [showJobForm, setShowJobForm] = useState(false);
  const [detailJob, setDetailJob] = useState<Job | null>(null);
  const [deleteJob, setDeleteJob] = useState<Job | null>(null);
  const [closeShipJob, setCloseShipJob] = useState<Job | null>(null);
  const [statusFilter, setStatusFilter] = useState<JobStatus | "TODOS">("TODOS");
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Embarque tab excludes Costado ships (those have services=["COSTADO"]).
  const costadoShipIds = new Set(
    ships.filter((s) => (s.services || []).includes("COSTADO")).map((s) => s.id)
  );
  // Todo navio (não-Costado) entra no Financeiro, em qualquer situação — não
  // precisa fechar antes. Só esconde navio Cancelado. Jobs sem navio
  // (lançamentos manuais) sempre aparecem.
  const embarqueJobs = jobs.filter((j) =>
    (!j.ship_id || !costadoShipIds.has(j.ship_id)) &&
    (!j.ship_id || shipStatusOf(j) !== "CANCELADO"),
  );
  // O filtro "EM_ANDAMENTO" pega qualquer status que NÃO é Pago nem Cancelado
  // (cobre os legados ABERTO/VERIFICADO).
  const filtered = embarqueJobs.filter((j) => {
    if (statusFilter === "TODOS") return true;
    if (statusFilter === "EM_ANDAMENTO") return j.status !== "FECHADO" && j.status !== "CANCELADO";
    return j.status === statusFilter;
  });

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
          {(["TODOS", "EM_ANDAMENTO", "FECHADO", "CANCELADO"] as const).map((s) => (
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
                      <ShipStatusBadge status={shipStatusOf(j)} />
                      {/* Navios mostram só a situação operacional (Em Operação/Concluído),
                          igual à aba Navios. O status de pagamento (Em Andamento/Pago) fica
                          só para pagamentos avulsos sem navio. */}
                      {!shipStatusOf(j) && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[j.status]}`}>
                          {STATUS_LABELS[j.status]}
                        </span>
                      )}
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
                      <div className="flex gap-1 items-center" onClick={(e) => e.stopPropagation()}>
                        {j.ship_id && shipStatusOf(j) && shipStatusOf(j) !== "CONCLUIDO" && shipStatusOf(j) !== "CANCELADO" && (
                          <button
                            onClick={() => setCloseShipJob(j)}
                            className="text-xs px-2 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700"
                            title="Fecha o navio (Concluído) e grava o valor do contrato"
                          >
                            🏁 Fechar Navio
                          </button>
                        )}
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
        specialRates={specialRates}
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

      <CloseShipModal
        job={closeShipJob}
        onClose={() => setCloseShipJob(null)}
        onClosed={() => { setCloseShipJob(null); onChange(); }}
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
  const [shipId, setShipId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  // Status simplificado: só Em Andamento e Pago. Internamente FECHADO = Pago,
  // EM_ANDAMENTO cobre os legados ABERTO/VERIFICADO.
  const [status, setStatus] = useState<"EM_ANDAMENTO" | "FECHADO">("EM_ANDAMENTO");
  const [contractValue, setContractValue] = useState("");
  const [notes, setNotes] = useState("");
  // Metadata cabeçalho
  const [client, setClient] = useState("");
  const [cargoType, setCargoType] = useState("");
  const [holdsCount, setHoldsCount] = useState("");
  const [port, setPort] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (item) {
      setShipId(item.ship_id || "");
      setStartDate(item.start_date.slice(0, 10));
      setEndDate(item.end_date?.slice(0, 10) || "");
      // Status legados (ABERTO, VERIFICADO) viram "Em Andamento" no UI.
      setStatus(item.status === "FECHADO" ? "FECHADO" : "EM_ANDAMENTO");
      setContractValue(item.contract_value?.toString() || "");
      setNotes(item.notes || "");
      setClient(item.client || "");
      setCargoType(item.cargo_type || "");
      setHoldsCount(item.holds_count?.toString() || "");
      setPort(item.port || "");
    } else {
      setShipId(""); setStartDate(isoDate(new Date()));
      setEndDate(""); setStatus("EM_ANDAMENTO"); setContractValue(""); setNotes("");
      setClient(""); setCargoType(""); setHoldsCount(""); setPort("SANTOS");
    }
  }, [item, open]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!shipId || !startDate) return;
    setSaving(true);
    // Nome do pagamento sempre derivado do navio escolhido. Supervisor é
    // gravado automaticamente como quem está logado.
    const ship = ships.find((s) => s.id === shipId);
    const payload = {
      name: ship?.name?.trim() || "Pagamento",
      ship_id: shipId,
      start_date: startDate,
      end_date: endDate || null,
      status,
      contract_value: contractValue ? parseFloat(contractValue) : null,
      notes: notes.trim() || null,
      client: client.trim() || null,
      supervisor: profileName || null,
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
            <label className="block text-sm font-medium mb-1">Navio *</label>
            {item ? (
              <div className={`${inputCls} bg-gray-50 text-text cursor-not-allowed`}>
                {ships.find((s) => s.id === shipId)?.name || item.name}
              </div>
            ) : (
              <>
                <select value={shipId} onChange={(e) => setShipId(e.target.value)} required className={inputCls}>
                  <option value="">Selecione o navio...</option>
                  {ships.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <p className="text-[10px] text-text-light mt-1">O nome do pagamento é o nome do navio.</p>
              </>
            )}
          </div>
          <div className="mt-3 p-2 bg-gray-50 border border-border rounded-lg text-xs text-text-light">
            <span className="font-medium text-text">Supervisor:</span> {profileName} <span className="text-[10px]">(usuário logado)</span>
          </div>
        </div>

        <div className="border-t border-border pt-3">
          <p className={sectionTitle}>Operação (cabeçalho do pagamento)</p>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium mb-1">Cliente</label><input type="text" value={client} onChange={(e) => setClient(e.target.value.toUpperCase())} className={inputCls} placeholder="DEEP" /></div>
            <div><label className="block text-sm font-medium mb-1">Carga</label><input type="text" value={cargoType} onChange={(e) => setCargoType(e.target.value.toUpperCase())} className={inputCls} placeholder="CARVÃO" /></div>
          </div>
          <div className="grid grid-cols-2 gap-4 mt-3">
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
              <select value={status} onChange={(e) => setStatus(e.target.value as "EM_ANDAMENTO" | "FECHADO")} className={inputCls}>
                <option value="EM_ANDAMENTO">Em Andamento</option>
                <option value="FECHADO">Pago</option>
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
          <Button type="submit" disabled={saving || !shipId}>{saving ? "Salvando..." : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Job Detail Modal (alocações + ajustes) ─────────────────────────────────

function JobDetailModal({
  open, job, allocations, adjustments, functions, employees, specialRates, canEdit, profileName, kindFilter, onClose, onChange,
}: {
  open: boolean;
  job: Job | null;
  allocations: JobAllocation[];
  adjustments: JobAdjustment[];
  functions: JobFunction[];
  employees: Employee[];
  specialRates: Map<string, number>;
  canEdit: boolean;
  profileName: string;
  // When set, people come from Escalação (read-only); modal only edits financial layer.
  kindFilter?: "EMBARQUE" | "COSTADO";
  onClose: () => void;
  onChange: () => void;
}) {
  // Embarque: rate (valor/porão) × holds, por funcionário (qty não importa).
  // Costado: rate (valor/turno) × qty — cada linha = 1 turno (data + período).
  // O valor/turno já inclui adicional noturno quando aplicável; a Escalação de
  // Costado calcula isso a partir de costado_function_rates.
  // Costado é gerenciado exclusivamente pela Escalação de Costado. Embarque permite
  // adicionar/remover funcionários direto daqui também (além da Escalação).
  const peopleReadOnly = kindFilter === "COSTADO";
  const holdsMultiplier =
    kindFilter === "EMBARQUE" ? Math.max(1, Number(job?.holds_count || 1))
    : 1; // Costado: rate já é valor/turno, base = rate × qty.
  const rateLabel = kindFilter === "EMBARQUE" ? "Valor/Porão" : kindFilter === "COSTADO" ? "Valor/Turno" : "Valor Diário";
  // Costado não tem mais coluna de multiplicador — rate já é por turno.
  const multiplierLabel = kindFilter === "EMBARQUE" ? "Porões" : null;
  // Embarque é pago por porão (uma operação só) — não há "qty" relevante por linha.
  const showQtyColumn = kindFilter !== "EMBARQUE";
  const qtyLabel = kindFilter === "COSTADO" ? "Turnos" : "Qtd";
  // Costado mostra colunas Data e Período por linha (cada linha = 1 turno).
  const showCostadoShiftColumns = kindFilter === "COSTADO";
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
  const [rateioSelectedIds, setRateioSelectedIds] = useState<Set<number>>(new Set());
  const [rateioSaving, setRateioSaving] = useState(false);

  // Edição inline da Folha (atualiza pluxee_value = total - folha).
  const [editingFolhaId, setEditingFolhaId] = useState<number | null>(null);
  const [folhaDraft, setFolhaDraft] = useState("");
  // Estados de edicao inline para os outros valores da linha. Sandra
  // (Financeiro) pediu controle total: clicou no valor, editou, salvou.
  // Cada par (id-em-edicao, draft) funciona igual ao da Folha.
  const [editingRateId, setEditingRateId] = useState<number | null>(null);
  const [rateDraft, setRateDraft] = useState("");
  const [editingQtyId, setEditingQtyId] = useState<number | null>(null);
  const [qtyDraft, setQtyDraft] = useState("");
  const [editingExtraId, setEditingExtraId] = useState<number | null>(null);
  const [extraDraft, setExtraDraft] = useState("");
  const [editingPluxeeId, setEditingPluxeeId] = useState<number | null>(null);
  const [pluxeeDraft, setPluxeeDraft] = useState("");

  // Status do import de PDF da Relação de Líquidos.
  const [pdfStatus, setPdfStatus] = useState<{
    kind: "idle" | "parsing" | "done" | "error";
    msg?: string;
    matched?: number;
    total?: number;
    unmatched?: { name: string; value: number }[];
  }>({ kind: "idle" });
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (open) {
      setShowAddAlloc(false); setShowAddAdj(false); setShowRateio(false);
      setAllocEmp(""); setAllocFn(""); setAllocDays("1"); setAllocRate(""); setAllocPluxee("0");
      setEditAllocId(null);
      setAdjCategory("COMPRAS"); setAdjDesc(""); setAdjAmt("");
      setRateioFnId(""); setRateioMissing("1"); setRateioSelectedIds(new Set());
      setPdfStatus({ kind: "idle" });
    }
  }, [open, job]);

  // ── Costado: hooks DEVEM vir antes do early return abaixo (React rules) ───
  // Toda computação que precisa de hook fica aqui em cima. As helpers que não
  // são hooks (rateForRow, effectiveQty, costadoFn, costadoRate, grand totals)
  // ficam depois do early return — daí a separação.
  const [costadoDateFilter, setCostadoDateFilter] = useState<string | "TODAS">("TODAS");
  useEffect(() => {
    setCostadoDateFilter("TODAS");
  }, [job?.id]);
  const uniqueDates = useMemo(() => {
    if (kindFilter !== "COSTADO") return [] as string[];
    const set = new Set<string>();
    for (const a of allocations) {
      if (a.shift_date) set.add(a.shift_date.slice(0, 10));
    }
    return Array.from(set).sort();
  }, [allocations, kindFilter]);
  const dateFilteredAllocations = useMemo(() => {
    if (kindFilter !== "COSTADO" || costadoDateFilter === "TODAS") return allocations;
    return allocations.filter((a) => (a.shift_date || "").slice(0, 10) === costadoDateFilter);
  }, [allocations, kindFilter, costadoDateFilter]);
  const costadoSummary = useMemo(() => {
    if (kindFilter !== "COSTADO") return [] as Array<{
      employeeId: number | null;
      name: string;
      role: string | null;
      turnos: number;
      diurnos: number;
      noturnos: number;
      shifts: Array<{ date: string | null; period: string | null; isNight: boolean }>;
      total: number;
      pluxee: number;
      folha: number;
    }>;
    const costadoFnLocal = functions.find((f) => f.name.trim().toUpperCase() === "COSTADO");
    const costadoRateLocal = costadoFnLocal ? Number(costadoFnLocal.default_rate) : 0;
    type Row = {
      employeeId: number | null;
      name: string;
      role: string | null;
      turnos: number;
      diurnos: number;
      noturnos: number;
      shifts: Array<{ date: string | null; period: string | null; isNight: boolean }>;
      total: number;
      pluxee: number;
      folha: number;
    };
    const byEmp = new Map<string, Row>();
    for (const a of allocations) {
      const key = a.employee_id ? `e${a.employee_id}` : `f${a.function_id}-${a.id}`;
      const isNight = COSTADO_NIGHT_SHIFT_PERIODS.includes(a.shift_period || "");
      const qty = Math.max(1, a.quantity);
      const rowPay = costadoRateLocal * qty;
      const extra = Number(a.extra_value || 0);
      const pluxee = Number(a.pluxee_value || 0);
      if (!byEmp.has(key)) {
        byEmp.set(key, {
          employeeId: a.employee_id ?? null,
          name: a.employees?.name || a.job_functions?.name || "—",
          role: null,
          turnos: 0, diurnos: 0, noturnos: 0,
          shifts: [],
          total: 0, pluxee: 0, folha: 0,
        });
      }
      const row = byEmp.get(key)!;
      row.turnos += qty;
      if (isNight) row.noturnos += qty;
      else if (a.shift_period) row.diurnos += qty;
      row.shifts.push({ date: a.shift_date?.slice(0, 10) || null, period: a.shift_period, isNight });
      row.total += rowPay + extra;
      row.pluxee += pluxee;
    }
    for (const row of byEmp.values()) {
      row.folha = row.total - row.pluxee;
      row.shifts.sort((x, y) => (x.date || "").localeCompare(y.date || "") || (x.period || "").localeCompare(y.period || ""));
    }
    return Array.from(byEmp.values()).sort((a, b) => b.total - a.total);
  }, [allocations, kindFilter, functions]);

  if (!job) return null;

  const cost = calcJobCost(job, allocations.map((a) => ({ ...a, job_id: job.id })), adjustments.map((a) => ({ ...a, job_id: job.id })));
  // Folha = soma de (base + extra - pluxee) por funcionário = cost.base - pluxeeTotal.
  // payroll_value no banco nunca é gravado, então o valor vem das próprias
  // alocações pra refletir 1:1 a coluna Folha da tabela.
  const pluxeeTotal = allocations.reduce((s, a) => s + Number(a.pluxee_value || 0), 0);
  const folhaValue = cost.base - pluxeeTotal;
  // Valor que precisamos = TOTAL - VALOR DA FOLHA (Pluxee + ajustes/despesas)
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
      await db.from("job_allocations").insert({
        ...payload,
        job_id: job!.id,
        status: "ATIVO",
        kind: kindFilter || "EMBARQUE",
      });
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
    const amountNum = parseFloat(adjAmt.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      alert("Informe um valor válido para a despesa.");
      return;
    }
    // description é NOT NULL no schema → quando vazio, manda string vazia em vez de null.
    // Despesas (comida, compras, química, etc.) são custos adicionais que SOMAM
    // ao total da operação. Por isso entram como ADICIONAL.
    const res = await db.from("job_adjustments").insert({
      job_id: job!.id,
      type: "ADICIONAL",
      category: adjCategory,
      description: adjDesc.trim(),
      amount: amountNum,
    });
    if (res?.error) {
      console.error("Erro ao adicionar despesa:", res.error);
      alert(`Não consegui salvar a despesa: ${res.error.message}`);
      return;
    }
    setShowAddAdj(false);
    setAdjDesc(""); setAdjAmt("");
    onChange();
  }

  // Rateio (Pagamento Embarque): pega o valor FIXO da função × porões × quem faltou
  // e divide somente entre os colaboradores selecionados pelo usuário.
  async function handleApplyRateio() {
    const fnId = parseInt(rateioFnId, 10);
    const missing = parseInt(rateioMissing, 10);
    if (!fnId || !missing || missing < 1) return;
    const selected = allocations.filter(
      (a) => a.status === "ATIVO" && rateioSelectedIds.has(a.id),
    );
    if (selected.length === 0) return;

    const fn = functions.find((f) => f.id === fnId);
    const fixedRate = Number(fn?.default_rate || 0);
    const holds = Math.max(1, Number(job?.holds_count || 1));
    const missingPay = fixedRate * holds * missing;
    const perPerson = +(missingPay / selected.length).toFixed(2);
    const fnName = fn?.name || `Função ${fnId}`;
    const reason = `Rateio: ${missing} ${fnName} faltou(aram), valor (${brl(fixedRate)} × ${holds} ${holds === 1 ? "porão" : "porões"} × ${missing}) dividido entre ${selected.length}`;

    setRateioSaving(true);
    try {
      for (const a of selected) {
        const current = Number(a.extra_value || 0);
        await db.from("job_allocations").update({
          extra_value: current + perPerson,
          extra_reason: reason,
        }).eq("id", a.id);
      }
      setShowRateio(false);
      setRateioFnId(""); setRateioMissing("1"); setRateioSelectedIds(new Set());
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

  async function handleDeleteAlloc(id: number) {
    await db.from("job_allocations").delete().eq("id", id);
    onChange();
  }

  // Folha vem do PDF (Relação de Líquidos) ou é editada manualmente; Pluxee é o resto.
  async function handleSetFolha(allocId: number, totalPerson: number, folhaValue: number) {
    const newPluxee = +Math.max(0, totalPerson - folhaValue).toFixed(2);
    await db.from("job_allocations").update({ pluxee_value: newPluxee }).eq("id", allocId);
    onChange();
  }

  // Helpers de edicao inline. Cada um faz parse do draft, valida e roda UPDATE.
  // Numero "0" eh valido em todos -- so rejeitamos NaN/negativo. Reusamos o
  // padrao replace(",", ".") pra aceitar 1.234,56 ou 1234.56 sem reclamar.
  function parseDecimal(s: string): number | null {
    const n = parseFloat(s.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) && n >= 0 ? +n.toFixed(2) : null;
  }
  function parseInt0(s: string): number | null {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  async function handleSetRate(allocId: number, raw: string, current: number) {
    const n = parseDecimal(raw);
    if (n == null || n === current) return;
    await db.from("job_allocations").update({ rate: n }).eq("id", allocId);
    onChange();
  }
  async function handleSetQty(allocId: number, raw: string, current: number) {
    const n = parseInt0(raw);
    if (n == null || n === current) return;
    await db.from("job_allocations").update({ quantity: n }).eq("id", allocId);
    onChange();
  }
  async function handleSetExtra(allocId: number, raw: string, current: number) {
    // Aceita negativo aqui (extra pode ser negativo via rateio reverso).
    const n = parseFloat(raw.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(n) || +n.toFixed(2) === current) return;
    await db.from("job_allocations").update({ extra_value: +n.toFixed(2) }).eq("id", allocId);
    onChange();
  }
  async function handleSetPluxee(allocId: number, raw: string, current: number) {
    const n = parseDecimal(raw);
    if (n == null || n === current) return;
    await db.from("job_allocations").update({ pluxee_value: n }).eq("id", allocId);
    onChange();
  }

  // Calcula o total que cada alocação recebe (base + extras). Reusado no PDF e no
  // Excel — fica aqui pra ficar consistente com o que aparece na tabela.
  function allocTotalPerson(a: JobAllocation): number {
    const fn = functions.find((f) => f.id === a.function_id);
    const defaultRate = Number(fn?.default_rate ?? a.rate);
    const actualRate = Number(a.rate);
    const isEmbarque = kindFilter === "EMBARQUE";
    const base = isEmbarque
      ? defaultRate * holdsMultiplier
      : actualRate * a.quantity * holdsMultiplier;
    const specialDelta = isEmbarque ? (actualRate - defaultRate) * holdsMultiplier : 0;
    const rateioExtra = Number(a.extra_value || 0);
    return base + specialDelta + rateioExtra;
  }

  // Import da Relação de Líquidos (PDF da contabilidade). Casa cada linha do PDF
  // com uma alocação pelo nome e atualiza pluxee_value = total - folhaDoPDF.
  async function handlePdfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setPdfStatus({ kind: "parsing", msg: "Lendo PDF…" });
    try {
      const buf = await file.arrayBuffer();
      const pdfjs: typeof import("pdfjs-dist") = await import("pdfjs-dist");
      (pdfjs as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
        "/pdf.worker.min.mjs";
      const doc = await pdfjs.getDocument({ data: buf }).promise;
      const allLines: string[] = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const items = content.items as { str: string; transform: number[] }[];
        allLines.push(...reconstructLinesFromPdfItems(items));
      }
      const entries = parseLiquidosPdf(allLines);
      if (entries.length === 0) {
        setPdfStatus({ kind: "error", msg: "Nenhum registro reconhecido. Confira se é a 'Relação Geral dos Líquidos'." });
        return;
      }
      const used = new Set<number>();
      let matched = 0;
      for (const a of allocations) {
        const name = a.employees?.name || a.job_functions?.name || "";
        const m = findBestPdfMatch(name, entries, used);
        if (!m) continue;
        used.add(m.idx);
        matched++;
        const total = allocTotalPerson(a);
        const newPluxee = +Math.max(0, total - m.entry.value).toFixed(2);
        await db.from("job_allocations").update({ pluxee_value: newPluxee }).eq("id", a.id);
      }
      const unmatched = entries.filter((_, i) => !used.has(i));
      onChange();
      setPdfStatus({ kind: "done", matched, total: entries.length, unmatched });
    } catch (err) {
      setPdfStatus({ kind: "error", msg: "Falha ao ler PDF: " + (err as Error).message });
    }
  }

  // Exporta a planilha de pagamento no formato da "PLANILHA BASE" usado pela
  // contabilidade. Usa xlsx-js-style pra aplicar bordas, alinhamento e formato BRL.
  async function handleExportExcel() {
    setExporting(true);
    try {
      const XLSX = (await import("xlsx-js-style")).default;
      const dateLabel = formatDateBR(job!.end_date) || formatDateBR(job!.start_date);
      const shipLabel = `${job!.name}${job!.holds_count ? ` - ${job!.holds_count} PORÕES` : ""}${job!.cargo_type ? `-${job!.cargo_type}` : ""}${job!.port ? `-${job!.port}` : ""}${job!.start_date ? ` ${formatDateBR(job!.start_date)}` : ""}${job!.end_date ? ` a ${formatDateBR(job!.end_date)}` : ""}${dateLabel ? ` - VENCTO: ${dateLabel}` : ""}`;

      // Estilos reutilizáveis (xlsx-js-style aceita objeto `s` em cada célula).
      const thin = { style: "thin", color: { rgb: "000000" } };
      const allBorders = { top: thin, bottom: thin, left: thin, right: thin };
      const BRL = 'R$ #,##0.00;R$ -#,##0.00;"R$ -"';
      const styleTitle = {
        font: { bold: true, sz: 14, color: { rgb: "1F4E78" } },
        alignment: { horizontal: "center", vertical: "center" },
      };
      const styleClient = {
        font: { bold: true, sz: 12, color: { rgb: "1F4E78" } },
        alignment: { horizontal: "center", vertical: "center" },
      };
      const styleHeader = {
        font: { bold: true, sz: 10, color: { rgb: "FFFFFF" } },
        fill: { patternType: "solid", fgColor: { rgb: "2E75B6" } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
        border: allBorders,
      };
      const styleSubHeader = {
        font: { bold: true, sz: 10 },
        fill: { patternType: "solid", fgColor: { rgb: "DDEBF7" } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
        border: allBorders,
      };
      const styleCellCenter = {
        font: { sz: 10 },
        alignment: { horizontal: "center", vertical: "center" },
        border: allBorders,
      };
      const styleCellMoney = {
        font: { sz: 10 },
        alignment: { horizontal: "right", vertical: "center" },
        border: allBorders,
        numFmt: BRL,
      };
      const styleTotalLabel = {
        font: { bold: true, sz: 10 },
        fill: { patternType: "solid", fgColor: { rgb: "FFE699" } },
        alignment: { horizontal: "center", vertical: "center" },
        border: allBorders,
      };
      const styleTotalMoney = {
        font: { bold: true, sz: 10 },
        fill: { patternType: "solid", fgColor: { rgb: "FFE699" } },
        alignment: { horizontal: "right", vertical: "center" },
        border: allBorders,
        numFmt: BRL,
      };
      const styleSummaryLabel = {
        font: { bold: true, sz: 10 },
        alignment: { horizontal: "right", vertical: "center" },
      };
      const styleSummaryMoney = {
        font: { bold: true, sz: 10, color: { rgb: "1F4E78" } },
        alignment: { horizontal: "right", vertical: "center" },
        numFmt: BRL,
      };
      const styleSummaryTitle = {
        font: { bold: true, sz: 11 },
        alignment: { horizontal: "left", vertical: "center" },
      };

      // Monta o sheet célula a célula com estilo aplicado.
      const ws: Record<string, unknown> = {};
      const set = (
        addr: string,
        v: string | number | null,
        s: Record<string, unknown>,
        t: "s" | "n" = typeof v === "number" ? "n" : "s",
      ) => {
        if (v === null || v === undefined || v === "") { ws[addr] = { t: "s", v: "", s }; return; }
        ws[addr] = { t, v, s };
      };

      // Linha 3: título "PAGAMENTO EM ..." (mesclado D3:G3 pra caber o texto inteiro)
      set("D3", `PAGAMENTO EM ${dateLabel || ""}`, styleTitle);
      // Linha 6: rótulos C=FUNCIONÁRIOS, K=cliente
      set("C6", "FUNCIONÁRIOS", styleSummaryTitle);
      set("K6", job!.client || "", styleClient);
      // Linha 7: cabeçalho da tabela
      set("C7", "Limpeza de porão", styleSubHeader);
      set("D7", "AGÊNCIA", styleHeader);
      set("E7", "CONTA", styleHeader);
      set("F7", "ITAÚ/SANTANDER", styleHeader);
      set("G7", "PAGTO PLUXEE", styleHeader);
      set("H7", "PAGTO NA FOLHA", styleHeader);
      set("I7", "DESCONTO GERAL", styleHeader);
      set("J7", "Perda de Material", styleHeader);
      set("K7", `MV 1: ${shipLabel}`, styleHeader);

      // Funcionários começam na linha 9 (linha 8 fica em branco como no template)
      let row = 9;
      let totalPluxee = 0, totalFolha = 0, totalNavio = 0;
      allocations.forEach((a, idx) => {
        const e = a.employees;
        const total = allocTotalPerson(a);
        const pluxee = Number(a.pluxee_value || 0);
        const folha = +(total - pluxee).toFixed(2);
        totalPluxee += pluxee;
        totalFolha += folha;
        totalNavio += total;
        set(`B${row}`, idx + 1, styleCellCenter, "n");
        set(`C${row}`, e?.name || a.job_functions?.name || `#${a.function_id}`, styleCellCenter);
        set(`D${row}`, e?.bank_agency || "", styleCellCenter);
        set(`E${row}`, e?.bank_account || "", styleCellCenter);
        set(`F${row}`, formatBankLabel(e?.bank_name ?? null, e?.bank_account_type ?? null), styleCellCenter);
        set(`G${row}`, pluxee, styleCellMoney, "n");
        set(`H${row}`, folha, styleCellMoney, "n");
        set(`I${row}`, 0, styleCellMoney, "n");
        set(`J${row}`, 0, styleCellMoney, "n");
        set(`K${row}`, total, styleCellMoney, "n");
        row++;
      });

      row++; // linha em branco
      const totalRow = row;
      set(`F${totalRow}`, "TOTAL", styleTotalLabel);
      set(`G${totalRow}`, totalPluxee, styleTotalMoney, "n");
      set(`H${totalRow}`, totalFolha, styleTotalMoney, "n");
      set(`I${totalRow}`, 0, styleTotalMoney, "n");
      set(`J${totalRow}`, 0, styleTotalMoney, "n");
      set(`K${totalRow}`, totalNavio, styleTotalMoney, "n");
      row += 2;

      set(`C${row}`, "TOTAL PAGAMENTO DOS MVs s/ desconto:", styleSummaryTitle); row++;
      set(`C${row}`, "MV 1:", styleSummaryLabel);
      set(`F${row}`, "TOTAIS:", styleSummaryLabel); row++;
      set(`C${row}`, totalNavio, styleSummaryMoney, "n");
      set(`F${row}`, "ADTO:", styleSummaryLabel);
      set(`G${row}`, 0, styleSummaryMoney, "n"); row++;
      set(`F${row}`, "PAGTO PLUXEE:", styleSummaryLabel);
      set(`G${row}`, totalPluxee, styleSummaryMoney, "n"); row++;
      set(`F${row}`, "PAGTO FOLHA:", styleSummaryLabel);
      set(`G${row}`, totalFolha, styleSummaryMoney, "n"); row++;
      set(`F${row}`, "PAGTO NAVIO:", styleSummaryLabel);
      set(`G${row}`, totalNavio, styleSummaryMoney, "n");

      ws["!ref"] = `A1:M${row + 2}`;
      ws["!cols"] = [
        { wch: 3 }, { wch: 5 }, { wch: 38 }, { wch: 10 }, { wch: 16 },
        { wch: 18 }, { wch: 14 }, { wch: 15 }, { wch: 14 }, { wch: 16 }, { wch: 70 },
      ];
      ws["!rows"] = Array.from({ length: row + 2 }, (_, i) => (i === 6 ? { hpt: 38 } : { hpt: 18 }));
      ws["!merges"] = [
        { s: { c: 3, r: 2 }, e: { c: 6, r: 2 } }, // D3:G3 título mesclado (mais largo pra caber "PAGAMENTO EM DD/MM/AA")
      ];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "PLANILHA BASE");
      const safeName = (job!.name || "planilha").replace(/[^a-zA-Z0-9_-]+/g, "_");
      const dateForFile = (job!.end_date || job!.start_date).slice(0, 10);
      XLSX.writeFile(wb, `${dateForFile}_${safeName}.xlsx`);
    } catch (err) {
      alert("Falha ao gerar XLSX: " + (err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  async function handleDeleteAdj(id: number) {
    await db.from("job_adjustments").delete().eq("id", id);
    onChange();
  }

  // Se o funcionário tem valor especial cadastrado pra essa função, usa ele;
  // senão cai no default_rate. Mantém o form coerente com "Valores Especiais".
  function rateForEmpFn(empId: number | null, fn: JobFunction): number {
    if (empId != null) {
      const special = specialRates.get(`${empId}-${fn.id}`);
      if (special != null) return special;
    }
    return Number(fn.default_rate);
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
      setAllocRate(rateForEmpFn(emp.id, fn).toString());
    }
  }

  function pickFunction(fnIdStr: string) {
    setAllocFn(fnIdStr);
    const fn = functions.find((f) => f.id === parseInt(fnIdStr));
    if (fn) {
      const empId = allocEmp ? parseInt(allocEmp) : null;
      setAllocRate(rateForEmpFn(empId, fn).toString());
    }
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

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";
  // Fechamento fica somente-leitura apenas após o último OK do gerente.
  const isReadOnly = job.status === "FECHADO";

  // ── Costado: helpers (não-hook) que dependem de `job` ───────────────────
  // O rate gravado em cada alocação pode ser legado errado (ex.: R$ 400 que
  // sobrou de quando o código usava default_rate de Embarque). Aqui sempre
  // exibimos o valor atual da função COSTADO — assim o financeiro vê o que
  // VAI pagar com base na configuração de hoje, não no que ficou salvo.
  const costadoFn = kindFilter === "COSTADO"
    ? functions.find((f) => f.name.trim().toUpperCase() === "COSTADO")
    : null;
  const costadoRate = costadoFn ? Number(costadoFn.default_rate) : 0;
  function effectiveQty(a: JobAllocation): number {
    if (kindFilter === "COSTADO") return Math.max(1, a.quantity);
    return a.quantity;
  }
  function rateForRow(a: JobAllocation): number {
    if (kindFilter === "COSTADO") return costadoRate;
    return Number(a.rate);
  }
  const costadoGrandTotal = costadoSummary.reduce((s, r) => s + r.total, 0);
  const costadoGrandTurnos = costadoSummary.reduce((s, r) => s + r.turnos, 0);
  const costadoGrandFolha = costadoSummary.reduce((s, r) => s + r.folha, 0);

  return (
    <Modal open={open} onClose={onClose} title={job.name} maxWidth="max-w-6xl">
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
          <div className={`rounded-lg border p-3 ${cost.adj > 0 ? "border-amber-200 bg-amber-50" : "border-gray-200 bg-gray-50"}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-wider ${cost.adj > 0 ? "text-amber-700" : "text-text-light"}`}>Despesas</p>
            <p className={`text-lg font-bold ${cost.adj > 0 ? "text-amber-700" : "text-text-light"}`}>{cost.adj > 0 ? brl(cost.adj) : "—"}</p>
            <p className="text-[10px] text-text-light">{adjustments.length === 0 ? "sem despesas" : `${adjustments.length} lançamento${adjustments.length === 1 ? "" : "s"}`}</p>
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
                  Lista gerenciada na Escalação de Costado — aqui edita-se só o financeiro.
                </p>
              )}
            </div>
            <div className="flex gap-2 flex-wrap">
              {/* Rateio só faz sentido em Embarque (pagamento por porão).
                  Costado é por turno fixo — quem faltou simplesmente não foi
                  escalado, não tem o que ratear. */}
              {canEdit && !isReadOnly && !showRateio && allocations.length > 0 && kindFilter !== "COSTADO" && (
                <button onClick={() => setShowRateio(true)} className="text-xs px-2 py-1 bg-amber-600 text-white rounded hover:bg-amber-700" title="Distribuir o pagamento de quem faltou entre os que foram">
                  ⚖️ Aplicar Rateio
                </button>
              )}
              {canEdit && !isReadOnly && allocations.length > 0 && (
                <label
                  className={`text-xs px-2 py-1 rounded cursor-pointer ${pdfStatus.kind === "parsing" ? "bg-blue-300 text-white" : "bg-blue-600 text-white hover:bg-blue-700"}`}
                  title="Importa a Relação de Líquidos (PDF) e preenche a coluna Folha"
                >
                  {pdfStatus.kind === "parsing" ? "Lendo…" : "📄 Importar Contabilidade"}
                  <input
                    type="file"
                    accept="application/pdf"
                    onChange={handlePdfUpload}
                    disabled={pdfStatus.kind === "parsing"}
                    className="hidden"
                  />
                </label>
              )}
              {allocations.length > 0 && (
                <button
                  onClick={handleExportExcel}
                  disabled={exporting}
                  className="text-xs px-2 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-60"
                  title="Exporta a planilha de pagamento no formato da contabilidade"
                >
                  {exporting ? "Gerando…" : "📥 Exportar Excel"}
                </button>
              )}
              {job && allocations.length > 0 && (
                <GerarPluxeeButton job={job} allocations={allocations} employees={employees} />
              )}
              {canEdit && !isReadOnly && !peopleReadOnly && !showAddAlloc && (
                <button onClick={() => setShowAddAlloc(true)} className="text-xs px-2 py-1 bg-primary text-white rounded hover:bg-primary-dark">
                  + Adicionar Funcionário
                </button>
              )}
            </div>
          </div>

          {pdfStatus.kind === "done" && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2 mb-2 text-[11px] space-y-1">
              <p className="text-emerald-800">
                ✓ PDF importado: <strong>{pdfStatus.matched}</strong> de <strong>{pdfStatus.total}</strong> registros casados com colaboradores.
              </p>
              {pdfStatus.unmatched && pdfStatus.unmatched.length > 0 && (
                <details className="text-amber-800">
                  <summary className="cursor-pointer">
                    ⚠ {pdfStatus.unmatched.length} sem match no PDF (preencher manualmente clicando na coluna Folha)
                  </summary>
                  <ul className="mt-1 ml-4 list-disc">
                    {pdfStatus.unmatched.map((u, i) => (
                      <li key={i}>{u.name} — <strong>{brl(u.value)}</strong></li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {pdfStatus.kind === "error" && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-2 mb-2 text-[11px] text-red-800">{pdfStatus.msg}</div>
          )}

          {showRateio && (() => {
            // Agrupa alocações ativas por função pra montar o seletor + lista de
            // colaboradores que podem receber a divisão.
            const fnGroups = new Map<number, JobAllocation[]>();
            for (const a of allocations) {
              if (a.status !== "ATIVO") continue;
              if (!fnGroups.has(a.function_id)) fnGroups.set(a.function_id, []);
              fnGroups.get(a.function_id)!.push(a);
            }
            const fnId = parseInt(rateioFnId, 10);
            const groupAllocs = fnId ? (fnGroups.get(fnId) || []) : [];
            const fn = fnId ? functions.find((f) => f.id === fnId) : undefined;
            const fixedRate = Number(fn?.default_rate || 0);
            const holds = Math.max(1, Number(job?.holds_count || 1));
            const missing = parseInt(rateioMissing, 10) || 0;
            const missingPay = fixedRate * holds * missing;
            const selectedCount = groupAllocs.filter((a) => rateioSelectedIds.has(a.id)).length;
            const perPerson = selectedCount > 0 ? missingPay / selectedCount : 0;
            return (
              <form onSubmit={(e) => { e.preventDefault(); handleApplyRateio(); }} className="bg-amber-50 rounded-lg p-3 mb-2 border border-amber-200 space-y-2">
                <p className="text-xs text-amber-900 font-medium">
                  ⚖️ Rateio — divide o pagamento de quem faltou entre os colaboradores selecionados (valor fixo da função × porões).
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">Função *</label>
                    <select
                      value={rateioFnId}
                      onChange={(e) => {
                        setRateioFnId(e.target.value);
                        // ao trocar de função, marca todos da nova função por padrão
                        const newId = parseInt(e.target.value, 10);
                        const next = new Set<number>();
                        if (newId) {
                          for (const a of allocations) {
                            if (a.function_id === newId && a.status === "ATIVO") next.add(a.id);
                          }
                        }
                        setRateioSelectedIds(next);
                      }}
                      required
                      className={inputCls}
                    >
                      <option value="">Selecione...</option>
                      {Array.from(fnGroups.entries()).map(([id, grp]) => {
                        const f = functions.find((ff) => ff.id === id);
                        return (
                          <option key={id} value={id}>
                            {f?.name || `Função ${id}`} ({grp.length} {grp.length === 1 ? "pessoa" : "pessoas"})
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

                {fnId > 0 && groupAllocs.length > 0 && (
                  <div className="bg-white border border-amber-300 rounded-lg p-2 space-y-1">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-amber-900">
                        Quem recebe o rateio ({selectedCount}/{groupAllocs.length})
                      </p>
                      <div className="flex gap-2 text-[10px]">
                        <button
                          type="button"
                          onClick={() => {
                            const next = new Set<number>();
                            for (const a of groupAllocs) next.add(a.id);
                            setRateioSelectedIds(next);
                          }}
                          className="text-blue-700 hover:underline"
                        >
                          Marcar todos
                        </button>
                        <button
                          type="button"
                          onClick={() => setRateioSelectedIds(new Set())}
                          className="text-blue-700 hover:underline"
                        >
                          Desmarcar todos
                        </button>
                      </div>
                    </div>
                    <div className="max-h-40 overflow-y-auto space-y-0.5">
                      {groupAllocs.map((a) => {
                        const checked = rateioSelectedIds.has(a.id);
                        return (
                          <label key={a.id} className="flex items-center gap-2 px-1 py-1 text-xs hover:bg-amber-50 rounded cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                const next = new Set(rateioSelectedIds);
                                if (e.target.checked) next.add(a.id);
                                else next.delete(a.id);
                                setRateioSelectedIds(next);
                              }}
                            />
                            <span className="flex-1">{a.employees?.name || a.job_functions?.name || `#${a.function_id}`}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}

                {fnId > 0 && missing > 0 && selectedCount > 0 && (
                  <div className="bg-white border border-amber-300 rounded-lg p-2 text-xs space-y-0.5">
                    <p>Valor fixo da função: <strong>{brl(fixedRate)}</strong></p>
                    <p>Pagamento por porões: <strong>{brl(fixedRate)} × {holds} {holds === 1 ? "porão" : "porões"} = {brl(fixedRate * holds)}</strong></p>
                    <p>Valor de quem faltou: <strong>{brl(fixedRate * holds)} × {missing} = {brl(missingPay)}</strong></p>
                    <p>Dividido entre {selectedCount} {selectedCount === 1 ? "colaborador selecionado" : "colaboradores selecionados"}: <strong className="text-emerald-700">+ {brl(perPerson)} por pessoa</strong></p>
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
                    <Button size="sm" type="submit" disabled={rateioSaving || !fnId || !missing || selectedCount === 0}>
                      {rateioSaving ? "Aplicando..." : "Aplicar Rateio"}
                    </Button>
                  </div>
                </div>
              </form>
            );
          })()}

          {showAddAlloc && (() => {
            // Resolve a função e o rate automaticamente a partir do funcionário
            // selecionado. Se ele tiver valor especial cadastrado em
            // Função/Valores/Pagas → 👤, usa esse valor. Senão, valor padrão.
            const selectedEmp = allocEmp ? employees.find((e) => String(e.id) === allocEmp) : null;
            const resolvedFn = selectedEmp
              ? functions.find((f) => f.name.toUpperCase() === (selectedEmp.role || "").toUpperCase())
              : null;
            const resolvedRate = selectedEmp && resolvedFn
              ? rateForEmpFn(selectedEmp.id, resolvedFn)
              : 0;
            const hasSpecial = selectedEmp && resolvedFn
              ? specialRates.get(`${selectedEmp.id}-${resolvedFn.id}`) != null
              : false;
            const canSubmit = !!(selectedEmp && resolvedFn);
            const submitQuick = async (ev: React.FormEvent) => {
              ev.preventDefault();
              if (!selectedEmp || !resolvedFn) return;
              const payload: Record<string, unknown> = {
                function_id: resolvedFn.id,
                employee_id: selectedEmp.id,
                quantity: kindFilter === "EMBARQUE" ? 1 : (parseInt(allocDays) || 1),
                rate: resolvedRate,
                pluxee_value: 0,
              };
              if (editAllocId) {
                await db.from("job_allocations").update(payload).eq("id", editAllocId);
              } else {
                await db.from("job_allocations").insert({
                  ...payload,
                  job_id: job!.id,
                  status: "ATIVO",
                  kind: kindFilter || "EMBARQUE",
                });
              }
              setShowAddAlloc(false);
              setAllocEmp(""); setAllocFn(""); setAllocDays("1"); setAllocRate(""); setAllocPluxee("0");
              setEditAllocId(null);
              onChange();
            };
            return (
              <form
                onSubmit={submitQuick}
                className="bg-blue-50 rounded-lg p-3 mb-2 border border-blue-200 space-y-2"
              >
                <div>
                  <label className="block text-xs font-medium mb-1">Funcionário *</label>
                  <select
                    value={allocEmp}
                    onChange={(e) => pickEmployee(e.target.value)}
                    required
                    className={inputCls}
                  >
                    <option value="">Selecione...</option>
                    {employees.filter((e) => e.status === "ATIVO").map((e) => (
                      <option key={e.id} value={e.id}>{e.name} {e.role ? `· ${e.role}` : ""}</option>
                    ))}
                  </select>
                </div>

                {selectedEmp && !resolvedFn && (
                  <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
                    ⚠️ {selectedEmp.name} não tem função cadastrada em RH › Colaboradores. Defina a função
                    dele antes de adicionar aqui.
                  </p>
                )}

                {selectedEmp && resolvedFn && (
                  <div className="bg-white border border-blue-200 rounded p-2 text-xs space-y-0.5">
                    <p>
                      Função: <strong>{resolvedFn.name}</strong>
                      {" · "}
                      {kindFilter === "EMBARQUE" ? "Valor/Porão" : kindFilter === "COSTADO" ? "Valor/Turno" : "Valor"}: <strong>{brl(resolvedRate)}</strong>
                      {/* Costado nao usa valor especial -- valor unico em Valores. */}
                      {hasSpecial && kindFilter !== "COSTADO" && (
                        <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-300 text-amber-900 font-bold">
                          VALOR ESPECIAL
                        </span>
                      )}
                    </p>
                    {kindFilter === "EMBARQUE" && (() => {
                      const holdsN = Math.max(1, Number(job?.holds_count || 1));
                      return (
                        <p className="text-text-light">
                          Total: <strong className="text-emerald-700">{brl(resolvedRate * holdsN)}</strong>
                          {" "}({holdsN} {holdsN === 1 ? "porão" : "porões"} × {brl(resolvedRate)})
                        </p>
                      );
                    })()}
                  </div>
                )}

                {kindFilter !== "EMBARQUE" && (
                  <div>
                    <label className="block text-xs font-medium mb-1">{kindFilter === "COSTADO" ? "Turnos *" : "Dias *"}</label>
                    <input type="number" min={1} value={allocDays} onChange={(e) => setAllocDays(e.target.value)} required className={inputCls} />
                  </div>
                )}

                <div className="flex gap-2 justify-end">
                  <Button variant="secondary" size="sm" type="button" onClick={() => { setShowAddAlloc(false); setEditAllocId(null); setAllocEmp(""); setAllocFn(""); setAllocRate(""); }}>Cancelar</Button>
                  <Button size="sm" type="submit" disabled={!canSubmit}>{editAllocId ? "Salvar Alterações" : "Adicionar"}</Button>
                </div>
              </form>
            );
          })()}

          {allocations.length === 0 ? (
            <p className="text-xs text-text-light italic text-center py-4">
              {peopleReadOnly ? "Nenhuma alocação na Escalação para este navio." : "Sem alocações."}
            </p>
          ) : (
            <>
              {/* Costado: resumo por pessoa + filtro de data ─────────────── */}
              {kindFilter === "COSTADO" && (
                <div className="space-y-3 mb-3">
                  {/* Banner de cálculo */}
                  <div className="px-3 py-2 bg-cyan-50 border border-cyan-200 rounded-lg text-[11px] text-cyan-900 flex items-center justify-between gap-2 flex-wrap">
                    <span>
                      💡 Costado é pago por <strong>turno de 6h</strong>. Valor/Turno = <strong className="text-emerald-700">{brl(costadoRate)}</strong>
                      {" "}(da função <a href="/financeiro?tab=funcoes" className="underline">COSTADO em Valores</a>) · cada linha = 1 turno.
                    </span>
                    {costadoRate === 0 && (
                      <span className="text-amber-900 bg-amber-100 px-2 py-0.5 rounded font-semibold">
                        ⚠️ Sem valor configurado — abra <a href="/financeiro?tab=funcoes" className="underline">Valores</a> e ajuste o valor da função COSTADO.
                      </span>
                    )}
                  </div>

                  {/* Cards do navio */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div className="bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wider text-indigo-900 font-semibold">Total turnos</p>
                      <p className="text-lg font-bold text-indigo-900 mt-0.5">{costadoGrandTurnos}</p>
                      <p className="text-[10px] text-indigo-700">{costadoGrandTurnos * HOURS_PER_SHIFT}h trabalhadas</p>
                    </div>
                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wider text-emerald-900 font-semibold">Custo total Costado</p>
                      <p className="text-lg font-bold text-emerald-700 mt-0.5">{brl(costadoGrandTotal)}</p>
                      <p className="text-[10px] text-emerald-700">{costadoSummary.length} {costadoSummary.length === 1 ? "colaborador" : "colaboradores"}</p>
                    </div>
                    <div className="bg-purple-50 border border-purple-200 rounded-lg px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wider text-purple-900 font-semibold">A pagar (Folha)</p>
                      <p className="text-lg font-bold text-purple-700 mt-0.5">{brl(costadoGrandFolha)}</p>
                      <p className="text-[10px] text-purple-700">custo − pluxee</p>
                    </div>
                    <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                      <p className="text-[10px] uppercase tracking-wider text-amber-900 font-semibold">Dias com escala</p>
                      <p className="text-lg font-bold text-amber-900 mt-0.5">{uniqueDates.length}</p>
                      <p className="text-[10px] text-amber-700">
                        {uniqueDates.length > 0
                          ? `${uniqueDates[0].split("-").reverse().join("/")} → ${uniqueDates[uniqueDates.length - 1].split("-").reverse().join("/")}`
                          : "—"}
                      </p>
                    </div>
                  </div>

                  {/* Resumo por pessoa (sempre mostra o navio inteiro) */}
                  <div className="bg-card border border-border rounded-xl overflow-hidden">
                    <div className="px-3 py-2 bg-gray-50 border-b border-border flex items-center justify-between">
                      <p className="text-xs font-semibold text-text">👥 Por colaborador <span className="text-text-light font-normal">— navio inteiro</span></p>
                      <p className="text-[10px] text-text-light">Quanto cada um trabalhou e quanto vai receber.</p>
                    </div>
                    <div className="divide-y divide-border">
                      {costadoSummary.map((row) => {
                        // Agrupa shifts pra exibir tipo "29/05: ☀️07-13, 🌙19-01 · 30/05: ☀️13-19"
                        const shiftsByDate = new Map<string, Array<{ period: string; isNight: boolean }>>();
                        for (const s of row.shifts) {
                          const d = s.date || "—";
                          if (!shiftsByDate.has(d)) shiftsByDate.set(d, []);
                          if (s.period) shiftsByDate.get(d)!.push({ period: s.period, isNight: s.isNight });
                        }
                        return (
                          <div key={row.name + row.employeeId} className="px-3 py-2 flex items-start gap-3">
                            <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
                              <span className="text-xs font-bold text-indigo-700">{row.name.charAt(0).toUpperCase()}</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                                <p className="text-sm font-semibold truncate">{row.name}</p>
                                <p className="text-sm font-bold text-emerald-700 shrink-0">{brl(row.total)}</p>
                              </div>
                              <p className="text-[10px] text-text-light mt-0.5">
                                <strong className="text-text">{row.turnos}</strong> turno{row.turnos === 1 ? "" : "s"}
                                {" "}({row.turnos * HOURS_PER_SHIFT}h){" · "}
                                ☀️ {row.diurnos} diurno{row.diurnos === 1 ? "" : "s"} · 🌙 {row.noturnos} noturno{row.noturnos === 1 ? "" : "s"}
                                {row.pluxee > 0 && (
                                  <> · pluxee {brl(row.pluxee)} → folha <strong className="text-purple-700">{brl(row.folha)}</strong></>
                                )}
                              </p>
                              {shiftsByDate.size > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-1.5">
                                  {Array.from(shiftsByDate.entries()).map(([date, periods]) => (
                                    <span key={date} className="inline-flex items-center gap-1 text-[10px] bg-gray-50 border border-border rounded px-1.5 py-0.5">
                                      <span className="font-mono text-text-light">{date === "—" ? "—" : date.split("-").reverse().join("/")}</span>
                                      <span className="text-text-light">·</span>
                                      {periods.map((p, i) => (
                                        <span
                                          key={i}
                                          className={`font-semibold ${p.isNight ? "text-indigo-700" : "text-amber-700"}`}
                                          title={p.isNight ? "Noturno" : "Diurno"}
                                        >
                                          {p.isNight ? "🌙" : "☀️"}{p.period}
                                        </span>
                                      ))}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Filtro por data pra inspecionar a tabela detalhada */}
                  {uniqueDates.length > 1 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] uppercase tracking-wider text-text-light font-semibold">Filtrar tabela:</span>
                      <button
                        type="button"
                        onClick={() => setCostadoDateFilter("TODAS")}
                        className={`text-xs px-2 py-1 rounded-lg border font-medium transition ${
                          costadoDateFilter === "TODAS"
                            ? "bg-primary text-white border-primary"
                            : "border-border text-text-light hover:bg-gray-50"
                        }`}
                      >
                        Todas ({allocations.length})
                      </button>
                      {uniqueDates.map((d) => {
                        const count = allocations.filter((a) => (a.shift_date || "").slice(0, 10) === d).length;
                        return (
                          <button
                            key={d}
                            type="button"
                            onClick={() => setCostadoDateFilter(d)}
                            className={`text-xs px-2 py-1 rounded-lg border font-medium transition ${
                              costadoDateFilter === d
                                ? "bg-primary text-white border-primary"
                                : "border-border text-text-light hover:bg-gray-50"
                            }`}
                          >
                            {d.split("-").reverse().join("/")} <span className="text-[10px] opacity-70">({count})</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

            <div className="bg-card border border-border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-border">
                  <tr>
                    <th className="px-2 py-2 text-left text-xs font-semibold text-text-light w-8">#</th>
                    <th className="px-2 py-2 text-left text-xs font-semibold text-text-light min-w-[14rem]">Funcionário / Função</th>
                    {showCostadoShiftColumns && (
                      <>
                        <th className="px-2 py-2 text-center text-xs font-semibold text-text-light whitespace-nowrap">Data</th>
                        <th className="px-2 py-2 text-center text-xs font-semibold text-text-light whitespace-nowrap">Período</th>
                      </>
                    )}
                    {showQtyColumn && (
                      <th className="px-2 py-2 text-center text-xs font-semibold text-text-light">{qtyLabel}</th>
                    )}
                    <th className="px-2 py-2 text-right text-xs font-semibold text-text-light whitespace-nowrap">{rateLabel}</th>
                    {multiplierLabel && (
                      <th className="px-2 py-2 text-center text-xs font-semibold text-text-light">{multiplierLabel}</th>
                    )}
                    <th className="px-2 py-2 text-right text-xs font-semibold text-text-light">Base</th>
                    <th className="px-2 py-2 text-right text-xs font-semibold text-text-light" title="Valor especial + rateio">Extra</th>
                    <th className="px-2 py-2 text-right text-xs font-semibold text-text-light">Total</th>
                    <th className="px-2 py-2 text-right text-xs font-semibold text-text-light">Pluxee</th>
                    <th className="px-2 py-2 text-right text-xs font-semibold text-text-light">Folha</th>
                    {canEdit && !isReadOnly && !peopleReadOnly && <th className="w-14"></th>}
                  </tr>
                </thead>
                <tbody>
                  {(showCostadoShiftColumns
                    ? [...dateFilteredAllocations].sort((x, y) => {
                        // Costado: agrupa por data + período pra ler a folha mais facil.
                        const xd = x.shift_date || "";
                        const yd = y.shift_date || "";
                        if (xd !== yd) return xd.localeCompare(yd);
                        const xp = x.shift_period || "";
                        const yp = y.shift_period || "";
                        if (xp !== yp) return xp.localeCompare(yp);
                        return (x.employees?.name || "").localeCompare(y.employees?.name || "");
                      })
                    : allocations
                  ).map((a, idx) => {
                    // No EMBARQUE: Base usa o valor FIXO da função (default_rate);
                    // diferenças (overrides) entram como Extra.
                    // No COSTADO: rate vem sempre da função COSTADO (Valores) —
                    // o stored rate da alocação pode ser legado errado.
                    const fn = functions.find((f) => f.id === a.function_id);
                    const defaultRate = Number(fn?.default_rate ?? a.rate);
                    const actualRate = Number(a.rate);
                    const isEmbarque = kindFilter === "EMBARQUE";
                    const isCostado = kindFilter === "COSTADO";
                    const rowRate = rateForRow(a);
                    const rowQty = effectiveQty(a);
                    const displayRate = isEmbarque ? defaultRate : rowRate;
                    const base = isEmbarque
                      ? defaultRate * holdsMultiplier
                      : isCostado ? rowRate * rowQty
                      : actualRate * a.quantity * holdsMultiplier;
                    // Costado: marca turnos noturnos visualmente.
                    const isCostadoNight = isCostado
                      && COSTADO_NIGHT_SHIFT_PERIODS.includes(a.shift_period || "");
                    const specialDelta = isEmbarque ? (actualRate - defaultRate) * holdsMultiplier : 0;
                    const rateioExtra = Number(a.extra_value || 0);
                    const extra = specialDelta + rateioExtra;
                    const pluxee = Number(a.pluxee_value || 0);
                    const folha = base + extra - pluxee;
                    return (
                      <tr key={a.id} className="border-b border-border last:border-0 hover:bg-gray-50">
                        <td className="px-2 py-2 text-text-light">{idx + 1}</td>
                        <td className="px-2 py-2">
                          <p className="font-medium whitespace-nowrap">{a.employees?.name || a.job_functions?.name || `#${a.function_id}`}</p>
                          {a.employees?.name && <p className="text-[10px] text-text-light">{a.job_functions?.name}</p>}
                          {specialDelta !== 0 && (
                            <p className="text-[10px] text-blue-700 italic mt-0.5" title={`Valor especial: ${brl(actualRate)}/porão (padrão ${brl(defaultRate)})`}>
                              💰 Valor especial {brl(actualRate)}/porão
                            </p>
                          )}
                          {rateioExtra > 0 && a.extra_reason && (
                            <p className="text-[10px] text-amber-700 italic mt-0.5" title={a.extra_reason}>
                              ⚖️ {a.extra_reason}
                            </p>
                          )}
                        </td>
                        {showCostadoShiftColumns && (
                          <>
                            <td className="px-2 py-2 text-center text-xs whitespace-nowrap">
                              {a.shift_date ? (
                                <span className="font-mono text-text">{formatJobDate(a.shift_date)}</span>
                              ) : (
                                <span className="text-text-light">—</span>
                              )}
                            </td>
                            <td className="px-2 py-2 text-center whitespace-nowrap">
                              {a.shift_period ? (
                                <span
                                  className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                                    isCostadoNight
                                      ? "bg-indigo-100 text-indigo-800"
                                      : "bg-amber-100 text-amber-800"
                                  }`}
                                  title={isCostadoNight ? "Turno noturno — recebe adicional" : "Turno diurno"}
                                >
                                  {isCostadoNight ? "🌙" : "☀️"} {a.shift_period}
                                </span>
                              ) : (
                                <span className="text-text-light text-xs">—</span>
                              )}
                            </td>
                          </>
                        )}
                        {showQtyColumn && (
                          <td className="px-2 py-2 text-center">
                            {editingQtyId === a.id && canEdit && !isReadOnly ? (
                              <input
                                type="number"
                                step="1"
                                min="0"
                                value={qtyDraft}
                                onChange={(e) => setQtyDraft(e.target.value)}
                                onBlur={async () => {
                                  await handleSetQty(a.id, qtyDraft, a.quantity);
                                  setEditingQtyId(null);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                  if (e.key === "Escape") { setEditingQtyId(null); setQtyDraft(""); }
                                }}
                                autoFocus
                                className="w-16 text-center px-1 py-0.5 border-2 border-primary rounded outline-none"
                              />
                            ) : (
                              <button
                                type="button"
                                disabled={!canEdit || isReadOnly}
                                onClick={() => { setQtyDraft(String(rowQty)); setEditingQtyId(a.id); }}
                                className={canEdit && !isReadOnly ? "hover:bg-blue-50 rounded px-1 cursor-text" : ""}
                                title={canEdit && !isReadOnly ? "Clique para editar" : (isCostado && a.quantity === 0 ? "Legado: quantity=0, exibido como 1 turno" : "")}
                              >
                                {rowQty}
                              </button>
                            )}
                          </td>
                        )}
                        <td className="px-2 py-2 text-right whitespace-nowrap">
                          {editingRateId === a.id && canEdit && !isReadOnly ? (
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={rateDraft}
                              onChange={(e) => setRateDraft(e.target.value)}
                              onBlur={async () => {
                                await handleSetRate(a.id, rateDraft, actualRate);
                                setEditingRateId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                if (e.key === "Escape") { setEditingRateId(null); setRateDraft(""); }
                              }}
                              autoFocus
                              className="w-24 text-right px-1 py-0.5 border-2 border-primary rounded outline-none"
                            />
                          ) : isCostado || isEmbarque ? (
                            // Embarque e Costado: o valor/porão vem sempre do
                            // cadastro do colaborador (cargo + valor especial/
                            // padrão da função), não é editável por navio. O
                            // stored rate (mesmo legado) é ignorado silenciosamente.
                            <span
                              className="text-text"
                              title={isEmbarque
                                ? "Valor vem do cadastro do colaborador (RH › Colaboradores)"
                                : "Valor da função COSTADO definido em Valores"}
                            >
                              {brl(displayRate)}
                            </span>
                          ) : (
                            <button
                              type="button"
                              disabled={!canEdit || isReadOnly}
                              onClick={() => { setRateDraft(actualRate.toString()); setEditingRateId(a.id); }}
                              className={canEdit && !isReadOnly ? "hover:bg-blue-50 rounded px-1 cursor-text" : ""}
                              title={canEdit && !isReadOnly ? (isEmbarque ? "Clique para editar (vira valor especial)" : "Clique para editar") : ""}
                            >
                              {brl(displayRate)}
                            </button>
                          )}
                        </td>
                        {multiplierLabel && (
                          <td className="px-2 py-2 text-center text-text-light">× {holdsMultiplier}</td>
                        )}
                        <td className="px-2 py-2 text-right whitespace-nowrap">{brl(base)}</td>
                        <td
                          className={`px-2 py-2 text-right whitespace-nowrap ${extra < 0 ? "text-red-700" : "text-amber-700"}`}
                          title={
                            specialDelta !== 0 && rateioExtra > 0
                              ? `Valor especial ${specialDelta >= 0 ? "+" : ""}${brl(specialDelta)} + Rateio ${brl(rateioExtra)}`
                              : specialDelta !== 0
                                ? `Valor especial ${specialDelta >= 0 ? "+" : ""}${brl(specialDelta)}`
                                : rateioExtra > 0
                                  ? `Rateio ${brl(rateioExtra)}`
                                  : undefined
                          }
                        >
                          {editingExtraId === a.id && canEdit && !isReadOnly ? (
                            <input
                              type="number"
                              step="0.01"
                              value={extraDraft}
                              onChange={(e) => setExtraDraft(e.target.value)}
                              onBlur={async () => {
                                await handleSetExtra(a.id, extraDraft, rateioExtra);
                                setEditingExtraId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                if (e.key === "Escape") { setEditingExtraId(null); setExtraDraft(""); }
                              }}
                              autoFocus
                              className="w-24 text-right px-1 py-0.5 border-2 border-primary rounded outline-none text-amber-700"
                            />
                          ) : (
                            <button
                              type="button"
                              disabled={!canEdit || isReadOnly}
                              onClick={() => { setExtraDraft(rateioExtra.toString()); setEditingExtraId(a.id); }}
                              className={canEdit && !isReadOnly ? "hover:bg-amber-50 rounded px-1 cursor-text" : ""}
                              title={canEdit && !isReadOnly ? "Clique para editar o rateio (valor especial fica intacto)" : ""}
                            >
                              {extra === 0 ? "—" : `${extra > 0 ? "+ " : "− "}${brl(Math.abs(extra))}`}
                            </button>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-semibold text-emerald-700 whitespace-nowrap">{brl(base + extra)}</td>
                        <td className="px-2 py-2 text-right text-amber-700 whitespace-nowrap">
                          {editingPluxeeId === a.id && canEdit && !isReadOnly ? (
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={pluxeeDraft}
                              onChange={(e) => setPluxeeDraft(e.target.value)}
                              onBlur={async () => {
                                await handleSetPluxee(a.id, pluxeeDraft, pluxee);
                                setEditingPluxeeId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                if (e.key === "Escape") { setEditingPluxeeId(null); setPluxeeDraft(""); }
                              }}
                              autoFocus
                              className="w-24 text-right px-1 py-0.5 border-2 border-primary rounded outline-none text-amber-700"
                            />
                          ) : (
                            <button
                              type="button"
                              disabled={!canEdit || isReadOnly}
                              onClick={() => { setPluxeeDraft(pluxee.toString()); setEditingPluxeeId(a.id); }}
                              className={canEdit && !isReadOnly ? "hover:bg-amber-50 rounded px-1 cursor-text" : ""}
                              title={canEdit && !isReadOnly ? "Clique para editar" : ""}
                            >
                              {brl(pluxee)}
                            </button>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">
                          {editingFolhaId === a.id && canEdit && !isReadOnly ? (
                            <input
                              type="number"
                              step="0.01"
                              value={folhaDraft}
                              onChange={(e) => setFolhaDraft(e.target.value)}
                              onBlur={async () => {
                                const n = parseFloat(folhaDraft.replace(",", "."));
                                if (Number.isFinite(n) && n !== folha) {
                                  await handleSetFolha(a.id, base + extra, n);
                                }
                                setEditingFolhaId(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                if (e.key === "Escape") { setEditingFolhaId(null); setFolhaDraft(""); }
                              }}
                              autoFocus
                              className="w-24 text-right px-1 py-0.5 border-2 border-primary rounded text-purple-700 font-semibold outline-none"
                            />
                          ) : (
                            <button
                              type="button"
                              disabled={!canEdit || isReadOnly}
                              onClick={() => {
                                setFolhaDraft(folha ? folha.toString() : "");
                                setEditingFolhaId(a.id);
                              }}
                              className={`text-purple-700 ${canEdit && !isReadOnly ? "hover:bg-purple-50 rounded px-1 -mx-1 cursor-text" : ""}`}
                              title={canEdit && !isReadOnly ? "Clique para editar" : ""}
                            >
                              {brl(folha)}
                            </button>
                          )}
                        </td>
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
                    const isEmbarque = kindFilter === "EMBARQUE";
                    const isCostado = kindFilter === "COSTADO";
                    // O total acompanha o filtro de data (quando ativo) -- o
                    // resumo do navio inteiro fica nos cards acima.
                    const totalAllocs = isCostado ? dateFilteredAllocations : allocations;
                    const baseTotal = totalAllocs.reduce((s, a) => {
                      if (isEmbarque) {
                        const fn = functions.find((f) => f.id === a.function_id);
                        const defaultRate = Number(fn?.default_rate ?? a.rate);
                        return s + defaultRate * holdsMultiplier;
                      }
                      if (isCostado) return s + costadoRate * effectiveQty(a);
                      return s + Number(a.rate) * a.quantity * holdsMultiplier;
                    }, 0);
                    const extraTotal = totalAllocs.reduce((s, a) => {
                      const rateio = Number(a.extra_value || 0);
                      if (isEmbarque) {
                        const fn = functions.find((f) => f.id === a.function_id);
                        const defaultRate = Number(fn?.default_rate ?? a.rate);
                        const special = (Number(a.rate) - defaultRate) * holdsMultiplier;
                        return s + special + rateio;
                      }
                      return s + rateio;
                    }, 0);
                    const pluxeeTotal = totalAllocs.reduce((s, a) => s + Number(a.pluxee_value || 0), 0);
                    // colSpan = "#" + nome + (data+periodo?) + (qty?) + rate = 3 base, +1 cada coluna opcional
                    const labelColSpan = 3
                      + (showCostadoShiftColumns ? 2 : 0)  // Data + Período
                      + (showQtyColumn ? 1 : 0)            // Turnos/Qtd
                      + (multiplierLabel ? 1 : 0);          // Porões (só Embarque)
                    return (
                      <tr>
                        <td colSpan={labelColSpan} className="px-2 py-2 text-text-light text-right">TOTAL</td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">{brl(baseTotal)}</td>
                        <td className={`px-2 py-2 text-right whitespace-nowrap ${extraTotal < 0 ? "text-red-700" : "text-amber-700"}`}>
                          {extraTotal === 0 ? "—" : `${extraTotal > 0 ? "+ " : "− "}${brl(Math.abs(extraTotal))}`}
                        </td>
                        <td className="px-2 py-2 text-right text-emerald-700 whitespace-nowrap">{brl(baseTotal + extraTotal)}</td>
                        <td className="px-2 py-2 text-right text-amber-700 whitespace-nowrap">{brl(pluxeeTotal)}</td>
                        <td className="px-2 py-2 text-right text-purple-700 whitespace-nowrap">{brl(baseTotal + extraTotal - pluxeeTotal)}</td>
                        {canEdit && !isReadOnly && !peopleReadOnly && <td></td>}
                      </tr>
                    );
                  })()}
                </tfoot>
              </table>
            </div>
            </>
          )}
        </div>

        {/* Ajustes */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-sm font-semibold">🪙 Despesas</h3>
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
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-light text-sm pointer-events-none">R$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={adjAmt}
                    onChange={(e) => setAdjAmt(e.target.value.replace(/[^\d.,]/g, ""))}
                    onBlur={() => {
                      const raw = adjAmt.replace(/\./g, "").replace(",", ".");
                      const n = parseFloat(raw);
                      if (!Number.isFinite(n)) { setAdjAmt(""); return; }
                      setAdjAmt(n.toFixed(2).replace(".", ","));
                    }}
                    required
                    className={`${inputCls} pl-9`}
                    placeholder="0,00"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">Descrição</label>
                <input type="text" value={adjDesc} onChange={(e) => setAdjDesc(e.target.value)} className={inputCls} placeholder="Opcional — detergente, sabão, etc." />
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

        {job.notes && (
          <div className="border-t border-border pt-3">
            <p className="text-xs font-semibold text-text-light uppercase tracking-wider mb-1">Observações</p>
            <p className="text-sm italic">"{job.notes}"</p>
          </div>
        )}

        {/* Action bar — só reabertura caso esteja verificado/fechado */}
        {canEdit && (job.status === "VERIFICADO" || job.status === "FECHADO") && (
          <div className="border-t border-border pt-4 flex flex-wrap gap-2 justify-end">
            <button onClick={handleReopen} className="px-3 py-2 text-sm font-medium bg-gray-200 text-text rounded-lg hover:bg-gray-300 transition">
              ↺ Reabrir
            </button>
          </div>
        )}
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
  jobs, allocations, adjustments, functions, ships, employees, specialRates, canEdit, profileName, onChange, loading,
}: {
  jobs: Job[];
  allocations: JobAllocation[];
  adjustments: JobAdjustment[];
  functions: JobFunction[];
  ships: Ship[];
  employees: Employee[];
  specialRates: Map<string, number>;
  canEdit: boolean;
  profileName: string;
  onChange: () => void;
  loading: boolean;
}) {
  const [detailJob, setDetailJob] = useState<Job | null>(null);
  const [statusFilter, setStatusFilter] = useState<JobStatus | "TODOS">("TODOS");
  const [deleteJob, setDeleteJob] = useState<Job | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const [closeShipJob, setCloseShipJob] = useState<Job | null>(null);

  // Costado jobs = jobs whose ship is marked as Costado OR that have any COSTADO allocation.
  const costadoShipIds = new Set(
    ships.filter((s) => (s.services || []).includes("COSTADO")).map((s) => s.id)
  );
  const jobsWithCostadoAlloc = new Set(
    allocations.filter((a) => a.kind === "COSTADO").map((a) => a.job_id)
  );
  // Todo navio de Costado entra no Financeiro em qualquer situação — não precisa
  // fechar antes. Só esconde navio Cancelado; jobs sem navio sempre aparecem.
  const costadoJobs = jobs.filter(
    (j) => ((j.ship_id && costadoShipIds.has(j.ship_id)) || jobsWithCostadoAlloc.has(j.id))
      && (!j.ship_id || shipStatusOf(j) !== "CANCELADO"),
  );
  const filtered = costadoJobs.filter((j) => {
    if (statusFilter === "TODOS") return true;
    if (statusFilter === "EM_ANDAMENTO") return j.status !== "FECHADO" && j.status !== "CANCELADO";
    return j.status === statusFilter;
  });

  // Para os cards de Costado, o rate canônico é o default_rate da função
  // COSTADO (configurada em Valores). O rate stored na alocação pode ser
  // legado errado (ex.: R$ 400 vindo do default_rate da role de Embarque).
  const costadoFnDef = functions.find((f) => f.name.trim().toUpperCase() === "COSTADO");
  const costadoRateDef = costadoFnDef ? Number(costadoFnDef.default_rate) : 0;
  function effectiveCostadoQty(a: JobAllocation): number {
    return Math.max(1, a.quantity);
  }
  // For job cards, compute Costado-only cost (filter allocs to kind=COSTADO).
  function costadoCost(job: Job) {
    const allocs = allocations.filter((a) => a.job_id === job.id && a.kind === "COSTADO");
    const adjs = adjustments.filter((a) => a.job_id === job.id);
    const base = allocs.reduce((s, a) => s + costadoRateDef * effectiveCostadoQty(a) + Number(a.extra_value || 0), 0);
    const adj = adjs.reduce((s, a) => s + (a.type === "ADICIONAL" ? Number(a.amount) : -Number(a.amount)), 0);
    return base + adj;
  }
  function costadoTotalShifts(job: Job): number {
    return allocations
      .filter((a) => a.job_id === job.id && a.kind === "COSTADO")
      .reduce((s, a) => s + effectiveCostadoQty(a), 0);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          {(["TODOS", "EM_ANDAMENTO", "FECHADO", "CANCELADO"] as const).map((s) => (
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
            const shifts = costadoTotalShifts(j);
            const hours = shifts * HOURS_PER_SHIFT;
            return (
              <div key={j.id} className="bg-card rounded-xl border border-border p-4 hover:shadow-md transition cursor-pointer" onClick={() => setDetailJob(j)}>
                <div className="flex flex-wrap justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold">{j.name}</h3>
                      <ShipStatusBadge status={shipStatusOf(j)} />
                      {/* Navios mostram só a situação operacional (Em Operação/Concluído),
                          igual à aba Navios. O status de pagamento (Em Andamento/Pago) fica
                          só para pagamentos avulsos sem navio. */}
                      {!shipStatusOf(j) && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[j.status]}`}>
                          {STATUS_LABELS[j.status]}
                        </span>
                      )}
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
                    {canEdit && (
                      <div className="flex gap-1 items-center" onClick={(e) => e.stopPropagation()}>
                        {j.ship_id && shipStatusOf(j) && shipStatusOf(j) !== "CONCLUIDO" && shipStatusOf(j) !== "CANCELADO" && (
                          <button
                            onClick={() => setCloseShipJob(j)}
                            className="text-xs px-2 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700"
                            title="Fecha o navio (Concluído) e grava o valor do contrato"
                          >
                            🏁 Fechar Navio
                          </button>
                        )}
                        <button
                          onClick={() => setDeleteJob(j)}
                          className="p-1.5 text-danger hover:bg-red-50 rounded"
                          title="Excluir pagamento (apaga alocações também)"
                        >
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

      {deleteErr && (
        <p className="fixed bottom-4 right-4 bg-red-600 text-white text-sm px-3 py-2 rounded shadow-lg z-50">
          {deleteErr}
        </p>
      )}

      <ConfirmDialog
        open={!!deleteJob}
        onClose={() => setDeleteJob(null)}
        onConfirm={async () => {
          if (!deleteJob) return;
          setDeleteErr(null);
          // Apaga primeiro as filhas (alocações e ajustes), depois o job.
          // O cascade do Prisma resolve isso quando configurado, mas o
          // db proxy não faz cascade automático — então faz a ordem na mão.
          const allocRes = await db.from("job_allocations").delete().eq("job_id", deleteJob.id);
          if (allocRes.error) {
            setDeleteErr(`Erro ao apagar alocações: ${allocRes.error.message}`);
            return;
          }
          const adjRes = await db.from("job_adjustments").delete().eq("job_id", deleteJob.id);
          if (adjRes.error) {
            setDeleteErr(`Erro ao apagar despesas: ${adjRes.error.message}`);
            return;
          }
          const jobRes = await db.from("jobs").delete().eq("id", deleteJob.id);
          if (jobRes.error) {
            setDeleteErr(`Erro ao apagar pagamento: ${jobRes.error.message}`);
            return;
          }
          setDeleteJob(null);
          onChange();
        }}
        title="Excluir pagamento de Costado?"
        message={`"${deleteJob?.name}" será excluído junto com todas as alocações e despesas. A escala em Escalação › Costado também perde esses registros. Essa ação não pode ser desfeita.`}
        confirmLabel="Excluir"
        variant="danger"
      />

      <JobDetailModal
        open={!!detailJob}
        job={detailJob}
        allocations={allocations.filter((a) => a.job_id === detailJob?.id && a.kind === "COSTADO")}
        adjustments={adjustments.filter((a) => a.job_id === detailJob?.id)}
        functions={functions}
        employees={employees}
        specialRates={specialRates}
        canEdit={canEdit}
        profileName={profileName}
        kindFilter="COSTADO"
        onClose={() => setDetailJob(null)}
        onChange={() => { onChange(); }}
      />

      <CloseShipModal
        job={closeShipJob}
        onClose={() => setCloseShipJob(null)}
        onClosed={() => { setCloseShipJob(null); onChange(); }}
      />
    </div>
  );
}

// ─── CONTROLE TAB ──────────────────────────────────────────────────────────
// Dashboard de equipe — agrega toda a movimentação financeira por colaborador
// pra responder: "quem trabalhou, em que navios, quantos porões/turnos, quanto
// recebeu?". Permite filtrar por mês/ano e por atividade (Embarque/Costado),
// e tem cards de destaque pra quem mais produziu.

interface EmployeeStats {
  employee: Employee;
  embarque: {
    ships: Set<string>;
    poroes: number;       // soma de porões (= holds_count por job, contado uma vez por funcionário/job)
    earnings: number;     // ganho total Embarque (rate × holds + extra)
    allocations: number;  // nº de alocações registradas
  };
  costado: {
    ships: Set<string>;
    turnos: number;       // soma de quantity
    diurnos: number;
    noturnos: number;
    earnings: number;
    allocations: number;
  };
  totalEarnings: number;
  lastActivity: string | null; // ISO date da movimentação mais recente
  history: Array<{
    jobId: string;
    jobName: string;
    shipName: string | null;
    kind: "EMBARQUE" | "COSTADO";
    date: string | null;
    period?: string | null;
    poroes?: number;
    quantity: number;
    rate: number;
    earnings: number;
    functionName: string | null;
  }>;
}

function ControleTab({
  jobs, allocations, functions, ships, employees, loading,
}: {
  jobs: Job[];
  allocations: JobAllocation[];
  // adjustments existem mas só afetam o custo do job (compras/despesas) —
  // não o ganho individual dos colaboradores, então não usamos aqui.
  adjustments: JobAdjustment[];
  functions: JobFunction[];
  ships: Ship[];
  employees: Employee[];
  loading: boolean;
}) {
  // ── Filtros ──────────────────────────────────────────────────────────────
  // Mês = 0..11; ano = 4 dígitos. "TODOS" no mês quer dizer "ano inteiro".
  // `now` em useMemo pra não invalidar a lista de anos a cada render.
  const now = useMemo(() => new Date(), []);
  const [year, setYear] = useState<number>(now.getFullYear());
  const [month, setMonth] = useState<number | "TODOS">(now.getMonth());
  const [activity, setActivity] = useState<"TODAS" | "EMBARQUE" | "COSTADO">("TODAS");
  const [statusFilter, setStatusFilter] = useState<"ATIVOS" | "TODOS">("ATIVOS");
  const [paymentFilter, setPaymentFilter] = useState<"TODOS" | "PAGO">("TODOS");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "earnings" | "poroes" | "turnos" | "ships">("earnings");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [detailEmp, setDetailEmp] = useState<Employee | null>(null);

  // ── Períodos disponíveis: anos com pelo menos uma alocação ─────────────
  const availableYears = useMemo(() => {
    const set = new Set<number>([now.getFullYear()]);
    for (const a of allocations) {
      const d = a.shift_date || jobs.find((j) => j.id === a.job_id)?.start_date;
      if (d) set.add(new Date(d).getFullYear());
    }
    return Array.from(set).sort((a, b) => b - a);
  }, [allocations, jobs, now]);

  // ── Helper: extrai "mês de referência" de uma alocação ─────────────────
  function allocMonthKey(a: JobAllocation): { year: number; month: number } | null {
    // Costado tem shift_date (data exata do turno). Embarque usa start_date do job.
    const dateStr = a.shift_date || jobs.find((j) => j.id === a.job_id)?.start_date || null;
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return null;
    return { year: d.getFullYear(), month: d.getMonth() };
  }

  function passesPeriodFilter(a: JobAllocation): boolean {
    const k = allocMonthKey(a);
    if (!k) return false;
    if (k.year !== year) return false;
    if (month !== "TODOS" && k.month !== month) return false;
    return true;
  }

  // ── Agregação por colaborador ────────────────────────────────────────────
  const stats: EmployeeStats[] = useMemo(() => {
    const map = new Map<number, EmployeeStats>();
    // Inicializa com TODOS os colaboradores filtrados — assim quem não trabalhou
    // ainda aparece no relatório (zerado) quando o usuário pede "Todos".
    for (const e of employees) {
      const isActive = (e.status ?? "ATIVO") === "ATIVO";
      if (statusFilter === "ATIVOS" && !isActive) continue;
      map.set(e.id, {
        employee: e,
        embarque: { ships: new Set(), poroes: 0, earnings: 0, allocations: 0 },
        costado: { ships: new Set(), turnos: 0, diurnos: 0, noturnos: 0, earnings: 0, allocations: 0 },
        totalEarnings: 0,
        lastActivity: null,
        history: [],
      });
    }

    // Pra contar "porões por funcionário por navio" sem duplicar quando alguém
    // tem várias alocações no mesmo job de embarque (cenário raro mas possível).
    const embarqueJobSeen = new Map<number, Set<string>>(); // empId -> Set<jobId>

    // Costado: rate canônico vem da função COSTADO em Valores (não do stored
    // rate da alocação, que pode ser legado errado).
    const ctrlCostadoFn = functions.find((f) => f.name.trim().toUpperCase() === "COSTADO");
    const ctrlCostadoRate = ctrlCostadoFn ? Number(ctrlCostadoFn.default_rate) : 0;

    for (const a of allocations) {
      if (a.status !== "ATIVO") continue;
      if (paymentFilter === "PAGO") {
        const job = jobs.find((j) => j.id === a.job_id);
        if (job?.status !== "FECHADO") continue;
      }
      if (!passesPeriodFilter(a)) continue;
      if (!a.employee_id) continue;
      const s = map.get(a.employee_id);
      if (!s) continue;
      const job = jobs.find((j) => j.id === a.job_id);
      const ship = job?.ship_id ? ships.find((sh) => sh.id === job.ship_id) : null;
      const shipName = ship?.name || job?.name || null;
      const fn = functions.find((f) => f.id === a.function_id);
      const kind: "EMBARQUE" | "COSTADO" = a.kind === "COSTADO" ? "COSTADO" : "EMBARQUE";
      if (activity !== "TODAS" && activity !== kind) continue;

      const rate = kind === "COSTADO" ? ctrlCostadoRate : Number(a.rate);
      const extra = Number(a.extra_value || 0);

      if (kind === "EMBARQUE") {
        const holds = Math.max(1, Number(job?.holds_count || 1));
        const earnings = rate * holds + extra;
        const seen = embarqueJobSeen.get(a.employee_id) || new Set<string>();
        // Soma porões só uma vez por (employee, job) — várias alocações no mesmo
        // job não duplicam a contagem.
        const firstTime = !seen.has(a.job_id);
        if (firstTime) {
          s.embarque.poroes += holds;
          seen.add(a.job_id);
          embarqueJobSeen.set(a.employee_id, seen);
          if (shipName) s.embarque.ships.add(shipName);
        }
        s.embarque.earnings += earnings;
        s.embarque.allocations += 1;
        s.history.push({
          jobId: a.job_id, jobName: job?.name || "—", shipName,
          kind, date: job?.start_date || null, poroes: firstTime ? holds : 0,
          quantity: 1, rate, earnings,
          functionName: fn?.name || null,
        });
      } else {
        // Costado: cada linha é 1 turno escalado (quantity=0 é legado, vira 1).
        const qty = Math.max(1, a.quantity);
        const earnings = rate * qty + extra;
        s.costado.turnos += qty;
        if (a.shift_period && ["19-01", "01-07"].includes(a.shift_period)) {
          s.costado.noturnos += qty;
        } else if (a.shift_period) {
          s.costado.diurnos += qty;
        }
        s.costado.earnings += earnings;
        s.costado.allocations += 1;
        if (shipName) s.costado.ships.add(shipName);
        s.history.push({
          jobId: a.job_id, jobName: job?.name || "—", shipName,
          kind, date: a.shift_date, period: a.shift_period,
          quantity: qty, rate, earnings,
          functionName: fn?.name || null,
        });
      }

      const refDate = a.shift_date || job?.start_date || null;
      if (refDate && (!s.lastActivity || refDate > s.lastActivity)) {
        s.lastActivity = refDate;
      }
    }

    // Finaliza totais
    for (const s of map.values()) {
      s.totalEarnings = s.embarque.earnings + s.costado.earnings;
      // Ordena history mais recente primeiro
      s.history.sort((x, y) => (y.date || "").localeCompare(x.date || ""));
    }

    return Array.from(map.values());
  // passesPeriodFilter / allocMonthKey usam só year/month/jobs — já cobertos.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, allocations, jobs, ships, functions, statusFilter, paymentFilter, activity, year, month]);

  // ── Ordenação & busca ────────────────────────────────────────────────────
  const visibleStats = useMemo(() => {
    let list = stats;
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((s) =>
        s.employee.name.toLowerCase().includes(q) ||
        (s.employee.role || "").toLowerCase().includes(q) ||
        (s.employee.team || "").toLowerCase().includes(q)
      );
    }
    const dir = sortDir === "asc" ? 1 : -1;
    const cmp = (a: EmployeeStats, b: EmployeeStats) => {
      switch (sortBy) {
        case "name": return a.employee.name.localeCompare(b.employee.name, "pt-BR") * dir;
        case "earnings": return (a.totalEarnings - b.totalEarnings) * dir;
        case "poroes": return (a.embarque.poroes - b.embarque.poroes) * dir;
        case "turnos": return (a.costado.turnos - b.costado.turnos) * dir;
        case "ships": return ((a.embarque.ships.size + a.costado.ships.size) - (b.embarque.ships.size + b.costado.ships.size)) * dir;
        default: return 0;
      }
    };
    return [...list].sort(cmp);
  }, [stats, search, sortBy, sortDir]);

  // ── KPIs gerais do período filtrado ──────────────────────────────────────
  const periodKpis = useMemo(() => {
    const workers = stats.filter((s) => s.totalEarnings > 0 || s.embarque.allocations > 0 || s.costado.allocations > 0);
    const totalPaid = stats.reduce((sum, s) => sum + s.totalEarnings, 0);
    const totalPoroes = stats.reduce((sum, s) => sum + s.embarque.poroes, 0);
    const totalTurnos = stats.reduce((sum, s) => sum + s.costado.turnos, 0);
    const totalHoras = totalTurnos * 6;
    const totalShipsEmbarque = new Set<string>();
    const totalShipsCostado = new Set<string>();
    for (const s of stats) {
      s.embarque.ships.forEach((n) => totalShipsEmbarque.add(n));
      s.costado.ships.forEach((n) => totalShipsCostado.add(n));
    }
    return {
      workers: workers.length,
      totalPaid,
      totalPoroes,
      totalTurnos,
      totalHoras,
      shipsEmbarque: totalShipsEmbarque.size,
      shipsCostado: totalShipsCostado.size,
    };
  }, [stats]);

  // ── Top performers (Top 3 em cada categoria, ignorando zeros) ───────────
  const topPerformers = useMemo(() => {
    const nonZero = (val: number) => val > 0;
    const sortedByEarnings = [...stats].filter((s) => nonZero(s.totalEarnings)).sort((a, b) => b.totalEarnings - a.totalEarnings).slice(0, 3);
    const sortedByPoroes = [...stats].filter((s) => nonZero(s.embarque.poroes)).sort((a, b) => b.embarque.poroes - a.embarque.poroes).slice(0, 3);
    const sortedByHoras = [...stats].filter((s) => nonZero(s.costado.turnos)).sort((a, b) => b.costado.turnos - a.costado.turnos).slice(0, 3);
    const sortedByShips = [...stats].filter((s) => (s.embarque.ships.size + s.costado.ships.size) > 0)
      .sort((a, b) => (b.embarque.ships.size + b.costado.ships.size) - (a.embarque.ships.size + a.costado.ships.size)).slice(0, 3);
    return { earnings: sortedByEarnings, poroes: sortedByPoroes, horas: sortedByHoras, ships: sortedByShips };
  }, [stats]);

  // ── Helpers de UI ───────────────────────────────────────────────────────
  function toggleSort(col: typeof sortBy) {
    if (sortBy === col) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortBy(col); setSortDir("desc"); }
  }

  function sortIcon(col: typeof sortBy): string {
    if (sortBy !== col) return "↕";
    return sortDir === "asc" ? "▲" : "▼";
  }

  const monthNames = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const periodLabel = month === "TODOS" ? `Ano ${year}` : `${monthNames[month]}/${year}`;

  function exportCsv() {
    // Export simples pro Excel: nome, função, embarque (navios/porões/ganho),
    // costado (turnos/horas/navios/ganho), total, última atividade.
    const sep = ";";
    const header = [
      "Nome", "Função", "Equipe", "Status",
      "Embarque - Navios", "Embarque - Porões", "Embarque - Ganho",
      "Costado - Turnos", "Costado - Horas", "Costado - Diurnos", "Costado - Noturnos", "Costado - Navios", "Costado - Ganho",
      "Total Ganho", "Última atividade",
    ].join(sep);
    const rows = visibleStats.map((s) => [
      `"${s.employee.name}"`,
      `"${s.employee.role || ""}"`,
      `"${s.employee.team || ""}"`,
      `"${s.employee.status || ""}"`,
      s.embarque.ships.size,
      s.embarque.poroes,
      s.embarque.earnings.toFixed(2).replace(".", ","),
      s.costado.turnos,
      s.costado.turnos * 6,
      s.costado.diurnos,
      s.costado.noturnos,
      s.costado.ships.size,
      s.costado.earnings.toFixed(2).replace(".", ","),
      s.totalEarnings.toFixed(2).replace(".", ","),
      s.lastActivity ? new Date(s.lastActivity).toLocaleDateString("pt-BR") : "",
    ].join(sep));
    const csv = "﻿" + [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `controle-equipe-${periodLabel.replace("/", "-")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      {/* Cabeçalho com filtros ─────────────────────────────────────────── */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="text-base font-bold text-text">🎯 Controle de Equipe</h2>
          <p className="text-xs text-text-light">Quem trabalhou, em que navios, quanto produziu e quanto recebeu.</p>
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          {/* Mês */}
          <div>
            <label className="block text-[10px] font-semibold text-text-light uppercase tracking-wider mb-1">Mês</label>
            <select
              value={month === "TODOS" ? "TODOS" : String(month)}
              onChange={(e) => setMonth(e.target.value === "TODOS" ? "TODOS" : Number(e.target.value))}
              className="px-3 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
            >
              <option value="TODOS">Ano inteiro</option>
              {monthNames.map((nm, idx) => (
                <option key={idx} value={idx}>{nm}</option>
              ))}
            </select>
          </div>

          {/* Ano */}
          <div>
            <label className="block text-[10px] font-semibold text-text-light uppercase tracking-wider mb-1">Ano</label>
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="px-3 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
            >
              {availableYears.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>

          {/* Atividade */}
          <div>
            <label className="block text-[10px] font-semibold text-text-light uppercase tracking-wider mb-1">Atividade</label>
            <div className="flex gap-1">
              {(["TODAS", "EMBARQUE", "COSTADO"] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setActivity(a)}
                  className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition ${
                    activity === a
                      ? "bg-primary text-white border-primary"
                      : "border-border text-text-light hover:bg-gray-50"
                  }`}
                >
                  {a === "TODAS" ? "Todas" : a === "EMBARQUE" ? "🚢 Embarque" : "⚓ Costado"}
                </button>
              ))}
            </div>
          </div>

          {/* Status */}
          <div>
            <label className="block text-[10px] font-semibold text-text-light uppercase tracking-wider mb-1">Quem mostrar</label>
            <div className="flex gap-1">
              {(["ATIVOS", "TODOS"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition ${
                    statusFilter === s
                      ? "bg-primary text-white border-primary"
                      : "border-border text-text-light hover:bg-gray-50"
                  }`}
                >
                  {s === "ATIVOS" ? "Só ativos" : "Todos"}
                </button>
              ))}
            </div>
          </div>

          {/* Pago vs Tudo */}
          <div>
            <label className="block text-[10px] font-semibold text-text-light uppercase tracking-wider mb-1">Pagamentos</label>
            <div className="flex gap-1">
              {(["TODOS", "PAGO"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setPaymentFilter(s)}
                  className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition ${
                    paymentFilter === s
                      ? "bg-primary text-white border-primary"
                      : "border-border text-text-light hover:bg-gray-50"
                  }`}
                >
                  {s === "TODOS" ? "Em aberto + pago" : "🔒 Só pago"}
                </button>
              ))}
            </div>
          </div>

          {/* Busca */}
          <div className="flex-1 min-w-[180px]">
            <label className="block text-[10px] font-semibold text-text-light uppercase tracking-wider mb-1">Buscar</label>
            <input
              type="text"
              placeholder="Nome, função ou equipe..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full px-3 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
            />
          </div>

          {/* Export */}
          <div>
            <button
              type="button"
              onClick={exportCsv}
              disabled={visibleStats.length === 0}
              className="px-3 py-1.5 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition"
            >
              📥 Exportar CSV
            </button>
          </div>
        </div>
      </div>

      {/* KPIs do período ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <KpiCard label={`Trabalharam em ${periodLabel}`} value={periodKpis.workers.toString()} accent="blue" />
        <KpiCard label="Folha do período" value={brl(periodKpis.totalPaid)} accent="emerald" />
        <KpiCard label="Porões trabalhados" value={periodKpis.totalPoroes.toString()} accent="amber" />
        <KpiCard label="Turnos Costado" value={`${periodKpis.totalTurnos} (${periodKpis.totalHoras}h)`} accent="amber" />
        <KpiCard label="Navios Embarque" value={periodKpis.shipsEmbarque.toString()} accent="blue" />
        <KpiCard label="Navios Costado" value={periodKpis.shipsCostado.toString()} accent="blue" />
      </div>

      {/* Top Performers ─────────────────────────────────────────────────── */}
      {(topPerformers.earnings.length > 0 || topPerformers.poroes.length > 0 || topPerformers.horas.length > 0 || topPerformers.ships.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          <TopPerformerCard
            title="🏆 Quem mais ganhou"
            color="emerald"
            items={topPerformers.earnings.map((s) => ({
              employee: s.employee, value: brl(s.totalEarnings), sub: `${s.embarque.ships.size + s.costado.ships.size} navios`,
            }))}
            onClick={(emp) => setDetailEmp(emp)}
          />
          <TopPerformerCard
            title="🚢 Top Embarque (porões)"
            color="blue"
            items={topPerformers.poroes.map((s) => ({
              employee: s.employee,
              value: `${s.embarque.poroes} ${s.embarque.poroes === 1 ? "porão" : "porões"}`,
              sub: `${s.embarque.ships.size} navios · ${brl(s.embarque.earnings)}`,
            }))}
            onClick={(emp) => setDetailEmp(emp)}
          />
          <TopPerformerCard
            title="⚓ Top Costado (horas)"
            color="indigo"
            items={topPerformers.horas.map((s) => ({
              employee: s.employee,
              value: `${s.costado.turnos * 6}h`,
              sub: `${s.costado.turnos} turnos · ${brl(s.costado.earnings)}`,
            }))}
            onClick={(emp) => setDetailEmp(emp)}
          />
          <TopPerformerCard
            title="🚢⚓ Mais navios feitos"
            color="amber"
            items={topPerformers.ships.map((s) => ({
              employee: s.employee,
              value: `${s.embarque.ships.size + s.costado.ships.size}`,
              sub: `${s.embarque.ships.size} embarque · ${s.costado.ships.size} costado`,
            }))}
            onClick={(emp) => setDetailEmp(emp)}
          />
        </div>
      )}

      {/* Tabela detalhada ───────────────────────────────────────────────── */}
      {loading ? (
        <p className="text-center text-text-light py-12">Carregando...</p>
      ) : visibleStats.length === 0 ? (
        <div className="text-center py-12 bg-card rounded-xl border border-border">
          <p className="text-3xl mb-2">🔎</p>
          <p className="text-sm text-text-light">Nenhum colaborador encontrado pra esse filtro.</p>
          <p className="text-xs text-text-light mt-1">Tente trocar o mês/ano ou o filtro de status.</p>
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-border">
              <tr>
                <th
                  className="px-3 py-2 text-left text-[10px] font-semibold text-text-light uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                  onClick={() => toggleSort("name")}
                >
                  Colaborador {sortIcon("name")}
                </th>
                <th className="px-3 py-2 text-center text-[10px] font-semibold text-blue-800 uppercase tracking-wider bg-blue-50" colSpan={3}>
                  🚢 Embarque
                </th>
                <th className="px-3 py-2 text-center text-[10px] font-semibold text-indigo-800 uppercase tracking-wider bg-indigo-50" colSpan={4}>
                  ⚓ Costado
                </th>
                <th
                  className="px-3 py-2 text-right text-[10px] font-semibold text-text-light uppercase tracking-wider cursor-pointer hover:bg-gray-100"
                  onClick={() => toggleSort("earnings")}
                >
                  Ganho Total {sortIcon("earnings")}
                </th>
                <th className="px-3 py-2 text-center text-[10px] font-semibold text-text-light uppercase tracking-wider">Última</th>
              </tr>
              <tr className="border-b border-border bg-gray-50/70">
                <th></th>
                <th
                  className="px-2 py-1.5 text-center text-[10px] font-semibold text-blue-800 cursor-pointer hover:bg-blue-100"
                  onClick={() => toggleSort("ships")}
                >
                  Navios {sortIcon("ships")}
                </th>
                <th
                  className="px-2 py-1.5 text-center text-[10px] font-semibold text-blue-800 cursor-pointer hover:bg-blue-100"
                  onClick={() => toggleSort("poroes")}
                >
                  Porões {sortIcon("poroes")}
                </th>
                <th className="px-2 py-1.5 text-right text-[10px] font-semibold text-blue-800">Ganho</th>
                <th
                  className="px-2 py-1.5 text-center text-[10px] font-semibold text-indigo-800 cursor-pointer hover:bg-indigo-100"
                  onClick={() => toggleSort("turnos")}
                >
                  Turnos {sortIcon("turnos")}
                </th>
                <th className="px-2 py-1.5 text-center text-[10px] font-semibold text-indigo-800">☀️/🌙</th>
                <th className="px-2 py-1.5 text-center text-[10px] font-semibold text-indigo-800">Navios</th>
                <th className="px-2 py-1.5 text-right text-[10px] font-semibold text-indigo-800">Ganho</th>
                <th></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visibleStats.map((s) => {
                const hasAnyActivity = s.embarque.allocations + s.costado.allocations > 0;
                return (
                  <tr
                    key={s.employee.id}
                    className={`border-b border-border last:border-0 hover:bg-blue-50/30 cursor-pointer transition ${hasAnyActivity ? "" : "opacity-50"}`}
                    onClick={() => setDetailEmp(s.employee)}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                          <span className="text-xs font-bold text-primary">{s.employee.name.charAt(0).toUpperCase()}</span>
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate">{s.employee.name}</p>
                          <p className="text-[10px] text-text-light">
                            {s.employee.role || <span className="italic">sem função</span>}
                            {s.employee.team && ` · ${s.employee.team}`}
                            {s.employee.status && s.employee.status !== "ATIVO" && (
                              <span className="ml-1 px-1 py-0.5 rounded bg-gray-200 text-gray-700 text-[9px] font-semibold">{s.employee.status}</span>
                            )}
                          </p>
                        </div>
                      </div>
                    </td>

                    {/* Embarque */}
                    <td className="px-2 py-2 text-center text-sm">{s.embarque.ships.size || "—"}</td>
                    <td className="px-2 py-2 text-center text-sm font-semibold text-blue-700">{s.embarque.poroes || "—"}</td>
                    <td className="px-2 py-2 text-right text-sm font-semibold text-emerald-700">
                      {s.embarque.earnings > 0 ? brl(s.embarque.earnings) : <span className="text-text-light">—</span>}
                    </td>

                    {/* Costado */}
                    <td className="px-2 py-2 text-center text-sm font-semibold text-indigo-700">
                      {s.costado.turnos || "—"}
                      {s.costado.turnos > 0 && <span className="block text-[9px] text-text-light font-normal">{s.costado.turnos * 6}h</span>}
                    </td>
                    <td className="px-2 py-2 text-center text-xs whitespace-nowrap">
                      {s.costado.diurnos > 0 || s.costado.noturnos > 0 ? (
                        <>
                          <span className="text-amber-700">☀️{s.costado.diurnos}</span>{" "}
                          <span className="text-indigo-700">🌙{s.costado.noturnos}</span>
                        </>
                      ) : <span className="text-text-light">—</span>}
                    </td>
                    <td className="px-2 py-2 text-center text-sm">{s.costado.ships.size || "—"}</td>
                    <td className="px-2 py-2 text-right text-sm font-semibold text-emerald-700">
                      {s.costado.earnings > 0 ? brl(s.costado.earnings) : <span className="text-text-light">—</span>}
                    </td>

                    {/* Total */}
                    <td className="px-3 py-2 text-right text-sm font-bold text-emerald-800">
                      {s.totalEarnings > 0 ? brl(s.totalEarnings) : <span className="text-text-light font-normal">—</span>}
                    </td>

                    {/* Última */}
                    <td className="px-3 py-2 text-center text-[10px] text-text-light whitespace-nowrap">
                      {s.lastActivity ? new Date(s.lastActivity).toLocaleDateString("pt-BR") : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-gray-50 border-t-2 border-border font-semibold text-xs">
              <tr>
                <td className="px-3 py-2 text-text-light">
                  TOTAL · {visibleStats.length} colaborador{visibleStats.length === 1 ? "" : "es"}
                </td>
                <td className="px-2 py-2 text-center text-blue-800">{periodKpis.shipsEmbarque}</td>
                <td className="px-2 py-2 text-center text-blue-800">{periodKpis.totalPoroes}</td>
                <td className="px-2 py-2 text-right text-emerald-700">{brl(visibleStats.reduce((s, x) => s + x.embarque.earnings, 0))}</td>
                <td className="px-2 py-2 text-center text-indigo-800">
                  {periodKpis.totalTurnos}
                  <span className="block text-[9px] text-text-light font-normal">{periodKpis.totalHoras}h</span>
                </td>
                <td className="px-2 py-2 text-center text-text-light">—</td>
                <td className="px-2 py-2 text-center text-indigo-800">{periodKpis.shipsCostado}</td>
                <td className="px-2 py-2 text-right text-emerald-700">{brl(visibleStats.reduce((s, x) => s + x.costado.earnings, 0))}</td>
                <td className="px-3 py-2 text-right text-emerald-800">{brl(periodKpis.totalPaid)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="text-[10px] text-text-light italic text-center">
        Período: <strong>{periodLabel}</strong> · Filtro: <strong>{activity === "TODAS" ? "Todas atividades" : activity === "EMBARQUE" ? "Só Embarque" : "Só Costado"}</strong>
        {paymentFilter === "PAGO" && <> · Só pagamentos <strong>FECHADO</strong></>}
        · Clique numa linha pra ver o detalhamento completo.
      </p>

      {/* Drawer de detalhe por colaborador */}
      <EmployeeDetailDrawer
        employee={detailEmp}
        stat={detailEmp ? stats.find((s) => s.employee.id === detailEmp.id) || null : null}
        periodLabel={periodLabel}
        onClose={() => setDetailEmp(null)}
      />
    </div>
  );
}

// ─── TOP PERFORMER CARD ────────────────────────────────────────────────────
function TopPerformerCard({
  title, color, items, onClick,
}: {
  title: string;
  color: "emerald" | "blue" | "indigo" | "amber";
  items: Array<{ employee: Employee; value: string; sub: string }>;
  onClick: (emp: Employee) => void;
}) {
  const colorMap = {
    emerald: { border: "border-emerald-200", bg: "bg-emerald-50/60", text: "text-emerald-800", accent: "bg-emerald-500" },
    blue: { border: "border-blue-200", bg: "bg-blue-50/60", text: "text-blue-800", accent: "bg-blue-500" },
    indigo: { border: "border-indigo-200", bg: "bg-indigo-50/60", text: "text-indigo-800", accent: "bg-indigo-500" },
    amber: { border: "border-amber-200", bg: "bg-amber-50/60", text: "text-amber-800", accent: "bg-amber-500" },
  };
  const c = colorMap[color];
  const medals = ["🥇", "🥈", "🥉"];

  return (
    <div className={`rounded-xl border ${c.border} ${c.bg} p-3`}>
      <p className={`text-xs font-bold ${c.text} mb-2`}>{title}</p>
      {items.length === 0 ? (
        <p className="text-[11px] text-text-light italic text-center py-4">Sem dados pra esse período</p>
      ) : (
        <ul className="space-y-2">
          {items.map((it, idx) => (
            <li
              key={it.employee.id}
              className="flex items-center gap-2 cursor-pointer hover:bg-white/50 rounded px-1 -mx-1 py-0.5 transition"
              onClick={() => onClick(it.employee)}
            >
              <span className="text-base shrink-0">{medals[idx] || "🏅"}</span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold truncate">{it.employee.name}</p>
                <p className="text-[10px] text-text-light truncate">{it.sub}</p>
              </div>
              <span className={`text-xs font-bold ${c.text} shrink-0`}>{it.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── EMPLOYEE DETAIL DRAWER ────────────────────────────────────────────────
// Abre quando o usuário clica num colaborador na tabela ou nos top cards.
// Mostra: resumo do colaborador, breakdown Embarque/Costado, histórico
// completo de alocações dentro do período filtrado.
function EmployeeDetailDrawer({
  employee, stat, periodLabel, onClose,
}: {
  employee: Employee | null;
  stat: EmployeeStats | null;
  periodLabel: string;
  onClose: () => void;
}) {
  if (!employee || !stat) return null;

  const totalShips = stat.embarque.ships.size + stat.costado.ships.size;

  return (
    <Modal open={!!employee} onClose={onClose} title={`Detalhamento · ${employee.name}`} maxWidth="max-w-3xl">
      <div className="space-y-4">
        {/* Cabeçalho */}
        <div className="bg-gray-50 border border-border rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <span className="text-lg font-bold text-primary">{employee.name.charAt(0).toUpperCase()}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-text">{employee.name}</p>
              <p className="text-xs text-text-light">
                {employee.role || <span className="italic">sem função</span>}
                {employee.team && ` · ${employee.team}`}
                {employee.sector && ` · ${employee.sector}`}
              </p>
              <p className="text-[10px] text-text-light mt-1">
                Status: <strong>{employee.status || "—"}</strong>
                {employee.phone && <> · Tel: <span className="font-mono">{employee.phone}</span></>}
                {employee.admission_date && <> · Admissão: {new Date(employee.admission_date).toLocaleDateString("pt-BR")}</>}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-[10px] uppercase tracking-wider text-text-light font-semibold">Ganho em {periodLabel}</p>
              <p className="text-xl font-bold text-emerald-700">{brl(stat.totalEarnings)}</p>
              <p className="text-[10px] text-text-light">{totalShips} navio{totalShips === 1 ? "" : "s"}</p>
            </div>
          </div>
        </div>

        {/* Breakdown Embarque vs Costado */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-blue-50/60 border border-blue-200 rounded-xl p-3">
            <p className="text-xs font-bold text-blue-900 mb-2">🚢 Embarque</p>
            <div className="space-y-1 text-xs">
              <p>Navios: <strong>{stat.embarque.ships.size}</strong></p>
              <p>Porões: <strong>{stat.embarque.poroes}</strong></p>
              <p>Alocações: <strong>{stat.embarque.allocations}</strong></p>
              <p className="text-emerald-700 pt-1 border-t border-blue-200 mt-1">
                Ganho: <strong>{brl(stat.embarque.earnings)}</strong>
              </p>
            </div>
            {stat.embarque.ships.size > 0 && (
              <div className="mt-2 pt-2 border-t border-blue-200">
                <p className="text-[10px] uppercase tracking-wider text-blue-800 font-semibold mb-1">Navios feitos</p>
                <div className="flex flex-wrap gap-1">
                  {Array.from(stat.embarque.ships).sort().map((n) => (
                    <span key={n} className="text-[10px] px-1.5 py-0.5 bg-white border border-blue-200 rounded text-blue-900">
                      {n}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="bg-indigo-50/60 border border-indigo-200 rounded-xl p-3">
            <p className="text-xs font-bold text-indigo-900 mb-2">⚓ Costado</p>
            <div className="space-y-1 text-xs">
              <p>Navios: <strong>{stat.costado.ships.size}</strong></p>
              <p>Turnos: <strong>{stat.costado.turnos}</strong> ({stat.costado.turnos * 6}h)</p>
              <p>
                ☀️ Diurnos: <strong>{stat.costado.diurnos}</strong>{" · "}
                🌙 Noturnos: <strong>{stat.costado.noturnos}</strong>
              </p>
              <p>Alocações: <strong>{stat.costado.allocations}</strong></p>
              <p className="text-emerald-700 pt-1 border-t border-indigo-200 mt-1">
                Ganho: <strong>{brl(stat.costado.earnings)}</strong>
              </p>
            </div>
            {stat.costado.ships.size > 0 && (
              <div className="mt-2 pt-2 border-t border-indigo-200">
                <p className="text-[10px] uppercase tracking-wider text-indigo-800 font-semibold mb-1">Navios feitos</p>
                <div className="flex flex-wrap gap-1">
                  {Array.from(stat.costado.ships).sort().map((n) => (
                    <span key={n} className="text-[10px] px-1.5 py-0.5 bg-white border border-indigo-200 rounded text-indigo-900">
                      {n}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Histórico completo */}
        <div>
          <h3 className="text-xs font-bold text-text-light uppercase tracking-wider mb-2">📋 Histórico no período</h3>
          {stat.history.length === 0 ? (
            <p className="text-xs text-text-light italic text-center py-6 bg-gray-50 rounded-lg border border-border">
              Sem registros nesse período.
            </p>
          ) : (
            <div className="border border-border rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-border">
                  <tr>
                    <th className="px-2 py-1.5 text-left text-[10px] font-semibold text-text-light uppercase">Data</th>
                    <th className="px-2 py-1.5 text-left text-[10px] font-semibold text-text-light uppercase">Navio</th>
                    <th className="px-2 py-1.5 text-left text-[10px] font-semibold text-text-light uppercase">Função</th>
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold text-text-light uppercase">Tipo</th>
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold text-text-light uppercase">Detalhe</th>
                    <th className="px-2 py-1.5 text-right text-[10px] font-semibold text-text-light uppercase">Ganho</th>
                  </tr>
                </thead>
                <tbody>
                  {stat.history.map((h, idx) => (
                    <tr key={`${h.jobId}-${idx}`} className="border-b border-border last:border-0">
                      <td className="px-2 py-1.5 text-text-light whitespace-nowrap">
                        {h.date ? new Date(h.date).toLocaleDateString("pt-BR") : "—"}
                      </td>
                      <td className="px-2 py-1.5 font-medium text-text">{h.shipName || h.jobName}</td>
                      <td className="px-2 py-1.5 text-text-light">{h.functionName || "—"}</td>
                      <td className="px-2 py-1.5 text-center">
                        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${
                          h.kind === "EMBARQUE" ? "bg-blue-100 text-blue-800" : "bg-indigo-100 text-indigo-800"
                        }`}>
                          {h.kind === "EMBARQUE" ? "🚢" : "⚓"} {h.kind}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-center text-text-light whitespace-nowrap">
                        {h.kind === "EMBARQUE" ? (
                          h.poroes ? <>{h.poroes} {h.poroes === 1 ? "porão" : "porões"}</> : "—"
                        ) : (
                          <>
                            {h.period && (
                              <span className={`text-[9px] font-semibold ${
                                ["19-01", "01-07"].includes(h.period) ? "text-indigo-700" : "text-amber-700"
                              }`}>
                                {["19-01", "01-07"].includes(h.period) ? "🌙" : "☀️"} {h.period}
                              </span>
                            )}
                            {h.quantity > 1 && <> · {h.quantity}×</>}
                          </>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right font-semibold text-emerald-700 whitespace-nowrap">
                        {brl(h.earnings)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t-2 border-border">
                  <tr>
                    <td colSpan={5} className="px-2 py-2 text-right text-[10px] font-bold text-text-light uppercase">Total</td>
                    <td className="px-2 py-2 text-right text-sm font-bold text-emerald-800">{brl(stat.totalEarnings)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        <div className="flex justify-between items-center pt-2 gap-2">
          <a href={`/colaboradores`} className="text-xs text-primary hover:underline">
            Abrir ficha em RH › Colaboradores →
          </a>
          <Button variant="secondary" onClick={onClose}>Fechar</Button>
        </div>
      </div>
    </Modal>
  );
}

// (Aba "Documentos" foi substituída por "Controle" — ver ControleTab acima.)
