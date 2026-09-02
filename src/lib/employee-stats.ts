// Agregação financeira por colaborador — o motor do Controle de Funcionários,
// extraído pra ser fonte única (a aba Controle e o Painel Financeiro usam o
// MESMO cálculo). Responde: "quem trabalhou, em que navios, quantos
// porões/turnos, quanto recebeu (Ganho/Folha/Desc. Geral/Adiant./Líquido)?".
// Espera alocações já enriquecidas por prepareFinanceAllocations (@/lib/job-cost).
// Puro/sem Prisma — roda no cliente.

import { allocCountsAsWorked } from "@/lib/alloc-worked";
import { pickCostadoFunction } from "@/lib/jobUnits";
import { type Advance, type AdvanceDiscount, employeeBalance, jobDiscountFor } from "@/lib/vales";
import type { Job, JobAllocation, JobAdjustment, JobFunction, Employee } from "@/types/database";

export interface EmployeeStats {
  employee: Employee;
  embarque: {
    ships: Set<string>;
    poroes: number;       // soma de porões (= holds_count por job, contado uma vez por funcionário/job)
    earnings: number;     // ganho total Embarque (rate × holds + extra)
    folha: number;        // parte do ganho que sai na folha (ganho − Pluxee)
    pluxee: number;       // parte paga no cartão Pluxee
    allocations: number;  // nº de alocações registradas
  };
  costado: {
    ships: Set<string>;
    turnos: number;       // soma de quantity
    diurnos: number;
    noturnos: number;
    earnings: number;
    folha: number;
    pluxee: number;
    allocations: number;
  };
  totalEarnings: number;
  // ── Espelho das colunas da Folha de Pagamento (modal do navio) ───────────
  // Ganho = MV1 (o que a operação gerou). Folha = PAGTO NA FOLHA (Ganho −
  // Pluxee). Desc. Geral e Adiant. são abatimentos: o que a pessoa recebe de
  // fato é o Líquido.
  folha: number;
  pluxee: number;
  descGeral: number;   // rateio de material perdido + desconto manual, nos navios do período
  adiant: number;      // vales descontados nesses navios
  liquido: number;     // Ganho − Desc. Geral − Adiant.
  valeBalance: number; // saldo devedor de vales do colaborador (independe do período)
  jobIds: Set<string>; // navios (jobs) considerados no período/filtros
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

export interface EmployeeStatsFilters {
  /** Ano de referência (obrigatório — a agregação é sempre por ano). */
  year: number;
  /** Mês 0..11; "TODOS" = ano inteiro. */
  month: number | "TODOS";
  activity?: "TODAS" | "EMBARQUE" | "COSTADO";
  status?: "ATIVOS" | "TODOS";
  employeeId?: number | "TODOS";
  shipId?: string | "TODOS";
  /** Cargo do cadastro, em MAIÚSCULAS; "TODAS" = sem filtro. */
  role?: string;
}

// Períodos noturnos do Costado (mesma lista da Escalação).
const NIGHT_PERIODS = ["19-01", "01-07"];

export function computeEmployeeStats(
  data: {
    employees: Employee[];
    allocations: JobAllocation[];
    adjustments: JobAdjustment[];
    advances: Advance[];
    advDiscounts: AdvanceDiscount[];
    jobs: Job[];
    ships: Array<{ id: string; name: string }>;
    functions: JobFunction[];
  },
  filters: EmployeeStatsFilters,
): EmployeeStats[] {
  const { employees, allocations, adjustments, advances, advDiscounts, jobs, ships, functions } = data;
  const activity = filters.activity ?? "TODAS";
  const statusFilter = filters.status ?? "ATIVOS";
  const employeeFilter = filters.employeeId ?? "TODOS";
  const shipFilter = filters.shipId ?? "TODOS";
  const roleFilter = filters.role ?? "TODAS";

  const jobById = new Map(jobs.map((j) => [j.id, j]));

  // "Mês de referência" de uma alocação: Costado tem shift_date (data exata do
  // turno); Embarque usa a start_date do job.
  function passesPeriodFilter(a: JobAllocation): boolean {
    const dateStr = a.shift_date || jobById.get(a.job_id)?.start_date || null;
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return false;
    if (d.getFullYear() !== filters.year) return false;
    if (filters.month !== "TODOS" && d.getMonth() !== filters.month) return false;
    return true;
  }

  const map = new Map<number, EmployeeStats>();
  // Inicializa com TODOS os colaboradores filtrados — assim quem não trabalhou
  // ainda aparece no relatório (zerado) quando o usuário pede "Todos".
  for (const e of employees) {
    const isActive = (e.status ?? "ATIVO") === "ATIVO";
    if (statusFilter === "ATIVOS" && !isActive) continue;
    if (employeeFilter !== "TODOS" && e.id !== employeeFilter) continue;
    if (roleFilter !== "TODAS" && (e.role || "").trim().toUpperCase() !== roleFilter) continue;
    map.set(e.id, {
      employee: e,
      embarque: { ships: new Set(), poroes: 0, earnings: 0, folha: 0, pluxee: 0, allocations: 0 },
      costado: { ships: new Set(), turnos: 0, diurnos: 0, noturnos: 0, earnings: 0, folha: 0, pluxee: 0, allocations: 0 },
      totalEarnings: 0,
      folha: 0, pluxee: 0, descGeral: 0, adiant: 0, liquido: 0,
      valeBalance: employeeBalance(e.id, advances, advDiscounts),
      jobIds: new Set(),
      lastActivity: null,
      history: [],
    });
  }

  // ── Desc. Geral por navio: material PERDIDO rateado pela equipe ─────────
  // Mesma conta do modal de Pagamento (perda do job ÷ nº de cabeças da
  // equipe), pra que o valor aqui bata com o da Folha de Pagamento.
  const perdaPorJob = new Map<string, number>();
  for (const adj of adjustments) {
    const isPerda =
      adj.category === "MATERIAL_PERDIDO" ||
      (adj.category === "MATERIAL_DANIFICADO" && adj.description.startsWith("Retorno de material"));
    if (!isPerda) continue;
    perdaPorJob.set(adj.job_id, (perdaPorJob.get(adj.job_id) || 0) + Number(adj.amount || 0));
  }
  // Cabeças por job: cada colaborador conta uma vez (no Costado ele aparece
  // uma vez por turno). Conta sobre TODAS as alocações do job, não só as
  // filtradas — o rateio é o do navio inteiro.
  const headcountPorJob = new Map<string, Set<number>>();
  for (const a of allocations) {
    if (a.employee_id == null) continue;
    const set = headcountPorJob.get(a.job_id) || new Set<number>();
    set.add(a.employee_id);
    headcountPorJob.set(a.job_id, set);
  }
  const descGeralPorJob = new Map<string, number>();
  // Desconto manual (Desc. Geral clicável) somado por colaborador no período.
  const manualDescByEmp = new Map<number, number>();
  for (const [jobId, perda] of perdaPorJob) {
    const heads = headcountPorJob.get(jobId)?.size || 0;
    if (perda > 0 && heads > 0) descGeralPorJob.set(jobId, +(perda / heads).toFixed(2));
  }

  // Pra contar "porões por funcionário por navio" sem duplicar quando alguém
  // tem várias alocações no mesmo job de embarque (cenário raro mas possível).
  const embarqueJobSeen = new Map<number, Set<string>>(); // empId -> Set<jobId>

  // Costado: rate canônico vem da função COSTADO em Valores (não do stored
  // rate da alocação, que pode ser legado errado).
  const ctrlCostadoFn = pickCostadoFunction(functions);
  const ctrlCostadoRate = ctrlCostadoFn ? Number(ctrlCostadoFn.default_rate) : 0;

  // Toda escalação trabalhada conta — não filtramos por pagamento/status do
  // job: o painel mostra quem trabalhou com base na escalação, pago ou não.
  // Inclui alocações liberadas pela finalização do navio (allocCountsAsWorked).
  for (const a of allocations) {
    if (!allocCountsAsWorked(a)) continue;
    if (!passesPeriodFilter(a)) continue;
    if (!a.employee_id) continue;
    const s = map.get(a.employee_id);
    if (!s) continue;
    const job = jobById.get(a.job_id);
    if (shipFilter !== "TODOS" && job?.ship_id !== shipFilter) continue;
    const ship = job?.ship_id ? ships.find((sh) => sh.id === job.ship_id) : null;
    const shipName = ship?.name || job?.name || null;
    const fn = functions.find((f) => f.id === a.function_id);
    // Administrativo é custo fixo por operação, não produtividade (porões/turnos).
    // Fica fora deste painel pra não inflar a contagem de porões.
    if ((a.kind || "EMBARQUE") === "ADMINISTRATIVO") continue;
    const kind: "EMBARQUE" | "COSTADO" = a.kind === "COSTADO" ? "COSTADO" : "EMBARQUE";
    if (activity !== "TODAS" && activity !== kind) continue;

    const rate = kind === "COSTADO" ? ctrlCostadoRate : Number(a.rate);
    const extra = Number(a.extra_value || 0);
    // Pluxee: parte do ganho paga no cartão (vem do import da Relação de
    // Líquidos). O que sobra é o que sai na folha — mesma conta do modal.
    // pluxee_value null = folha ainda não definida → a alocação conta 0 na
    // folha (o Pagamento de Navios começa com Folha 0 desde 2026-09-02).
    const pluxee = Number(a.pluxee_value || 0);
    const folhaSet = a.pluxee_value != null;
    s.jobIds.add(a.job_id);
    if (a.employee_id != null) {
      const md = Number(a.general_discount || 0);
      if (md) manualDescByEmp.set(a.employee_id, (manualDescByEmp.get(a.employee_id) || 0) + md);
    }

    if (kind === "EMBARQUE") {
      const holds = Math.max(1, Number(job?.holds_count || 1));
      // Serviço extra do navio (Raspagem/Pintura) por porão, somado à limpeza —
      // mesmo Ganho/porão que a Folha de Pagamento mostra.
      const embRate = rate + Number(a.service_extra_rate || 0);
      const earnings = embRate * holds + extra;
      s.embarque.pluxee += pluxee;
      s.embarque.folha += folhaSet ? Math.max(0, earnings - pluxee) : 0;
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
        // Porões REAIS do job em toda linha — com 2 funções no mesmo navio, a
        // 2ª linha mostrava "—" e parecia bug. A soma deduplicada continua
        // protegida pelo firstTime acima.
        kind, date: job?.start_date || null, poroes: holds,
        quantity: 1, rate: embRate, earnings,
        functionName: fn?.name || null,
      });
    } else {
      // Costado: cada linha é 1 turno escalado (quantity=0 é legado, vira 1).
      const qty = Math.max(1, a.quantity);
      const earnings = rate * qty + extra;
      s.costado.pluxee += pluxee;
      s.costado.folha += folhaSet ? Math.max(0, earnings - pluxee) : 0;
      s.costado.turnos += qty;
      if (a.shift_period && NIGHT_PERIODS.includes(a.shift_period)) {
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
    s.folha = s.embarque.folha + s.costado.folha;
    s.pluxee = s.embarque.pluxee + s.costado.pluxee;
    // Abatimentos são por NAVIO, não por alocação: cada um entra uma vez por
    // job em que a pessoa trabalhou no período filtrado.
    let descGeral = 0, adiant = 0;
    for (const jobId of s.jobIds) {
      descGeral += descGeralPorJob.get(jobId) || 0;
      adiant += jobDiscountFor(jobId, s.employee.id, advDiscounts);
    }
    descGeral += manualDescByEmp.get(s.employee.id) || 0;
    s.descGeral = +descGeral.toFixed(2);
    s.adiant = +adiant.toFixed(2);
    s.liquido = +(s.totalEarnings - s.descGeral - s.adiant).toFixed(2);
    // Ordena history mais recente primeiro
    s.history.sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  }

  return Array.from(map.values());
}
