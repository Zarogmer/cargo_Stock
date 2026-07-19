import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";
import { materializeRecurringBills } from "@/lib/services/recurring-bills";

// PATCH /api/financeiro/contas/recorrentes/[id] — liga/desliga ou ajusta a
// conta mensal (valor, dia, mês final...). Os títulos já gerados não mudam —
// a alteração vale dos próximos meses em diante.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON inválido" }, { status: 400 });

  const bill = await prisma.recurringBill.findUnique({ where: { id: Number(id) } });
  if (!bill) return NextResponse.json({ error: "Conta mensal não encontrada" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (body.active !== undefined) data.active = body.active === true;
  if (body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: "Valor inválido" }, { status: 400 });
    }
    data.amount = new Prisma.Decimal(amount.toFixed(2));
  }
  if (body.due_day !== undefined) {
    const dueDay = Number(body.due_day);
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      return NextResponse.json({ error: "Dia do vencimento deve ser entre 1 e 31" }, { status: 400 });
    }
    data.due_day = dueDay;
  }
  if (body.end_month !== undefined) {
    const endMonth = body.end_month ? String(body.end_month).trim() : null;
    if (endMonth && !/^\d{4}-\d{2}$/.test(endMonth)) {
      return NextResponse.json({ error: "Mês final inválido (AAAA-MM)" }, { status: 400 });
    }
    data.end_month = endMonth;
  }

  const updated = await prisma.recurringBill.update({
    where: { id: bill.id },
    data,
    include: { suppliers: { select: { id: true, name: true } } },
  });

  // Reativou/ajustou → completa o que faltar do mês atual/próximo.
  try {
    await materializeRecurringBills();
  } catch (err) {
    console.error("[recorrentes] materialize:", err);
  }

  return NextResponse.json({ bill: updated });
}

// DELETE /api/financeiro/contas/recorrentes/[id] — apaga a recorrência. Os
// títulos já gerados FICAM (o vínculo vira null) — apagar a conta mensal só
// para de gerar meses novos.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const { id } = await params;

  const bill = await prisma.recurringBill.findUnique({ where: { id: Number(id) }, select: { id: true } });
  if (!bill) return NextResponse.json({ error: "Conta mensal não encontrada" }, { status: 404 });

  await prisma.recurringBill.delete({ where: { id: bill.id } });
  return NextResponse.json({ ok: true });
}
