import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import * as XLSX from "xlsx-js-style";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

// GET /api/financeiro/extrato/export?account=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
//   → planilha de UM período, numa aba só.
// GET /api/financeiro/extrato/export?account=<id>&year=YYYY
//   → planilha do ANO INTEIRO, uma aba por mês (Jan..mês atual), no formato
//     que a contabilidade mantinha à mão. É essa que reproduz a "Jan a Dez"
//     do Itaú/Santander — roda uma vez por conta e sai um arquivo por banco.
//
// Layout da contabilidade em cada aba:
//   [ok] | data | lançamento | Débito | Crédito | saldo (R$)
// com "SALDO ANTERIOR", saldo corrente acumulado e a marca "ok" (conciliado
// manual ou automático). O cabeçalho segue o banco (Itaú x Santander).

const MES_ABBR = [
  "Jan", "Fev", "Mar", "Abr", "Maio", "Jun",
  "Jul", "Ago", "Set", "Out", "Nov", "Dez",
];
const MES_FULL = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

// Formatos de número copiados das planilhas-modelo da contabilidade:
//   - Santander: Débito/Crédito com "R$ " e negativo em vermelho.
//   - Itaú: Débito/Crédito como número simples (sem R$).
//   - saldo (col F): sempre 2 casas, sem R$ (igual aos dois modelos).
const FMT_RS = '"R$ "#,##0.00;[Red]\\-"R$ "#,##0.00';
const FMT_NUM = "#,##0.00";
const FMT_SALDO = "0.00";

function fmtBrDate(d: Date): string {
  const iso = d.toISOString().slice(0, 10);
  const [y, m, dd] = iso.split("-");
  return `${dd}/${m}/${y}`;
}

function num(v: Prisma.Decimal | number): number {
  return Number(v);
}

interface TxRow {
  posted_at: Date;
  amount: Prisma.Decimal;
  review_status: string;
  review_note: string | null;
  payee_name: string | null;
  description: string | null;
  reconciliation: { status: string } | null;
}

// Monta as linhas (aoa) de UMA aba a partir do saldo de abertura e das
// transações já filtradas/ordenadas do período. Retorna a aoa e o saldo final.
function buildSheet(
  account: { nickname: string; bank: string; agency: string | null; account_number: string | null },
  opening: number,
  txs: TxRow[],
  header: (string | number)[][],
  anteriorDate: string,
): { aoa: (string | number)[][]; closing: number } {
  const aoa: (string | number)[][] = [...header];
  aoa.push(["", anteriorDate, "SALDO ANTERIOR", "", "", Number(opening.toFixed(2))]);

  let running = opening;
  for (const t of txs) {
    const v = num(t.amount);
    running += v;
    const conciliado = t.review_status === "CONCILIADO" || t.reconciliation?.status === "CONFIRMADA";
    const lancamento = t.review_note || t.payee_name || t.description || "";
    aoa.push([
      conciliado ? "ok" : "",
      fmtBrDate(t.posted_at),
      lancamento,
      v < 0 ? Number(v.toFixed(2)) : "",
      v > 0 ? Number(v.toFixed(2)) : "",
      Number(running.toFixed(2)),
    ]);
  }
  return { aoa, closing: running };
}

// Cabeçalho de uma aba conforme o banco.
function sheetHeader(
  account: { nickname: string; bank: string; agency: string | null; account_number: string | null },
  monthIdx: number | null,
  year: number | null,
  periodoLabel: string,
): (string | number)[][] {
  if (account.bank === "SANTANDER") {
    // Santander rotula a coluna com o mês ("lançamento - Março/26").
    const lancCol =
      monthIdx != null && year != null
        ? `lançamento - ${MES_FULL[monthIdx]}/${String(year).slice(2)}`
        : "lançamento";
    return [
      ["", account.nickname],
      ["", "BANCO", account.bank],
      ["", "AGENCIA", account.agency || ""],
      ["", "CONTA", account.account_number || ""],
      [],
      ["", "data", lancCol, "Débito", "Crédito", "saldo (R$)"],
    ];
  }
  // Itaú / outros
  return [
    ["", "Nome:", account.nickname],
    ["", "Agência:", account.agency || ""],
    ["", "Conta:", account.account_number || ""],
    ["", "Periodo:", periodoLabel],
    [],
    ["", "data", "lançamento", "Débito", "Crédito", "saldo (R$)"],
  ];
}

// Larguras aproximadas das planilhas-modelo (col A = "ok", B = data,
// C = lançamento larga, D/E/F = valores).
const COL_WIDTHS = [{ wch: 6 }, { wch: 13 }, { wch: 62 }, { wch: 15 }, { wch: 15 }, { wch: 15 }];

// Monta a worksheet: larguras, formato de número por banco (Débito/Crédito
// em R$ no Santander, número puro no Itaú; saldo sempre 0.00) e cabeçalho
// em negrito. `headerLen` = nº de linhas do cabeçalho (a linha de títulos
// "data|lançamento|..." é a última delas).
function styleSheet(aoa: (string | number)[][], bank: string, headerLen: number): XLSX.WorkSheet {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = COL_WIDTHS;

  const debitCreditFmt = bank === "SANTANDER" ? FMT_RS : FMT_NUM;
  const colHeaderRow = headerLen - 1; // linha "data|lançamento|Débito|..."
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");

  for (let r = range.s.r; r <= range.e.r; r++) {
    // Formato de número nas colunas Débito(3)/Crédito(4)/saldo(5).
    for (const c of [3, 4, 5]) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && typeof cell.v === "number") cell.z = c === 5 ? FMT_SALDO : debitCreditFmt;
    }
    // Negrito: linha de títulos das colunas e a coluna de rótulos do
    // cabeçalho (Nome:/BANCO/AGENCIA/CONTA/Periodo: e o nome da empresa).
    if (r === colHeaderRow) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell) cell.s = { font: { bold: true } };
      }
    } else if (r < colHeaderRow - 1) {
      // Coluna B: rótulos (Nome:/BANCO/...) e o nome da empresa no Santander.
      const cell = ws[XLSX.utils.encode_cell({ r, c: 1 })];
      if (cell && cell.v !== "") cell.s = { font: { bold: true } };
    }
  }
  return ws;
}

function xlsxResponse(wb: XLSX.WorkBook, fname: string): NextResponse {
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fname}"`,
    },
  });
}

export async function GET(request: NextRequest) {
  const guard = await requireFinance("view");
  if (guard.error) return guard.error;

  const sp = request.nextUrl.searchParams;

  // Aceita ?account=<id> OU ?bank=ITAU|SANTANDER (resolve a conta pelo banco).
  const bankParam = (sp.get("bank") || "").toUpperCase();
  let account = null as Awaited<ReturnType<typeof prisma.bankAccount.findUnique>> | null;
  if (bankParam === "ITAU" || bankParam === "SANTANDER" || bankParam === "OUTRO") {
    account = await prisma.bankAccount.findFirst({ where: { bank: bankParam }, orderBy: { id: "asc" } });
    if (!account) {
      return NextResponse.json({ error: `Conta do ${bankParam} não cadastrada` }, { status: 404 });
    }
  } else {
    const accountId = Number(sp.get("account"));
    if (!Number.isInteger(accountId)) {
      return NextResponse.json({ error: "Informe 'account' ou 'bank'" }, { status: 400 });
    }
    account = await prisma.bankAccount.findUnique({ where: { id: accountId } });
  }
  if (!account) return NextResponse.json({ error: "Conta não encontrada" }, { status: 404 });
  const accountId = account.id;

  // Ano padrão = ano corrente quando não vem ?year nem período.
  const yearParam = sp.get("year") || (sp.get("from") || sp.get("to") ? null : String(new Date().getUTCFullYear()));

  // ── Modo ANO: uma aba por mês (reproduz a planilha "Jan a Dez") ───────────
  if (yearParam) {
    const year = Number(yearParam);
    if (!Number.isInteger(year)) {
      return NextResponse.json({ error: "Parâmetro 'year' inválido" }, { status: 400 });
    }
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const yearEnd = new Date(Date.UTC(year + 1, 0, 1));

    // Saldo de abertura do ano = saldo inicial da conta + tudo antes de 01/jan.
    let opening = num(account.opening_balance);
    const before = await prisma.bankTransaction.aggregate({
      where: { bank_account_id: accountId, posted_at: { lt: yearStart } },
      _sum: { amount: true },
    });
    if (before._sum.amount) opening += num(before._sum.amount);

    const txs = await prisma.bankTransaction.findMany({
      where: { bank_account_id: accountId, posted_at: { gte: yearStart, lt: yearEnd } },
      orderBy: [{ posted_at: "asc" }, { id: "asc" }],
      include: { reconciliation: { select: { status: true } } },
    });

    // Agrupa por mês (0-11).
    const byMonth: TxRow[][] = Array.from({ length: 12 }, () => []);
    for (const t of txs) byMonth[t.posted_at.getUTCMonth()].push(t as TxRow);

    const wb = XLSX.utils.book_new();
    let carry = opening; // saldo que passa de um mês pro outro
    let anySheet = false;
    for (let m = 0; m < 12; m++) {
      const monthTxs = byMonth[m];
      if (monthTxs.length === 0) continue; // pula meses sem movimento
      // SALDO ANTERIOR datado no último dia do mês anterior.
      const anteriorDate = fmtBrDate(new Date(Date.UTC(year, m, 0)));
      const periodoLabel = `01/${String(m + 1).padStart(2, "0")}/${year} até ${fmtBrDate(
        new Date(Date.UTC(year, m + 1, 0)),
      )}`;
      const header = sheetHeader(account, m, year, periodoLabel);
      const { aoa, closing } = buildSheet(account, carry, monthTxs, header, anteriorDate);
      carry = closing;
      const ws = styleSheet(aoa, account.bank, header.length);
      XLSX.utils.book_append_sheet(wb, ws, `${MES_ABBR[m]} ${year}`.slice(0, 31));
      anySheet = true;
    }

    if (!anySheet) {
      return NextResponse.json(
        { error: `Sem movimentações em ${year} para esta conta.` },
        { status: 404 },
      );
    }

    const fname = `Conciliacao_${account.nickname.replace(/\s+/g, "_")}_${year}.xlsx`;
    return xlsxResponse(wb, fname);
  }

  // ── Modo PERÍODO: uma aba só (comportamento original) ─────────────────────
  const from = sp.get("from");
  const to = sp.get("to");

  let startBalance = num(account.opening_balance);
  if (from) {
    const before = await prisma.bankTransaction.aggregate({
      where: { bank_account_id: accountId, posted_at: { lt: new Date(from) } },
      _sum: { amount: true },
    });
    startBalance += before._sum.amount ? num(before._sum.amount) : 0;
  }

  const where: Prisma.BankTransactionWhereInput = { bank_account_id: accountId };
  if (from || to) {
    where.posted_at = {};
    if (from) where.posted_at.gte = new Date(from);
    if (to) where.posted_at.lte = new Date(to);
  }
  const txs = await prisma.bankTransaction.findMany({
    where,
    orderBy: [{ posted_at: "asc" }, { id: "asc" }],
    include: { reconciliation: { select: { status: true } } },
  });

  const monthIdx = from ? new Date(from).getUTCMonth() : null;
  const yearOf = from ? new Date(from).getUTCFullYear() : null;
  const periodo =
    from && to ? `${fmtBrDate(new Date(from))} até ${fmtBrDate(new Date(to))}` : "todos os lançamentos";
  const header = sheetHeader(account, monthIdx, yearOf, periodo);
  const anteriorDate = from ? fmtBrDate(new Date(new Date(from).getTime() - 86_400_000)) : "";
  const { aoa } = buildSheet(account, startBalance, txs as TxRow[], header, anteriorDate);
  const ws = styleSheet(aoa, account.bank, header.length);

  let sheetName = "Extrato";
  if (from) {
    const d = new Date(from);
    sheetName = `${MES_ABBR[d.getUTCMonth()]} ${d.getUTCFullYear()}`.slice(0, 31);
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const fname = `Conciliacao_${account.nickname.replace(/\s+/g, "_")}_${from || "tudo"}.xlsx`;
  return xlsxResponse(wb, fname);
}
