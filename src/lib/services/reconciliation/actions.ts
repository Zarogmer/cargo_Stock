// Ações de revisão da fila de conciliação: aceitar/rejeitar uma sugestão e
// casar manualmente. Mantêm título e conciliação consistentes numa transação.

import { prisma } from "@/lib/prisma";

// Aceita uma sugestão: conciliação vira CONFIRMADA e o título vira PAGO.
export async function acceptReconciliation(reconciliationId: number, userName: string) {
  const rec = await prisma.reconciliation.findUnique({ where: { id: reconciliationId } });
  if (!rec) return { error: "Conciliação não encontrada", status: 404 as const };
  if (rec.status === "CONFIRMADA") return { ok: true };

  await prisma.$transaction([
    prisma.reconciliation.update({
      where: { id: reconciliationId },
      data: { status: "CONFIRMADA", decided_by: userName, decided_at: new Date() },
    }),
    prisma.payableInvoice.update({
      where: { id: rec.invoice_id },
      data: { status: "PAGO", paid_by: `Conciliação (${userName})`, paid_at: new Date() },
    }),
  ]);
  return { ok: true };
}

// Rejeita uma sugestão: fica REJEITADA (a movimentação não é ressugerida). O
// título continua em aberto.
export async function rejectReconciliation(reconciliationId: number, userName: string) {
  const rec = await prisma.reconciliation.findUnique({ where: { id: reconciliationId } });
  if (!rec) return { error: "Conciliação não encontrada", status: 404 as const };

  await prisma.reconciliation.update({
    where: { id: reconciliationId },
    data: { status: "REJEITADA", decided_by: userName, decided_at: new Date() },
  });
  return { ok: true };
}

// Casa manualmente uma movimentação a um título. Substitui uma conciliação
// anterior da mesma movimentação (ex.: uma sugestão que estava errada).
export async function manualReconcile(transactionId: string, invoiceId: string, userName: string) {
  const [tx, inv] = await Promise.all([
    prisma.bankTransaction.findUnique({ where: { id: transactionId } }),
    prisma.payableInvoice.findUnique({ where: { id: invoiceId } }),
  ]);
  if (!tx) return { error: "Movimentação não encontrada", status: 404 as const };
  if (!inv) return { error: "Título não encontrado", status: 404 as const };
  if (inv.status === "CANCELADO") return { error: "Título cancelado não pode ser conciliado", status: 422 as const };

  await prisma.$transaction([
    prisma.reconciliation.upsert({
      where: { transaction_id: transactionId },
      create: {
        transaction_id: transactionId,
        invoice_id: invoiceId,
        status: "CONFIRMADA",
        score: 100,
        reason: "Conciliação manual",
        matched_by: userName,
        decided_by: userName,
        decided_at: new Date(),
      },
      update: {
        invoice_id: invoiceId,
        status: "CONFIRMADA",
        reason: "Conciliação manual",
        matched_by: userName,
        decided_by: userName,
        decided_at: new Date(),
      },
    }),
    prisma.payableInvoice.update({
      where: { id: invoiceId },
      data: { status: "PAGO", paid_by: `Conciliação manual (${userName})`, paid_at: new Date() },
    }),
  ]);
  return { ok: true };
}
