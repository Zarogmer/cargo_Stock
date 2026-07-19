import { NextRequest, NextResponse } from "next/server";
import { Prisma, type PayableStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";
import { normalizePaymentMethod } from "@/lib/payment-methods";
import { resolveStatementSectionKey } from "@/lib/services/statement-section-validate";
import { materializeRecurringBills } from "@/lib/services/recurring-bills";
import { AUTO_APPROVE_SETTING_KEY, autoApproveReason } from "@/lib/services/payable-status";

// GET /api/financeiro/contas?status=A,B — lista títulos (sem o conteúdo dos
// PDFs; anexos vêm só como metadados). Filtro de status opcional; o resto o
// front filtra em memória, como nas outras telas.
export async function GET(request: NextRequest) {
  const guard = await requireFinance("view");
  if (guard.error) return guard.error;

  // Contas mensais: gera os títulos do mês atual/próximo que ainda faltam —
  // lazy, sem cron; o mês novo aparece na primeira abertura da tela dentro
  // dele. Best-effort: falha aqui não derruba a listagem.
  try {
    await materializeRecurringBills();
  } catch (err) {
    console.error("[contas] materialize recorrentes:", err);
  }

  const statusParam = request.nextUrl.searchParams.get("status");
  const statuses = statusParam
    ? (statusParam.split(",").filter(Boolean) as PayableStatus[])
    : undefined;

  const invoices = await prisma.payableInvoice.findMany({
    where: statuses ? { status: { in: statuses } } : undefined,
    include: {
      suppliers: { select: { id: true, name: true, cnpj: true } },
      attachments: {
        select: { id: true, filename: true, created_at: true, created_by: true },
        orderBy: { created_at: "asc" },
      },
    },
    orderBy: [{ due_date: "asc" }, { created_at: "desc" }],
  });

  return NextResponse.json({ invoices });
}

// POST /api/financeiro/contas — lançamento manual. Nasce AGUARDANDO_APROVACAO
// (quem digita já está pedindo aprovação); a regra de teto pode aprovar direto.
export async function POST(request: NextRequest) {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON inválido" }, { status: 400 });

  const description = String(body.description || "").trim();
  const amount = Number(body.amount);
  if (!description) return NextResponse.json({ error: "Descrição é obrigatória" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Valor inválido" }, { status: 400 });
  }

  const digitableLine = body.digitable_line
    ? String(body.digitable_line).replace(/\D/g, "")
    : null;

  // Dedupe por linha digitável: o mesmo boleto não entra duas vezes.
  if (digitableLine) {
    const dup = await prisma.payableInvoice.findUnique({
      where: { digitable_line: digitableLine },
      select: { id: true, description: true, status: true },
    });
    if (dup) {
      return NextResponse.json(
        { error: "Já existe um título com esta linha digitável", existing: dup },
        { status: 409 }
      );
    }
  }

  const autoSetting = await prisma.appSetting.findUnique({
    where: { key: AUTO_APPROVE_SETTING_KEY },
  });
  const autoReason = autoApproveReason(amount, autoSetting?.value);
  const statementSection = await resolveStatementSectionKey(body.statement_section);

  const invoice = await prisma.payableInvoice.create({
    data: {
      description,
      amount: new Prisma.Decimal(amount.toFixed(2)),
      due_date: body.due_date ? new Date(body.due_date) : null,
      supplier_id: body.supplier_id ? Number(body.supplier_id) : null,
      payee_name: body.payee_name ? String(body.payee_name).trim() : null,
      payee_document: body.payee_document ? String(body.payee_document).replace(/\D/g, "") : null,
      digitable_line: digitableLine,
      barcode: body.barcode ? String(body.barcode).replace(/\D/g, "") : null,
      notes: body.notes ? String(body.notes) : null,
      bank: body.bank ? String(body.bank).trim() : null,
      expense_type: body.expense_type ? String(body.expense_type).trim() : null,
      payment_method: normalizePaymentMethod(body.payment_method),
      recurrence: body.recurrence === "MENSAL" ? "MENSAL" : "UNICA",
      // Seção da Demonstração Financeira — fixas ("6.1".."12") ou custom ("c<id>").
      statement_section: statementSection,
      origin: "MANUAL",
      status: autoReason ? "APROVADO" : "AGUARDANDO_APROVACAO",
      approved_by: autoReason,
      approved_at: autoReason ? new Date() : null,
      created_by: guard.userName,
    },
    include: { suppliers: { select: { id: true, name: true, cnpj: true } }, attachments: true },
  });

  return NextResponse.json({ invoice }, { status: 201 });
}
