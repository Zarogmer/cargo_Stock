import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";
import { isGraphConfigured } from "@/lib/services/email/graph";

// GET /api/financeiro/email/contas — caixas monitoradas + se o Graph está
// configurado (pra UI mostrar o aviso de "aguardando credenciais").
export async function GET() {
  const guard = await requireFinance("view");
  if (guard.error) return guard.error;

  const accounts = await prisma.emailIntegrationAccount.findMany({
    orderBy: { mailbox: "asc" },
    select: {
      id: true, mailbox: true, tenant_id: true, enabled: true,
      last_sync_at: true, last_status: true, created_at: true,
    },
  });
  return NextResponse.json({ accounts, graphConfigured: isGraphConfigured() });
}

// POST /api/financeiro/email/contas — cadastra uma caixa.
export async function POST(request: NextRequest) {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const body = await request.json().catch(() => null);
  const mailbox = String(body?.mailbox || "").trim().toLowerCase();
  if (!mailbox || !mailbox.includes("@")) {
    return NextResponse.json({ error: "Informe um e-mail válido" }, { status: 400 });
  }

  const account = await prisma.emailIntegrationAccount.create({
    data: {
      mailbox,
      tenant_id: body?.tenant_id ? String(body.tenant_id).trim() : null,
      created_by: guard.userName,
    },
    select: { id: true, mailbox: true, tenant_id: true, enabled: true, last_sync_at: true, last_status: true, created_at: true },
  }).catch((err) => {
    if (err.code === "P2002") return null; // mailbox unique
    throw err;
  });

  if (!account) return NextResponse.json({ error: "Essa caixa já está cadastrada" }, { status: 409 });
  return NextResponse.json({ account }, { status: 201 });
}
