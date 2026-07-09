// Extração de NOTA FISCAL (DANFE / NF-e) a partir do PDF, e unificação com o
// boleto num único "documento" pra o import de Contas a Pagar.
//
// Precisão:
//   - Chave de acesso (44 díg) é DETERMINÍSTICA — dela saem CNPJ do emitente
//     (fornecedor), número da NF, série e competência (AAMM). Mesmo espírito do
//     parser de linha digitável do boleto.
//   - Valor total: lido POR POSIÇÃO (o número fica na linha abaixo do rótulo
//     "VALOR TOTAL DA NOTA"); regex de texto puro não resolve por causa da
//     ordem em que o DANFE joga os itens. É uma sugestão revisável.
//   - PDF escaneado (sem camada de texto) não dá pra ler sem OCR → cai no manual.

import { extractPdfItems, type PdfItem } from "./pdf";
import { findLinhaDigitavel, type BoletoParsed } from "./linha-digitavel";

export interface NfeParsed {
  chave: string; // 44 dígitos
  cnpjEmitente: string; // 14 dígitos
  numero: string; // número da NF (sem zeros à esquerda)
  serie: string;
  modelo: string; // "55" NF-e, "65" NFC-e
  competencia: string; // "YYYY-MM" (da chave)
  emissao: string | null; // "YYYY-MM-DD" (do texto, quando achado)
  emitenteName: string | null;
  valor: number | null; // valor total da nota (sugerido)
}

export interface DocExtract {
  kind: "BOLETO" | "NFE" | "DESCONHECIDO";
  scanned: boolean; // PDF sem texto legível (provável scan → precisa OCR/manual)
  boleto: BoletoParsed | null;
  nfe: NfeParsed | null;
  cnpj: string | null; // melhor palpite do CNPJ do fornecedor
  amount: number | null; // valor sugerido (boleto: da linha; NF: total)
  dueDate: string | null; // "YYYY-MM-DD" (só boleto)
  digitableLine: string | null;
  suggestedDescription: string;
}

// ── Chave de acesso ──────────────────────────────────────────────────────────

// DV (mod 11) da chave de 44 dígitos — valida sobre os 43 primeiros.
function chaveDV(k43: string): number {
  let sum = 0;
  let w = 2;
  for (let i = k43.length - 1; i >= 0; i--) {
    sum += Number(k43[i]) * w;
    w = w === 9 ? 2 : w + 1;
  }
  const dv = 11 - (sum % 11);
  return dv >= 10 ? 0 : dv;
}

// Acha a chave: o DANFE imprime como 11 grupos de 4 dígitos. Pegamos o grupo
// com modelo válido (55/65); preferimos o de DV correto.
function findChave(text: string): string | null {
  const flat = text.replace(/\s+/g, " ");
  const cands = (flat.match(/\b\d{4}(?:[\s.]\d{4}){10}\b/g) || [])
    .map((g) => g.replace(/\D/g, ""))
    .filter((x) => x.length === 44);
  for (const c of flat.match(/\d{44}/g) || []) cands.push(c);

  const valid = cands.filter((c) => {
    const modelo = c.slice(20, 22);
    return modelo === "55" || modelo === "65";
  });
  const dvOk = valid.find((c) => chaveDV(c.slice(0, 43)) === Number(c[43]));
  return dvOk ?? valid[0] ?? null;
}

function parseChave(c: string): Omit<NfeParsed, "emissao" | "emitenteName" | "valor"> {
  const aa = c.slice(2, 4);
  const mm = c.slice(4, 6);
  return {
    chave: c,
    cnpjEmitente: c.slice(6, 20),
    modelo: c.slice(20, 22),
    serie: String(Number(c.slice(22, 25))),
    numero: String(Number(c.slice(25, 34))),
    competencia: `20${aa}-${mm}`,
  };
}

// ── Valor total por posição ─────────────────────────────────────────────────

function brNum(s: string): number | null {
  if (!/^\d{1,3}(?:\.\d{3})*,\d{2}$|^\d+,\d{2}$/.test(s)) return null;
  return parseFloat(s.replace(/\./g, "").replace(",", "."));
}

// Acha o rótulo "VALOR TOTAL DA NOTA" e pega o primeiro número NÃO-ZERO na
// linha imediatamente abaixo (as células vizinhas de imposto costumam ser 0,00).
function valorPorPosicao(items: PdfItem[]): number | null {
  let label: PdfItem | null = null;
  for (let i = 0; i < items.length; i++) {
    if (items[i].s.toUpperCase().includes("TOTAL DA NOTA")) {
      label = items[i];
      break;
    }
  }
  if (!label) {
    for (let i = 0; i + 3 < items.length; i++) {
      const seq = `${items[i].s} ${items[i + 1].s} ${items[i + 2].s} ${items[i + 3].s}`.toUpperCase();
      if (seq.includes("VALOR TOTAL DA NOTA")) {
        label = items[i + 3];
        break;
      }
    }
  }
  if (!label) return null;
  const lbl = label;
  const cands = items
    .filter((it) => it.page === lbl.page && brNum(it.s) != null && it.y < lbl.y && lbl.y - it.y < 40)
    .map((it) => ({ v: brNum(it.s) as number, dx: Math.abs(it.x - lbl.x), dy: lbl.y - it.y }))
    .filter((it) => it.dx < 130)
    .sort((a, b) => a.dy - b.dy || a.dx - b.dx);
  if (cands.length === 0) return null;
  const nonZero = cands.find((c) => c.v > 0);
  return nonZero ? nonZero.v : cands[0].v;
}

// Fallback de valor por texto (alguns layouts trazem "VALOR TOTAL: R$ ... nn,nn").
function valorPorTexto(text: string): number | null {
  const pats = [
    /VALOR\s+TOTAL\s*:?\s*R\$[^\d]{0,30}(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i,
    /VALOR\s+A\s+PAGAR[^\d]{0,15}R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i,
    /Valor\s+pago\s*R?\$?:?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i,
    /VALOR\s+TOTAL\s+DOS\s+PRODUTOS[^\d]{0,15}(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i,
    /Total\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i,
  ];
  for (const re of pats) {
    const m = text.match(re);
    if (m) {
      const v = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
      if (v > 0) return v;
    }
  }
  return null;
}

// ── Outros campos do texto ──────────────────────────────────────────────────

function parseEmissao(text: string): string | null {
  const m = text.match(/EMISS[ÃA]O\s*:?\s*(\d{2})\/(\d{2})\/(\d{2,4})/i);
  if (!m) return null;
  const [, d, mo, y] = m;
  const yyyy = y.length === 2 ? `20${y}` : y;
  return `${yyyy}-${mo}-${d}`;
}

function parseEmitente(text: string): string | null {
  const m = text.match(/RECEBEMOS DE\s+(.+?)\s+OS PRODUTOS/i);
  if (m && m[1]) return m[1].replace(/&AMP;/gi, "&").replace(/\s+/g, " ").trim().slice(0, 120);
  return null;
}

// ── Extração unificada ──────────────────────────────────────────────────────

export async function extractDocumentFromPdf(buffer: Buffer): Promise<DocExtract> {
  let text = "";
  let items: PdfItem[] = [];
  try {
    const r = await extractPdfItems(buffer);
    text = r.text;
    items = r.items;
  } catch {
    return blank("DESCONHECIDO", true);
  }

  const scanned = text.replace(/\s/g, "").length < 20;
  if (scanned) return blank("DESCONHECIDO", true);

  // 1) Boleto? (linha digitável dá valor + vencimento com precisão)
  const boleto = findLinhaDigitavel(text);
  if (boleto) {
    const cnpj = firstCnpj(text);
    return {
      kind: "BOLETO",
      scanned: false,
      boleto,
      nfe: null,
      cnpj,
      amount: boleto.amount,
      dueDate: boleto.dueDate ? boleto.dueDate.toISOString().slice(0, 10) : null,
      digitableLine: boleto.digits,
      suggestedDescription: cnpj ? `Boleto ${formatCnpj(cnpj)}` : "Boleto",
    };
  }

  // 2) Nota fiscal? (chave de acesso)
  const chave = findChave(text);
  if (chave) {
    const base = parseChave(chave);
    const valor = valorPorPosicao(items) ?? valorPorTexto(text);
    const emitenteName = parseEmitente(text);
    const nfe: NfeParsed = {
      ...base,
      emissao: parseEmissao(text),
      emitenteName,
      valor,
    };
    const nome = emitenteName || formatCnpj(base.cnpjEmitente);
    return {
      kind: "NFE",
      scanned: false,
      boleto: null,
      nfe,
      cnpj: base.cnpjEmitente,
      amount: valor,
      dueDate: null,
      digitableLine: null,
      suggestedDescription: `NF ${base.numero} - ${nome}`,
    };
  }

  // 3) Documento sem chave nem linha (pedido, recibo...) — tenta só valor/CNPJ.
  const cnpj = firstCnpj(text);
  return {
    kind: "DESCONHECIDO",
    scanned: false,
    boleto: null,
    nfe: null,
    cnpj,
    amount: valorPorTexto(text),
    dueDate: null,
    digitableLine: null,
    suggestedDescription: cnpj ? `Documento ${formatCnpj(cnpj)}` : "Documento",
  };
}

function blank(kind: DocExtract["kind"], scanned: boolean): DocExtract {
  return {
    kind,
    scanned,
    boleto: null,
    nfe: null,
    cnpj: null,
    amount: null,
    dueDate: null,
    digitableLine: null,
    suggestedDescription: scanned ? "Documento escaneado (preencher à mão)" : "Documento",
  };
}

// Primeiro CNPJ do emitente: preferimos o que NÃO é o da própria Cargo Ships
// (destinatária), pegando o primeiro CNPJ formatado que não seja o dela.
const CARGO_CNPJS = new Set(["41560212000100"]); // CARGO SHIPS CLEANING LTDA
function firstCnpj(text: string): string | null {
  const all = (text.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g) || []).map((c) => c.replace(/\D/g, ""));
  const other = all.find((c) => !CARGO_CNPJS.has(c));
  return other || all[0] || null;
}

function formatCnpj(d: string): string {
  if (d.length !== 14) return d;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}
