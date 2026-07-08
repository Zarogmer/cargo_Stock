// Motor de conciliação — casa débitos do extrato (BankTransaction) com títulos
// a pagar (PayableInvoice). Independente de banco: só lê o model normalizado.
//
// Score 0-100 ponderado por valor, documento (CNPJ/CPF), proximidade de data e
// similaridade de nome. Score alto e candidato único → concilia automático
// (título vira PAGO). Divergência/ambiguidade → sugestão na fila de revisão.
//
// Idempotência: a @@unique(transaction_id) de Reconciliation garante 1 conciliação
// por movimentação. O run pula qualquer transação que já tenha conciliação (mesmo
// REJEITADA), então rodar de novo nunca duplica nem ressugere o que foi descartado.

import { Prisma, type PayableStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalize } from "@/lib/utils";

// Configuráveis via AppSetting.
export const CFG_TOLERANCE_DAYS = "financeiro_conciliacao_tolerancia_dias";
export const CFG_AUTO_SCORE = "financeiro_conciliacao_score_auto";
const DEFAULT_TOLERANCE_DAYS = 3;
const DEFAULT_AUTO_SCORE = 90;
const SUGGEST_MIN_SCORE = 50; // abaixo disso não vira nem sugestão

// Títulos que ainda podem ser pagos (candidatos à conciliação).
const OPEN_INVOICE_STATUSES: PayableStatus[] = ["RECEBIDO", "AGUARDANDO_APROVACAO", "APROVADO"];

interface Candidate {
  id: string;
  amountCents: number;
  due_date: Date | null;
  payee_name: string | null;
  payee_document: string | null;
  supplierCnpj: string | null;
  supplierName: string | null;
}

interface ScoredCandidate extends Candidate {
  score: number;
  reasons: string[];
}

function toCents(d: Prisma.Decimal | number): number {
  return Math.round(Number(d) * 100);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

// Jaccard sobre tokens normalizados — 0..1.
function nameSimilarity(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const ta = new Set(normalize(a).split(/\s+/).filter((w) => w.length >= 3));
  const tb = new Set(normalize(b).split(/\s+/).filter((w) => w.length >= 3));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter);
}

export interface MatchScore {
  score: number;
  reasons: string[];
}

// Pontua um par (transação, título). Assume que o valor JÁ bate (gate do caller).
export function scoreMatch(
  tx: { postedAt: Date; payeeName: string | null; payeeDocument: string | null },
  inv: Candidate,
  toleranceDays: number
): MatchScore {
  const reasons: string[] = ["valor exato"];
  let score = 50;

  const invDoc = inv.payee_document || inv.supplierCnpj;
  if (tx.payeeDocument && invDoc && tx.payeeDocument === invDoc) {
    score += 30;
    reasons.push("CNPJ/CPF confere");
  }

  if (inv.due_date) {
    const diff = Math.abs(daysBetween(tx.postedAt, inv.due_date));
    if (diff <= toleranceDays) {
      score += Math.round(20 * (1 - diff / (toleranceDays + 1)));
      reasons.push(diff === 0 ? "vencimento no dia" : `vencimento ±${diff}d`);
    }
  }

  const sim = nameSimilarity(tx.payeeName, inv.payee_name || inv.supplierName);
  if (sim >= 0.5) {
    score += Math.round(20 * sim);
    reasons.push("nome parecido");
  }

  return { score: Math.min(100, score), reasons };
}

async function readIntSetting(key: string, fallback: number): Promise<number> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  const n = row ? parseInt(row.value, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface ReconcileSummary {
  confirmed: number;
  suggested: number;
  unmatched: number;
  scanned: number;
}

// Roda o motor sobre as transações ainda não conciliadas (opcionalmente de uma
// conta só). Retorna o resumo e registra em IntegrationLog.
export async function runReconciliation(
  userName: string,
  opts: { accountId?: number } = {}
): Promise<ReconcileSummary> {
  const toleranceDays = await readIntSetting(CFG_TOLERANCE_DAYS, DEFAULT_TOLERANCE_DAYS);
  const autoScore = await readIntSetting(CFG_AUTO_SCORE, DEFAULT_AUTO_SCORE);

  // Débitos conciliáveis, sem conciliação ainda.
  const txs = await prisma.bankTransaction.findMany({
    where: {
      reconcilable: true,
      amount: { lt: 0 },
      reconciliation: null,
      ...(opts.accountId ? { bank_account_id: opts.accountId } : {}),
    },
    orderBy: [{ posted_at: "asc" }, { id: "asc" }],
  });

  const invoicesRaw = await prisma.payableInvoice.findMany({
    where: { status: { in: OPEN_INVOICE_STATUSES } },
    include: { suppliers: { select: { cnpj: true, name: true } } },
  });

  // Títulos já conciliados de forma CONFIRMADA saem do páreo.
  const confirmedInvoiceIds = new Set(
    (
      await prisma.reconciliation.findMany({
        where: { status: "CONFIRMADA" },
        select: { invoice_id: true },
      })
    ).map((r) => r.invoice_id)
  );

  const candidates: Candidate[] = invoicesRaw
    .filter((inv) => !confirmedInvoiceIds.has(inv.id))
    .map((inv) => ({
      id: inv.id,
      amountCents: toCents(inv.amount),
      due_date: inv.due_date,
      payee_name: inv.payee_name,
      payee_document: inv.payee_document,
      supplierCnpj: inv.suppliers?.cnpj ?? null,
      supplierName: inv.suppliers?.name ?? null,
    }));

  // Índice por valor pra não varrer todos os títulos por transação.
  const byValue = new Map<number, Candidate[]>();
  for (const c of candidates) {
    const arr = byValue.get(c.amountCents);
    if (arr) arr.push(c);
    else byValue.set(c.amountCents, [c]);
  }

  const usedInvoiceIds = new Set<string>(); // travados por auto-conciliação neste run
  let confirmed = 0;
  let suggested = 0;
  let unmatched = 0;

  for (const tx of txs) {
    const cents = Math.abs(toCents(tx.amount));
    const pool = (byValue.get(cents) || []).filter((c) => !usedInvoiceIds.has(c.id));
    if (pool.length === 0) {
      unmatched++;
      continue;
    }

    const scored: ScoredCandidate[] = pool
      .map((c) => ({ ...c, ...scoreMatch({ postedAt: tx.posted_at, payeeName: tx.payee_name, payeeDocument: tx.payee_document }, c, toleranceDays) }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const tie = scored.filter((s) => s.score === best.score).length > 1;

    if (best.score < SUGGEST_MIN_SCORE) {
      unmatched++;
      continue;
    }

    const auto = best.score >= autoScore && !tie;
    const reason = best.reasons.join(", ") + (tie ? " (empate — revisar)" : "");

    if (auto) {
      await prisma.$transaction([
        prisma.reconciliation.create({
          data: {
            transaction_id: tx.id,
            invoice_id: best.id,
            status: "CONFIRMADA",
            score: best.score,
            reason,
            matched_by: "AUTO",
            decided_at: new Date(),
          },
        }),
        prisma.payableInvoice.update({
          where: { id: best.id },
          data: { status: "PAGO", paid_by: `Conciliação automática (${userName})`, paid_at: new Date() },
        }),
      ]);
      usedInvoiceIds.add(best.id);
      confirmed++;
    } else {
      await prisma.reconciliation.create({
        data: {
          transaction_id: tx.id,
          invoice_id: best.id,
          status: "SUGERIDA",
          score: best.score,
          reason,
          matched_by: "AUTO",
        },
      });
      suggested++;
    }
  }

  const summary: ReconcileSummary = { confirmed, suggested, unmatched, scanned: txs.length };
  await prisma.integrationLog.create({
    data: {
      provider: "ENGINE",
      operation: "run_conciliacao",
      ok: true,
      message: `${confirmed} conciliadas, ${suggested} sugestões, ${unmatched} sem par (de ${txs.length} débitos)`,
      details: { ...summary, toleranceDays, autoScore } as Prisma.InputJsonValue,
    },
  });
  return summary;
}
