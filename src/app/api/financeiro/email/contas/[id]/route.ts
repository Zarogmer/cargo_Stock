import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

// PATCH /api/financeiro/email/contas/[id] — habilita/desabilita ou ajusta tenant.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const body = await request.json().catch(() => null);
  const data: Record<string, unknown> = {};
  if (body?.enabled !== undefined) data.enabled = !!body.enabled;
  if (body?.tenant_id !== undefined) data.tenant_id = body.tenant_id ? String(body.tenant_id).trim() : null;

  const account = await prisma.emailIntegrationAccount.update({
    where: { id },
    data,
    select: { id: true, mailbox: true, tenant_id: true, enabled: true, last_sync_at: true, last_status: true },
  });
  return NextResponse.json({ account });
}

// DELETE /api/financeiro/email/contas/[id] — remove a caixa do monitoramento.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("delete");
  if (guard.error) return guard.error;
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  await prisma.emailIntegrationAccount.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
