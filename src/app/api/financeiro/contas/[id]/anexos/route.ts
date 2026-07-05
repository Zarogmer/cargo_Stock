import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

// Limite de tamanho do PDF — boleto real tem dezenas/centenas de KB; 10 MB já
// é folga. O arquivo vive inline no Postgres (sem storage externo).
const MAX_SIZE = 10 * 1024 * 1024;

// POST /api/financeiro/contas/[id]/anexos — multipart FormData com campo
// "file". Dedupe global por SHA-256: o mesmo arquivo nunca é gravado duas
// vezes, mesmo que anexado em títulos diferentes.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const { id } = await params;

  const invoice = await prisma.payableInvoice.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!invoice) return NextResponse.json({ error: "Título não encontrado" }, { status: 404 });
  if (invoice.status === "CANCELADO") {
    return NextResponse.json({ error: "Título cancelado não recebe anexos" }, { status: 422 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Envie o arquivo no campo \"file\"" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "Arquivo maior que 10 MB" }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  // Valida pelo conteúdo (magic bytes), não só pela extensão/mime do cliente.
  if (!buffer.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
    return NextResponse.json({ error: "O arquivo não é um PDF válido" }, { status: 400 });
  }

  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const existing = await prisma.invoiceAttachment.findUnique({
    where: { sha256 },
    select: { id: true, filename: true, invoice_id: true },
  });
  if (existing) {
    const samePlace = existing.invoice_id === id;
    return NextResponse.json(
      {
        error: samePlace
          ? "Este PDF já está anexado a este título"
          : "Este PDF já está anexado a outro título",
        existing,
      },
      { status: 409 }
    );
  }

  const attachment = await prisma.invoiceAttachment.create({
    data: {
      invoice_id: id,
      filename: file.name || "boleto.pdf",
      mime_type: "application/pdf",
      content: buffer,
      sha256,
      created_by: guard.userName,
    },
    select: { id: true, filename: true, created_at: true, created_by: true },
  });

  return NextResponse.json({ attachment }, { status: 201 });
}
