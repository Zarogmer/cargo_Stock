import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";
import { SECTION_BY_KEY } from "@/lib/demonstracao-financeira";
import { materializeRecurringBills } from "@/lib/services/recurring-bills";

// Contas mensais (recorrentes) do Contas a Pagar — o modelo que gera um
// título por mês (ver src/lib/services/recurring-bills.ts).

// GET /api/financeiro/contas/recorrentes — lista as recorrências.
export async function GET() {
  const guard = await requireFinance("view");
  if (guard.error) return guard.error;

  const bills = await prisma.recurringBill.findMany({
    include: { suppliers: { select: { id: true, name: true } } },
    orderBy: [{ active: "desc" }, { description: "asc" }],
  });
  return NextResponse.json({ bills });
}

// POST /api/financeiro/contas/recorrentes — cria uma conta mensal e já
// materializa os títulos do mês atual/próximo (respeitando o "começa em").
export async function POST(request: NextRequest) {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON inválido" }, { status: 400 });

  const description = String(body.description || "").trim();
  const amount = Number(body.amount);
  const dueDay = Number(body.due_day);
  const startMonth = String(body.start_month || "").trim();
  const endMonth = body.end_month ? String(body.end_month).trim() : null;

  if (!description) return NextResponse.json({ error: "Descrição é obrigatória" }, { status: 400 });
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Valor inválido" }, { status: 400 });
  }
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    return NextResponse.json({ error: "Dia do vencimento deve ser entre 1 e 31" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}$/.test(startMonth)) {
    return NextResponse.json({ error: "Informe o mês de início (AAAA-MM)" }, { status: 400 });
  }
  if (endMonth && !/^\d{4}-\d{2}$/.test(endMonth)) {
    return NextResponse.json({ error: "Mês final inválido (AAAA-MM)" }, { status: 400 });
  }
  if (endMonth && endMonth < startMonth) {
    return NextResponse.json({ error: "O mês final vem antes do início" }, { status: 400 });
  }

  const bill = await prisma.recurringBill.create({
    data: {
      description,
      amount: new Prisma.Decimal(amount.toFixed(2)),
      due_day: dueDay,
      supplier_id: body.supplier_id ? Number(body.supplier_id) : null,
      payee_name: body.payee_name ? String(body.payee_name).trim() : null,
      bank: body.bank ? String(body.bank).trim() : null,
      expense_type: body.expense_type ? String(body.expense_type).trim() : null,
      statement_section:
        body.statement_section && SECTION_BY_KEY.has(String(body.statement_section))
          ? String(body.statement_section)
          : null,
      notes: body.notes ? String(body.notes) : null,
      start_month: startMonth,
      end_month: endMonth,
      created_by: guard.userName,
    },
    include: { suppliers: { select: { id: true, name: true } } },
  });

  // Já gera o(s) título(s) do mês corrente/próximo, se o início permitir.
  let created = 0;
  try {
    created = await materializeRecurringBills();
  } catch (err) {
    console.error("[recorrentes] materialize:", err);
  }

  return NextResponse.json({ bill, generated: created }, { status: 201 });
}
