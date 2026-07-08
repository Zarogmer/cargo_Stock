import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

// PATCH /api/financeiro/contas-bancarias/[id] — edita apelido/agência/conta/ativo.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON inválido" }, { status: 400 });

  const data: Record<string, unknown> = {};
  if (body.nickname !== undefined) {
    const n = String(body.nickname).trim();
    if (!n) return NextResponse.json({ error: "Apelido não pode ficar vazio" }, { status: 400 });
    data.nickname = n;
  }
  if (body.agency !== undefined) data.agency = body.agency ? String(body.agency).trim() : null;
  if (body.account_number !== undefined) {
    data.account_number = body.account_number ? String(body.account_number).trim() : null;
  }
  if (body.active !== undefined) data.active = !!body.active;

  const account = await prisma.bankAccount.update({
    where: { id },
    data,
    include: { _count: { select: { transactions: true } } },
  });
  return NextResponse.json({ account });
}

// DELETE /api/financeiro/contas-bancarias/[id] — só se não tiver movimentação
// (histórico não some por engano).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("delete");
  if (guard.error) return guard.error;
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const count = await prisma.bankTransaction.count({ where: { bank_account_id: id } });
  if (count > 0) {
    return NextResponse.json(
      { error: `Conta tem ${count} movimentação(ões) — desative em vez de excluir` },
      { status: 422 }
    );
  }
  await prisma.bankAccount.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
