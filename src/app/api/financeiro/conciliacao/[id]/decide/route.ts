import { NextRequest, NextResponse } from "next/server";
import { requireFinance } from "@/lib/financeiro-api";
import { acceptReconciliation, rejectReconciliation } from "@/lib/services/reconciliation/actions";

// POST /api/financeiro/conciliacao/[id]/decide { decision: "ACEITAR" | "REJEITAR" }
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const body = await request.json().catch(() => null);
  const decision = body?.decision;
  const result =
    decision === "ACEITAR"
      ? await acceptReconciliation(id, guard.userName)
      : decision === "REJEITAR"
        ? await rejectReconciliation(id, guard.userName)
        : { error: "decision deve ser ACEITAR ou REJEITAR", status: 400 as const };

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
