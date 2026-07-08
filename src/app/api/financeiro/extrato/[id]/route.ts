import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

const VALID_STATUS = new Set(["PENDENTE", "CONCILIADO", "IGNORADO"]);

// PATCH /api/financeiro/extrato/[id] — marca a linha do extrato como conciliada
// ("ok") / ignorada e/ou reescreve o lançamento. É a revisão manual da
// conciliação (independe de casar com conta a pagar).
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON inválido" }, { status: 400 });

  const data: Record<string, unknown> = {};
  if (body.review_status !== undefined) {
    const s = String(body.review_status).toUpperCase();
    if (!VALID_STATUS.has(s)) return NextResponse.json({ error: "review_status inválido" }, { status: 400 });
    data.review_status = s;
    data.reviewed_by = guard.userName;
    data.reviewed_at = new Date();
  }
  if (body.review_note !== undefined) {
    data.review_note = body.review_note ? String(body.review_note) : null;
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nada para atualizar" }, { status: 400 });
  }

  const tx = await prisma.bankTransaction.update({
    where: { id },
    data,
    include: {
      reconciliation: { select: { status: true, invoice_id: true } },
    },
  });
  return NextResponse.json({ transaction: tx });
}
