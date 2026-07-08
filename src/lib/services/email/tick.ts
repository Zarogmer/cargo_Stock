// Um tick do Financeiro (chamado pelo scheduler in-process e pela rota de cron):
// sincroniza as caixas (se o Graph estiver configurado) e processa a fila.
// Sempre processa a fila — assim, se a config chegar depois, os jobs pendentes
// andam sozinhos. Erros são isolados por caixa/job; nunca derrubam o tick.

import { syncAllMailboxes, processEmailJobs } from "./sync";

export async function runFinanceTick(): Promise<{ sync: unknown; jobs: unknown }> {
  let sync: unknown = null;
  try {
    sync = await syncAllMailboxes();
  } catch (err) {
    sync = { error: (err as Error).message };
  }
  let jobs: unknown = null;
  try {
    jobs = await processEmailJobs();
  } catch (err) {
    jobs = { error: (err as Error).message };
  }
  return { sync, jobs };
}
