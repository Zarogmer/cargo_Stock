import { NextRequest, NextResponse } from "next/server";
import { requireFinance } from "@/lib/financeiro-api";
import { runReconciliation } from "@/lib/services/reconciliation/engine";

// POST /api/financeiro/conciliacao/run { account_id? }
// Roda o motor sobre os débitos ainda não conciliados. Idempotente.
export async function POST(request: NextRequest) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;

  const body = await request.json().catch(() => ({}));
  const accountId = body?.account_id ? Number(body.account_id) : undefined;

  const summary = await runReconciliation(guard.userName, {
    accountId: Number.isInteger(accountId) ? accountId : undefined,
  });
  return NextResponse.json({ summary });
}
