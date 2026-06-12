import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx-js-style";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { COMPRAS_ROLES } from "@/lib/rbac";
import type { Role } from "@/types/database";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Relatório de Controle de Compras em Excel, no mesmo layout da planilha oficial
// "PLANILHA DE COMPRAS - CARGO" (uma aba por mês): título + total no topo, cabeçalho
// e uma linha por compra. As colunas batem 1:1 com o modelo purchase_orders:
//   # · DESCRIÇÃO · DEPARTAMENTO · FORNECEDOR · DATA DA COMPRA · VALOR unit.(R$) ·
//   QUANTIDADE · VALOR total (R$) · FORMA DE PAGAMENTO · OBSERVAÇÃO
// Filtros (querystring): year (obrigatório), month (1-12, vazio = ano inteiro),
// department, supplier, payment_method.

const MONTH_NAMES = [
  "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
  "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
];

// Rótulo curto do destino/departamento — espelha DEST_SHORT_LABEL da página de
// Solicitações (o "Destino" no Almoxarifado é o que a planilha chama DEPARTAMENTO).
const DEST_LABEL: Record<string, string> = {
  ESTOQUE: "Estoque", RANCHO: "Rancho", EPI: "EPI",
  UNIFORME: "Uniforme", MAQUINARIO: "Maquinário", FERRAMENTA: "Ferramenta", ELETRICA: "Elétrica", ESCRITORIO: "Escritório", OUTROS: "Outros",
};
function deptLabel(d: string | null): string {
  if (!d) return "";
  return DEST_LABEL[d] || d;
}

// Serial do Excel (dias desde 1899-12-30), calculado em UTC pra não escorregar
// um dia por causa de fuso. purchase_date é @db.Date (meia-noite UTC).
function excelSerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((utc - epoch) / 86400000);
}

const BRL = 'R$ #,##0.00';
const QTY_FMT = '#,##0.###';
const thin = { style: "thin", color: { rgb: "B7B7B7" } };
const borderAll = { top: thin, bottom: thin, left: thin, right: thin };

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!COMPRAS_ROLES.includes(session.user.role as Role)) {
    return NextResponse.json({ error: "Sem permissão para gerar o relatório de compras." }, { status: 403 });
  }

  const sp = request.nextUrl.searchParams;
  const year = Number(sp.get("year"));
  if (!year || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Ano inválido." }, { status: 400 });
  }
  const monthRaw = sp.get("month");
  const month = monthRaw ? Number(monthRaw) : null; // 1-12 ou null (ano inteiro)
  if (month !== null && (month < 1 || month > 12)) {
    return NextResponse.json({ error: "Mês inválido." }, { status: 400 });
  }
  const dept = (sp.get("department") || "").trim();
  const supplier = (sp.get("supplier") || "").trim();
  const payment = (sp.get("payment_method") || "").trim();

  // Período: ano inteiro ou só um mês. Intervalo em UTC casa com o @db.Date.
  const start = month ? new Date(Date.UTC(year, month - 1, 1)) : new Date(Date.UTC(year, 0, 1));
  const end = month ? new Date(Date.UTC(year, month, 1)) : new Date(Date.UTC(year + 1, 0, 1));

  const where: Prisma.PurchaseOrderWhereInput = { purchase_date: { gte: start, lt: end } };
  if (dept) where.department = dept;
  if (supplier) where.supplier = supplier;
  if (payment) where.payment_method = payment;

  const purchases = await prisma.purchaseOrder.findMany({
    where,
    orderBy: [{ purchase_date: "asc" }, { created_at: "asc" }],
  });

  // ── Monta a planilha (AoA: array de arrays) ───────────────────────────────
  const headerRow = [
    "#", "DESCRIÇÃO", "DEPARTAMENTO", "FORNECEDOR", "DATA DA COMPRA",
    "VALOR unit.(R$)", "QUANTIDADE", "VALOR total (R$)", "FORMA DE PAGAMENTO", "OBSERVAÇÃO",
  ];

  const periodLabel = month ? `${MONTH_NAMES[month - 1]} DE ${year}` : `ANO DE ${year}`;
  const filterParts: string[] = [];
  if (dept) filterParts.push(`Destino: ${deptLabel(dept)}`);
  if (supplier) filterParts.push(`Fornecedor: ${supplier}`);
  if (payment) filterParts.push(`Pagamento: ${payment}`);
  const filterNote = filterParts.length
    ? `Filtros — ${filterParts.join(" · ")}`
    : "Todos os destinos, fornecedores e formas de pagamento";

  const lastRow = 2 + purchases.length; // última linha de dados (1-indexed Excel)

  // Linha 1 (título). Células nulas não viram cell — só as preenchidas existem.
  const titleRow: (string | number | { f: string } | null)[] = [
    "CONTROLE DE COMPRAS", null, null, null,
    periodLabel, null,
    "TOTAL R$",
    purchases.length ? { f: `SUM(H3:H${lastRow})` } : 0,
    filterNote, null,
  ];

  const aoa: (string | number | { f: string } | null)[][] = [titleRow, headerRow];
  purchases.forEach((p, i) => {
    const r = i + 3; // linha no Excel
    const iso = p.purchase_date ? p.purchase_date.toISOString().slice(0, 10) : "";
    const serial = excelSerial(iso);
    aoa.push([
      i + 1,
      p.description || "",
      deptLabel(p.department),
      p.supplier || "",
      serial ?? "",
      p.unit_value || 0,
      p.quantity || 0,
      { f: `F${r}*G${r}` },
      p.payment_method || "",
      p.notes || "",
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // ── Estilos ────────────────────────────────────────────────────────────────
  const setStyle = (addr: string, s: Record<string, unknown>) => {
    const c = ws[addr] as { s?: unknown } | undefined;
    if (c) c.s = s;
  };

  setStyle("A1", { font: { name: "Calibri", sz: 18, bold: true, color: { rgb: "1F3864" } }, alignment: { horizontal: "left", vertical: "center" } });
  setStyle("E1", { font: { name: "Calibri", sz: 13, bold: true, color: { rgb: "1F3864" } }, alignment: { horizontal: "center", vertical: "center" } });
  setStyle("G1", { font: { name: "Calibri", sz: 11, bold: true }, alignment: { horizontal: "right", vertical: "center" } });
  setStyle("H1", { font: { name: "Calibri", sz: 14, bold: true, color: { rgb: "C00000" } }, alignment: { horizontal: "center", vertical: "center" }, numFmt: BRL });
  setStyle("I1", { font: { name: "Calibri", sz: 9, italic: true, color: { rgb: "808080" } }, alignment: { horizontal: "left", vertical: "center", wrapText: true } });

  const headerStyle = {
    font: { name: "Calibri", sz: 12, bold: true, color: { rgb: "1F3864" } },
    fill: { patternType: "solid", fgColor: { rgb: "D9E1F2" } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border: borderAll,
  };
  for (let c = 0; c < headerRow.length; c++) {
    setStyle(XLSX.utils.encode_cell({ r: 1, c }), headerStyle);
  }

  // Estilo base por coluna das linhas de dados (alinhamento, formato, fill).
  const colStyle = (col: number) => {
    const base: Record<string, unknown> = {
      font: { name: "Calibri", sz: 11 },
      alignment: { vertical: "center", wrapText: col === 1 || col === 9 } as Record<string, unknown>,
      border: borderAll,
    };
    const align = base.alignment as { horizontal?: string };
    if (col === 0) align.horizontal = "center";                 // #
    if (col === 4) align.horizontal = "center";                 // data
    if (col === 5 || col === 6 || col === 7) align.horizontal = "right"; // unit / qtd / total
    if (col === 4) base.numFmt = "dd/mm/yyyy";
    if (col === 5 || col === 7) base.numFmt = BRL;
    if (col === 6) base.numFmt = QTY_FMT;
    if (col === 7) base.fill = { patternType: "solid", fgColor: { rgb: "F2F2F2" } }; // total levemente sombreado
    return base;
  };
  for (let i = 0; i < purchases.length; i++) {
    const r = i + 2; // índice 0-based da linha (dados começam em r=2 → Excel linha 3)
    for (let c = 0; c < headerRow.length; c++) {
      setStyle(XLSX.utils.encode_cell({ r, c }), colStyle(c));
    }
  }

  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }, // A1:D1 título
    { s: { r: 0, c: 4 }, e: { r: 0, c: 5 } }, // E1:F1 período
    { s: { r: 0, c: 8 }, e: { r: 0, c: 9 } }, // I1:J1 nota de filtros
  ];
  ws["!cols"] = [
    { wch: 5 }, { wch: 58 }, { wch: 16 }, { wch: 20 }, { wch: 15 },
    { wch: 15 }, { wch: 11 }, { wch: 17 }, { wch: 20 }, { wch: 28 },
  ];
  ws["!rows"] = [{ hpt: 34 }, { hpt: 26 }];

  const wb = XLSX.utils.book_new();
  const sheetName = (month ? `${MONTH_NAMES[month - 1]} ${year}` : `${year}`)
    .replace(/[\\/?*[\]:]/g, "").slice(0, 31);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const periodFile = month ? `${MONTH_NAMES[month - 1]} ${year}` : String(year);
  const filename = `Controle de Compras - ${periodFile}.xlsx`;
  return new NextResponse(buf, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="Controle de Compras.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
