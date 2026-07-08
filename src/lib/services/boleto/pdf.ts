// Extração de texto de PDF de boleto no SERVIDOR (Node). Usa o build "legacy"
// do pdfjs-dist e o worker embutido (fake worker, no mesmo processo) — suficiente
// pra ler texto. Deriva a linha digitável e o CNPJ do beneficiário.
//
// ⚠️ Polyfill de Uint8Array.prototype.toHex/setFromHex: o pdfjs v5 usa esses
// métodos, que só existem no Node 22+. No Node 20 (engine do projeto) eles não
// existem e o import quebra com "toHex is not a function" — mesmo motivo do
// polyfill no client (financeiro/page.tsx).

import { findLinhaDigitavel, type BoletoParsed } from "./linha-digitavel";

function ensureUint8Polyfill() {
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
  const U8c = Uint8Array as unknown as { fromHex?: (s: string) => Uint8Array };
  if (typeof U8c.fromHex !== "function") {
    U8c.fromHex = function (s: string): Uint8Array {
      const len = Math.floor(s.length / 2);
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
      return out;
    };
  }
}

// Exige a pontuação do CNPJ (XX.XXX.XXX/XXXX-XX). Boleto sempre renderiza o
// CNPJ do beneficiário formatado — assim não confundimos com os 14 dígitos
// crus do código de barras / linha digitável.
const CNPJ_RE = /(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/g;

export interface BoletoExtract {
  text: string;
  linha: BoletoParsed | null;
  cnpj: string | null; // CNPJ do beneficiário (só dígitos), melhor palpite
  payeeName: string | null;
}

// Lê todo o texto do PDF (todas as páginas).
export async function extractPdfText(buffer: Buffer): Promise<string> {
  ensureUint8Polyfill();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const parts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items) {
      const s = (item as { str?: string }).str;
      if (s) parts.push(s);
    }
    parts.push("\n");
  }
  await doc.cleanup();
  return parts.join(" ");
}

// Extrai boleto (linha digitável + CNPJ) de um PDF. Nunca lança: em erro
// devolve o que conseguiu (text vazio, linha null) pra o chamador decidir.
export async function extractBoletoFromPdf(buffer: Buffer): Promise<BoletoExtract> {
  let text = "";
  try {
    text = await extractPdfText(buffer);
  } catch {
    return { text: "", linha: null, cnpj: null, payeeName: null };
  }

  const linha = findLinhaDigitavel(text);

  // CNPJ do beneficiário: pega o primeiro CNPJ que aparece perto de
  // "beneficiário"/"cedente"; senão o primeiro CNPJ do documento.
  let cnpj: string | null = null;
  const lower = text.toLowerCase();
  const anchor = Math.max(lower.indexOf("beneficiário"), lower.indexOf("beneficiario"), lower.indexOf("cedente"));
  if (anchor >= 0) {
    const near = text.substring(anchor, anchor + 240);
    const m = near.match(CNPJ_RE);
    if (m && m[0]) cnpj = m[0].replace(/\D/g, "");
  }
  if (!cnpj) {
    const m = text.match(CNPJ_RE);
    if (m && m[0]) cnpj = m[0].replace(/\D/g, "");
  }
  if (cnpj && cnpj.length !== 14) cnpj = null;

  return { text, linha, cnpj, payeeName: null };
}
