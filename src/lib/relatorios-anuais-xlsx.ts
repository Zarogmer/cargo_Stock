// Planilhas anuais da diretoria, geradas pelo sistema no formato dos arquivos
// que a empresa mantém à mão em "02 - CONTROLE DE PAGAMENTO/<ano>":
//   1 NAVIOS <ano>.xlsx                      — 1 linha por navio, numerado no ano
//   2 FUNCIONARIOS X NAVIOS <ano>.xlsx       — 1 aba por colaborador: navios em
//                                              que subiu e o valor no mês da saída
//   3 PAGAMENTOS DOS FUNCIONÁRIOS <ano>.xlsx — resumo: navios, porões e valor no ano
//
// Mesma numeração dos cards (computeShipYearNumbers) e mesma conta de ganho do
// Controle de Funcionários (computeEmployeeStats) — não inventa cálculo novo.
// Puro/sem Prisma; roda no cliente (xlsx-js-style pra bordas e formato).

import * as XLSX from "xlsx-js-style";
import type { EmployeeStats } from "@/lib/employee-stats";
import type { ShipYearNumber } from "@/lib/ship-number";
import type { Job } from "@/types/database";

export interface AnnualShipRow {
  id: string;
  name: string;
  arrival_date: string | null;
  departure_date: string | null;
  holds_count: number | null;
  client_name: string | null;
  port: string | null;
  cargo_type: string | null;
  services: string[] | null;
  status: string | null;
  // Desempate da numeração (computeShipYearNumbers); não vai pra planilha.
  created_at?: string | null;
}

const MONTHS = [
  "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
  "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
];

// Cabeçalho da lista de navios — igual às planilhas (a coluna A é o Nº do ano).
const SHIP_HEADERS = ["Nº", "NAVIOS", "ENTRADA", "SAIDA", "PORÕES", "CLIENTE", "PORTO", "PRODUTO", "EXECUTADO"];

// "EXECUTADO" das planilhas: LIMPEZA é a lavagem padrão; Raspagem/Pintura são
// os serviços extras. Costado também é limpeza (de costado).
const EXECUTADO_LABELS: Record<string, string> = {
  LAVAGEM_PORAO: "LIMPEZA",
  RASPAGEM: "RASPAGEM",
  PINTURA: "PINTURA",
  COSTADO: "LIMPEZA",
};

function executadoOf(services: string[] | null | undefined): string {
  const labels = (services || []).map((s) => EXECUTADO_LABELS[s] || s);
  return [...new Set(labels)].join(" / ");
}

function produtoOf(ship: Pick<AnnualShipRow, "cargo_type" | "services">): string {
  if (ship.cargo_type) return ship.cargo_type;
  return (ship.services || []).includes("COSTADO") ? "COSTADO" : "";
}

// ── Células ────────────────────────────────────────────────────────────────

type Cell = XLSX.CellObject & { s?: Record<string, unknown> };

const thin = { style: "thin", color: { rgb: "9CA3AF" } };
const border = { top: thin, bottom: thin, left: thin, right: thin };

const S = {
  title: { font: { name: "Calibri", bold: true, sz: 16 } },
  label: { font: { name: "Calibri", bold: true, sz: 11 } },
  header: {
    font: { name: "Calibri", bold: true, sz: 11 },
    fill: { patternType: "solid", fgColor: { rgb: "E5E9F0" } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border,
  },
  cell: { font: { name: "Calibri", sz: 11 }, border },
  cellCenter: { font: { name: "Calibri", sz: 11 }, alignment: { horizontal: "center" }, border },
  cellBold: { font: { name: "Calibri", bold: true, sz: 11 }, alignment: { horizontal: "center" }, border },
  total: {
    font: { name: "Calibri", bold: true, sz: 11 },
    fill: { patternType: "solid", fgColor: { rgb: "FFF59D" } },
    border,
  },
  note: { font: { name: "Calibri", italic: true, sz: 9, color: { rgb: "6B7280" } } },
};

const DATE_FMT = "dd/mm/yyyy";
const MONEY_FMT = '"R$" #,##0.00';

// ISO "2026-08-26" → serial do Excel (dia inteiro, sem fuso).
function excelDate(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

// O estilo é SEMPRE clonado por célula: o xlsx-js-style grava o formato numérico
// (`z`) dentro do objeto `s` na hora de escrever, então um estilo compartilhado
// entre uma data e um número faria o número virar data (5 → 05/01/1900).
function text(v: string | null | undefined, s: Record<string, unknown> = S.cell): Cell {
  return { t: "s", v: v ?? "", s: { ...s } };
}
function num(v: number | null | undefined, s: Record<string, unknown> = S.cellCenter, z?: string): Cell {
  if (v == null || !Number.isFinite(v)) return { t: "s", v: "", s: { ...s } };
  return { t: "n", v, s: { ...s }, ...(z ? { z } : {}) };
}
function date(iso: string | null | undefined, s: Record<string, unknown> = S.cellCenter): Cell {
  const serial = excelDate(iso);
  if (serial == null) return { t: "s", v: "", s: { ...s } };
  return { t: "n", v: serial, z: DATE_FMT, s: { ...s } };
}
// Fórmula + valor já calculado em cache: o Excel recalcula ao abrir, mas
// visualizadores sem motor de cálculo (preview do Drive/WhatsApp) mostram `v`.
function formula(f: string, v: number, s: Record<string, unknown> = S.total, z?: string): Cell {
  return { t: "n", f, v: +v.toFixed(2), s: { ...s }, ...(z ? { z } : {}) } as Cell;
}

// Monta a aba a partir de um mapa {A1: cell}. Mais legível que AoA quando as
// linhas têm colunas vazias no meio (valor só no mês certo).
function sheetFromCells(cells: Record<string, Cell>, cols: number[], maxRow: number, maxCol: number): XLSX.WorkSheet {
  const ws: XLSX.WorkSheet = { ...cells };
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxRow - 1, c: maxCol - 1 } });
  ws["!cols"] = cols.map((wch) => ({ wch }));
  return ws;
}

function addr(col: number, row: number): string {
  return XLSX.utils.encode_cell({ c: col, r: row - 1 });
}

// Linha de navio (colunas A..I) — compartilhada pelas planilhas 1 e 2.
function putShipRow(
  cells: Record<string, Cell>,
  row: number,
  ship: AnnualShipRow,
  numberCell: Cell,
  holdsOverride?: number | null,
) {
  cells[addr(0, row)] = numberCell;
  cells[addr(1, row)] = text(ship.name);
  cells[addr(2, row)] = date(ship.arrival_date);
  cells[addr(3, row)] = date(ship.departure_date);
  cells[addr(4, row)] = num(holdsOverride !== undefined ? holdsOverride : ship.holds_count);
  cells[addr(5, row)] = text(ship.client_name);
  cells[addr(6, row)] = text(ship.port);
  cells[addr(7, row)] = text(produtoOf(ship));
  cells[addr(8, row)] = text(executadoOf(ship.services));
}

function putHeaders(cells: Record<string, Cell>, row: number, headers: string[]) {
  headers.forEach((h, i) => { cells[addr(i, row)] = text(h, S.header); });
}

const SHIP_COL_WIDTHS = [7, 30, 13, 13, 9, 20, 25, 22, 22];

function toArrayBuffer(wb: XLSX.WorkBook): ArrayBuffer {
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

// ── 1 NAVIOS <ano> ──────────────────────────────────────────────────────────

export function buildNaviosXlsx(
  year: number,
  ships: AnnualShipRow[],
  numbers: Map<string, ShipYearNumber>,
): ArrayBuffer {
  const rows = ships
    .filter((s) => numbers.get(s.id)?.year === year)
    .sort((a, b) => (numbers.get(a.id)!.n - numbers.get(b.id)!.n));

  const cells: Record<string, Cell> = {};
  cells["B1"] = text(`NAVIOS ${year}`, S.title);
  cells["B3"] = text(`Gerado pelo Cargo Stock em ${new Date().toLocaleDateString("pt-BR")} · ${rows.length} navio(s)`, S.note);
  putHeaders(cells, 5, SHIP_HEADERS);
  let row = 6;
  for (const s of rows) {
    putShipRow(cells, row, s, num(numbers.get(s.id)!.n, S.cellBold));
    row++;
  }
  const last = row - 1;
  if (rows.length > 0) {
    row++;
    cells[addr(0, row)] = text("TOTAL", S.total);
    cells[addr(1, row)] = formula(`COUNTA(B6:B${last})`, rows.length);
    cells[addr(4, row)] = formula(`SUM(E6:E${last})`, rows.reduce((t, s) => t + (s.holds_count || 0), 0));
    for (let c = 2; c <= 8; c++) if (!cells[addr(c, row)]) cells[addr(c, row)] = text("", S.total);
  }
  const ws = sheetFromCells(cells, SHIP_COL_WIDTHS, Math.max(row, 6), SHIP_HEADERS.length);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `NAVIOS ${year}`);
  return toArrayBuffer(wb);
}

// ── 2 FUNCIONARIOS X NAVIOS <ano> ───────────────────────────────────────────

// Mês da coluna do valor: a planilha lança o ganho do navio no mês da SAÍDA
// (fim da operação); navio ainda aberto cai no mês da entrada.
function monthOfJob(job: Job | undefined): number | null {
  const iso = job?.end_date || job?.start_date;
  if (!iso) return null;
  const m = parseInt(iso.slice(5, 7), 10) - 1;
  return m >= 0 && m < 12 ? m : null;
}

// Nome de aba válido no Excel: sem []:*?/\ e até 31 caracteres; único no arquivo.
function sheetName(name: string, used: Set<string>): string {
  const base = name.replace(/[\[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 31) || "SEM NOME";
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) {
    const suffix = ` (${i++})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate);
  return candidate;
}

export function buildFuncionariosNaviosXlsx(
  year: number,
  stats: EmployeeStats[],
  jobs: Job[],
  ships: AnnualShipRow[],
  numbers: Map<string, ShipYearNumber>,
): ArrayBuffer {
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const shipById = new Map(ships.map((s) => [s.id, s]));
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();

  const worked = stats
    .filter((s) => s.history.length > 0)
    .sort((a, b) => a.employee.name.localeCompare(b.employee.name, "pt-BR"));

  const headers = [...SHIP_HEADERS, ...MONTHS];
  const cols = [...SHIP_COL_WIDTHS, ...MONTHS.map(() => 13), 14];

  for (const st of worked) {
    // Agrupa o histórico por navio (job): no Costado cada turno é uma linha do
    // histórico, mas a planilha tem 1 linha por navio.
    const byJob = new Map<string, { earnings: number; poroes: number | null; turnos: number; kind: "EMBARQUE" | "COSTADO" }>();
    for (const h of st.history) {
      const cur = byJob.get(h.jobId) || { earnings: 0, poroes: null, turnos: 0, kind: h.kind };
      cur.earnings += h.earnings;
      if (h.kind === "EMBARQUE") cur.poroes = h.poroes ?? cur.poroes;
      else cur.turnos += h.quantity;
      byJob.set(h.jobId, cur);
    }
    const entries = [...byJob.entries()]
      .map(([jobId, agg]) => {
        const job = jobById.get(jobId);
        const ship = job?.ship_id ? shipById.get(job.ship_id) : undefined;
        return { jobId, job, ship, agg };
      })
      .sort((a, b) => ((a.job?.start_date || "").localeCompare(b.job?.start_date || "")));

    const cells: Record<string, Cell> = {};
    cells["B1"] = text(`NAVIOS ${year}`, S.title);
    cells["B3"] = text("Nome", S.label);
    cells["C3"] = text(st.employee.name, S.label);
    putHeaders(cells, 5, headers);

    // Totais em cache (valor de cada fórmula da linha TOTAL).
    const monthTotals = Array<number>(12).fill(0);
    let holdsTotal = 0;
    let row = 6;
    for (const e of entries) {
      const shipRow: AnnualShipRow = e.ship || {
        id: e.jobId,
        name: e.job?.name || "—",
        arrival_date: e.job?.start_date || null,
        departure_date: e.job?.end_date || null,
        holds_count: e.job?.holds_count ?? null,
        client_name: e.job?.client || null,
        port: e.job?.port || null,
        cargo_type: e.job?.cargo_type || null,
        services: e.agg.kind === "COSTADO" ? ["COSTADO"] : null,
        status: null,
      };
      const numCell = e.ship && numbers.get(e.ship.id)
        ? num(numbers.get(e.ship.id)!.n, S.cellBold)
        : text("", S.cellBold);
      const holds = e.agg.kind === "EMBARQUE" ? (e.agg.poroes ?? shipRow.holds_count) : null;
      putShipRow(cells, row, shipRow, numCell, holds);
      if (e.agg.kind === "COSTADO") {
        cells[addr(8, row)] = text(`COSTADO · ${e.agg.turnos} turno(s)`);
      }
      // Valor do navio na coluna do mês; as outras 11 ficam vazias (com borda).
      const m = monthOfJob(e.job);
      for (let i = 0; i < 12; i++) {
        cells[addr(9 + i, row)] = i === m ? num(+e.agg.earnings.toFixed(2), S.cell, MONEY_FMT) : text("", S.cell);
      }
      if (m != null) monthTotals[m] += e.agg.earnings;
      holdsTotal += holds || 0;
      row++;
    }
    const last = row - 1;
    row++;
    cells[addr(0, row)] = text("TOTAL", S.total);
    cells[addr(1, row)] = formula(`COUNTA(B6:B${last})`, entries.length);
    for (let c = 2; c <= 8; c++) cells[addr(c, row)] = text("", S.total);
    cells[addr(4, row)] = formula(`SUM(E6:E${last})`, holdsTotal);
    for (let i = 0; i < 12; i++) {
      const col = XLSX.utils.encode_col(9 + i);
      cells[addr(9 + i, row)] = formula(`SUM(${col}6:${col}${last})`, monthTotals[i], S.total, MONEY_FMT);
    }
    cells[addr(21, row - 1)] = text(`TOTAL ${year}`, S.label);
    cells[addr(21, row)] = formula(
      `SUM(${addr(9, row)}:${addr(20, row)})`,
      monthTotals.reduce((t, v) => t + v, 0),
      S.total,
      MONEY_FMT,
    );

    const ws = sheetFromCells(cells, cols, row, 22);
    XLSX.utils.book_append_sheet(wb, ws, sheetName(st.employee.name, used));
  }

  if (worked.length === 0) {
    const cells: Record<string, Cell> = {
      B1: text(`NAVIOS ${year}`, S.title),
      B3: text("Nenhum colaborador com navio neste ano.", S.note),
    };
    XLSX.utils.book_append_sheet(wb, sheetFromCells(cells, cols, 3, 3), `NAVIOS ${year}`);
  }
  return toArrayBuffer(wb);
}

// ── 3 PAGAMENTOS DOS FUNCIONÁRIOS <ano> ─────────────────────────────────────

export function buildPagamentosXlsx(year: number, stats: EmployeeStats[]): ArrayBuffer {
  const rows = [...stats].sort((a, b) => a.employee.name.localeCompare(b.employee.name, "pt-BR"));
  const headers = ["", "NOME", "ADMISSÃO", "NAVIOS", "PORÕES", `VALOR EM ${year}`, "13º SALÁRIO", "OBSERVAÇÃO"];

  // Destaques da planilha original: quem fez mais navios, quem ganhou mais e
  // quem fez menos (entre os que subiram em algum navio).
  const withShips = rows.filter((s) => s.jobIds.size > 0);
  const maxShips = Math.max(0, ...withShips.map((s) => s.jobIds.size));
  const minShips = withShips.length ? Math.min(...withShips.map((s) => s.jobIds.size)) : 0;
  const maxValue = Math.max(0, ...withShips.map((s) => s.totalEarnings));

  const cells: Record<string, Cell> = {};
  cells["B1"] = text(`RELATÓRIO GERAL DOS FUNCIONÁRIOS ${year}`, S.title);
  cells["B3"] = text(`Gerado pelo Cargo Stock em ${new Date().toLocaleDateString("pt-BR")}`, S.note);
  putHeaders(cells, 5, headers);
  let row = 6;
  rows.forEach((s, i) => {
    const obs: string[] = [];
    if (withShips.length > 1 && s.jobIds.size === maxShips && maxShips > 0) obs.push("MAIS NAVIOS");
    if (withShips.length > 1 && s.totalEarnings === maxValue && maxValue > 0) obs.push("MAIOR VALOR");
    if (withShips.length > 1 && s.jobIds.size === minShips && minShips !== maxShips) obs.push("MENOS NAVIOS");
    cells[addr(0, row)] = num(i + 1, S.cellCenter);
    cells[addr(1, row)] = text(s.employee.name);
    cells[addr(2, row)] = date(s.employee.admission_date);
    cells[addr(3, row)] = num(s.jobIds.size);
    cells[addr(4, row)] = num(s.embarque.poroes);
    cells[addr(5, row)] = num(+s.totalEarnings.toFixed(2), S.cell, MONEY_FMT);
    cells[addr(6, row)] = text("");
    cells[addr(7, row)] = text(obs.join(" · "));
    row++;
  });
  const last = row - 1;
  if (rows.length > 0) {
    row++;
    cells[addr(1, row)] = text("TOTAL", S.total);
    cells[addr(2, row)] = text("", S.total);
    cells[addr(3, row)] = formula(`SUM(D6:D${last})`, rows.reduce((t, s) => t + s.jobIds.size, 0));
    cells[addr(4, row)] = formula(`SUM(E6:E${last})`, rows.reduce((t, s) => t + s.embarque.poroes, 0));
    cells[addr(5, row)] = formula(`SUM(F6:F${last})`, rows.reduce((t, s) => t + s.totalEarnings, 0), S.total, MONEY_FMT);
    cells[addr(6, row)] = formula(`SUM(G6:G${last})`, 0, S.total, MONEY_FMT);
    cells[addr(7, row)] = text("", S.total);
  }
  const ws = sheetFromCells(cells, [5, 42, 13, 9, 9, 18, 16, 28], Math.max(row, 6), headers.length);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `RELATORIO GERAL ${year}`);
  return toArrayBuffer(wb);
}
