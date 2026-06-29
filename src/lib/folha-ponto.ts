// Lógica pura (sem dependência de servidor) da Folha de Ponto, compartilhada
// entre a API que gera o arquivo (Excel/PDF) e a tela que mostra a prévia de
// dias trabalhados. Os dias vêm dos navios cadastrados (job_allocations):
//   - COSTADO: cada turno tem shift_date + shift_period exatos. Jornada de 6h
//     corridas, no horário do turno escalado (07-13, 13-19, 19-01, 01-07).
//   - EMBARQUE: o sistema guarda a operação do navio (chegada → saída); a folha
//     marca TODA a janela arrival_date..departure_date (inclui fim de semana).
//     Sem data de saída, marca só o dia de chegada. Jornada de 7h20.
// No Embarque o horário do dia é "aleatório" mas determinístico (semente =
// colaborador+data), então gerar de novo a mesma competência dá a mesma folha;
// no Costado o horário é fixo pelo turno.

// Carga horária diária padrão (Embarque): 7h20 (igual à planilha oficial).
export const CARGA_DIARIA_MIN = 7 * 60 + 20; // 440
// Jornada do turno de Costado: 6h corridas (sem intervalo de almoço).
export const COSTADO_DIARIA_MIN = 6 * 60; // 360
// Jornada administrativa: 09:00–18:00 com 1h de almoço = 8h. Independe de navio:
// quem é do setor Administrativo bate ponto fixo de segunda a sexta (sem
// fim de semana e sem feriado nacional), nunca a janela do navio escalado.
export const ADMIN_DIARIA_MIN = 8 * 60; // 480
// 1ª faixa de hora extra vai até 4h; o que passar cai na 2ª faixa (PREMISSAS).
export const FAIXA1_LIMITE_MIN = 4 * 60; // 240
// Tolerância de atraso/extra (PREMISSAS!C13 = 0:00 → sem tolerância).
export const TOLERANCIA_MIN = 0;

// Horário de cada turno de Costado (relógio, minutos desde 00:00). Os turnos da
// noite cruzam a meia-noite (fim "no dia seguinte") — segMin() trata o cálculo.
const COSTADO_SHIFTS: Record<string, { start: number; end: number }> = {
  "07-13": { start: 7 * 60, end: 13 * 60 },
  "13-19": { start: 13 * 60, end: 19 * 60 },
  "19-01": { start: 19 * 60, end: 1 * 60 },
  "01-07": { start: 1 * 60, end: 7 * 60 },
};
// Turno assumido quando a alocação de Costado não tem shift_period gravado.
const COSTADO_SHIFT_FALLBACK = "07-13";

function costadoShift(period: string | null): { start: number; end: number } {
  return COSTADO_SHIFTS[period ?? ""] ?? COSTADO_SHIFTS[COSTADO_SHIFT_FALLBACK];
}

export const DIAS_SEMANA_PT = [
  "Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado",
] as const;

export const MESES_PT = [
  "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
  "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
] as const;

// Feriados nacionais de data fixa (MM-DD). Pintam a linha (igual a domingo) e, na
// folha administrativa, contam como dia não trabalhado. Carnaval e Corpus Christi
// NÃO são feriados nacionais oficiais (são facultativos/municipais) → não entram.
const FERIADOS_FIXOS = new Set([
  "01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25",
]);

// ── Datas (YYYY-MM-DD em UTC, sem escorregar fuso) ─────────────────────────────

function isoToSerial(iso: string): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function serialToIso(serial: number): string {
  const dt = new Date(serial * 86400000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function weekdayOf(iso: string): number {
  // 0 = Domingo .. 6 = Sábado
  return new Date(isoToSerial(iso) * 86400000).getUTCDay();
}

// Domingo de Páscoa (algoritmo de Computus / Meeus–Jones–Butcher). Base do único
// feriado nacional MÓVEL relevante aqui: a Sexta-feira Santa (Páscoa − 2 dias).
function easterSundayIso(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = março, 4 = abril
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Sexta-feira Santa = Páscoa − 2 dias. Único feriado nacional móvel marcado.
function goodFridayIso(year: number): string {
  return serialToIso(isoToSerial(easterSundayIso(year)) - 2);
}

export function isHoliday(iso: string): boolean {
  if (FERIADOS_FIXOS.has(iso.slice(5, 10))) return true;
  return iso === goodFridayIso(Number(iso.slice(0, 4)));
}

export function isHighlightedDay(iso: string): boolean {
  // Linha realçada (azul) na folha: domingos e feriados fixos.
  return weekdayOf(iso) === 0 || isHoliday(iso);
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

// ── Folha administrativa (setor Administrativo) ────────────────────────────────
// Quem é do Administrativo tem jornada fixa de escritório, não a janela do navio.

export function isAdminSector(sector?: string | null): boolean {
  return (sector || "").trim().toUpperCase() === "ADMINISTRATIVO";
}

// Dia útil administrativo: segunda a sexta que não seja feriado nacional. Sábado,
// domingo e feriado ficam de fora (não trabalhados).
export function isAdminWorkday(iso: string): boolean {
  const wd = weekdayOf(iso);
  return wd >= 1 && wd <= 5 && !isHoliday(iso);
}

// Quantos dias úteis administrativos há no mês — alimenta o contador da tela.
export function countAdminWorkdays(year: number, month1to12: number): number {
  const n = daysInMonth(year, month1to12);
  let count = 0;
  for (let d = 1; d <= n; d++) {
    const iso = `${year}-${String(month1to12).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (isAdminWorkday(iso)) count++;
  }
  return count;
}

// ── Quais dias o colaborador trabalhou ─────────────────────────────────────────

export type AllocKind = "COSTADO" | "EMBARQUE";

export interface AllocInput {
  // Tipo da escalação (legado). O tipo de jornada da folha é decidido pelo
  // navio (ship_services), não por este campo.
  kind: AllocKind;
  // COSTADO: data exata do turno (YYYY-MM-DD).
  shift_date: string | null;
  // COSTADO: turno de 6h ("07-13", "13-19", "19-01", "01-07").
  shift_period?: string | null;
  // Serviços do navio (aba Navios): inclui "COSTADO" → dia de Costado (6h, turno);
  // senão → Embarque (7h20). Esta é a FONTE do tipo de jornada de cada dia.
  ship_services?: string[] | null;
  // EMBARQUE: janela da operação do navio.
  ship_arrival: string | null;
  ship_departure: string | null;
  // Fallback de início quando o navio não tem arrival_date.
  job_start: string | null;
}

// Um dia trabalhado, já resolvido para um tipo de jornada. O Costado carrega os
// turnos escalados do dia (a pessoa pode fazer mais de um turno de 6h no mesmo
// dia); o Embarque é a jornada de 7h20 (sem turnos).
export type WorkedKind = "EMBARQUE" | "COSTADO";
export interface WorkedDay {
  kind: WorkedKind;
  periods: string[]; // turnos de Costado no dia (vazio no Embarque; 1+ no Costado)
}
export type WorkedMap = Map<string, WorkedDay>;

// Filtro de jornada da folha (o que o RH escolhe na tela). "AMBAS" não filtra:
// mostra Embarque e Costado juntos na mesma folha (é o que vai pra contabilidade).
export type JornadaFilter = WorkedKind | "AMBAS";

// Mapa dia (YYYY-MM-DD) → tipo de jornada, a partir das alocações do mês.
// Costado (turno específico) tem prioridade sobre Embarque (janela ampla); entre
// dois turnos de Costado no mesmo dia, fica o que começa mais cedo (determinístico).
export function expandWorkedDates(
  allocs: AllocInput[],
  year: number,
  month1to12: number,
): WorkedMap {
  const mm = String(month1to12).padStart(2, "0");
  const monthStart = `${year}-${mm}-01`;
  const monthEnd = `${year}-${mm}-${String(daysInMonth(year, month1to12)).padStart(2, "0")}`;
  const out: WorkedMap = new Map();

  // Costado (turno específico) tem prioridade sobre Embarque (janela ampla); e
  // acumula vários turnos no mesmo dia (a pessoa pode fazer 2+ turnos de 6h).
  const addCostado = (iso: string, period: string | null) => {
    const prev = out.get(iso);
    if (!prev || prev.kind === "EMBARQUE") {
      out.set(iso, { kind: "COSTADO", periods: period ? [period] : [] });
    } else if (period && !prev.periods.includes(period)) {
      prev.periods.push(period);
    }
  };
  const addEmbarque = (iso: string) => {
    if (!out.has(iso)) out.set(iso, { kind: "EMBARQUE", periods: [] });
  };

  for (const a of allocs) {
    // O navio decide o tipo: services com "COSTADO" → turno de 6h (shift_date);
    // qualquer outro navio → Embarque (janela do navio).
    if ((a.ship_services || []).includes("COSTADO")) {
      const d = (a.shift_date || "").slice(0, 10);
      if (d && d >= monthStart && d <= monthEnd) addCostado(d, a.shift_period ?? null);
      continue;
    }
    // EMBARQUE: toda a janela do navio (chegada → saída), recortada ao mês.
    const start = (a.ship_arrival || a.job_start || "").slice(0, 10);
    if (!start) continue;
    const end = (a.ship_departure || start).slice(0, 10);
    // YYYY-MM-DD compara lexicograficamente = cronologicamente.
    const from = start > monthStart ? start : monthStart;
    const to = end < monthEnd ? end : monthEnd;
    if (from > to) continue;
    for (let s = isoToSerial(from); s <= isoToSerial(to); s++) {
      addEmbarque(serialToIso(s));
    }
  }
  return out;
}

// ── Horário "aleatório" determinístico ─────────────────────────────────────────

function hashStr(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DayTimes {
  entrada1: number; // minutos desde 00:00 (relógio)
  saida1: number;
  entrada2: number | null; // Costado é corrido: sem 2º período
  saida2: number | null;
}

// Horário do dia conforme o tipo de jornada (sempre com minutos "quebrados",
// variação determinística por colaborador+dia):
//   - COSTADO: jornada de 6h corrida = um único período (entra perto do início,
//     sai no fim do turno ou pouco depois — nunca antes). Se a pessoa fez 2+
//     turnos no dia, a folha mostra SÓ O PRIMEIRO (o que começa mais cedo),
//     porque vai pra contabilidade como 6h. % 1440 mantém o relógio 00:00–23:59
//     mesmo no turno que cruza a meia-noite.
//   - EMBARQUE: padrão da planilha oficial — entra ~09:00, almoço de 1h começando
//     ~12:15–12:45, saída fixa 17:20. Como o almoço é exatamente 1h e a saída é
//     fixa, a H. Diária depende só da entrada (≈ 16:20 − entrada): entrar antes
//     das 9h vira hora extra, depois vira atraso — igual ao exemplo do CARLISSON.
export function timesForDay(seedKey: string, day: WorkedDay): DayTimes {
  const rnd = mulberry32(hashStr(seedKey));
  const randInt = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  if (day.kind === "COSTADO") {
    // Só o primeiro turno do dia (o que começa mais cedo): a folha vai pra
    // contabilidade como 6h, então 2+ turnos não viram 2 períodos.
    const shift = (day.periods.length ? day.periods : [COSTADO_SHIFT_FALLBACK])
      .map(costadoShift)
      .sort((a, b) => a.start - b.start)[0];
    const entrada1 = (shift.start + randInt(-6, 6) + 1440) % 1440;
    const saida1 = (shift.end + randInt(1, 8) + 1440) % 1440; // fim do turno ou pouco depois
    return { entrada1, saida1, entrada2: null, saida2: null };
  }
  const entrada1 = 9 * 60 + randInt(-6, 6); // 08:54..09:06
  const saida1 = 12 * 60 + 15 + randInt(0, 30); // 12:15..12:45
  const entrada2 = saida1 + 60; // almoço de 1h
  const saida2 = 17 * 60 + 20; // 17:20 fixo
  return { entrada1, saida1, entrada2, saida2 };
}

// Horário fixo da jornada administrativa: 09:00–12:00 / 13:00–18:00 (8h, 1h de
// almoço). Sem variação — é contrato de escritório, não ponto estimado por navio.
export const ADMIN_TIMES: DayTimes = {
  entrada1: 9 * 60,
  saida1: 12 * 60,
  entrada2: 13 * 60,
  saida2: 18 * 60,
};

export interface DayTotals {
  hDiaria: number; // minutos trabalhados no dia
  atraso: number; // minutos abaixo da carga (após tolerância)
  he: number; // minutos de hora extra (após tolerância)
  faixa1: number; // HE na 1ª faixa (até 4h)
  faixa2: number; // HE acima de 4h
}

// Duração de um trecho entrada→saída em minutos. Trata turno que cruza a
// meia-noite (saída "no dia seguinte", ex.: 19:00→01:00): soma 24h.
function segMin(entrada: number, saida: number): number {
  return (saida >= entrada ? saida : saida + 1440) - entrada;
}

export function totalsForDay(t: DayTimes, cargaMin: number = CARGA_DIARIA_MIN): DayTotals {
  let hDiaria = segMin(t.entrada1, t.saida1);
  if (t.entrada2 != null && t.saida2 != null) hDiaria += segMin(t.entrada2, t.saida2);
  const diff = hDiaria - cargaMin;
  let atraso = 0;
  let he = 0;
  if (diff < 0 && -diff > TOLERANCIA_MIN) atraso = -diff;
  if (diff > 0 && diff > TOLERANCIA_MIN) he = diff;
  const faixa1 = Math.min(he, FAIXA1_LIMITE_MIN);
  const faixa2 = Math.max(0, he - FAIXA1_LIMITE_MIN);
  return { hDiaria, atraso, he, faixa1, faixa2 };
}

// Carga horária esperada do dia. No Costado é sempre 6h: a folha mostra só o
// primeiro turno (vai pra contabilidade como 6h), então 2+ turnos no mesmo dia
// não somam carga.
export function cargaForDay(day: WorkedDay): number {
  if (day.kind === "COSTADO") return COSTADO_DIARIA_MIN;
  return CARGA_DIARIA_MIN;
}

// Semente estável por colaborador+dia.
export function seedKey(employeeId: number, iso: string): string {
  return `${employeeId}|${iso}`;
}

// "HH:MM" a partir de minutos (aceita > 24h para os totais).
export function fmtHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ── Folha consolidada (fonte única do Excel e da prévia em tela) ────────────────

export interface FolhaDayRow {
  iso: string;
  day: number;
  dayName: string;
  highlight: boolean; // domingo/feriado → linha realçada
  worked: boolean;
  kind: WorkedKind | "ADMIN" | null; // tipo de jornada do dia (null = não trabalhou)
  times: DayTimes | null;
  totals: DayTotals | null;
}

export interface FolhaComputed {
  rows: FolhaDayRow[];
  totals: DayTotals; // somatório do mês
}

// Monta as linhas da folha de um colaborador (todos os dias do mês; só os dias
// trabalhados recebem horário/cálculo). Usada pelo gerador de Excel e pela prévia
// da tela — assim a visualização bate exatamente com o arquivo gerado.
// O tipo de cada dia vem do navio onde a pessoa esteve (definido em
// expandWorkedDates pelo services): COSTADO = 6h no turno; EMBARQUE = 7h20.
// `jornada` filtra a folha por tipo: "EMBARQUE"/"COSTADO" passa só os dias
// daquele tipo; "AMBAS" (ou sem `jornada`) mostra todos os dias, Embarque e
// Costado juntos na mesma folha.
export function computeFolha(
  empId: number,
  worked: WorkedMap,
  year: number,
  month1to12: number,
  jornada?: JornadaFilter,
  admin?: boolean,
): FolhaComputed {
  const nDays = daysInMonth(year, month1to12);
  const rows: FolhaDayRow[] = [];
  let totH = 0, totA = 0, totHE = 0, totF1 = 0, totF2 = 0;
  for (let d = 1; d <= nDays; d++) {
    const iso = `${year}-${String(month1to12).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    let times: DayTimes | null = null;
    let totals: DayTotals | null = null;
    let kind: WorkedKind | "ADMIN" | null = null;
    let isWorked = false;

    if (admin) {
      // Administrativo: jornada fixa seg–sex (sem navio, sem fim de semana/feriado).
      if (isAdminWorkday(iso)) {
        isWorked = true;
        kind = "ADMIN";
        times = ADMIN_TIMES;
        totals = totalsForDay(times, ADMIN_DIARIA_MIN);
      }
    } else {
      const wd = worked.get(iso) ?? null;
      // Filtra pelo tipo selecionado; "AMBAS" (ou sem filtro) mantém todos os dias.
      const day = wd && (jornada == null || jornada === "AMBAS" || wd.kind === jornada) ? wd : null;
      if (day) {
        isWorked = true;
        kind = day.kind;
        times = timesForDay(seedKey(empId, iso), day);
        totals = totalsForDay(times, cargaForDay(day));
      }
    }

    if (totals) {
      totH += totals.hDiaria; totA += totals.atraso; totHE += totals.he;
      totF1 += totals.faixa1; totF2 += totals.faixa2;
    }
    rows.push({
      iso,
      day: d,
      dayName: DIAS_SEMANA_PT[weekdayOf(iso)],
      highlight: isHighlightedDay(iso),
      worked: isWorked,
      kind,
      times,
      totals,
    });
  }
  return { rows, totals: { hDiaria: totH, atraso: totA, he: totHE, faixa1: totF1, faixa2: totF2 } };
}

// Quantos dias de um tipo há no mapa — para o contador da tela. "AMBAS" conta
// todos os dias trabalhados (Embarque + Costado).
export function countWorkedKind(worked: WorkedMap, jornada: JornadaFilter): number {
  let n = 0;
  for (const v of worked.values()) if (jornada === "AMBAS" || v.kind === jornada) n++;
  return n;
}
