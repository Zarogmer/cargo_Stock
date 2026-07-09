import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

// GET /api/financeiro/contas/[id] — detalhe do título (anexos como metadados;
// o PDF em si é servido por /api/financeiro/anexos/[id]).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("view");
  if (guard.error) return guard.error;
  const { id } = await params;

  const invoice = await prisma.payableInvoice.findUnique({
    where: { id },
    include: {
      suppliers: { select: { id: true, name: true, cnpj: true } },
      attachments: {
        select: { id: true, filename: true, mime_type: true, created_at: true, created_by: true, source_message_id: true },
        orderBy: { created_at: "asc" },
      },
    },
  });
  if (!invoice) return NextResponse.json({ error: "Título não encontrado" }, { status: 404 });
  return NextResponse.json({ invoice });
}

// PATCH /api/financeiro/contas/[id] — edita os dados do título. Valor,
// vencimento, fornecedor etc. só mudam enquanto não aprovado (o que foi
// aprovado não muda por trás); notes pode sempre, exceto cancelado.
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON inválido" }, { status: 400 });

  const invoice = await prisma.payableInvoice.findUnique({ where: { id } });
  if (!invoice) return NextResponse.json({ error: "Título não encontrado" }, { status: 404 });
  if (invoice.status === "CANCELADO") {
    return NextResponse.json({ error: "Título cancelado não pode ser editado" }, { status: 422 });
  }

  const data: Record<string, unknown> = {};
  if (body.notes !== undefined) data.notes = body.notes ? String(body.notes) : null;
  // Campos do controle de vencimentos, editáveis em qualquer status (menos cancelado).
  if (body.bank !== undefined) data.bank = body.bank ? String(body.bank).trim() : null;
  if (body.expense_type !== undefined) data.expense_type = body.expense_type ? String(body.expense_type).trim() : null;
  if (body.paid_amount !== undefined) {
    data.paid_amount = body.paid_amount === null || body.paid_amount === "" ? null : new Prisma.Decimal(Number(body.paid_amount).toFixed(2));
  }
  if (body.payment_date !== undefined) data.payment_date = body.payment_date ? new Date(body.payment_date) : null;

  const wantsCoreEdit =
    body.description !== undefined ||
    body.amount !== undefined ||
    body.due_date !== undefined ||
    body.supplier_id !== undefined ||
    body.payee_name !== undefined ||
    body.payee_document !== undefined ||
    body.digitable_line !== undefined ||
    body.barcode !== undefined;

  if (wantsCoreEdit) {
    // Edição liberada em qualquer status (menos CANCELADO, já barrado acima):
    // títulos vindos do OFX/boleto trazem dados crus (fornecedor do memo, sem
    // vencimento) e o usuário precisa poder corrigir mesmo depois de pagos.
    if (body.description !== undefined) {
      const d = String(body.description).trim();
      if (!d) return NextResponse.json({ error: "Descrição é obrigatória" }, { status: 400 });
      data.description = d;
    }
    if (body.amount !== undefined) {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: "Valor inválido" }, { status: 400 });
      }
      data.amount = new Prisma.Decimal(amount.toFixed(2));
    }
    if (body.due_date !== undefined) data.due_date = body.due_date ? new Date(body.due_date) : null;
    if (body.supplier_id !== undefined) data.supplier_id = body.supplier_id ? Number(body.supplier_id) : null;
    if (body.payee_name !== undefined) data.payee_name = body.payee_name ? String(body.payee_name).trim() : null;
    if (body.payee_document !== undefined) {
      data.payee_document = body.payee_document ? String(body.payee_document).replace(/\D/g, "") : null;
    }
    if (body.digitable_line !== undefined) {
      const line = body.digitable_line ? String(body.digitable_line).replace(/\D/g, "") : null;
      if (line) {
        const dup = await prisma.payableInvoice.findUnique({ where: { digitable_line: line } });
        if (dup && dup.id !== id) {
          return NextResponse.json(
            { error: "Já existe um título com esta linha digitável" },
            { status: 409 }
          );
        }
      }
      data.digitable_line = line;
    }
    if (body.barcode !== undefined) data.barcode = body.barcode ? String(body.barcode).replace(/\D/g, "") : null;
  }

  const updated = await prisma.payableInvoice.update({
    where: { id },
    data,
    include: {
      suppliers: { select: { id: true, name: true, cnpj: true } },
      attachments: {
        select: { id: true, filename: true, created_at: true, created_by: true },
        orderBy: { created_at: "asc" },
      },
    },
  });

  return NextResponse.json({ invoice: updated });
}

// DELETE /api/financeiro/contas/[id] — exclui o título de vez (diferente de
// "Cancelar", que só marca CANCELADO e mantém o histórico). Anexos e
// conciliações somem junto (onDelete: Cascade no schema). Uso: limpar
// lançamentos errados/duplicados que não deveriam ficar no controle.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;
  const { id } = await params;

  const invoice = await prisma.payableInvoice.findUnique({ where: { id }, select: { id: true } });
  if (!invoice) return NextResponse.json({ error: "Título não encontrado" }, { status: 404 });

  await prisma.payableInvoice.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
