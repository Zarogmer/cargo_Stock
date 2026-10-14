// Fechamento de Navio — a planilha "NN - FECHAMENTO <NAVIO> - <CLIENTE>.xlsx"
// da diretoria (pasta "01 - RELATÓRIO DE DESPESAS DE LIMPEZA DE PORÕES"),
// reproduzida na tela Financeiro › Fechamento de Navio.
//
// Na planilha o executivo só mexe nas fórmulas: a paga de cada um é
// "=250*7" (paga × porões), com "+100*7" quando há serviço extra por porão
// (produto no piso, raspagem…) ou um valor fixo (administrativo "200"). As
// despesas são linhas livres (COMPRAS, QUIMICA, ALMOÇO, VAN…), e os totais
// MÃO DE OBRA / DESPESAS DIVERSAS / TOTAL GERAL são somas. Quando o cliente
// paga em dólar (Wilson Sons) entram as linhas "VALOR COBRADO USD …", a
// "TAXA DO DOLLAR" e o "Total em Real".
//
// Este módulo é puro (sem Prisma/React): define o documento salvo em
// job_closings.data, monta o rascunho inicial a partir da escala/despesas do
// navio e calcula os totais do preview. A tela só edita e exibe.

import { allocCountsAsWorked } from "@/lib/alloc-worked";
import { pickCostadoFunction } from "@/lib/jobUnits";
import type { Job, JobAdjustment, JobAllocation, JobFunction } from "@/types/database";

export type ClosingCurrency = "BRL" | "USD";
export type ClosingWorkerMode = "PORAO" | "FIXO";

export interface ClosingCharge {
  id: string;
  label: string; // "LAVAGEM DOS PORÕES", "2 BARCOS", "PRODUTO NO PISO"
  amount: number;
  currency: ClosingCurrency;
}

export interface ClosingWorker {
  id: string;
  name: string;
  // PORAO: (paga + extra/porão) × porões + extra fixo — a "=250*7+100*7".
  // FIXO:  paga + extra fixo — administrativo ("200") e Costado (turnos já somados).
  mode: ClosingWorkerMode;
  rate: number;
  // Porões só desta pessoa (quem fez 5 dos 7). null = porões do navio.
  holds: number | null;
  extra_per_hold: number;
  fixed_extra: number;
  // Observação curta, só na tela ("3 turnos", "rateio").
  note: string;
}

export interface ClosingExpense {
  id: string;
  label: string;
  amount: number;
}

export interface ClosingDoc {
  version: 1;
  // Cabeçalho — "42 - M/V EUROPA GRAECA - 7 PORÕES - CARVÃO - SANTOS - 03/09/26 À 06/09/26"
  number: string;
  ship_name: string;
  holds_count: number;
  cargo_type: string;
  port: string;
  // "LIMPEZA DE COSTADO" no fechamento de Costado; vazio no Embarque.
  service_label: string;
  start_date: string; // "YYYY-MM-DD" ou ""
  end_date: string;
  // Título digitado à mão; null = montado dos campos acima.
  title_override: string | null;
  client: string;
  supervisor: string;
  charges: ClosingCharge[];
  // Taxa do dólar negociada (só pesa quando há linha em USD).
  exchange_rate: number | null;
  workers: ClosingWorker[];
  expenses: ClosingExpense[];
  notes: string;
}

export interface ClosingTotals {
  title: string;
  workerValues: number[]; // mesma ordem de doc.workers
  maoDeObra: number;
  usdTotal: number;
  brlCharges: number;
  // Receita em R$: linhas em R$ + linhas em USD × taxa.
  totalBRL: number;
  hasUSD: boolean;
  despesas: number;
  totalGeral: number;
  resultado: number; // totalBRL − totalGeral
}

// Tipo do serviço, igual à aba Navios: Costado quando o título leva "LIMPEZA
// DE COSTADO" no lugar de porões/carga; senão Embarque (lavagem dos porões).
export type ClosingServiceKind = "EMBARQUE" | "COSTADO";
export const COSTADO_SERVICE_LABEL = "LIMPEZA DE COSTADO";
export function closingServiceKind(doc: Pick<ClosingDoc, "service_label">): ClosingServiceKind {
  return doc.service_label.trim() ? "COSTADO" : "EMBARQUE";
}

export const COMPANY_FOOTER = [
  "CARGO SHIPS CLEANING LTDA.",
  "Praça Iguatemi Martins, 08, VILA NOVA, SANTOS /SP, CEP: 11013-310",
  "CARGOSHIPS@CARGOSHIPS.COM.BR",
];

let seq = 0;
export function newId(prefix = "r"): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export function workerValue(w: ClosingWorker, globalHolds: number): number {
  const rate = Number(w.rate) || 0;
  const fixed = Number(w.fixed_extra) || 0;
  if (w.mode === "FIXO") return round2(rate + fixed);
  const holds = w.holds != null && w.holds > 0 ? w.holds : Math.max(0, Number(globalHolds) || 0);
  const perHold = Number(w.extra_per_hold) || 0;
  return round2((rate + perHold) * holds + fixed);
}

// "03/09/26" — datas chegam como "2026-09-03" ou ISO com hora; só os 10
// primeiros caracteres contam (sem shift de fuso).
export function shortDateBR(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = iso.slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  return `${m[3]}/${m[2]}/${m[1].slice(2)}`;
}

export function buildClosingTitle(doc: ClosingDoc): string {
  if (doc.title_override != null && doc.title_override.trim() !== "") return doc.title_override;
  const parts: string[] = [];
  if (doc.number.trim()) parts.push(doc.number.trim());
  const name = doc.ship_name.trim().toUpperCase();
  parts.push(name.startsWith("M/V ") ? name : `M/V ${name}`);
  if (doc.holds_count > 0 && !doc.service_label.trim()) parts.push(`${doc.holds_count} PORÕES`);
  if (doc.cargo_type.trim() && !doc.service_label.trim()) parts.push(doc.cargo_type.trim().toUpperCase());
  if (doc.service_label.trim()) parts.push(doc.service_label.trim().toUpperCase());
  if (doc.port.trim()) parts.push(doc.port.trim().toUpperCase());
  const d1 = shortDateBR(doc.start_date);
  const d2 = shortDateBR(doc.end_date);
  if (d1 && d2 && d1 !== d2) parts.push(`${d1} À ${d2}`);
  else if (d1 || d2) parts.push(d1 || d2);
  return parts.join(" - ");
}

export function computeClosing(doc: ClosingDoc): ClosingTotals {
  const workerValues = doc.workers.map((w) => workerValue(w, doc.holds_count));
  const maoDeObra = round2(workerValues.reduce((s, v) => s + v, 0));
  const usdTotal = round2(doc.charges.filter((c) => c.currency === "USD").reduce((s, c) => s + (Number(c.amount) || 0), 0));
  const brlCharges = round2(doc.charges.filter((c) => c.currency !== "USD").reduce((s, c) => s + (Number(c.amount) || 0), 0));
  const rate = Number(doc.exchange_rate) || 0;
  const totalBRL = round2(brlCharges + usdTotal * rate);
  const despesas = round2(doc.expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0));
  const totalGeral = round2(maoDeObra + despesas);
  return {
    title: buildClosingTitle(doc),
    workerValues,
    maoDeObra,
    usdTotal,
    brlCharges,
    totalBRL,
    hasUSD: doc.charges.some((c) => c.currency === "USD"),
    despesas,
    totalGeral,
    resultado: round2(totalBRL - totalGeral),
  };
}

// Categorias de despesa do Resultado do Navio (job_adjustments.category) na
// ordem em que aparecem na planilha. "Outros" (ou sem categoria) sai linha a
// linha com a própria descrição — é como a diretoria escreve "ALMOCO
// ITAPARICA", "VAN - CAMINHÃO SR. ANDRE".
const EXPENSE_CATEGORY_ORDER: Array<[string, string]> = [
  ["COMPRAS", "COMPRAS"],
  ["QUIMICA", "QUIMICA"],
  ["MATERIAL_DANIFICADO", "MATERIAL DANIFICADO"],
  ["MATERIAL_PERDIDO", "MATERIAL PERDIDO"],
  ["AJUDA_DE_CUSTO", "AJUDA DE CUSTO"],
  ["ALIMENTACAO", "ALIMENTAÇÃO"],
  ["RESTAURANTE", "JANTAR/RESTAURANTE"],
  ["REPASSE", "NOTA DE CRÉDITO"],
];

export interface ClosingDraftInput {
  job: Job;
  // Nº do navio no ano (ship-number.ts) já formatado: "42". "" = sem número.
  number: string;
  // Alocações do job, já passadas por prepareFinanceAllocations (valor do
  // cadastro + serviço extra por porão).
  allocations: JobAllocation[];
  adjustments: JobAdjustment[];
  functions: JobFunction[];
  // Supervisor da escala (função SUPERVISOR) — cai no job.supervisor.
  supervisorName: string | null;
  // Serviços do navio (ships.services) pra saber se é Costado.
  services: string[] | null | undefined;
  // Última Nota de Débito do navio, se houver: define moeda/valor cobrado e taxa.
  debitNote?: { currency: string | null; subtotal: number; exchange_rate: number | null } | null;
}

export function buildClosingDraft(input: ClosingDraftInput): ClosingDoc {
  const { job, allocations, adjustments, functions } = input;
  const services = input.services || [];
  const isCostadoOnly = services.includes("COSTADO") && !services.some((s) => s !== "COSTADO");
  const worked = allocations.filter((a) => a.job_id === job.id && allocCountsAsWorked(a));

  const workers: ClosingWorker[] = [];
  // Embarque: paga × porões (+ rateio fixo). O serviço extra por porão
  // (raspagem/pintura) já entra somado na paga — na tela só existe a coluna
  // Paga, igual ao "=350*7" que a diretoria escreve na planilha.
  for (const a of worked) {
    if ((a.kind || "EMBARQUE") !== "EMBARQUE") continue;
    const extra = round2(Number(a.extra_value || 0));
    workers.push({
      id: newId("w"),
      name: (a.employees?.name || a.job_functions?.name || "").trim(),
      mode: "PORAO",
      rate: round2((Number(a.rate) || 0) + (Number(a.service_extra_rate) || 0)),
      holds: null,
      extra_per_hold: 0,
      fixed_extra: extra,
      note: extra !== 0 ? `rateio ${extra > 0 ? "+" : ""}${formatNumberBR(extra)}` : "",
    });
  }
  // Costado: valor por turno × turnos, agrupado por pessoa — entra como fixo.
  const costadoFn = pickCostadoFunction(functions);
  const costadoRate = costadoFn ? Number(costadoFn.default_rate || 0) : 0;
  const costadoByPerson = new Map<string, { name: string; turnos: number; extra: number }>();
  for (const a of worked) {
    if (a.kind !== "COSTADO") continue;
    const key = a.employee_id ? `e${a.employee_id}` : `a${a.id}`;
    const row = costadoByPerson.get(key) || {
      name: (a.employees?.name || a.job_functions?.name || "").trim(),
      turnos: 0,
      extra: 0,
    };
    row.turnos += Math.max(1, Number(a.quantity) || 1);
    row.extra += Number(a.extra_value || 0);
    costadoByPerson.set(key, row);
  }
  for (const row of costadoByPerson.values()) {
    workers.push({
      id: newId("w"),
      name: row.name,
      mode: "FIXO",
      rate: round2(costadoRate * row.turnos),
      holds: null,
      extra_per_hold: 0,
      fixed_extra: round2(row.extra),
      note: `${row.turnos} turno${row.turnos === 1 ? "" : "s"} × ${costadoRate}`,
    });
  }
  // Administrativo: valor fixo por navio (employees.admin_ship_rate gravado na alocação).
  for (const a of worked) {
    if (a.kind !== "ADMINISTRATIVO") continue;
    workers.push({
      id: newId("w"),
      name: (a.employees?.name || "Administrativo").trim(),
      mode: "FIXO",
      rate: round2(Number(a.rate) || 0),
      holds: null,
      extra_per_hold: 0,
      fixed_extra: round2(Number(a.extra_value || 0)),
      note: "administrativo",
    });
  }

  // Despesas: categorias conhecidas somadas numa linha; o resto linha a linha.
  const byCat = new Map<string, number>();
  const loose: ClosingExpense[] = [];
  for (const adj of adjustments) {
    if (adj.job_id !== job.id) continue;
    const signed = adj.type === "ADICIONAL" ? Number(adj.amount) : -Number(adj.amount);
    const cat = (adj.category || "").toUpperCase();
    if (cat && cat !== "OUTROS" && EXPENSE_CATEGORY_ORDER.some(([k]) => k === cat)) {
      byCat.set(cat, round2((byCat.get(cat) || 0) + signed));
    } else {
      loose.push({ id: newId("x"), label: (adj.description || "OUTROS").trim().toUpperCase(), amount: round2(signed) });
    }
  }
  const expenses: ClosingExpense[] = [];
  for (const [key, label] of EXPENSE_CATEGORY_ORDER) {
    const v = byCat.get(key);
    if (v != null && v !== 0) expenses.push({ id: newId("x"), label, amount: v });
  }
  expenses.push(...loose);

  // Valor cobrado: a Nota de Débito emitida manda (moeda + valor); sem nota,
  // o valor do contrato do job em R$.
  const charges: ClosingCharge[] = [];
  const serviceName = isCostadoOnly ? "LIMPEZA DE COSTADO" : "LAVAGEM DOS PORÕES";
  const note = input.debitNote;
  if (note && note.subtotal > 0) {
    charges.push({ id: newId("c"), label: serviceName, amount: round2(note.subtotal), currency: note.currency === "USD" ? "USD" : "BRL" });
  } else {
    charges.push({ id: newId("c"), label: serviceName, amount: round2(Number(job.contract_value || 0)), currency: "BRL" });
  }

  const holds = Number(job.holds_count || job.ships?.holds_count || 0) || 0;
  return {
    version: 1,
    number: input.number || "",
    ship_name: (job.name || job.ships?.name || "").trim(),
    holds_count: holds,
    cargo_type: (job.cargo_type || "").trim(),
    port: (job.port || job.ships?.port || "").trim(),
    service_label: isCostadoOnly ? COSTADO_SERVICE_LABEL : "",
    start_date: (job.start_date || "").slice(0, 10),
    end_date: (job.end_date || "").slice(0, 10),
    title_override: null,
    client: (job.client || job.ships?.client_name || "").trim(),
    supervisor: (input.supervisorName || job.supervisor || "").trim(),
    charges,
    exchange_rate: note?.exchange_rate != null && Number(note.exchange_rate) > 0 ? Number(note.exchange_rate) : null,
    workers,
    expenses,
    notes: "",
  };
}

// Documento vindo do banco pode ser de uma versão antiga ou ter sido editado
// à mão: preenche o que faltar pra tela nunca quebrar.
export function normalizeClosingDoc(raw: unknown): ClosingDoc | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Partial<ClosingDoc>;
  const num = (v: unknown, def = 0) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    version: 1,
    number: str(d.number),
    ship_name: str(d.ship_name),
    holds_count: num(d.holds_count),
    cargo_type: str(d.cargo_type),
    port: str(d.port),
    service_label: str(d.service_label),
    start_date: str(d.start_date),
    end_date: str(d.end_date),
    title_override: typeof d.title_override === "string" ? d.title_override : null,
    client: str(d.client),
    supervisor: str(d.supervisor),
    charges: Array.isArray(d.charges)
      ? d.charges.map((c) => ({
          id: str(c?.id) || newId("c"),
          label: str(c?.label),
          amount: num(c?.amount),
          currency: c?.currency === "USD" ? "USD" : "BRL",
        }))
      : [],
    exchange_rate: d.exchange_rate == null ? null : num(d.exchange_rate, 0) || null,
    workers: Array.isArray(d.workers)
      ? d.workers.map((w) => ({
          id: str(w?.id) || newId("w"),
          name: str(w?.name),
          mode: w?.mode === "FIXO" ? "FIXO" : "PORAO",
          rate: num(w?.rate),
          holds: w?.holds == null || !Number.isFinite(Number(w.holds)) || Number(w.holds) <= 0 ? null : Number(w.holds),
          extra_per_hold: num(w?.extra_per_hold),
          fixed_extra: num(w?.fixed_extra),
          note: str(w?.note),
        }))
      : [],
    expenses: Array.isArray(d.expenses)
      ? d.expenses.map((e) => ({ id: str(e?.id) || newId("x"), label: str(e?.label), amount: num(e?.amount) }))
      : [],
    notes: str(d.notes),
  };
}

export function formatBRL(n: number): string {
  return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatUSD(n: number): string {
  return `USD ${(Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatNumberBR(n: number, decimals = 2): string {
  return (Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// "1.234,56" → 1234.56 ; "1234.56" → 1234.56 ; "250" → 250 ; lixo → 0
export function parseNumberBR(s: string): number {
  const t = (s || "").trim().replace(/\s/g, "").replace(/R\$|USD|\$/gi, "");
  if (!t) return 0;
  let cleaned = t;
  if (t.includes(",")) cleaned = t.replace(/\./g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}
