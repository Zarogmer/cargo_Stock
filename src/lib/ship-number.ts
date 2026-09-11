// Numeração do navio no ano — o "Nº" da planilha "1 NAVIOS 2026.xlsx" da
// diretoria (coluna A): o 1º navio que chegou em janeiro é o 1, o seguinte o 2,
// e assim até dezembro. Reinicia todo ano.
//
// É calculada, não gravada: ordem de chegada (arrival_date), empate pelo
// cadastro mais antigo. Navio Cancelado não conta (e não desloca os outros);
// navio sem data de chegada fica sem número. Puro/sem Prisma — roda no cliente
// com qualquer lista de navios que tenha esses campos.

export interface ShipYearNumber {
  year: number;
  n: number;
  /** Quantos navios o ano tem até agora (pra mostrar "7 de 44"). */
  total: number;
}

export function computeShipYearNumbers<
  T extends { id: string; arrival_date: string | null; created_at?: string | null; status?: string | null },
>(ships: T[]): Map<string, ShipYearNumber> {
  const byYear = new Map<number, T[]>();
  for (const s of ships) {
    if (!s.arrival_date) continue;
    if (s.status === "CANCELADO") continue;
    const year = parseInt(s.arrival_date.slice(0, 4), 10);
    if (!Number.isFinite(year)) continue;
    const list = byYear.get(year) || [];
    list.push(s);
    byYear.set(year, list);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const out = new Map<string, ShipYearNumber>();
  for (const [year, list] of byYear) {
    // Datas vêm como ISO ("2026-08-26" ou "2026-08-26T00:00:00.000Z"): comparar
    // a string basta e não sofre shift de fuso.
    list.sort(
      (a, b) =>
        cmp((a.arrival_date || "").slice(0, 10), (b.arrival_date || "").slice(0, 10)) ||
        cmp(a.created_at || "", b.created_at || "") ||
        cmp(a.id, b.id),
    );
    list.forEach((s, i) => out.set(s.id, { year, n: i + 1, total: list.length }));
  }
  return out;
}

/** "Nº 7/26" — número no ano + ano curto, como se lê na planilha. */
export function formatShipNumber(num: ShipYearNumber | undefined | null): string {
  if (!num) return "";
  return `Nº ${num.n}/${String(num.year).slice(-2)}`;
}
