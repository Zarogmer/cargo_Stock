import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO", "COMERCIAL", "FINANCEIRO"];

// Map of all expense categories in the order they should appear on the sheet.
// Matches the constant on the frontend (src/app/(dashboard)/financeiro/page.tsx).
const EXPENSE_CATEGORIES: Array<{ value: string; label: string }> = [
  { value: "COMPRAS",             label: "COMPRAS" },
  { value: "QUIMICA",             label: "QUÍMICA" },
  { value: "MATERIAL_DANIFICADO", label: "MATERIAL DANIFICADO" },
  { value: "MATERIAL_PERDIDO",    label: "MATERIAL PERDIDO" },
  { value: "AJUDA_DE_CUSTO",      label: "AJUDA DE CUSTO" },
  { value: "ALIMENTACAO",         label: "ALIMENTAÇÃO" },
  { value: "RESTAURANTE",         label: "JANTAR / RESTAURANTE" },
  { value: "OUTROS",              label: "OUTROS" },
];

// GET /api/financeiro/jobs/export-fechamento?jobId=...
// Generates an Excel file with the closing of a ship, laid out to match the
// "20 - FECHAMENTO MANDARIN KAOHSIUNG" template provided by the user:
//   1. Header with ship name + cargo + porões + porto + cliente + supervisor
//   2. "VALOR COBRADO" row (contract_value)
//   3. Worker list: # / nome / VALOR (= rate × days + extra_value rateio)
//      "MÃO DE OBRA" total row
//   4. Expenses grouped by category, then "DESPESAS DIVERSAS" total
//   5. "TOTAL GERAL" (mão de obra + despesas)
//
// Formulas (=SUM, =A+B) are written as formulas so the file stays dynamic
// when opened in Excel/LibreOffice.
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const jobId = request.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId obrigatório" }, { status: 400 });

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      ships: { select: { name: true, port: true, cargo_type: true, holds_count: true } },
      allocations: {
        where: { status: "ATIVO" },
        include: {
          employees: { select: { name: true } },
          job_functions: { select: { name: true } },
        },
        orderBy: { id: "asc" },
      },
      adjustments: { orderBy: { id: "asc" } },
    },
  });
  if (!job) return NextResponse.json({ error: "Fechamento não encontrado" }, { status: 404 });

  // ── Build the worksheet as an AoA (array of arrays) so column widths and
  // formula cells are easy to control row-by-row.
  const rows: (string | number | null)[][] = [];

  // Row 1-3: navio + cargo + porões + porto
  const shipHeader = [
    job.name || "",
    job.cargo_type || job.ships?.cargo_type || "",
    job.holds_count ? `${job.holds_count} PORÕES` : (job.ships?.holds_count ? `${job.ships.holds_count} PORÕES` : ""),
    job.port || job.ships?.port || "",
  ].filter(Boolean).join(" - ");
  rows.push([shipHeader]);
  // Supervisor = quem está na equipe do navio com a função SUPERVISOR; o campo
  // salvo no job é só fallback de legado.
  const supervisorName = job.allocations.find(
    (a) => (a.job_functions?.name || "").trim().toUpperCase() === "SUPERVISOR" && a.employees?.name,
  )?.employees?.name || job.supervisor;
  rows.push([
    job.client ? `CLIENTE: ${job.client}` : "",
    supervisorName ? `SUPERVISOR: ${supervisorName}` : "",
  ]);
  rows.push([]);
  rows.push(["VALOR COBRADO R$", Number(job.contract_value || 0)]);
  rows.push([]);

  // Workers table header
  rows.push(["#", "FUNCIONÁRIO", "FUNÇÃO", "DIAS", "VALOR DIÁRIO", "RATEIO", "VALOR"]);
  const firstWorkerRow = rows.length + 1; // 1-indexed for Excel
  for (let i = 0; i < job.allocations.length; i++) {
    const a = job.allocations[i];
    const name = a.employees?.name?.trim() || a.job_functions?.name || `Função ${a.function_id}`;
    const fn = a.job_functions?.name || "";
    const days = a.quantity;
    const rate = Number(a.rate);
    const extra = Number(a.extra_value || 0);
    const excelRow = firstWorkerRow + i;
    // Formula so opening in Excel and tweaking the rate/days/extra updates
    // the row total automatically.
    rows.push([i + 1, name, fn, days, rate, extra > 0 ? extra : null, { f: `D${excelRow}*E${excelRow}+IFERROR(F${excelRow},0)` } as unknown as number]);
  }
  const lastWorkerRow = firstWorkerRow + job.allocations.length - 1;

  // "MÃO DE OBRA" subtotal
  rows.push([]);
  const maoDeObraRow = rows.length + 1;
  rows.push([null, "MÃO DE OBRA", null, null, null, null, { f: `SUM(G${firstWorkerRow}:G${lastWorkerRow})` } as unknown as number]);
  rows.push([]);

  // Expenses, grouped by category
  rows.push(["", "DESPESAS", "", "", "", "", "VALOR"]);
  const firstExpRow = rows.length + 1;
  const sortedAdjs = [...job.adjustments].sort((a, b) => {
    const ai = EXPENSE_CATEGORIES.findIndex((c) => c.value === (a.category || "OUTROS"));
    const bi = EXPENSE_CATEGORIES.findIndex((c) => c.value === (b.category || "OUTROS"));
    return ai - bi;
  });
  for (const adj of sortedAdjs) {
    const catLabel = EXPENSE_CATEGORIES.find((c) => c.value === adj.category)?.label || "OUTROS";
    const signed = adj.type === "ADICIONAL" ? Number(adj.amount) : -Number(adj.amount);
    rows.push([null, catLabel, adj.description, null, null, null, signed]);
  }
  const lastExpRow = firstExpRow + sortedAdjs.length - 1;

  // "DESPESAS DIVERSAS" subtotal
  rows.push([]);
  const despesasRow = rows.length + 1;
  if (sortedAdjs.length > 0) {
    rows.push([null, "DESPESAS DIVERSAS", null, null, null, null, { f: `SUM(G${firstExpRow}:G${lastExpRow})` } as unknown as number]);
  } else {
    rows.push([null, "DESPESAS DIVERSAS", null, null, null, null, 0]);
  }

  // "TOTAL GERAL"
  rows.push([]);
  rows.push([null, "TOTAL GERAL", null, null, null, null, { f: `G${maoDeObraRow}+G${despesasRow}` } as unknown as number]);

  // ── Build worksheet and apply column widths + currency formatting ──────
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 4 },  // #
    { wch: 36 }, // Funcionário / Categoria
    { wch: 18 }, // Função / Descrição
    { wch: 6 },  // Dias
    { wch: 14 }, // Valor diário
    { wch: 12 }, // Rateio
    { wch: 14 }, // Valor
  ];

  // BRL currency on monetary columns (E, F, G) — let Excel render "R$ 1.234,56"
  const moneyCols = ["E", "F", "G"];
  const fmt = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
  for (let r = 1; r <= rows.length; r++) {
    for (const col of moneyCols) {
      const cell = ws[`${col}${r}`];
      if (cell && (typeof cell.v === "number" || cell.f)) {
        cell.z = fmt;
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "FECHAMENTO");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const safeName = (job.name || "fechamento").replace(/[^a-z0-9-_ ]/gi, "_").slice(0, 80);
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="Fechamento_${safeName}.xlsx"`,
    },
  });
}
