import { NextRequest, NextResponse } from "next/server";
import { runFinanceTick } from "@/lib/services/email/tick";

// Disparo externo/cron do ciclo do Financeiro (captura de boletos + fila),
// protegido por CRON_SECRET — fallback caso o scheduler in-process não esteja
// ativo. Precisa estar em isPublic no auth.config.ts (já incluído em /api/cron/).
export const dynamic = "force-dynamic";

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET não configurado" }, { status: 503 });
  const provided = request.nextUrl.searchParams.get("secret") || request.headers.get("x-cron-secret");
  if (provided !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await runFinanceTick();
  return NextResponse.json({ ok: true, ...result });
}

export async function GET(request: NextRequest) {
  return handle(request);
}
export async function POST(request: NextRequest) {
  return handle(request);
}
