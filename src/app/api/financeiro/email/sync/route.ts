import { NextResponse } from "next/server";
import { requireFinance } from "@/lib/financeiro-api";
import { runFinanceTick } from "@/lib/services/email/tick";

// POST /api/financeiro/email/sync — dispara manualmente um ciclo (sync das
// caixas + processamento da fila). Útil pra testar sem esperar o tick de 60s.
export async function POST() {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;

  const result = await runFinanceTick();
  return NextResponse.json(result);
}
