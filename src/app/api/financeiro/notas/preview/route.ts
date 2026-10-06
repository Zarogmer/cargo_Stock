import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { buildFiscalNotePdf } from "@/lib/fiscal-note-pdf";
import { clientKey, type FiscalNoteInput } from "@/lib/fiscal-note";
import type { Role } from "@/types/database";

// POST /api/financeiro/notas/preview → PDF da nota AINDA NÃO emitida, com o
// mesmo gerador do download. O modal manda o rascunho a cada alteração e mostra
// a folha ao lado do formulário — o que aparece ali é exatamente o que sai.
// Nada é gravado.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = session.user.role as Role;
  if (!hasPermission(role, "FINANCEIRO_MOD", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as FiscalNoteInput | null;
  if (!body) return NextResponse.json({ error: "Rascunho inválido" }, { status: 400 });

  const input: FiscalNoteInput = {
    ...body,
    kind: body.kind === "CREDITO" ? "CREDITO" : "DEBITO",
    language: body.language === "EN" ? "EN" : "PT",
    currency: body.currency === "USD" ? "USD" : "BRL",
    number: Number(body.number) || 1,
    year: Number(body.year) || new Date().getFullYear(),
    items: (body.items || []).map((it, i) => ({
      position: i + 1,
      description: String(it.description || ""),
      unit_value: it.unit_value != null ? Number(it.unit_value) : null,
      quantity: it.quantity != null ? Number(it.quantity) : null,
      amount: Number(it.amount) || 0,
    })),
  };
  // Dados de depósito: mesmo critério do download (cadastro atual do cliente).
  const clients = await prisma.invoiceClient.findMany({ select: { name: true, deposit_bank: true } });
  input.deposit_bank = clients.find((c) => clientKey(c.name) === clientKey(input.client_name))?.deposit_bank ?? null;

  const pdf = await buildFiscalNotePdf(input);
  return new NextResponse(Buffer.from(pdf), {
    headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" },
  });
}
