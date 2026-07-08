// Parser determinístico da linha digitável / código de barras FEBRABAN.
// Deriva VALOR e VENCIMENTO direto dos dígitos (não de texto solto do PDF),
// tratando os dois tipos:
//   - Boleto bancário de cobrança: 47 dígitos (5 campos).
//   - Boleto de arrecadação/convênio: 48 dígitos (começa com 8).
//
// Referências: Manual FEBRABAN de código de barras; fator de vencimento com o
// reinício de 2025 (o contador de 4 dígitos estourou 9999 em 21/02/2025 e
// voltou a 1000 em 22/02/2025).

export type BoletoTipo = "BANCARIO" | "ARRECADACAO";

export interface BoletoParsed {
  tipo: BoletoTipo;
  digits: string; // linha digitável só com dígitos
  barcode: string; // 44 dígitos do código de barras
  bankCode: string | null; // banco emissor (só boleto bancário)
  amount: number | null; // R$ (null quando o boleto não traz valor)
  dueDate: Date | null; // vencimento (null em arrecadação sem data)
  dvValid: boolean; // DVs de campo conferem (mod10) — false = provável erro de leitura
}

const MS_DAY = 86_400_000;
// Base oficial do fator de vencimento: 07/10/1997.
const FATOR_BASE = Date.UTC(1997, 9, 7);
// Um ciclo do fator (1000→9999) tem 8999 incrementos; o reinício de 2025 faz o
// fator "novo" ser o "contínuo" menos 9000. Pra desfazer a ambiguidade dos 4
// dígitos, escolhemos a ocorrência mais próxima de hoje.
const FATOR_CYCLE = 9000;

// mod10 de um campo da linha digitável (pesos 2,1,2,1... da direita p/ esquerda).
function mod10(field: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = field.length - 1; i >= 0; i--) {
    let p = Number(field[i]) * weight;
    if (p > 9) p = Math.floor(p / 10) + (p % 10);
    sum += p;
    weight = weight === 2 ? 1 : 2;
  }
  const r = sum % 10;
  return r === 0 ? 0 : 10 - r;
}

// Converte o fator de vencimento (4 díg) na data, resolvendo o rollover de 2025
// pela ocorrência mais próxima de hoje.
export function fatorVencimentoToDate(fator: number, now: number = Date.now()): Date | null {
  if (!fator || fator <= 0) return null;
  const candidates = [fator, fator + FATOR_CYCLE, fator + 2 * FATOR_CYCLE].map(
    (f) => FATOR_BASE + f * MS_DAY
  );
  let best = candidates[0];
  for (const c of candidates) {
    if (Math.abs(c - now) < Math.abs(best - now)) best = c;
  }
  return new Date(best);
}

// Remove os DVs (cada 12º dígito) da linha de 48 e remonta o código de barras
// de 44 dígitos do boleto de arrecadação.
function arrecadacaoBarcode(digits: string): string {
  let bc = "";
  for (let b = 0; b < 4; b++) {
    bc += digits.substr(b * 12, 11); // 11 dados + 1 DV, descarta o DV
  }
  return bc;
}

export function parseLinhaDigitavel(input: string): BoletoParsed | null {
  const digits = (input || "").replace(/\D/g, "");

  // ── Arrecadação/convênio: 48 dígitos, começa com 8 ──────────────────────
  if (digits.length === 48 && digits[0] === "8") {
    const barcode = arrecadacaoBarcode(digits);
    // pos 3 (id valor): 6/7 = valor efetivo em reais; 8/9 = valor referenciado.
    const valorId = barcode[2];
    const valorRaw = barcode.substring(4, 15); // 11 dígitos
    const hasValue = valorId === "6" || valorId === "7";
    const amount = hasValue ? Number(valorRaw) / 100 : null;
    return {
      tipo: "ARRECADACAO",
      digits,
      barcode,
      bankCode: null,
      amount: amount && amount > 0 ? amount : null,
      dueDate: null, // arrecadação não tem fator de vencimento padrão
      dvValid: true, // (DV mod10/mod11 de arrecadação varia por segmento; não bloqueia)
    };
  }

  // ── Bancário: 47 dígitos, 5 campos ──────────────────────────────────────
  if (digits.length === 47) {
    const campo1 = digits.substring(0, 10); // 9 dados + DV1
    const campo2 = digits.substring(10, 21); // 10 dados + DV2
    const campo3 = digits.substring(21, 32); // 10 dados + DV3
    // campo4 = digits[32] (DV geral); campo5 = digits.substring(33) (14 díg)
    const campo5 = digits.substring(33); // fator(4) + valor(10)

    const dvValid =
      mod10(campo1.slice(0, 9)) === Number(campo1[9]) &&
      mod10(campo2.slice(0, 10)) === Number(campo2[10]) &&
      mod10(campo3.slice(0, 10)) === Number(campo3[10]);

    const fator = Number(campo5.substring(0, 4));
    const valorRaw = campo5.substring(4); // 10 dígitos
    const amount = Number(valorRaw) / 100;

    // Remonta o código de barras (44) a partir dos campos.
    const barcode =
      campo1.substring(0, 4) + // banco + moeda
      digits[32] + // DV geral
      campo5 + // fator + valor
      campo1.substring(4, 9) + // 5 díg do campo livre
      campo2.substring(0, 10) +
      campo3.substring(0, 10);

    return {
      tipo: "BANCARIO",
      digits,
      barcode,
      bankCode: campo1.substring(0, 3),
      amount: amount > 0 ? amount : null,
      dueDate: fatorVencimentoToDate(fator),
      dvValid,
    };
  }

  return null; // comprimento não reconhecido
}

// Acha a primeira linha digitável válida dentro de um texto (do PDF do boleto).
// Tolera pontos, espaços e a formatação típica "34191.79001 01043.510047 ...".
export function findLinhaDigitavel(text: string): BoletoParsed | null {
  // Junta candidatos de 47/48 dígitos considerando separadores comuns.
  const compact = text.replace(/[.\s]/g, " ");
  // Sequências longas de dígitos (com espaços internos) — pega blocos plausíveis.
  const runs = compact.match(/(?:\d[\s]?){44,55}/g) || [];
  for (const run of runs) {
    const only = run.replace(/\D/g, "");
    // tenta janelas de 47 e 48
    for (const len of [47, 48]) {
      for (let i = 0; i + len <= only.length; i++) {
        const slice = only.substring(i, i + len);
        if (len === 48 && slice[0] !== "8") continue;
        const parsed = parseLinhaDigitavel(slice);
        if (parsed && (parsed.tipo === "ARRECADACAO" || parsed.dvValid)) return parsed;
      }
    }
  }
  return null;
}
