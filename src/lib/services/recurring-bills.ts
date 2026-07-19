// Contas mensais do Contas a Pagar — materializa os títulos das recorrências.
//
// Cada RecurringBill ativa gera um PayableInvoice por mês (mês atual e o
// próximo, pra dar visibilidade do que vem), vencendo no due_day (clampado ao
// fim do mês curto). O título nasce APROVADO — é conta conhecida que volta
// todo mês; pagar/conciliar segue o fluxo normal.
//
// Idempotente: o par (recurring_bill_id, due_date) é @@unique no schema, e o
// gerador confere o que já existe antes de criar. Roda no GET da listagem do
// Contas a Pagar (lazy — sem cron), então o mês novo aparece na primeira vez
// que alguém abre a tela dentro dele.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** "YYYY-MM" de uma data local. */
function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Vencimento da recorrência num mês "YYYY-MM": due_day clampado ao fim do mês. */
export function dueDateInMonth(month: string, dueDay: number): Date {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1, Math.min(Math.max(1, dueDay), lastDay)));
}

/**
 * Gera os títulos pendentes das contas mensais ativas (mês atual + próximo).
 * Devolve quantos criou. Erro aqui não pode derrubar a listagem — o chamador
 * trata como best-effort.
 */
export async function materializeRecurringBills(): Promise<number> {
  const now = new Date();
  const thisMonth = monthKey(now);
  const nextMonth = monthKey(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  const months = [thisMonth, nextMonth];

  const bills = await prisma.recurringBill.findMany({ where: { active: true } });
  if (bills.length === 0) return 0;

  // due_dates alvo por recorrência, respeitando começa em / termina em.
  const targets: { bill: (typeof bills)[number]; due: Date }[] = [];
  for (const bill of bills) {
    for (const month of months) {
      if (month < bill.start_month) continue;
      if (bill.end_month && month > bill.end_month) continue;
      targets.push({ bill, due: dueDateInMonth(month, bill.due_day) });
    }
  }
  if (targets.length === 0) return 0;

  // O que já existe (o unique segura corrida; a consulta evita o erro).
  const existing = await prisma.payableInvoice.findMany({
    where: {
      recurring_bill_id: { in: bills.map((b) => b.id) },
      due_date: { in: targets.map((t) => t.due) },
    },
    select: { recurring_bill_id: true, due_date: true },
  });
  const have = new Set(existing.map((e) => `${e.recurring_bill_id}|${e.due_date!.toISOString().slice(0, 10)}`));

  const toCreate = targets.filter((t) => !have.has(`${t.bill.id}|${t.due.toISOString().slice(0, 10)}`));
  if (toCreate.length === 0) return 0;

  await prisma.payableInvoice.createMany({
    data: toCreate.map(({ bill, due }) => ({
      description: bill.description,
      amount: new Prisma.Decimal(Number(bill.amount).toFixed(2)),
      due_date: due,
      supplier_id: bill.supplier_id,
      payee_name: bill.payee_name,
      bank: bill.bank,
      expense_type: bill.expense_type,
      statement_section: bill.statement_section,
      notes: bill.notes,
      recurring_bill_id: bill.id,
      origin: "MANUAL" as const,
      status: "APROVADO" as const,
      approved_by: "conta mensal",
      approved_at: new Date(),
      created_by: bill.created_by,
    })),
    skipDuplicates: true,
  });
  return toCreate.length;
}
