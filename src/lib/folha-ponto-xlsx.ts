// Geração do arquivo Excel da Folha de Ponto no layout "CARGO SHIPS CLEANING".
// Mantido separado da rota (sem imports de servidor) pra poder ser testado
// isolado e reaproveitado. Uma aba por colaborador; o page setup (paisagem +
// ajustar à largura) é injetado no XML porque o xlsx-js-style não escreve
// <pageSetup>, garantindo um PDF limpo na conversão via LibreOffice.
import * as XLSX from "xlsx-js-style";
import PizZip from "pizzip";
import { CARGA_DIARIA_MIN, MESES_PT, WorkedKind, WorkedMap, computeFolha } from "./folha-ponto";

export interface FolhaEmployee {
  id: number;
  name: string;
  worked: WorkedMap; // dias trabalhados no mês (origem dos navios)
}

// ── Estilo ─────────────────────────────────────────────────────────────────────
const NAVY = "1F3864";
const GREY_HEAD = "D9D9D9";
const GREY_SECTION = "BFBFBF";
const YELLOW = "FFF2CC"; // células de "entrada/saída"
const BLUE_HL = "9DC3E6"; // domingos/feriados
const TEAL = "1F7A4D";
const RED = "C00000";
const BLUE_TXT = "0070C0";
const GREY_TXT = "BFBFBF";
const thin = { style: "thin", color: { rgb: "B7B7B7" } };
const borderAll = { top: thin, bottom: thin, left: thin, right: thin };
const F = "Calibri";
const HHMM = "hh:mm";
const HHMM_LONG = "[hh]:mm";

function excelSerial(year: number, month1: number, day: number): number {
  const utc = Date.UTC(year, month1 - 1, day);
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((utc - epoch) / 86400000);
}

function sanitizeSheetName(name: string, used: Set<string>): string {
  const base = (name || "Colaborador").replace(/[\\/?*[\]:]/g, "").trim().slice(0, 28) || "Colaborador";
  let n = base;
  let i = 2;
  while (used.has(n.toLowerCase())) n = `${base} ${i++}`.slice(0, 31);
  used.add(n.toLowerCase());
  return n;
}

function cargaLabelValue(): string {
  const h = String(Math.floor(CARGA_DIARIA_MIN / 60)).padStart(2, "0");
  const m = String(CARGA_DIARIA_MIN % 60).padStart(2, "0");
  return `${h}:${m}`;
}

// Constrói a worksheet de um colaborador.
function buildSheet(emp: FolhaEmployee, year: number, month1: number, jornada?: WorkedKind): XLSX.WorkSheet {
  const { rows: dayRows, totals: monthTotals } = computeFolha(emp.id, emp.worked, year, month1, jornada);
  const COLS = 16; // A..P
  const blankRow = () => Array(COLS).fill(null) as (string | number | null)[];
  const aoa: (string | number | null)[][] = [];

  // 0: título · 1: subtítulo · 2: branco · 3: cabeçalho de grupo · 4: branco · 5: cabeçalho de coluna
  aoa.push(["CARGO SHIPS CLEANING", ...Array(COLS - 1).fill(null)]);
  aoa.push([`FOLHA DE PONTO · ${MESES_PT[month1 - 1]} / ${year}`, ...Array(COLS - 1).fill(null)]);
  aoa.push(blankRow());

  const groupRow = blankRow();
  groupRow[0] = "Funcionário";
  groupRow[1] = emp.name.toUpperCase();
  groupRow[6] = "H.E. / Atrasos / A.N";
  groupRow[11] = "Distrib. H.E. p/ Faixa";
  groupRow[14] = "CARGA HORÁRIA";
  aoa.push(groupRow);

  aoa.push(blankRow());

  const headRow = blankRow();
  ["Data", "Dia Semana", "Entrada", "Saída", "Entrada", "Saída", "H. Diária", "Atrasos", "Abona", "Horas Extras", "A.N.", "1ª Faixa", "2ª Faixa"].forEach((h, i) => (headRow[i] = h));
  aoa.push(headRow);
  const HEAD_ROW = 5;

  const cargaLabels = ["SEGUNDA", "TERÇA", "QUARTA", "QUINTA", "SEXTA", "SÁBADO", "DOMINGO", "FERIADOS"];

  const dayMeta: { row: number; highlight: boolean }[] = [];
  for (const dr of dayRows) {
    const row = blankRow();
    row[0] = excelSerial(year, month1, dr.day);
    row[1] = dr.dayName;
    if (dr.worked && dr.times && dr.totals) {
      const t = dr.times, tot = dr.totals;
      row[2] = t.entrada1 / 1440;
      row[3] = t.saida1 / 1440;
      // Costado é corrido (sem 2º período) → colunas Entrada/Saída ficam vazias.
      row[4] = t.entrada2 != null ? t.entrada2 / 1440 : "-";
      row[5] = t.saida2 != null ? t.saida2 / 1440 : "-";
      row[6] = tot.hDiaria / 1440;
      row[7] = tot.atraso ? tot.atraso / 1440 : "-";
      row[8] = "-";
      row[9] = tot.he ? tot.he / 1440 : "-";
      row[10] = "-";
      row[11] = tot.faixa1 ? tot.faixa1 / 1440 : "-";
      row[12] = tot.faixa2 ? tot.faixa2 / 1440 : "-";
    } else {
      for (let c = 2; c <= 12; c++) row[c] = "-";
    }
    aoa.push(row);
    dayMeta.push({ row: aoa.length - 1, highlight: dr.highlight });
  }

  // Tabela lateral CARGA HORÁRIA (coluna O/P) a partir da linha de cabeçalho.
  for (let i = 0; i < cargaLabels.length; i++) {
    const r = HEAD_ROW + i;
    while (aoa.length <= r) aoa.push(blankRow());
    aoa[r][14] = cargaLabels[i];
    aoa[r][15] = cargaLabelValue();
  }

  const totalRow = blankRow();
  totalRow[0] = "TOTAIS";
  totalRow[6] = monthTotals.hDiaria ? monthTotals.hDiaria / 1440 : "-";
  totalRow[7] = monthTotals.atraso ? monthTotals.atraso / 1440 : "-";
  totalRow[9] = monthTotals.he ? monthTotals.he / 1440 : "-";
  totalRow[11] = monthTotals.faixa1 ? monthTotals.faixa1 / 1440 : "-";
  totalRow[12] = monthTotals.faixa2 ? monthTotals.faixa2 / 1440 : "-";
  aoa.push(totalRow);
  const TOTAL_ROW = aoa.length - 1;

  aoa.push(blankRow());
  const obsRow = blankRow();
  obsRow[0] = "OBSERVAÇÕES:";
  aoa.push(obsRow);
  const OBS_ROW = aoa.length - 1;

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const set = (r: number, c: number, s: Record<string, unknown>) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    const cell = ws[addr] as { s?: unknown } | undefined;
    if (cell) cell.s = s;
  };

  set(0, 0, { font: { name: F, sz: 18, bold: true, color: { rgb: NAVY } }, alignment: { horizontal: "center", vertical: "center" } });
  set(1, 0, { font: { name: F, sz: 11, bold: true, color: { rgb: "595959" } }, alignment: { horizontal: "center", vertical: "center" } });

  const sectionStyle = { font: { name: F, sz: 11, bold: true }, fill: { patternType: "solid", fgColor: { rgb: GREY_SECTION } }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll };
  set(3, 0, { font: { name: F, sz: 11, bold: true }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll });
  set(3, 1, { font: { name: F, sz: 12, bold: true, color: { rgb: NAVY } }, fill: { patternType: "solid", fgColor: { rgb: YELLOW } }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll });
  set(3, 6, sectionStyle);
  set(3, 11, sectionStyle);
  set(3, 14, sectionStyle);

  const headStyle = { font: { name: F, sz: 10, bold: true, color: { rgb: NAVY } }, fill: { patternType: "solid", fgColor: { rgb: GREY_HEAD } }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border: borderAll };
  for (let c = 0; c <= 12; c++) set(HEAD_ROW, c, headStyle);

  for (let i = 0; i < cargaLabels.length; i++) {
    const r = HEAD_ROW + i;
    set(r, 14, { font: { name: F, sz: 10, bold: true }, fill: { patternType: "solid", fgColor: { rgb: GREY_HEAD } }, alignment: { horizontal: "left", vertical: "center" }, border: borderAll });
    set(r, 15, { font: { name: F, sz: 10, bold: true, color: { rgb: NAVY } }, fill: { patternType: "solid", fgColor: { rgb: YELLOW } }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll });
  }

  for (const dm of dayMeta) {
    const r = dm.row;
    const dayFill = dm.highlight ? BLUE_HL : "FFFFFF";
    set(r, 0, { font: { name: F, sz: 10, bold: dm.highlight }, fill: { patternType: "solid", fgColor: { rgb: dayFill } }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll, numFmt: "dd/mm/yyyy" });
    set(r, 1, { font: { name: F, sz: 10, bold: dm.highlight }, fill: { patternType: "solid", fgColor: { rgb: dayFill } }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll });
    for (let c = 2; c <= 5; c++) {
      set(r, c, { font: { name: F, sz: 10 }, fill: { patternType: "solid", fgColor: { rgb: YELLOW } }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll, numFmt: HHMM });
    }
    const computed: [number, string][] = [[6, TEAL], [7, RED], [8, GREY_TXT], [9, BLUE_TXT], [10, GREY_TXT], [11, BLUE_TXT], [12, BLUE_TXT]];
    for (const [c, color] of computed) {
      const isText = typeof aoa[r][c] === "string";
      set(r, c, { font: { name: F, sz: 10, bold: c === 6, color: { rgb: isText ? GREY_TXT : color } }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll, numFmt: HHMM_LONG });
    }
  }

  set(TOTAL_ROW, 0, { font: { name: F, sz: 11, bold: true }, fill: { patternType: "solid", fgColor: { rgb: GREY_HEAD } }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll });
  const totColor: Record<number, string> = { 6: TEAL, 7: RED, 9: BLUE_TXT, 11: BLUE_TXT, 12: BLUE_TXT };
  for (let c = 1; c <= 12; c++) {
    const v = aoa[TOTAL_ROW][c];
    const isText = typeof v === "string" || v == null;
    set(TOTAL_ROW, c, { font: { name: F, sz: 11, bold: true, color: { rgb: isText ? GREY_TXT : (totColor[c] || "000000") } }, fill: { patternType: "solid", fgColor: { rgb: GREY_HEAD } }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll, numFmt: HHMM_LONG });
  }

  set(OBS_ROW, 0, { font: { name: F, sz: 10, bold: true, color: { rgb: "595959" } }, alignment: { horizontal: "left", vertical: "top" }, border: borderAll });
  for (let c = 1; c <= 12; c++) set(OBS_ROW, c, { border: borderAll });

  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 12 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 12 } },
    { s: { r: 3, c: 1 }, e: { r: 3, c: 5 } },
    { s: { r: 3, c: 6 }, e: { r: 3, c: 10 } },
    { s: { r: 3, c: 11 }, e: { r: 3, c: 12 } },
    { s: { r: 3, c: 14 }, e: { r: 3, c: 15 } },
    { s: { r: TOTAL_ROW, c: 0 }, e: { r: TOTAL_ROW, c: 5 } },
    { s: { r: OBS_ROW, c: 0 }, e: { r: OBS_ROW, c: 12 } },
  ];
  ws["!cols"] = [
    { wch: 11 }, { wch: 12 }, { wch: 9 }, { wch: 9 }, { wch: 9 }, { wch: 9 },
    { wch: 10 }, { wch: 9 }, { wch: 8 }, { wch: 12 }, { wch: 8 }, { wch: 9 }, { wch: 9 },
    { wch: 2 }, { wch: 11 }, { wch: 8 },
  ];
  const rows: ({ hpt: number } | undefined)[] = [];
  rows[0] = { hpt: 26 };
  rows[1] = { hpt: 18 };
  rows[3] = { hpt: 20 };
  rows[HEAD_ROW] = { hpt: 28 };
  rows[OBS_ROW] = { hpt: 46 };
  ws["!rows"] = rows as { hpt: number }[];
  ws["!margins"] = { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 };

  return ws;
}

// Injeta page setup (paisagem + ajustar à largura) em cada worksheet.
function injectPageSetup(buf: Buffer): Buffer {
  const zip = new PizZip(buf);
  const files = zip.file(/xl\/worksheets\/sheet\d+\.xml$/);
  const pageSetup = `<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0" horizontalDpi="300" verticalDpi="300"/>`;
  for (const f of files) {
    let xml = f.asText();
    if (!xml.includes("<pageSetUpPr")) {
      xml = xml.replace(/(<worksheet[^>]*>)/, `$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`);
    }
    if (/<pageMargins[^>]*\/>/.test(xml)) {
      xml = xml.replace(/(<pageMargins[^>]*\/>)/, `$1${pageSetup}`);
    } else {
      xml = xml.replace(/(<\/worksheet>)/, `${pageSetup}$1`);
    }
    zip.file(f.name, xml);
  }
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

// Gera o workbook (uma aba por colaborador) já com page setup para PDF limpo.
// `jornada` filtra a folha por tipo (Costado/Embarque); sem ela, todos os dias.
export function buildFolhaPontoXlsx(
  employees: FolhaEmployee[],
  year: number,
  month1: number,
  jornada?: WorkedKind,
): Buffer {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const emp of employees) {
    const ws = buildSheet(emp, year, month1, jornada);
    XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(emp.name, used));
  }
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return injectPageSetup(buf);
}
