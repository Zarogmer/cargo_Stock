import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";
import { customKey } from "@/lib/statement-sections";

// PATCH /api/financeiro/statement-sections/[id] — renomeia/move a subseção.
// Body: { label?, group_label?, sort_order?, active? }
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const body = await request.json().catch(() => null);
  const data: Record<string, unknown> = {};
  if (body?.label !== undefined) {
    const label = String(body.label).trim();
    if (!label) return NextResponse.json({ error: "Nome não pode ficar vazio" }, { status: 400 });
    data.label = label;
  }
  if (body?.group_label !== undefined) {
    const g = String(body.group_label).trim();
    if (!g) return NextResponse.json({ error: "Grupo não pode ficar vazio" }, { status: 400 });
    data.group_label = g;
  }
  if (body?.sort_order !== undefined && Number.isFinite(Number(body.sort_order))) {
    data.sort_order = Number(body.sort_order);
  }
  if (body?.active !== undefined) data.active = !!body.active;

  const section = await prisma.customStatementSection.update({
    where: { id: numId },
    data,
    select: { id: true, label: true, group_label: true, sort_order: true, active: true },
  });
  return NextResponse.json({ section });
}

// DELETE /api/financeiro/statement-sections/[id] — remove a subseção. Se houver
// títulos usando a chave, apenas DESATIVA (some das listas, mas o histórico
// dos títulos fica intacto); sem títulos, apaga de vez.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isInteger(numId)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const inUse = await prisma.payableInvoice.count({ where: { statement_section: customKey(numId) } });
  if (inUse > 0) {
    await prisma.customStatementSection.update({ where: { id: numId }, data: { active: false } });
    return NextResponse.json({ ok: true, deactivated: true, inUse });
  }
  await prisma.customStatementSection.delete({ where: { id: numId } });
  return NextResponse.json({ ok: true, deactivated: false });
}
