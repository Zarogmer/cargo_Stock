import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canDeleteFiscalNote } from "@/lib/rbac";
import { formatNoteNumber } from "@/lib/fiscal-note";
import type { Role } from "@/types/database";

// DELETE /api/financeiro/notas/[id]
// Apaga uma nota emitida (e os itens, por cascade). Não é operação do dia a dia:
// o número sai da sequência do ano, então só a conta do Guilherme e o papel
// EXECUTIVO passam aqui (canDeleteFiscalNote). O /api/db já barra qualquer
// escrita em fiscal_notes, então esta rota é a única porta.

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = session.user.role as Role;
  if (!canDeleteFiscalNote(role, session.user.email)) {
    return NextResponse.json(
      { error: "Só as contas Guilherme e Executivo podem apagar notas emitidas." },
      { status: 403 },
    );
  }

  const { id } = await params;
  const note = await prisma.fiscalNote.findUnique({
    where: { id },
    select: { id: true, kind: true, number: true, year: true, ship_name: true },
  });
  if (!note) return NextResponse.json({ error: "Nota não encontrada" }, { status: 404 });

  await prisma.fiscalNote.delete({ where: { id } });

  const label = `${note.kind === "DEBITO" ? "ND" : "NC"} ${formatNoteNumber(note.number, note.year)}`;
  return NextResponse.json({ ok: true, deleted: label, ship_name: note.ship_name });
}
