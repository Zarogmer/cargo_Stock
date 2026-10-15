// PDF do Fechamento de Navio, com pdf-lib (mesma stack dos Relatórios de
// Bordo e da Nota de Débito/Crédito). Reproduz a folha da aba Financeiro ›
// Fechamento de Navio exatamente como aparece na tela: timbrado da Cargo,
// título em negrito, CLIENTE/SUPERVISOR, linhas de VALOR COBRADO, taxa do
// dólar e total em real (quando cobra em USD), tabela numerada de
// funcionários (equipe + administrativo), MÃO DE OBRA, despesas, DESPESAS
// DIVERSAS, TOTAL GERAL, os cards de resultado e o rodapé da empresa.
//
// A tabela tem 3 colunas estreitas, então A4 retrato basta; folha com muita
// gente/despesa continua na página seguinte (ensure).

import { readFile } from "fs/promises";
import path from "path";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { safe } from "@/lib/report-pdf";
import { CARGO_ISSUER } from "@/lib/fiscal-note";
import {
  COMPANY_FOOTER,
  computeClosing,
  formatBRL,
  formatNumberBR,
  formatUSD,
  type ClosingCharge,
  type ClosingDoc,
} from "@/lib/fechamento-navio";

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 40;
const INK = rgb(0, 0, 0);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.72, 0.74, 0.78);
const BLUE_BG = rgb(0.937, 0.965, 1); // blue-50
const BLUE_FG = rgb(0.118, 0.227, 0.541);
const RED_BG = rgb(0.996, 0.949, 0.949); // red-50
const RED_FG = rgb(0.498, 0.114, 0.114);
const GREEN_BG = rgb(0.925, 0.992, 0.961); // emerald-50
const GREEN_FG = rgb(0.024, 0.306, 0.231);

interface Ctx {
  pdf: PDFDocument;
  page: PDFPage;
  sans: PDFFont;
  sansBold: PDFFont;
  serif: PDFFont;
  serifBold: PDFFont;
  y: number;
}

function draw(ctx: Ctx, s: string, x: number, y: number, font: PDFFont, size: number, color = INK) {
  ctx.page.drawText(safe(s), { x, y, size, font, color });
}
function drawRight(ctx: Ctx, s: string, right: number, y: number, font: PDFFont, size: number, color = INK) {
  const t = safe(s);
  ctx.page.drawText(t, { x: right - font.widthOfTextAtSize(t, size), y, size, font, color });
}
function drawCenter(ctx: Ctx, s: string, cx: number, y: number, font: PDFFont, size: number, color = INK) {
  const t = safe(s);
  ctx.page.drawText(t, { x: cx - font.widthOfTextAtSize(t, size) / 2, y, size, font, color });
}

function wrap(s: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = safe(s).split(/\s+/).filter(Boolean);
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

function chargeLine(c: ClosingCharge): string {
  return c.currency === "USD"
    ? `VALOR COBRADO USD ${formatNumberBR(c.amount)} ( DOLARES )${c.label ? ` ${c.label.toUpperCase()}` : ""}`
    : `VALOR COBRADO R$ ${formatNumberBR(c.amount)}${c.label ? ` ( ${c.label.toUpperCase()} )` : ""}`;
}

export async function buildFechamentoPdf(doc: ClosingDoc): Promise<Uint8Array> {
  const totals = computeClosing(doc);
  const pdf = await PDFDocument.create();
  const ctx: Ctx = {
    pdf,
    page: pdf.addPage(A4),
    sans: await pdf.embedFont(StandardFonts.Helvetica),
    sansBold: await pdf.embedFont(StandardFonts.HelveticaBold),
    serif: await pdf.embedFont(StandardFonts.TimesRoman),
    serifBold: await pdf.embedFont(StandardFonts.TimesRomanBold),
    y: A4[1] - MARGIN,
  };
  const left = MARGIN;
  const right = A4[0] - MARGIN;
  const innerW = right - left;

  // Antes de cada bloco: se não cabe, página nova.
  const ensure = (needed: number) => {
    if (ctx.y - needed < MARGIN) {
      ctx.page = pdf.addPage(A4);
      ctx.y = A4[1] - MARGIN;
    }
  };

  // ── Timbrado: logo à esquerda, dados da empresa à direita ─────────────────
  try {
    const logoBytes = await readFile(path.join(process.cwd(), "public", "cargo-logo.png"));
    const logo = await pdf.embedPng(logoBytes);
    const h = 46;
    const w = (logo.width / logo.height) * h;
    ctx.page.drawImage(logo, { x: left, y: ctx.y - h, width: w, height: h });
  } catch {
    // Sem logo o documento continua válido — só perde a marca.
    draw(ctx, "CARGO SHIPS CLEANING", left, ctx.y - 22, ctx.sansBold, 13);
  }
  let hy = ctx.y - 4;
  for (const l of [CARGO_ISSUER.address, CARGO_ISSUER.city, `Tel.: ${CARGO_ISSUER.phone}`, CARGO_ISSUER.email]) {
    hy -= 8.5;
    drawRight(ctx, l, right, hy, ctx.sans, 6.6, MUTED);
  }
  ctx.y -= 54;
  ctx.page.drawLine({ start: { x: left, y: ctx.y }, end: { x: right, y: ctx.y }, thickness: 0.6, color: LINE });
  ctx.y -= 22;

  // ── Título + cabeçalho ───────────────────────────────────────────────────
  for (const l of wrap(totals.title || "—", ctx.serifBold, 12.5, innerW)) {
    ensure(16);
    draw(ctx, l, left, ctx.y, ctx.serifBold, 12.5);
    ctx.y -= 16;
  }
  ctx.y -= 2;
  const headerLine = (s: string) => {
    for (const l of wrap(s, ctx.sans, 9.5, innerW)) {
      ensure(13);
      draw(ctx, l, left, ctx.y, ctx.sans, 9.5);
      ctx.y -= 13;
    }
  };
  headerLine(`CLIENTE: ${doc.client || "—"}${doc.supervisor ? `  -  SUPERVISOR  ${doc.supervisor}` : ""}`.toUpperCase());
  for (const c of doc.charges) headerLine(chargeLine(c));

  if (totals.hasUSD) {
    ctx.y -= 4;
    ensure(28);
    draw(ctx, `TAXA DO DOLLAR R$ ${doc.exchange_rate ? formatNumberBR(doc.exchange_rate, 4) : "—"} TOTAL SERVIÇO USD:`, left, ctx.y, ctx.sans, 9.5);
    drawRight(ctx, formatUSD(totals.usdTotal), right, ctx.y, ctx.serif, 9.5);
    ctx.y -= 13;
    draw(ctx, "Total em Real:", left, ctx.y, ctx.sans, 9.5);
    drawRight(ctx, formatBRL(totals.totalBRL), right, ctx.y, ctx.serif, 9.5);
    ctx.y -= 13;
  } else if (doc.charges.length > 1) {
    ctx.y -= 4;
    ensure(13);
    draw(ctx, `TOTAL COBRADO: R$ ${formatNumberBR(totals.totalBRL)}`, left, ctx.y, ctx.sans, 9.5);
    ctx.y -= 13;
  }
  ctx.y -= 8;

  // ── Tabela numerada (nº | nome | valor), bordas pretas como na tela ───────
  const colNo = 26;
  const colValue = 92;
  const tableW = Math.min(innerW, 430);
  const colName = tableW - colNo - colValue;
  const xNo = left;
  const xName = xNo + colNo;
  const xValue = xName + colName;
  const rowH = 16;
  let n = 0;
  const tableRow = (label: string, value: string, bold = false) => {
    ensure(rowH);
    n += 1;
    const y = ctx.y - rowH;
    const font = bold ? ctx.serifBold : ctx.serif;
    for (const [x, w] of [[xNo, colNo], [xName, colName], [xValue, colValue]] as Array<[number, number]>) {
      ctx.page.drawRectangle({ x, y, width: w, height: rowH, borderColor: INK, borderWidth: 0.6 });
    }
    drawCenter(ctx, String(n), xNo + colNo / 2, y + 4.5, font, 9.5);
    const lines = wrap(label, font, 9.5, colName - 8);
    draw(ctx, lines[0], xName + 4, y + 4.5, font, 9.5, label ? INK : MUTED);
    drawCenter(ctx, value, xValue + colValue / 2, y + 4.5, font, 9.5);
    ctx.y = y;
  };
  const blank = () => tableRow("", "");

  doc.workers.forEach((w, i) => tableRow((w.name || "—").toUpperCase(), formatNumberBR(totals.workerValues[i])));
  for (const a of doc.admin) tableRow((a.name || "—").toUpperCase(), formatNumberBR(a.amount));
  blank();
  tableRow("MÃO DE OBRA", formatNumberBR(totals.maoDeObra), true);
  for (const e of doc.expenses) tableRow((e.label || "—").toUpperCase(), formatNumberBR(e.amount));
  blank();
  tableRow("DESPESAS DIVERSAS", formatNumberBR(totals.despesas), true);
  blank();
  tableRow("TOTAL GERAL", formatNumberBR(totals.totalGeral), true);

  // ── Resultado: os três cards abaixo da folha ─────────────────────────────
  ctx.y -= 18;
  const cardH = 38;
  ensure(cardH);
  const gap = 8;
  const cardW = (innerW - gap * 2) / 3;
  const lucro = totals.resultado >= 0;
  const cards: Array<{ label: string; value: string; hint: string; bg: ReturnType<typeof rgb>; fg: ReturnType<typeof rgb> }> = [
    {
      label: "RECEITA (R$)",
      value: formatBRL(totals.totalBRL),
      hint: totals.hasUSD ? `${formatUSD(totals.usdTotal)} x ${doc.exchange_rate ? formatNumberBR(doc.exchange_rate, 4) : "taxa?"}` : "",
      bg: BLUE_BG, fg: BLUE_FG,
    },
    { label: "CUSTO TOTAL", value: formatBRL(totals.totalGeral), hint: "", bg: RED_BG, fg: RED_FG },
    {
      label: lucro ? "LUCRO" : "PREJUÍZO",
      value: formatBRL(Math.abs(totals.resultado)),
      hint: totals.totalBRL > 0 ? `${formatNumberBR((totals.resultado / totals.totalBRL) * 100, 1)}% da receita` : "",
      bg: lucro ? GREEN_BG : RED_BG, fg: lucro ? GREEN_FG : RED_FG,
    },
  ];
  cards.forEach((c, i) => {
    const x = left + i * (cardW + gap);
    const y = ctx.y - cardH;
    ctx.page.drawRectangle({ x, y, width: cardW, height: cardH, color: c.bg, borderColor: c.fg, borderWidth: 0.5, opacity: 1, borderOpacity: 0.35 });
    draw(ctx, c.label, x + 8, y + cardH - 12, ctx.sansBold, 6.5, c.fg);
    draw(ctx, c.value, x + 8, y + cardH - 25, ctx.sansBold, 11, c.fg);
    if (c.hint) draw(ctx, c.hint, x + 8, y + 5, ctx.sans, 6.2, c.fg);
  });
  ctx.y -= cardH;

  // ── Rodapé da empresa ────────────────────────────────────────────────────
  ctx.y -= 26;
  ensure(COMPANY_FOOTER.length * 9);
  for (const line of COMPANY_FOOTER) {
    draw(ctx, line, left, ctx.y, ctx.sans, 7, MUTED);
    ctx.y -= 9;
  }

  return pdf.save();
}
