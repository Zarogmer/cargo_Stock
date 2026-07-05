import { NextRequest, NextResponse } from "next/server";
import type { PayableStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";
import { canTransition, transitionPatch, PAYABLE_TRANSITIONS } from "@/lib/services/payable-status";

// POST /api/financeiro/contas/[id]/transition { to, reason? }
// ÚNICO caminho pra mudar o status de um título — valida a máquina de estados
// e grava a trilha de auditoria (quem aprovou/pagou/cancelou e quando).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  const to = body?.to as PayableStatus | undefined;
  if (!to || !(to in PAYABLE_TRANSITIONS)) {
    return NextResponse.json({ error: "Status de destino inválido" }, { status: 400 });
  }

  // Update condicional ao status atual: se dois usuários mexerem no mesmo
  // título ao mesmo tempo, o segundo não sobrescreve a transição do primeiro
  // (updateMany com where de status = compare-and-set; count 0 = perdeu a corrida).
  const invoice = await prisma.payableInvoice.findUnique({ where: { id } });
  if (!invoice) return NextResponse.json({ error: "Título não encontrado" }, { status: 404 });

  if (!canTransition(invoice.status, to)) {
    return NextResponse.json(
      {
        error: `Transição inválida: ${invoice.status} → ${to}`,
        allowed: PAYABLE_TRANSITIONS[invoice.status],
      },
      { status: 422 }
    );
  }

  const patch = transitionPatch(to, guard.userName, body?.reason);
  const result = await prisma.payableInvoice.updateMany({
    where: { id, status: invoice.status },
    data: patch,
  });
  if (result.count === 0) {
    return NextResponse.json(
      { error: "O título mudou de status enquanto você decidia — recarregue e tente de novo" },
      { status: 409 }
    );
  }

  const updated = await prisma.payableInvoice.findUnique({
    where: { id },
    include: {
      suppliers: { select: { id: true, name: true, cnpj: true } },
      attachments: {
        select: { id: true, filename: true, created_at: true, created_by: true },
        orderBy: { created_at: "asc" },
      },
    },
  });

  return NextResponse.json({ invoice: updated });
}
