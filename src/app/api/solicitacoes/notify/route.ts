import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isEvolutionConfigured, sendWhatsappText } from "@/lib/services/evolution-api";

interface NotifyBody {
  toolName: string;
  quantity?: number;
  reason?: string;
  requestedBy: string;
}

// Mensagem enviada (pelo número da Cargo no WhatsApp) aos supervisores quando
// uma nova solicitação de compra é registrada.
function buildMessage(b: NotifyBody): string {
  const qty = b.quantity && b.quantity > 1 ? ` (x${b.quantity})` : "";
  const reason = b.reason?.trim() ? `📝 Motivo: ${b.reason.trim()}\n` : "";
  return (
    `🛒 *Nova solicitação de compra*\n\n` +
    `📦 Produto: *${b.toolName}*${qty}\n` +
    reason +
    `👤 Solicitado por: ${b.requestedBy}\n\n` +
    `Acesse o Cargo Stock para aprovar ou recusar.`
  );
}

// POST /api/solicitacoes/notify
// Best-effort: avisa por WhatsApp todos os colaboradores com função SUPERVISOR
// quando uma nova solicitação é criada. Nunca bloqueia a criação da solicitação
// — devolve 200 com um resumo por destinatário (igual ao /api/escalacao/notify).
//
// Qualquer usuário autenticado pode disparar: a solicitação pode ser feita até
// por um funcionário, e mesmo assim os supervisores precisam ser avisados.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isEvolutionConfigured()) {
    return NextResponse.json({ skipped: "Evolution API não configurada" }, { status: 200 });
  }

  let body: NotifyBody;
  try {
    body = (await request.json()) as NotifyBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  if (!body.toolName || !body.requestedBy) {
    return NextResponse.json({ error: "Campos obrigatórios faltando" }, { status: 400 });
  }

  // Função "SUPERVISOR" em case-insensitive — dados importados da planilha do RH
  // podem vir como "Supervisor". O filtro de status fica em JS (e não no Prisma)
  // pra não depender da semântica de null do `not` e nunca pular um supervisor
  // com status nulo.
  const supervisors = (
    await prisma.employee.findMany({
      where: { role: { equals: "SUPERVISOR", mode: "insensitive" } },
      select: { id: true, name: true, phone: true, status: true },
    })
  ).filter((s) => s.status !== "INATIVO");

  const message = buildMessage(body);
  const results: { target: string; ok: boolean; error?: string }[] = [];

  for (const sup of supervisors) {
    if (!sup.phone || sup.phone.trim().length < 10) {
      results.push({ target: `dm:${sup.name}`, ok: false, error: "sem telefone válido" });
      continue;
    }
    try {
      await sendWhatsappText(sup.phone, message);
      results.push({ target: `dm:${sup.name}`, ok: true });
    } catch (err) {
      results.push({ target: `dm:${sup.name}`, ok: false, error: (err as Error).message });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  return NextResponse.json({ status: "ok", sent, total: results.length, results });
}
