import { NextRequest, NextResponse } from "next/server";
import { runDueScheduledMessages } from "@/lib/services/scheduler";
import { runDueBirthdayMessages } from "@/lib/services/birthday-message";

// Disparo manual/externo do runner de agendas. Protegido por segredo (sem
// sessão — funciona via curl/cron). Serve pra testar sem esperar o relógio e
// como fallback caso o scheduler in-process não esteja ativo.
//
// IMPORTANTE: esta rota precisa estar em `isPublic` no auth.config.ts, senão o
// middleware redireciona pro /login antes de chegar aqui.
export const dynamic = "force-dynamic";

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET não configurado no servidor" }, { status: 503 });
  }
  const provided = request.nextUrl.searchParams.get("secret") || request.headers.get("x-cron-secret");
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await runDueScheduledMessages();
  // Parabéns de aniversário (10h SP) — isolado pra um erro aqui não derrubar o
  // resultado das agendas de grupo.
  let birthday;
  try {
    birthday = await runDueBirthdayMessages();
  } catch (err) {
    birthday = { error: (err as Error).message };
  }
  return NextResponse.json({ ok: true, ...result, birthday });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
