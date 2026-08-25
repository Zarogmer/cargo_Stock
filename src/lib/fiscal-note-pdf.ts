// PDF da Nota de Débito / Crédito, com pdf-lib (mesma stack dos Relatórios de
// Bordo). O layout segue o das notas que a empresa já manda pro cliente:
// timbrado da Cargo no topo, faixa NOTA DE DÉBITO com o número à direita, bloco
// do destinatário com "Valor total a Fatura", bloco Ref. do navio, tabela
// Histórico/Débito/Crédito, SUB-TOTAL e TOTAL, e os dados de depósito no rodapé.
//
// Um modelo só serve os dois formatos de hoje: `language` troca os rótulos
// (Wilson Sons recebe em inglês), `oi`/`exchange_rate`/`iss_percent` aparecem só
// quando preenchidos, e cada serviço é uma linha do Histórico.

import { readFile } from "fs/promises";
import path from "path";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import {
  CARGO_ISSUER,
  CURRENCY_SYMBOL,
  FiscalNoteInput,
  NOTE_LABELS,
  calcFiscalNoteTotals,
  formatIssueCity,
  formatNoteDate,
  formatNoteNumber,
  resolveHeaderLine,
} from "@/lib/fiscal-note";

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 34;
const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.72, 0.74, 0.78);
const HEAD_BG = rgb(0.90, 0.92, 0.95);
const HIGHLIGHT = rgb(1, 0.96, 0.62); // amarelo do "VENCIMENTO"/"Valor total"

interface Ctx {
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  width: number;
}

function text(ctx: Ctx, s: string, x: number, y: number, size = 8, bold = false, color = INK) {
  ctx.page.drawText(s || "", { x, y, size, font: bold ? ctx.bold : ctx.font, color });
}

// Texto alinhado à direita a partir de `right`.
function textRight(ctx: Ctx, s: string, right: number, y: number, size = 8, bold = false, color = INK) {
  const f = bold ? ctx.bold : ctx.font;
  const w = f.widthOfTextAtSize(s || "", size);
  ctx.page.drawText(s || "", { x: right - w, y, size, font: f, color });
}

function rect(ctx: Ctx, x: number, y: number, w: number, h: number, fill?: ReturnType<typeof rgb>) {
  ctx.page.drawRectangle({
    x, y, width: w, height: h,
    borderColor: LINE, borderWidth: 0.6,
    ...(fill ? { color: fill } : {}),
  });
}

// Quebra o texto na largura da coluna (descrições longas do Histórico).
function wrap(s: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = (s || "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

// pdf-lib usa WinAnsi nas fontes padrão: caracteres fora dela (traço longo,
// aspas curvas) quebram a geração. Normaliza antes de desenhar.
function ascii(s: string | null | undefined): string {
  return (s || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ");
}

function money(v: number, symbol: string): string {
  return `${symbol} ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export async function buildFiscalNotePdf(note: FiscalNoteInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage(A4);
  const ctx: Ctx = { page, font, bold, width: A4[0] };

  const L = NOTE_LABELS[note.language] ?? NOTE_LABELS.PT;
  const symbol = CURRENCY_SYMBOL[note.currency];
  const isDebit = note.kind === "DEBITO";
  const totals = calcFiscalNoteTotals(note.items, note.iss_percent);

  const left = MARGIN;
  const right = A4[0] - MARGIN;
  const innerW = right - left;
  let y = A4[1] - MARGIN;

  // ── Timbrado: logo à esquerda, dados da empresa à direita ─────────────────
  try {
    const logoBytes = await readFile(path.join(process.cwd(), "public", "cargo-logo.png"));
    const logo = await pdf.embedPng(logoBytes);
    const h = 44;
    const w = (logo.width / logo.height) * h;
    page.drawImage(logo, { x: left, y: y - h, width: w, height: h });
  } catch {
    // Sem logo o documento continua válido — só perde a marca.
    text(ctx, "CARGO SHIPS CLEANING", left, y - 22, 13, true);
  }
  let hy = y - 4;
  const issuerLines = [
    CARGO_ISSUER.address,
    CARGO_ISSUER.city,
    `Tel.: ${CARGO_ISSUER.phone}`,
    CARGO_ISSUER.email,
    `CNPJ MATRIZ: ${CARGO_ISSUER.cnpjMatriz} / Insc. Municipal: ${CARGO_ISSUER.inscMatriz}`,
    `CNPJ FILIAL: ${CARGO_ISSUER.cnpjFilial} / Insc. Municipal: ${CARGO_ISSUER.inscFilial}`,
    `I.E: ${CARGO_ISSUER.ie}`,
  ];
  for (const l of issuerLines) {
    hy -= 8;
    textRight(ctx, ascii(l), right, hy, 6.2, false, MUTED);
  }
  y = Math.min(hy, y - 50) - 16;

  // Data de emissão
  text(ctx, ascii(formatIssueCity(note.issue_date)), left, y, 7.5, false, MUTED);
  y -= 12;

  // ── Faixa do tipo da nota + número ────────────────────────────────────────
  const bandH = 14;
  rect(ctx, left, y - bandH, innerW, bandH, HEAD_BG);
  const title = isDebit ? L.debito : L.credito;
  text(ctx, ascii(title), left + innerW / 2 - bold.widthOfTextAtSize(ascii(title), 8.5) / 2, y - bandH + 4, 8.5, true);
  textRight(ctx, formatNoteNumber(note.number, note.year), right - 6, y - bandH + 4, 8.5, true);
  y -= bandH;

  // ── Destinatário + "Valor total a Fatura" ─────────────────────────────────
  const destH = 42;
  const valueBoxW = 200;
  rect(ctx, left, y - destH, innerW - valueBoxW, destH);
  rect(ctx, left + innerW - valueBoxW, y - destH, valueBoxW, destH);

  const headerLine = resolveHeaderLine(
    note.header_line,
    note.ship_name,
    note.client_legal_name || note.client_name,
  );
  let dy = y - 11;
  for (const l of wrap(ascii(headerLine), bold, 7.5, innerW - valueBoxW - 12).slice(0, 2)) {
    text(ctx, l, left + 5, dy, 7.5, true);
    dy -= 9;
  }
  for (const l of [note.client_address, [
    note.client_cnpj ? `CNPJ: ${note.client_cnpj}` : "",
    note.client_ie ? `I.E.: ${note.client_ie}` : "",
    note.client_municipal ? `Insc. Munic.: ${note.client_municipal}` : "",
  ].filter(Boolean).join(" - ")]) {
    if (!l) continue;
    for (const w of wrap(ascii(l), font, 6.6, innerW - valueBoxW - 12).slice(0, 2)) {
      text(ctx, w, left + 5, dy, 6.6, false, MUTED);
      dy -= 8;
    }
  }
  // Caixa do valor (destaque amarelo, como na planilha)
  const vbx = left + innerW - valueBoxW;
  page.drawRectangle({ x: vbx + 1, y: y - 17, width: valueBoxW - 2, height: 15, color: HIGHLIGHT });
  text(ctx, ascii(L.invoiceTotal), vbx + 5, y - 13, 7, true);
  textRight(ctx, money(totals.total, symbol), right - 5, y - 13, 8, true);
  y -= destH;

  // ── Ref. do navio (OI, entrada/saída, porto) ──────────────────────────────
  const refLines = [
    `${L.ref}  ${note.ship_name}`,
    note.oi ? `${L.oi} ${note.oi}` : "",
    note.arrival_date ? `${L.arrival} ${formatNoteDate(note.arrival_date)}` : "",
    note.departure_date ? `${L.departure} ${formatNoteDate(note.departure_date)}` : "",
    note.port ? `${L.port} ${note.port}` : "",
  ].filter(Boolean);
  const refH = 10 + refLines.length * 9;
  rect(ctx, left, y - refH, innerW, refH);
  let ry = y - 12;
  refLines.forEach((l, i) => {
    text(ctx, ascii(l), left + 5, ry, i === 0 ? 8 : 7, i === 0);
    ry -= 9;
  });
  y -= refH + 8;

  // ── Tabela: Histórico | Débito | Crédito | D/C | Total ────────────────────
  const colTotal = 78;
  const colDC = 24;
  const colCredit = 88;
  const colDebit = 88;
  const colDesc = innerW - colDebit - colCredit - colDC - colTotal;
  const xDesc = left;
  const xDebit = xDesc + colDesc;
  const xCredit = xDebit + colDebit;
  const xDC = xCredit + colCredit;
  const xTotal = xDC + colDC;

  const headH = 13;
  rect(ctx, xDesc, y - headH, colDesc, headH, HEAD_BG);
  rect(ctx, xDebit, y - headH, colDebit, headH, HEAD_BG);
  rect(ctx, xCredit, y - headH, colCredit, headH, HEAD_BG);
  rect(ctx, xDC, y - headH, colDC, headH, HEAD_BG);
  rect(ctx, xTotal, y - headH, colTotal, headH, HEAD_BG);
  const hc = (label: string, x: number, w: number) =>
    text(ctx, ascii(label), x + w / 2 - bold.widthOfTextAtSize(ascii(label), 7) / 2, y - headH + 4, 7, true);
  hc(L.description, xDesc, colDesc);
  hc(L.debit, xDebit, colDebit);
  hc(L.credit, xCredit, colCredit);
  hc("D/C", xDC, colDC);
  hc(L.total, xTotal, colTotal);
  y -= headH;

  // Corpo: uma linha por item. Débito e Crédito ficam em colunas opostas
  // conforme o tipo da nota (ND lança no débito, NC lança no crédito).
  const bodyTop = y;
  for (const item of [...note.items].sort((a, b) => a.position - b.position)) {
    const memo = item.unit_value && item.quantity
      ? `${money(Number(item.unit_value), symbol)} x ${Number(item.quantity).toLocaleString("pt-BR")}`
      : "";
    const descLines = wrap(ascii(item.description), font, 7.2, colDesc - 10);
    const rowH = Math.max(16, descLines.length * 9 + (memo ? 9 : 0) + 6);
    rect(ctx, xDesc, y - rowH, colDesc, rowH);
    rect(ctx, xDebit, y - rowH, colDebit, rowH);
    rect(ctx, xCredit, y - rowH, colCredit, rowH);
    rect(ctx, xDC, y - rowH, colDC, rowH);
    rect(ctx, xTotal, y - rowH, colTotal, rowH);
    let ly = y - 11;
    for (const l of descLines) { text(ctx, l, xDesc + 5, ly, 7.2, true); ly -= 9; }
    if (memo) text(ctx, ascii(memo), xDesc + 5, ly, 6.4, false, MUTED);
    const amountX = isDebit ? xDebit + colDebit : xCredit + colCredit;
    textRight(ctx, money(Number(item.amount), symbol), amountX - 5, y - rowH + 5, 7.4);
    y -= rowH;
  }

  // Linha do ISS: entra do lado oposto ao do serviço, abatendo o total.
  if (totals.issValue > 0) {
    const rowH = 16;
    const pct = Number(note.iss_percent || 0);
    const label = `${L.iss} (${pct.toLocaleString("pt-BR", { maximumFractionDigits: 4 })}%) - ${L.issValue}`;
    rect(ctx, xDesc, y - rowH, colDesc, rowH);
    rect(ctx, xDebit, y - rowH, colDebit, rowH);
    rect(ctx, xCredit, y - rowH, colCredit, rowH);
    rect(ctx, xDC, y - rowH, colDC, rowH);
    rect(ctx, xTotal, y - rowH, colTotal, rowH);
    text(ctx, ascii(label), xDesc + 5, y - 11, 7.2, true);
    const issX = isDebit ? xCredit + colCredit : xDebit + colDebit;
    textRight(ctx, money(totals.issValue, symbol), issX - 5, y - rowH + 5, 7.4);
    y -= rowH;
  }

  // Vencimento + taxa do dólar, no meio da tabela (como nas notas atuais).
  const infoLines = [
    note.due_date ? `${L.due} ${formatNoteDate(note.due_date)}` : "",
    note.exchange_rate
      ? `${L.exchange} ${Number(note.exchange_rate).toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
      : "",
    (note.notes || "").trim(),
  ].filter(Boolean);
  if (infoLines.length) {
    const infoH = 8 + infoLines.length * 10;
    rect(ctx, xDesc, y - infoH, colDesc, infoH);
    rect(ctx, xDebit, y - infoH, colDebit, infoH);
    rect(ctx, xCredit, y - infoH, colCredit, infoH);
    rect(ctx, xDC, y - infoH, colDC, infoH);
    rect(ctx, xTotal, y - infoH, colTotal, infoH);
    let iy = y - 12;
    infoLines.forEach((l, i) => {
      if (i === 0 && note.due_date) {
        page.drawRectangle({ x: xDesc + 3, y: iy - 3, width: colDesc - 6, height: 11, color: HIGHLIGHT });
      }
      text(ctx, ascii(l), xDesc + 6, iy, 7.2, true);
      iy -= 10;
    });
    y -= infoH;
  }
  void bodyTop;

  // ── SUB-TOTAL e TOTAL ─────────────────────────────────────────────────────
  const debitSum = isDebit ? totals.subtotal : totals.issValue;
  const creditSum = isDebit ? totals.issValue : totals.subtotal;
  const totalRow = (label: string, dv: number, cv: number, showDC: boolean, h: number, strong: boolean) => {
    rect(ctx, xDesc, y - h, colDesc, h, strong ? HEAD_BG : undefined);
    rect(ctx, xDebit, y - h, colDebit, h, strong ? HEAD_BG : undefined);
    rect(ctx, xCredit, y - h, colCredit, h, strong ? HEAD_BG : undefined);
    rect(ctx, xDC, y - h, colDC, h, strong ? HEAD_BG : undefined);
    rect(ctx, xTotal, y - h, colTotal, h, strong ? HEAD_BG : undefined);
    text(ctx, ascii(label), xDesc + 5, y - h + 4, 7.4, true);
    textRight(ctx, money(dv, symbol), xDebit + colDebit - 5, y - h + 4, 7.4, strong);
    textRight(ctx, money(cv, symbol), xCredit + colCredit - 5, y - h + 4, 7.4, strong);
    if (showDC) {
      const dc = isDebit ? "D" : "C";
      text(ctx, dc, xDC + colDC / 2 - bold.widthOfTextAtSize(dc, 7.4) / 2, y - h + 4, 7.4, true);
      textRight(ctx, money(totals.total, symbol), xTotal + colTotal - 5, y - h + 4, 7.4, true);
    }
    y -= h;
  };
  totalRow(L.subtotal, debitSum, creditSum, false, 13, false);
  totalRow(L.grandTotal, debitSum, creditSum, true, 14, true);

  // Observação de moeda + linha "Crédito a Favor"
  const obsH = 11;
  rect(ctx, left, y - obsH, innerW, obsH, HEAD_BG);
  const obs = note.currency === "USD" ? L.obsUSD : L.obsBRL;
  text(ctx, ascii(obs), left + innerW / 2 - bold.widthOfTextAtSize(ascii(obs), 6.8) / 2, y - obsH + 3, 6.8, true);
  y -= obsH;

  const favH = 14;
  rect(ctx, left, y - favH, innerW - colTotal, favH);
  rect(ctx, left + innerW - colTotal, y - favH, colTotal, favH);
  text(ctx, ascii(isDebit ? L.inFavorDebit : L.inFavorCredit), left + 5, y - favH + 4, 7.4);
  textRight(ctx, money(totals.total, symbol), right - 5, y - favH + 4, 7.4, true);
  y -= favH + 26;

  // ── Rodapé: dados de depósito + assinatura ────────────────────────────────
  const boxW = 190;
  const boxH = 52;
  rect(ctx, right - boxW, y - boxH, boxW, boxH);
  let by = y - 12;
  for (const l of [
    L.deposit,
    CARGO_ISSUER.bank,
    `AG: ${CARGO_ISSUER.agency}`,
    `C/C: ${CARGO_ISSUER.account}`,
    `PIX: ${CARGO_ISSUER.pix}`,
  ]) {
    text(ctx, ascii(l), right - boxW + 6, by, 7, true);
    by -= 9;
  }
  page.drawLine({
    start: { x: left + 10, y: y - 34 },
    end: { x: left + 190, y: y - 34 },
    thickness: 0.6, color: LINE,
  });
  text(ctx, ascii(CARGO_ISSUER.name), left + 10, y - 45, 7.6, true);

  return pdf.save();
}
