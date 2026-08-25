// XLSX da Nota de Débito / Crédito — o mesmo documento do PDF, no formato das
// planilhas que a empresa mantém hoje (WILSON SONS/NOTAS DE DÉBITOS 2026.xlsx,
// uma aba por nota). Serve pra quem precisa editar a nota depois de gerada e
// pra colar na planilha do ano.
//
// A aba nasce com o nome "059-26 BSM QINZHOU", igual às abas atuais.

import * as XLSX from "xlsx-js-style";
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

const border = {
  top: { style: "thin", color: { rgb: "B7BAC0" } },
  bottom: { style: "thin", color: { rgb: "B7BAC0" } },
  left: { style: "thin", color: { rgb: "B7BAC0" } },
  right: { style: "thin", color: { rgb: "B7BAC0" } },
};

const S = {
  issuer: { font: { sz: 8, color: { rgb: "6B7280" } }, alignment: { horizontal: "right" } },
  small: { font: { sz: 8, color: { rgb: "6B7280" } } },
  band: {
    font: { bold: true, sz: 11 },
    fill: { patternType: "solid", fgColor: { rgb: "E5E9F0" } },
    alignment: { horizontal: "center", vertical: "center" },
    border,
  },
  bandNum: {
    font: { bold: true, sz: 11 },
    fill: { patternType: "solid", fgColor: { rgb: "E5E9F0" } },
    alignment: { horizontal: "right", vertical: "center" },
    border,
  },
  dest: { font: { bold: true, sz: 9 }, alignment: { wrapText: true, vertical: "center" }, border },
  destSub: { font: { sz: 8, color: { rgb: "6B7280" } }, alignment: { wrapText: true }, border },
  highlightLabel: {
    font: { bold: true, sz: 9 },
    fill: { patternType: "solid", fgColor: { rgb: "FFF59D" } },
    border,
  },
  ref: { font: { bold: true, sz: 10 }, border },
  refSub: { font: { sz: 8 }, border },
  header: {
    font: { bold: true, sz: 9 },
    fill: { patternType: "solid", fgColor: { rgb: "E5E9F0" } },
    alignment: { horizontal: "center", vertical: "center" },
    border,
  },
  cell: { font: { sz: 9 }, alignment: { wrapText: true, vertical: "center" }, border },
  cellBold: { font: { bold: true, sz: 9 }, alignment: { wrapText: true, vertical: "center" }, border },
  cellMemo: { font: { sz: 8, italic: true, color: { rgb: "6B7280" } }, border },
  totalLabel: {
    font: { bold: true, sz: 9 },
    fill: { patternType: "solid", fgColor: { rgb: "E5E9F0" } },
    border,
  },
  due: {
    font: { bold: true, sz: 9 },
    fill: { patternType: "solid", fgColor: { rgb: "FFF59D" } },
    alignment: { horizontal: "center" },
    border,
  },
  obs: {
    font: { bold: true, sz: 8 },
    fill: { patternType: "solid", fgColor: { rgb: "E5E9F0" } },
    alignment: { horizontal: "center" },
    border,
  },
  deposit: { font: { bold: true, sz: 9 }, border },
} as const;

function moneyStyle(base: Record<string, unknown>, currency: string) {
  const fmt = currency === "USD" ? '"USD" #,##0.00' : '"R$" #,##0.00';
  return { ...base, numFmt: fmt, alignment: { horizontal: "right", vertical: "center" } };
}

export function buildFiscalNoteXlsx(note: FiscalNoteInput): ArrayBuffer {
  const L = NOTE_LABELS[note.language] ?? NOTE_LABELS.PT;
  const isDebit = note.kind === "DEBITO";
  const totals = calcFiscalNoteTotals(note.items, note.iss_percent);
  const symbol = CURRENCY_SYMBOL[note.currency];
  const money = (b: Record<string, unknown>) => moneyStyle(b, note.currency);

  const ws: XLSX.WorkSheet = {};
  const merges: XLSX.Range[] = [];
  const set = (addr: string, v: string | number | null, s: Record<string, unknown>, t?: "s" | "n") => {
    const type = t ?? (typeof v === "number" ? "n" : "s");
    ws[addr] = { t: type, v: v ?? "", s };
  };
  // Colunas: B=descrição … F=total (mesmo desenho das planilhas atuais).
  const merge = (c1: number, r1: number, c2: number, r2: number) =>
    merges.push({ s: { c: c1, r: r1 }, e: { c: c2, r: r2 } });

  let row = 1;

  // ── Timbrado ──────────────────────────────────────────────────────────────
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
    set(`D${row}`, l, S.issuer);
    merge(3, row - 1, 5, row - 1);
    row++;
  }
  row++;
  set(`B${row}`, formatIssueCity(note.issue_date), S.small);
  row += 1;

  // ── Faixa do tipo + número ────────────────────────────────────────────────
  set(`B${row}`, isDebit ? L.debito : L.credito, S.band);
  merge(1, row - 1, 4, row - 1);
  set(`F${row}`, formatNoteNumber(note.number, note.year), S.bandNum);
  row++;

  // ── Destinatário + valor total ────────────────────────────────────────────
  const headerLine = resolveHeaderLine(
    note.header_line,
    note.ship_name,
    note.client_legal_name || note.client_name,
  );
  set(`B${row}`, headerLine, S.dest);
  merge(1, row - 1, 3, row - 1);
  set(`E${row}`, L.invoiceTotal, S.highlightLabel);
  set(`F${row}`, totals.total, money(S.highlightLabel), "n");
  row++;
  if (note.client_address) {
    set(`B${row}`, note.client_address, S.destSub);
    merge(1, row - 1, 5, row - 1);
    row++;
  }
  const docLine = [
    note.client_cnpj ? `CNPJ: ${note.client_cnpj}` : "",
    note.client_ie ? `I.E.: ${note.client_ie}` : "",
    note.client_municipal ? `Insc. Munic.: ${note.client_municipal}` : "",
  ].filter(Boolean).join(" - ");
  if (docLine) {
    set(`B${row}`, docLine, S.destSub);
    merge(1, row - 1, 5, row - 1);
    row++;
  }
  row++;

  // ── Ref. do navio ─────────────────────────────────────────────────────────
  set(`B${row}`, `${L.ref}  ${note.ship_name}`, S.ref);
  merge(1, row - 1, 5, row - 1);
  row++;
  for (const l of [
    note.oi ? `${L.oi} ${note.oi}` : "",
    note.arrival_date ? `${L.arrival} ${formatNoteDate(note.arrival_date)}` : "",
    note.departure_date ? `${L.departure} ${formatNoteDate(note.departure_date)}` : "",
    note.port ? `${L.port} ${note.port}` : "",
  ].filter(Boolean)) {
    set(`B${row}`, l, S.refSub);
    merge(1, row - 1, 5, row - 1);
    row++;
  }
  row++;

  // ── Tabela ────────────────────────────────────────────────────────────────
  set(`B${row}`, L.description, S.header);
  merge(1, row - 1, 2, row - 1);
  set(`D${row}`, L.debit, S.header);
  set(`E${row}`, L.credit, S.header);
  set(`F${row}`, L.total, S.header);
  row++;

  for (const item of [...note.items].sort((a, b) => a.position - b.position)) {
    set(`B${row}`, item.description, S.cellBold);
    merge(1, row - 1, 2, row - 1);
    set(`D${row}`, isDebit ? Number(item.amount) : "", isDebit ? money(S.cell) : S.cell, isDebit ? "n" : "s");
    set(`E${row}`, isDebit ? "" : Number(item.amount), isDebit ? S.cell : money(S.cell), isDebit ? "s" : "n");
    set(`F${row}`, "", S.cell);
    row++;
    if (item.unit_value && item.quantity) {
      const memo = `${symbol} ${Number(item.unit_value).toLocaleString("pt-BR", { minimumFractionDigits: 2 })} x ${Number(item.quantity).toLocaleString("pt-BR")}`;
      set(`B${row}`, memo, S.cellMemo);
      merge(1, row - 1, 2, row - 1);
      set(`D${row}`, "", S.cellMemo);
      set(`E${row}`, "", S.cellMemo);
      set(`F${row}`, "", S.cellMemo);
      row++;
    }
  }

  if (totals.issValue > 0) {
    const pct = Number(note.iss_percent || 0);
    set(`B${row}`, `${L.iss} (${pct.toLocaleString("pt-BR", { maximumFractionDigits: 4 })}%) - ${L.issValue}`, S.cellBold);
    merge(1, row - 1, 2, row - 1);
    set(`D${row}`, isDebit ? "" : totals.issValue, isDebit ? S.cell : money(S.cell), isDebit ? "s" : "n");
    set(`E${row}`, isDebit ? totals.issValue : "", isDebit ? money(S.cell) : S.cell, isDebit ? "n" : "s");
    set(`F${row}`, "", S.cell);
    row++;
  }

  for (const l of [
    note.due_date ? `${L.due} ${formatNoteDate(note.due_date)}` : "",
    note.exchange_rate
      ? `${L.exchange} ${Number(note.exchange_rate).toLocaleString("pt-BR", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`
      : "",
    (note.notes || "").trim(),
  ].filter(Boolean)) {
    set(`B${row}`, l, l.startsWith(L.due) ? S.due : S.refSub);
    merge(1, row - 1, 2, row - 1);
    set(`D${row}`, "", S.cell);
    set(`E${row}`, "", S.cell);
    set(`F${row}`, "", S.cell);
    row++;
  }

  // ── SUB-TOTAL / TOTAL ─────────────────────────────────────────────────────
  const debitSum = isDebit ? totals.subtotal : totals.issValue;
  const creditSum = isDebit ? totals.issValue : totals.subtotal;
  set(`B${row}`, L.subtotal, S.cellBold);
  merge(1, row - 1, 2, row - 1);
  set(`D${row}`, debitSum, money(S.cell), "n");
  set(`E${row}`, creditSum, money(S.cell), "n");
  set(`F${row}`, "", S.cell);
  row++;

  set(`B${row}`, L.grandTotal, S.totalLabel);
  merge(1, row - 1, 2, row - 1);
  set(`D${row}`, debitSum, money(S.totalLabel), "n");
  set(`E${row}`, creditSum, money(S.totalLabel), "n");
  set(`F${row}`, totals.total, money(S.totalLabel), "n");
  row++;

  set(`B${row}`, note.currency === "USD" ? L.obsUSD : L.obsBRL, S.obs);
  merge(1, row - 1, 5, row - 1);
  row++;

  set(`B${row}`, isDebit ? L.inFavorDebit : L.inFavorCredit, S.cellBold);
  merge(1, row - 1, 4, row - 1);
  set(`F${row}`, totals.total, money(S.cellBold), "n");
  row += 3;

  // ── Depósito ──────────────────────────────────────────────────────────────
  for (const l of [
    L.deposit,
    CARGO_ISSUER.bank,
    `Agência: ${CARGO_ISSUER.agency}`,
    `Conta Corrente: ${CARGO_ISSUER.account}`,
    `PIX: ${CARGO_ISSUER.pix}`,
  ]) {
    set(`E${row}`, l, S.deposit);
    merge(4, row - 1, 5, row - 1);
    row++;
  }
  row++;
  set(`B${row}`, CARGO_ISSUER.name, { font: { bold: true, sz: 9 } });

  ws["!ref"] = `A1:G${row + 2}`;
  ws["!cols"] = [
    { wch: 3 }, { wch: 52 }, { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 4 },
  ];
  ws["!merges"] = merges;

  const wb = XLSX.utils.book_new();
  // Nome da aba no padrão das planilhas atuais ("059-26 BSM QINZHOU"); o Excel
  // limita a 31 caracteres e proíbe : \ / ? * [ ].
  const tab = `${String(note.number).padStart(3, "0")}-${String(note.year).slice(-2)} ${note.ship_name}`
    .replace(/[:\\/?*[\]]/g, "-")
    .slice(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, tab);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}
