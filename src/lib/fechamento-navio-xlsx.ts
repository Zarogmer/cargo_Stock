// Excel do Fechamento de Navio — a folha da aba Financeiro › Fechamento de
// Navio no formato da planilha da diretoria ("42 - FECHAMENTO EUROPA GRAECA -
// WILSONSONS - SANTOS.xlsx", aba LIMPEZA): logo no topo, título em negrito,
// CLIENTE/SUPERVISOR, linhas de VALOR COBRADO, taxa do dólar e total em real
// (quando cobra em USD), tabela numerada de funcionários, MÃO DE OBRA,
// despesas, DESPESAS DIVERSAS, TOTAL GERAL e rodapé da empresa.
//
// Igual à planilha original, a paga de cada um sai como FÓRMULA ("=250*7",
// "=250*7+100*7-50") e os totais são SUM — a diretoria segue mexendo no Excel
// como sempre fez. O valor calculado vai em cache (`v`) pra visualizadores
// sem motor de cálculo (preview do WhatsApp/Drive) mostrarem o número.
//
// Mesma lib e mesmo estilo das planilhas anuais (relatorios-anuais-xlsx.ts).
// Roda no cliente; o logo entra pelo xlsx-logo.ts.

import * as XLSX from "xlsx-js-style";
import {
  COMPANY_FOOTER,
  closingServiceKind,
  computeClosing,
  formatNumberBR,
  type ClosingCharge,
  type ClosingDoc,
  type ClosingWorker,
} from "@/lib/fechamento-navio";
import { xlsxBlobWithLogo } from "@/lib/xlsx-logo";

type Cell = XLSX.CellObject & { s?: Record<string, unknown> };

const thin = { style: "thin", color: { rgb: "000000" } };
const border = { top: thin, bottom: thin, left: thin, right: thin };
const SERIF = "Times New Roman";

const S = {
  title: { font: { name: SERIF, bold: true, sz: 13 }, alignment: { vertical: "center" } },
  line: { font: { name: "Calibri", sz: 11 } },
  lineMoney: { font: { name: SERIF, sz: 10 }, alignment: { horizontal: "right" } },
  rowNo: { font: { name: SERIF, sz: 11 }, alignment: { horizontal: "center", vertical: "center" }, border },
  name: { font: { name: SERIF, sz: 11 }, alignment: { vertical: "center" }, border },
  value: { font: { name: SERIF, sz: 11 }, alignment: { horizontal: "center", vertical: "center" }, border },
  totalNo: { font: { name: SERIF, bold: true, sz: 11 }, fill: { patternType: "solid", fgColor: { rgb: "FFF59D" } }, alignment: { horizontal: "center", vertical: "center" }, border },
  totalLabel: { font: { name: SERIF, bold: true, sz: 11 }, fill: { patternType: "solid", fgColor: { rgb: "FFF59D" } }, alignment: { vertical: "center" }, border },
  totalValue: { font: { name: SERIF, bold: true, sz: 11 }, fill: { patternType: "solid", fgColor: { rgb: "FFF59D" } }, alignment: { horizontal: "center", vertical: "center" }, border },
  resultLabel: { font: { name: "Calibri", bold: true, sz: 10, color: { rgb: "374151" } } },
  resultValue: { font: { name: "Calibri", bold: true, sz: 11 }, alignment: { horizontal: "right" } },
  footer: { font: { name: "Calibri", sz: 8, color: { rgb: "6B7280" } } },
};

const NUM_FMT = "#,##0.00";
const BRL_FMT = '"R$" #,##0.00';
const USD_FMT = '"USD" #,##0.00';
const RATE_FMT = "0.0000";

// Estilo sempre clonado por célula: o xlsx-js-style grava o formato numérico
// dentro de `s` na hora de escrever (ver relatorios-anuais-xlsx.ts).
function text(v: string, s: Record<string, unknown>): Cell {
  return { t: "s", v, s: { ...s } };
}
function num(v: number, s: Record<string, unknown>, z = NUM_FMT): Cell {
  return { t: "n", v: +(Number(v) || 0).toFixed(4), s: { ...s }, z };
}
function formula(f: string, v: number, s: Record<string, unknown>, z = NUM_FMT): Cell {
  return { t: "n", f, v: +(Number(v) || 0).toFixed(2), s: { ...s }, z } as Cell;
}

// "250*7+100*7-50": a conta da paga como a diretoria escreve na planilha.
// null = valor simples (fixo sem extra/desconto) — vai como número.
function workerFormula(w: ClosingWorker, globalHolds: number): string | null {
  const fx = (n: number) => String(+(Number(n) || 0).toFixed(2));
  const signed = (n: number) => (n >= 0 ? `+${fx(n)}` : `-${fx(-n)}`);
  const rate = Number(w.rate) || 0;
  const fixed = Number(w.fixed_extra) || 0;
  const discount = Number(w.discount) || 0;
  if (w.mode === "FIXO") {
    if (!fixed && !discount) return null;
    return `${fx(rate)}${fixed ? signed(fixed) : ""}${discount ? signed(-discount) : ""}`;
  }
  const holds = w.holds != null && w.holds > 0 ? w.holds : Math.max(0, Number(globalHolds) || 0);
  const perHold = Number(w.extra_per_hold) || 0;
  let f = `${fx(rate)}*${holds}`;
  if (perHold) f += `${signed(perHold)}*${holds}`;
  if (fixed) f += signed(fixed);
  if (discount) f += signed(-discount);
  return f;
}

function chargeLine(c: ClosingCharge): string {
  return c.currency === "USD"
    ? `VALOR COBRADO USD ${formatNumberBR(c.amount)} ( DOLARES )${c.label ? ` ${c.label.toUpperCase()}` : ""}`
    : `VALOR COBRADO R$ ${formatNumberBR(c.amount)}${c.label ? ` ( ${c.label.toUpperCase()} )` : ""}`;
}

// Deixa as 4 primeiras linhas livres pro logo (ancorado em A1).
const LOGO_ANCHOR = { col: 0, row: 0, widthPx: 230, heightPx: 60, offsetXPx: 6, offsetYPx: 6 };
const FIRST_ROW = 6;

export function buildFechamentoWorkbook(doc: ClosingDoc): XLSX.WorkBook {
  const totals = computeClosing(doc);
  const cells: Record<string, Cell> = {};
  const A = (r: number) => `A${r}`;
  const B = (r: number) => `B${r}`;
  const C = (r: number) => `C${r}`;

  let row = FIRST_ROW;
  cells[B(row)] = text(totals.title || "", S.title);
  row++;
  cells[B(row)] = text(`CLIENTE: ${doc.client || "—"}${doc.supervisor ? `  -  SUPERVISOR  ${doc.supervisor}` : ""}`.toUpperCase(), S.line);
  row++;

  // Valores cobrados: texto igual ao da tela + o número na coluna C, pra
  // "Total em Real" ser fórmula.
  const usdCells: string[] = [];
  const brlCells: string[] = [];
  for (const c of doc.charges) {
    cells[B(row)] = text(chargeLine(c), S.line);
    cells[C(row)] = num(c.amount, S.lineMoney, c.currency === "USD" ? USD_FMT : BRL_FMT);
    (c.currency === "USD" ? usdCells : brlCells).push(C(row));
    row++;
  }
  let receitaRef = "";
  if (totals.hasUSD) {
    cells[B(row)] = text("TAXA DO DOLLAR R$", S.line);
    cells[C(row)] = doc.exchange_rate ? num(doc.exchange_rate, S.lineMoney, RATE_FMT) : text("", S.lineMoney);
    const rateRef = C(row);
    row++;
    cells[B(row)] = text("TOTAL SERVIÇO USD:", S.line);
    cells[C(row)] = formula(usdCells.join("+"), totals.usdTotal, S.lineMoney, USD_FMT);
    const usdRef = C(row);
    row++;
    cells[B(row)] = text("TOTAL EM REAL:", S.line);
    cells[C(row)] = formula([`${usdRef}*${rateRef}`, ...brlCells].join("+"), totals.totalBRL, S.lineMoney, BRL_FMT);
    receitaRef = C(row);
    row++;
  } else if (doc.charges.length > 1) {
    cells[B(row)] = text("TOTAL COBRADO R$", S.line);
    cells[C(row)] = formula(brlCells.join("+"), totals.totalBRL, S.lineMoney, BRL_FMT);
    receitaRef = C(row);
    row++;
  } else if (brlCells.length === 1) {
    receitaRef = brlCells[0];
  }
  row++;

  // ── Tabela numerada ──────────────────────────────────────────────────────
  let n = 0;
  const putRow = (name: string, value: Cell, bold = false) => {
    n += 1;
    cells[A(row)] = num(n, bold ? S.totalNo : S.rowNo, "0");
    cells[B(row)] = text(name, bold ? S.totalLabel : S.name);
    cells[C(row)] = value;
    row++;
  };
  const blankRow = () => putRow("", text("", S.value));

  const firstWorker = row;
  doc.workers.forEach((w, i) => {
    const f = workerFormula(w, doc.holds_count);
    putRow((w.name || "").toUpperCase(), f ? formula(f, totals.workerValues[i], S.value) : num(totals.workerValues[i], S.value));
  });
  for (const a of doc.admin) putRow((a.name || "").toUpperCase(), num(a.amount, S.value));
  const lastWorker = row - 1;
  blankRow();
  const maoRef = C(row);
  putRow("MÃO DE OBRA", formula(lastWorker >= firstWorker ? `SUM(C${firstWorker}:C${lastWorker})` : "0", totals.maoDeObra, S.totalValue), true);

  const firstExp = row;
  for (const e of doc.expenses) putRow((e.label || "").toUpperCase(), num(e.amount, S.value));
  const lastExp = row - 1;
  blankRow();
  const despRef = C(row);
  putRow("DESPESAS DIVERSAS", formula(lastExp >= firstExp ? `SUM(C${firstExp}:C${lastExp})` : "0", totals.despesas, S.totalValue), true);
  blankRow();
  const totalRef = C(row);
  putRow("TOTAL GERAL", formula(`${maoRef}+${despRef}`, totals.totalGeral, S.totalValue), true);

  // ── Resultado (os cards abaixo da folha na tela) ─────────────────────────
  row += 2;
  cells[B(row)] = text("RECEITA (R$)", S.resultLabel);
  cells[C(row)] = receitaRef ? formula(receitaRef, totals.totalBRL, S.resultValue, BRL_FMT) : num(totals.totalBRL, S.resultValue, BRL_FMT);
  const recRef = C(row);
  row++;
  cells[B(row)] = text("CUSTO TOTAL", S.resultLabel);
  cells[C(row)] = formula(totalRef, totals.totalGeral, S.resultValue, BRL_FMT);
  row++;
  cells[B(row)] = text(totals.resultado >= 0 ? "LUCRO" : "PREJUÍZO", S.resultLabel);
  cells[C(row)] = formula(`${recRef}-${totalRef}`, totals.resultado, S.resultValue, BRL_FMT);
  row++;

  // ── Rodapé ───────────────────────────────────────────────────────────────
  row += 2;
  for (const line of COMPANY_FOOTER) {
    cells[B(row)] = text(line, S.footer);
    row++;
  }

  const ws: XLSX.WorkSheet = { ...cells };
  ws["!ref"] = `A1:C${row}`;
  ws["!cols"] = [{ wch: 5 }, { wch: 52 }, { wch: 16 }];
  ws["!rows"] = [];
  ws["!rows"][FIRST_ROW - 1] = { hpt: 22 };
  ws["!margins"] = { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, closingServiceKind(doc) === "COSTADO" ? "COSTADO" : "LIMPEZA");
  return wb;
}

// Arquivo pronto pra baixar/compartilhar, com o logo da Cargo no topo.
export async function buildFechamentoXlsxBlob(doc: ClosingDoc): Promise<Blob> {
  return xlsxBlobWithLogo(buildFechamentoWorkbook(doc), LOGO_ANCHOR);
}
