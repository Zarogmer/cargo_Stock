// Numeração do navio no ano — o "Nº" da planilha "1 NAVIOS 2026.xlsx" da
// diretoria (coluna A) e o número que abre cada fechamento na pasta
// "03 - RELATÓRIO DE DESPESAS DE LIMPEZA DE PORÕES"
// ("27 - M/V FEDERAL IMABARI - 5 PORÕES - ..."): o 1º navio que chegou em
// janeiro é o 1, o seguinte o 2, e assim até dezembro. Reinicia todo ano.
//
// A fonte oficial é ships.year_number, gravado na importação dos fechamentos.
// Quem não tem número gravado (navio novo, cadastrado direto no sistema) cai no
// cálculo: ordem de chegada (arrival_date), empate pelo cadastro mais antigo,
// pegando sempre o menor número ainda livre do ano — então o navio seguinte ao
// 42 vira 43, mesmo com um 100/101 fora de série gravado.
//
// Navio Cancelado sem número gravado não conta (e não desloca os outros); navio
// sem data de chegada e sem número fica sem número. Puro/sem Prisma — roda no
// cliente com qualquer lista de navios que tenha esses campos.

export interface ShipYearNumber {
  year: number;
  n: number;
  /** Quantos navios o ano tem até agora (pra mostrar "7 de 44"). */
  total: number;
  /** true = veio da planilha da diretoria; false = calculado por ordem de chegada. */
  official: boolean;
}

export interface ShipNumberInput {
  id: string;
  arrival_date: string | null;
  created_at?: string | null;
  status?: string | null;
  /** Nº oficial da planilha da diretoria. null/undefined = calcular. */
  year_number?: number | null;
}

export function computeShipYearNumbers<T extends ShipNumberInput>(
  ships: T[],
): Map<string, ShipYearNumber> {
  const byYear = new Map<number, T[]>();
  for (const s of ships) {
    if (!s.arrival_date) continue;
    // Cancelado só entra se a diretoria já deu número pra ele na planilha.
    if (s.status === "CANCELADO" && !s.year_number) continue;
    const year = parseInt(s.arrival_date.slice(0, 4), 10);
    if (!Number.isFinite(year)) continue;
    const list = byYear.get(year) || [];
    list.push(s);
    byYear.set(year, list);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const out = new Map<string, ShipYearNumber>();
  for (const [year, list] of byYear) {
    const total = list.length;
    const taken = new Set<number>();
    const pending: T[] = [];
    for (const s of list) {
      const n = s.year_number;
      // Número repetido na planilha não pode roubar o do outro: o segundo cai
      // no cálculo como se não tivesse número.
      if (n != null && n > 0 && !taken.has(n)) {
        taken.add(n);
        out.set(s.id, { year, n, total, official: true });
      } else {
        pending.push(s);
      }
    }
    // Datas vêm como ISO ("2026-08-26" ou "2026-08-26T00:00:00.000Z"): comparar
    // a string basta e não sofre shift de fuso.
    pending.sort(
      (a, b) =>
        cmp((a.arrival_date || "").slice(0, 10), (b.arrival_date || "").slice(0, 10)) ||
        cmp(a.created_at || "", b.created_at || "") ||
        cmp(a.id, b.id),
    );
    let next = 1;
    for (const s of pending) {
      while (taken.has(next)) next++;
      taken.add(next);
      out.set(s.id, { year, n: next, total, official: false });
    }
  }
  return out;
}

/** "Nº 7/26" — número no ano + ano curto, como se lê na planilha. */
export function formatShipNumber(num: ShipYearNumber | undefined | null): string {
  if (!num) return "";
  return `Nº ${num.n}/${String(num.year).slice(-2)}`;
}
