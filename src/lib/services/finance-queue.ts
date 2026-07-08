// Fila de jobs do Financeiro em Postgres (tabela finance_jobs). Consumida pelo
// tick do scheduler (instrumentation) e por uma rota de cron. Sem Redis: a
// instância única do Railway + SELECT ... FOR UPDATE SKIP LOCKED bastam pro
// volume (docs/financeiro/00-arquitetura.md §5).

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type FinanceJobKind = "EMAIL_MESSAGE";

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 5 * 60 * 1000;

// Enfileira um job. dedupeKey evita enfileirar o mesmo trabalho duas vezes
// (unique no banco → ON CONFLICT DO NOTHING).
export async function enqueueFinanceJob(
  kind: FinanceJobKind,
  payload: Record<string, unknown>,
  dedupeKey?: string
): Promise<boolean> {
  try {
    await prisma.financeJob.create({
      data: { kind, payload: payload as Prisma.InputJsonValue, dedupe_key: dedupeKey ?? null },
    });
    return true;
  } catch (err) {
    // Violação de unique (dedupe_key) = já enfileirado; não é erro.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
}

interface ClaimedJob {
  id: number;
  kind: string;
  payload: unknown;
  attempts: number;
}

// Reivindica um lote de jobs pendentes de forma atômica (SKIP LOCKED), pra
// duas execuções concorrentes nunca pegarem o mesmo job.
async function claimJobs(batch: number): Promise<ClaimedJob[]> {
  return prisma.$queryRaw<ClaimedJob[]>`
    UPDATE finance_jobs SET status = 'PROCESSANDO', updated_at = now()
    WHERE id IN (
      SELECT id FROM finance_jobs
      WHERE status = 'PENDENTE' AND (run_after IS NULL OR run_after <= now())
      ORDER BY id
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, payload, attempts
  `;
}

async function markDone(id: number) {
  await prisma.financeJob.update({ where: { id }, data: { status: "CONCLUIDO" } });
}

async function markFailed(id: number, attempts: number, error: string) {
  const willRetry = attempts + 1 < MAX_ATTEMPTS;
  await prisma.financeJob.update({
    where: { id },
    data: {
      status: willRetry ? "PENDENTE" : "ERRO",
      attempts: attempts + 1,
      last_error: error.slice(0, 1000),
      run_after: willRetry ? new Date(Date.now() + RETRY_DELAY_MS) : null,
    },
  });
}

export interface ProcessResult {
  processed: number;
  done: number;
  failed: number;
}

// Processa a fila. `handlers` mapeia kind → função que executa o job.
export async function processFinanceJobs(
  handlers: Record<string, (payload: unknown) => Promise<void>>,
  batch = 20
): Promise<ProcessResult> {
  const jobs = await claimJobs(batch);
  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    const handler = handlers[job.kind];
    try {
      if (!handler) throw new Error(`Sem handler pro job kind=${job.kind}`);
      await handler(job.payload);
      await markDone(job.id);
      done++;
    } catch (err) {
      await markFailed(job.id, job.attempts, (err as Error).message);
      failed++;
    }
  }
  return { processed: jobs.length, done, failed };
}
