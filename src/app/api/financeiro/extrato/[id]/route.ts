import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

const VALID_STATUS = new Set(["PENDENTE", "CONCILIADO", "IGNORADO"]);

// Linha "manual" = adicionada do Contas a Pagar (marcada no raw). Só essas
// podem ter valor/descrição/data editados ou serem excluídas — as do OFX são
// o extrato do banco e ficam protegidas.
function isManual(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as { manual?: boolean }).manual === true;
}

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

  // Edição de VALOR/DESCRIÇÃO/DATA — só pra linha manual (do Contas a Pagar).
  const wantsManualEdit =
    body.description !== undefined || body.amount !== undefined || body.posted_at !== undefined;
  if (wantsManualEdit) {
    const existing = await prisma.bankTransaction.findUnique({ where: { id }, select: { raw: true } });
    if (!existing) return NextResponse.json({ error: "Lançamento não encontrado" }, { status: 404 });
    if (!isManual(existing.raw)) {
      return NextResponse.json(
        { error: "Só linhas adicionadas manualmente podem ser editadas (as do extrato são do banco)." },
        { status: 422 }
      );
    }
    if (body.description !== undefined) {
      const d = String(body.description).trim();
      if (!d) return NextResponse.json({ error: "Descrição obrigatória" }, { status: 400 });
      data.description = d;
      data.review_note = d;
    }
    if (body.amount !== undefined) {
      const v = Number(body.amount);
      if (!Number.isFinite(v) || v === 0) return NextResponse.json({ error: "Valor inválido" }, { status: 400 });
      // Pagamento = débito (negativo).
      data.amount = new Prisma.Decimal((-Math.abs(v)).toFixed(2));
    }
    if (body.posted_at !== undefined) data.posted_at = new Date(body.posted_at);
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

// DELETE /api/financeiro/extrato/[id] — remove a linha, só se for manual.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const { id } = await params;

  const existing = await prisma.bankTransaction.findUnique({ where: { id }, select: { raw: true } });
  if (!existing) return NextResponse.json({ error: "Lançamento não encontrado" }, { status: 404 });
  if (!isManual(existing.raw)) {
    return NextResponse.json(
      { error: "Só linhas adicionadas manualmente podem ser excluídas (as do extrato são do banco)." },
      { status: 422 }
    );
  }
  await prisma.reconciliation.deleteMany({ where: { transaction_id: id } });
  await prisma.bankTransaction.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
