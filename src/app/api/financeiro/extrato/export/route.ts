import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

// GET /api/financeiro/extrato/export?account=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
// Gera a planilha de conciliação NO FORMATO da contabilidade:
//   [ok] | data | lançamento | Débito | Crédito | saldo (R$)
// com "SALDO ANTERIOR", saldo corrente e a marca "ok" (conciliado manual ou
// automático). Substitui a digitação manual do extrato.

const MES_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

function fmtBrDate(d: Date): string {
  const iso = d.toISOString().slice(0, 10);
  const [y, m, dd] = iso.split("-");
  return `${dd}/${m}/${y}`;
}

function num(v: Prisma.Decimal | number): number {
  return Number(v);
}

export async function GET(request: NextRequest) {
  const guard = await requireFinance("view");
  if (guard.error) return guard.error;

  const sp = request.nextUrl.searchParams;
  const accountId = Number(sp.get("account"));
  if (!Number.isInteger(accountId)) {
    return NextResponse.json({ error: "Parâmetro 'account' obrigatório" }, { status: 400 });
  }
  const from = sp.get("from");
  const to = sp.get("to");

  const account = await prisma.bankAccount.findUnique({ where: { id: accountId } });
  if (!account) return NextResponse.json({ error: "Conta não encontrada" }, { status: 404 });

  // Saldo no início do período = saldo inicial da conta + tudo antes de `from`.
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

  // Cabeçalho no layout da planilha atual.
  const periodo =
    from && to ? `${fmtBrDate(new Date(from))} até ${fmtBrDate(new Date(to))}` : "todos os lançamentos";
  const aoa: (string | number)[][] = [
    [],
    ["", "Nome:", account.nickname],
    ["", "Banco:", account.bank],
    ["", "Agência:", account.agency || ""],
    ["", "Conta:", account.account_number || ""],
    ["", "Período:", periodo],
    [],
    ["", "data", "lançamento", "Débito", "Crédito", "saldo (R$)"],
  ];

  // Linha SALDO ANTERIOR (datada no dia anterior ao início, como a planilha).
  const anteriorDate = from ? fmtBrDate(new Date(new Date(from).getTime() - 86_400_000)) : "";
  aoa.push(["", anteriorDate, "SALDO ANTERIOR", "", "", Number(startBalance.toFixed(2))]);

  let running = startBalance;
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

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 5 }, { wch: 12 }, { wch: 52 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
  ];

  // Nome da aba: "Mês Ano" quando o período é um mês só; senão "Extrato".
  let sheetName = "Extrato";
  if (from) {
    const d = new Date(from);
    sheetName = `${MES_PT[d.getUTCMonth()]} ${d.getUTCFullYear()}`.slice(0, 31);
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const fname = `Conciliacao_${account.nickname.replace(/\s+/g, "_")}_${from || "tudo"}.xlsx`;
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fname}"`,
    },
  });
}
