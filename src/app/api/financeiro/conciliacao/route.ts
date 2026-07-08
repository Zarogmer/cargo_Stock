import { NextRequest, NextResponse } from "next/server";
import type { Prisma, ReconciliationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

// GET /api/financeiro/conciliacao?status=SUGERIDA&account=<id>
// Lista conciliações (fila de revisão por padrão) com a movimentação e o título.
export async function GET(request: NextRequest) {
  const guard = await requireFinance("view");
  if (guard.error) return guard.error;

  const sp = request.nextUrl.searchParams;
  const status = (sp.get("status") || "SUGERIDA") as ReconciliationStatus | "ALL";
  const accountId = Number(sp.get("account"));

  const where: Prisma.ReconciliationWhereInput = {};
  if (status !== "ALL") where.status = status;
  if (Number.isInteger(accountId)) where.transactions = { bank_account_id: accountId };

  const reconciliations = await prisma.reconciliation.findMany({
    where,
    orderBy: [{ score: "desc" }, { created_at: "desc" }],
    take: 500,
    include: {
      transactions: {
        select: { id: true, posted_at: true, amount: true, description: true, payee_name: true, payee_document: true },
      },
      invoices: {
        select: { id: true, description: true, amount: true, due_date: true, status: true, payee_name: true },
      },
    },
  });

  return NextResponse.json({ reconciliations });
}
