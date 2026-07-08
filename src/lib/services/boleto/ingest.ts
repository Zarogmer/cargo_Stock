// Ingestão de um PDF de boleto → cria PayableInvoice (Contas a Pagar) com o
// boleto anexado, valor e vencimento derivados da linha digitável. Reusado por:
//   - upload manual na UI (origin MANUAL) — funciona hoje, sem integração;
//   - captura por e-mail via Graph (origin EMAIL) — Fase 5c.
//
// Dedupe em três camadas, pra o mesmo boleto nunca virar dois títulos:
//   1. SHA-256 do PDF (anexo já existe → devolve o título dele);
//   2. linha digitável (título já existe com a mesma linha);
//   3. se não há linha digitável, cai só no SHA-256.

import { createHash } from "node:crypto";
import { Prisma, type PayableOrigin } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { extractBoletoFromPdf } from "./pdf";

export interface IngestResult {
  status: "created" | "duplicate";
  invoiceId: string;
  reason?: string;
  parsed: {
    amount: number | null;
    dueDate: string | null;
    digitableLine: string | null;
    tipo: string | null;
    cnpj: string | null;
    dvValid: boolean | null;
  };
}

export interface IngestOptions {
  origin?: PayableOrigin; // default MANUAL
  createdBy: string;
  filename?: string;
  sourceMessageId?: string; // id da mensagem no Graph, quando vier de e-mail
  description?: string; // fallback de descrição (ex.: assunto do e-mail)
}

export async function ingestBoletoPdf(buffer: Buffer, opts: IngestOptions): Promise<IngestResult> {
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const filename = opts.filename || "boleto.pdf";

  // (1) mesmo arquivo já ingerido?
  const existingAttachment = await prisma.invoiceAttachment.findUnique({
    where: { sha256 },
    select: { invoice_id: true },
  });
  if (existingAttachment) {
    return {
      status: "duplicate",
      invoiceId: existingAttachment.invoice_id,
      reason: "PDF idêntico já ingerido",
      parsed: emptyParsed(),
    };
  }

  const extract = await extractBoletoFromPdf(buffer);
  const linha = extract.linha;
  const digitableLine = linha?.digits ?? null;

  // (2) linha digitável já existe?
  if (digitableLine) {
    const dup = await prisma.payableInvoice.findUnique({
      where: { digitable_line: digitableLine },
      select: { id: true },
    });
    if (dup) {
      // anexa o PDF ao título existente (não perde o arquivo) e retorna.
      await attachSafe(dup.id, buffer, sha256, filename, opts);
      return {
        status: "duplicate",
        invoiceId: dup.id,
        reason: "Boleto com a mesma linha digitável já cadastrado",
        parsed: toParsed(extract),
      };
    }
  }

  // Casa fornecedor por CNPJ do beneficiário, se houver.
  let supplierId: number | null = null;
  if (extract.cnpj) {
    const sup = await prisma.supplier.findUnique({ where: { cnpj: extract.cnpj }, select: { id: true } });
    supplierId = sup?.id ?? null;
  }

  const amount = linha?.amount ?? null;
  const description =
    opts.description?.trim() ||
    (extract.cnpj ? `Boleto ${extract.cnpj}` : filename.replace(/\.pdf$/i, "")) ||
    "Boleto";

  const invoice = await prisma.payableInvoice.create({
    data: {
      description,
      // Sem valor legível → 0 provisório; o usuário corrige na aprovação.
      amount: new Prisma.Decimal((amount ?? 0).toFixed(2)),
      due_date: linha?.dueDate ?? null,
      supplier_id: supplierId,
      payee_document: extract.cnpj,
      digitable_line: digitableLine,
      barcode: linha?.barcode ?? null,
      origin: opts.origin ?? "MANUAL",
      status: "RECEBIDO",
      created_by: opts.createdBy,
      attachments: {
        create: {
          filename,
          mime_type: "application/pdf",
          content: new Uint8Array(buffer),
          sha256,
          source_message_id: opts.sourceMessageId ?? null,
          created_by: opts.createdBy,
        },
      },
    },
    select: { id: true },
  });

  return { status: "created", invoiceId: invoice.id, parsed: toParsed(extract) };
}

async function attachSafe(
  invoiceId: string,
  buffer: Buffer,
  sha256: string,
  filename: string,
  opts: IngestOptions
) {
  try {
    await prisma.invoiceAttachment.create({
      data: {
        invoice_id: invoiceId,
        filename,
        mime_type: "application/pdf",
        content: new Uint8Array(buffer),
        sha256,
        source_message_id: opts.sourceMessageId ?? null,
        created_by: opts.createdBy,
      },
    });
  } catch {
    // corrida/duplicado de sha256 — ignora, o PDF já está lá.
  }
}

function toParsed(extract: Awaited<ReturnType<typeof extractBoletoFromPdf>>): IngestResult["parsed"] {
  return {
    amount: extract.linha?.amount ?? null,
    dueDate: extract.linha?.dueDate ? extract.linha.dueDate.toISOString().slice(0, 10) : null,
    digitableLine: extract.linha?.digits ?? null,
    tipo: extract.linha?.tipo ?? null,
    cnpj: extract.cnpj,
    dvValid: extract.linha?.dvValid ?? null,
  };
}

function emptyParsed(): IngestResult["parsed"] {
  return { amount: null, dueDate: null, digitableLine: null, tipo: null, cnpj: null, dvValid: null };
}
