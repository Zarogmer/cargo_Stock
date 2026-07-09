// Ingestão de um PDF (boleto OU nota fiscal) → cria PayableInvoice em Contas a
// Pagar, com o arquivo anexado e os campos extraídos. Usado pelo botão
// "Import Boleto (PDF)" (um ou vários arquivos de uma vez).
//
// Dedupe: SHA-256 do PDF (mesmo arquivo nunca vira dois títulos). Boleto
// também dedupa por linha digitável.

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { extractDocumentFromPdf, type DocExtract } from "./nf-extract";

export interface DocIngestResult {
  status: "created" | "duplicate" | "scanned";
  invoiceId: string | null;
  filename: string;
  kind: DocExtract["kind"];
  description: string;
  amount: number | null;
  needsAmount: boolean; // valor não detectado — usuário completa
}

export async function ingestDocumentPdf(
  buffer: Buffer,
  filename: string,
  createdBy: string,
): Promise<DocIngestResult> {
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const nameNoExt = filename.replace(/\.pdf$/i, "");

  // Mesmo arquivo já ingerido?
  const existing = await prisma.invoiceAttachment.findUnique({
    where: { sha256 },
    select: { invoice_id: true },
  });
  if (existing) {
    return { status: "duplicate", invoiceId: existing.invoice_id, filename, kind: "DESCONHECIDO", description: nameNoExt, amount: null, needsAmount: false };
  }

  const doc = await extractDocumentFromPdf(buffer);

  // Escaneado / ilegível: cria mesmo assim (com o PDF anexo) pra não perder o
  // documento, mas sinaliza que precisa preencher à mão.
  const description = doc.suggestedDescription?.trim() || nameNoExt || "Documento";
  const amount = doc.amount ?? null;

  // Boleto com linha digitável já cadastrada → anexa no título existente.
  if (doc.digitableLine) {
    const dup = await prisma.payableInvoice.findUnique({
      where: { digitable_line: doc.digitableLine },
      select: { id: true },
    });
    if (dup) {
      await attachSafe(dup.id, buffer, sha256, filename, createdBy);
      return { status: "duplicate", invoiceId: dup.id, filename, kind: doc.kind, description, amount, needsAmount: false };
    }
  }

  // Casa fornecedor pelo CNPJ.
  let supplierId: number | null = null;
  if (doc.cnpj) {
    const sup = await prisma.supplier.findUnique({ where: { cnpj: doc.cnpj }, select: { id: true } });
    supplierId = sup?.id ?? null;
  }

  const notes = doc.nfe
    ? `NF ${doc.nfe.numero} série ${doc.nfe.serie} · emissão ${doc.nfe.emissao || doc.nfe.competencia} · chave ${doc.nfe.chave}`
    : null;

  const invoice = await prisma.payableInvoice.create({
    data: {
      description,
      amount: new Prisma.Decimal((amount ?? 0).toFixed(2)),
      due_date: doc.dueDate ? new Date(doc.dueDate) : null,
      supplier_id: supplierId,
      payee_document: doc.cnpj,
      payee_name: doc.nfe?.emitenteName ?? null,
      digitable_line: doc.digitableLine,
      barcode: doc.boleto?.barcode ?? doc.nfe?.chave ?? null,
      notes,
      origin: "BOLETO_PDF",
      status: "RECEBIDO",
      created_by: createdBy,
      attachments: {
        create: {
          filename,
          mime_type: "application/pdf",
          content: new Uint8Array(buffer),
          sha256,
          created_by: createdBy,
        },
      },
    },
    select: { id: true },
  });

  return {
    status: doc.scanned ? "scanned" : "created",
    invoiceId: invoice.id,
    filename,
    kind: doc.kind,
    description,
    amount,
    needsAmount: amount == null || amount === 0,
  };
}

async function attachSafe(invoiceId: string, buffer: Buffer, sha256: string, filename: string, createdBy: string) {
  try {
    await prisma.invoiceAttachment.create({
      data: {
        invoice_id: invoiceId,
        filename,
        mime_type: "application/pdf",
        content: new Uint8Array(buffer),
        sha256,
        created_by: createdBy,
      },
    });
  } catch {
    // corrida/duplicado de sha256 — o PDF já está lá.
  }
}
