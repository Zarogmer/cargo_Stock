import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

// GET /api/financeiro/extrato?account=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD
// Lista as movimentações de uma conta no período, com o status de conciliação
// (join leve) pra UI já mostrar o que está conciliado/pendente.
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

  const where: Prisma.BankTransactionWhereInput = { bank_account_id: accountId };
  if (from || to) {
    where.posted_at = {};
    if (from) where.posted_at.gte = new Date(from);
    if (to) where.posted_at.lte = new Date(to);
  }

  const transactions = await prisma.bankTransaction.findMany({
    where,
    orderBy: [{ posted_at: "asc" }, { id: "asc" }],
    include: {
      reconciliation: {
        select: {
          id: true,
          status: true,
          score: true,
          invoice_id: true,
          invoices: { select: { description: true } },
        },
      },
    },
    take: 2000,
  });

  return NextResponse.json({ transactions });
}
