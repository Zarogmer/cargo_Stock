import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

// GET /api/financeiro/painel — visão geral do módulo bancário (só EXEC/FIN/TEC,
// via requireFinance). Fica DENTRO do Financeiro; nada no Dashboard principal.
export async function GET() {
  const guard = await requireFinance("view");
  if (guard.error) return guard.error;

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const in7 = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  const monthPrefix = today.slice(0, 7);

  const [
    invoices,
    recebidosCount,
    sugeridasCount,
    confirmadasCount,
    naoConciliadas,
    accounts,
    logs,
  ] = await Promise.all([
    // Títulos em aberto (não pagos/cancelados) — pra falta pagar / vencidas / vencendo.
    prisma.payableInvoice.findMany({
      where: { status: { in: ["RECEBIDO", "AGUARDANDO_APROVACAO", "APROVADO"] } },
      select: { id: true, description: true, amount: true, due_date: true, status: true, suppliers: { select: { name: true } } },
      orderBy: { due_date: "asc" },
    }),
    prisma.payableInvoice.count({ where: { status: "RECEBIDO" } }),
    prisma.reconciliation.count({ where: { status: "SUGERIDA" } }),
    prisma.reconciliation.count({ where: { status: "CONFIRMADA" } }),
    // Débitos conciliáveis ainda sem conciliação (pendentes de casar).
    prisma.bankTransaction.count({
      where: { reconcilable: true, amount: { lt: 0 }, reconciliation: null, review_status: "PENDENTE" },
    }),
    prisma.bankAccount.findMany({
      where: { active: true },
      select: { id: true, nickname: true, bank: true, opening_balance: true },
    }),
    prisma.integrationLog.findMany({ orderBy: { created_at: "desc" }, take: 20 }),
  ]);

  // Saldo atual por conta = saldo inicial + soma das movimentações.
  const sums = await prisma.bankTransaction.groupBy({
    by: ["bank_account_id"],
    _sum: { amount: true },
  });
  const sumByAccount = new Map(sums.map((s) => [s.bank_account_id, Number(s._sum.amount ?? 0)]));
  const saldos = accounts.map((a) => ({
    id: a.id,
    nickname: a.nickname,
    bank: a.bank,
    balance: Number(a.opening_balance) + (sumByAccount.get(a.id) ?? 0),
  }));

  // Agregados de contas a pagar.
  let faltaPagar = 0;
  let vencidasCount = 0;
  let vencendo7Count = 0;
  let vencendo7Sum = 0;
  const proximosVencimentos: Array<{ id: string; description: string; amount: number; due_date: string | null; supplier: string | null; overdue: boolean }> = [];
  for (const inv of invoices) {
    const amount = Number(inv.amount);
    faltaPagar += amount;
    const due = inv.due_date?.toISOString().slice(0, 10) || null;
    const overdue = !!due && due < today;
    if (overdue) vencidasCount++;
    else if (due && due <= in7) {
      vencendo7Count++;
      vencendo7Sum += amount;
    }
    if (proximosVencimentos.length < 12) {
      proximosVencimentos.push({
        id: inv.id,
        description: inv.description,
        amount,
        due_date: due,
        supplier: inv.suppliers?.name ?? null,
        overdue,
      });
    }
  }

  const pagoMes = await prisma.payableInvoice.aggregate({
    where: { status: "PAGO", paid_at: { gte: new Date(`${monthPrefix}-01T00:00:00Z`) } },
    _sum: { amount: true },
  });

  return NextResponse.json({
    contasPagar: {
      faltaPagar,
      vencidasCount,
      vencendo7Count,
      vencendo7Sum,
      pagoMes: Number(pagoMes._sum.amount ?? 0),
      recebidosCount,
    },
    conciliacao: {
      sugeridas: sugeridasCount,
      confirmadas: confirmadasCount,
      naoConciliadas,
    },
    saldos,
    proximosVencimentos,
    logs: logs.map((l) => ({
      id: l.id,
      provider: l.provider,
      operation: l.operation,
      ok: l.ok,
      message: l.message,
      created_at: l.created_at,
    })),
  });
}
