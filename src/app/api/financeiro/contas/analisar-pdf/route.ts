import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";
import { extractDocumentFromPdf, nfeNoteSummary } from "@/lib/services/boleto/nf-extract";

const MAX_SIZE = 15 * 1024 * 1024;

// POST /api/financeiro/contas/analisar-pdf — multipart { file }
// Só LÊ o PDF (boleto ou nota fiscal) e devolve os campos extraídos pra
// pré-preencher o formulário de "Nova conta" — não grava nada.
export async function POST(request: NextRequest) {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'Envie o arquivo no campo "file"' }, { status: 400 });
  }
  if (file.size > MAX_SIZE) return NextResponse.json({ error: "Arquivo maior que 15 MB" }, { status: 413 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const doc = await extractDocumentFromPdf(buffer);

  // Casa fornecedor pelo CNPJ, se houver cadastro.
  let supplierId: number | null = null;
  if (doc.cnpj) {
    const sup = await prisma.supplier.findUnique({ where: { cnpj: doc.cnpj }, select: { id: true } });
    supplierId = sup?.id ?? null;
  }

  const ocrNote = doc.ocr ? "lido por OCR (PDF escaneado) — conferir os dados" : null;
  const notes = [doc.nfe ? nfeNoteSummary(doc.nfe) : null, ocrNote].filter(Boolean).join(" · ") || null;

  return NextResponse.json({
    parsed: {
      kind: doc.kind,
      scanned: doc.scanned,
      ocr: doc.ocr,
      description: doc.suggestedDescription,
      amount: doc.amount,
      due_date: doc.dueDate,
      payee_name: doc.nfe?.emitenteName ?? null,
      payee_document: doc.cnpj,
      digitable_line: doc.digitableLine,
      supplier_id: supplierId,
      notes,
    },
  });
}
