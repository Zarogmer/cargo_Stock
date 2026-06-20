// Lógica pura (sem dependência de servidor) da Folha de Ponto, compartilhada
// entre a API que gera o arquivo (Excel/PDF) e a tela que mostra a prévia de
// dias trabalhados. Os dias vêm dos navios cadastrados (job_allocations):
//   - COSTADO: cada turno tem shift_date exato.
//   - EMBARQUE: o sistema guarda a operação do navio (chegada → saída); a folha
//     marca TODA a janela arrival_date..departure_date (inclui fim de semana).
//     Sem data de saída, marca só o dia de chegada.
// O horário do dia é "aleatório" mas determinístico (semente = colaborador+data),
// então gerar de novo a mesma competência dá exatamente a mesma folha.

// Carga horária diária padrão da empresa: 7h20 (igual à planilha oficial).
export const CARGA_DIARIA_MIN = 7 * 60 + 20; // 440
// 1ª faixa de hora extra vai até 4h; o que passar cai na 2ª faixa (PREMISSAS).
export const FAIXA1_LIMITE_MIN = 4 * 60; // 240
// Tolerância de atraso/extra (PREMISSAS!C13 = 0:00 → sem tolerância).
export const TOLERANCIA_MIN = 0;

export const DIAS_SEMANA_PT = [
  "Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado",
] as const;

export const MESES_PT = [
  "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
  "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
] as const;

// Feriados nacionais de data fixa (MM-DD). Só servem pra pintar a linha (igual a
// domingo) — a carga continua 7:20. Feriados móveis (Carnaval, Sexta-feira Santa,
// Corpus Christi) não são marcados automaticamente.
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

export function isHoliday(iso: string): boolean {
  return FERIADOS_FIXOS.has(iso.slice(5, 10));
}

export function isHighlightedDay(iso: string): boolean {
  // Linha realçada (azul) na folha: domingos e feriados fixos.
  return weekdayOf(iso) === 0 || isHoliday(iso);
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

// ── Quais dias o colaborador trabalhou ─────────────────────────────────────────

export type AllocKind = "COSTADO" | "EMBARQUE";

export interface AllocInput {
  kind: AllocKind;
  // COSTADO: data exata do turno (YYYY-MM-DD).
  shift_date: string | null;
  // EMBARQUE: janela da operação do navio.
  ship_arrival: string | null;
  ship_departure: string | null;
  // Fallback de início quando o navio não tem arrival_date.
  job_start: string | null;
}

// Conjunto de dias (YYYY-MM-DD) trabalhados no mês, a partir das alocações.
export function expandWorkedDates(
  allocs: AllocInput[],
  year: number,
  month1to12: number,
): Set<string> {
  const mm = String(month1to12).padStart(2, "0");
  const monthStart = `${year}-${mm}-01`;
  const monthEnd = `${year}-${mm}-${String(daysInMonth(year, month1to12)).padStart(2, "0")}`;
  const out = new Set<string>();

  for (const a of allocs) {
    if (a.kind === "COSTADO") {
      const d = (a.shift_date || "").slice(0, 10);
      if (d && d >= monthStart && d <= monthEnd) out.add(d);
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
    for (let s = isoToSerial(from); s <= isoToSerial(to); s++) out.add(serialToIso(s));
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
  entrada1: number; // minutos desde 00:00
  saida1: number;
  entrada2: number;
  saida2: number;
}

// Padrão observado na planilha oficial: entra ~09:00, almoço de 1h começando
// ~12:15–12:45, saída fixa 17:20. Como o almoço é exatamente 1h e a saída é fixa,
// a H. Diária depende só da entrada (≈ 16:20 − entrada): entrar antes das 9h vira
// hora extra, depois vira atraso — igual ao exemplo do CARLISSON.
export function timesForDay(seedKey: string): DayTimes {
  const rnd = mulberry32(hashStr(seedKey));
  const randInt = (min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));
  const entrada1 = 9 * 60 + randInt(-6, 6); // 08:54..09:06
  const saida1 = 12 * 60 + 15 + randInt(0, 30); // 12:15..12:45
  const entrada2 = saida1 + 60; // almoço de 1h
  const saida2 = 17 * 60 + 20; // 17:20 fixo
  return { entrada1, saida1, entrada2, saida2 };
}

export interface DayTotals {
  hDiaria: number; // minutos trabalhados no dia
  atraso: number; // minutos abaixo da carga (após tolerância)
  he: number; // minutos de hora extra (após tolerância)
  faixa1: number; // HE na 1ª faixa (até 4h)
  faixa2: number; // HE acima de 4h
}

export function totalsForDay(t: DayTimes): DayTotals {
  const hDiaria = t.saida1 - t.entrada1 + (t.saida2 - t.entrada2);
  const diff = hDiaria - CARGA_DIARIA_MIN;
  let atraso = 0;
  let he = 0;
  if (diff < 0 && -diff > TOLERANCIA_MIN) atraso = -diff;
  if (diff > 0 && diff > TOLERANCIA_MIN) he = diff;
  const faixa1 = Math.min(he, FAIXA1_LIMITE_MIN);
  const faixa2 = Math.max(0, he - FAIXA1_LIMITE_MIN);
  return { hDiaria, atraso, he, faixa1, faixa2 };
}

// Semente estável por colaborador+dia.
export function seedKey(employeeId: number, iso: string): string {
  return `${employeeId}|${iso}`;
}
