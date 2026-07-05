import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

// GET /api/financeiro/anexos/[id] — serve o PDF inline (pro <iframe> do
// detalhe do título e pra download).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("view");
  if (guard.error) return guard.error;
  const { id } = await params;

  const attachment = await prisma.invoiceAttachment.findUnique({ where: { id } });
  if (!attachment) return NextResponse.json({ error: "Anexo não encontrado" }, { status: 404 });

  return new NextResponse(Buffer.from(attachment.content), {
    headers: {
      "Content-Type": attachment.mime_type,
      "Content-Disposition": `inline; filename="${encodeURIComponent(attachment.filename)}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

// DELETE /api/financeiro/anexos/[id] — remove um anexo. Bloqueado depois que o
// título foi pago (o comprovante do que foi pago não some).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const { id } = await params;

  const attachment = await prisma.invoiceAttachment.findUnique({
    where: { id },
    select: { id: true, invoices: { select: { status: true } } },
  });
  if (!attachment) return NextResponse.json({ error: "Anexo não encontrado" }, { status: 404 });
  if (attachment.invoices.status === "PAGO") {
    return NextResponse.json({ error: "Título pago — anexo não pode ser removido" }, { status: 422 });
  }

  await prisma.invoiceAttachment.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
