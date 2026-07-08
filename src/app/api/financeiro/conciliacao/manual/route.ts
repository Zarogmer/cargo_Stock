import { NextRequest, NextResponse } from "next/server";
import { requireFinance } from "@/lib/financeiro-api";
import { manualReconcile } from "@/lib/services/reconciliation/actions";

// POST /api/financeiro/conciliacao/manual { transaction_id, invoice_id }
// Casa manualmente uma movimentação a um título (substitui sugestão anterior).
export async function POST(request: NextRequest) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;

  const body = await request.json().catch(() => null);
  const transactionId = body?.transaction_id;
  const invoiceId = body?.invoice_id;
  if (!transactionId || !invoiceId) {
    return NextResponse.json({ error: "transaction_id e invoice_id são obrigatórios" }, { status: 400 });
  }

  const result = await manualReconcile(String(transactionId), String(invoiceId), guard.userName);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
