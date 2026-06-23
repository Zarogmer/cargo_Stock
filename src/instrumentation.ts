// Scheduler in-process das mensagens agendadas. Next 15 chama register() uma vez
// no boot do servidor. O Railway roda `next start` persistente (instância
// única), então um setInterval aqui basta — sem cron externo nem infra extra.
//
// ⚠️ TRAVAS (críticas): o .env local aponta pro banco de PRODUÇÃO e register()
// roda também em `next dev`. Sem as guardas abaixo, um `next dev` dispararia
// mensagens REAIS nos grupos do WhatsApp. Por isso o scheduler só liga em
// produção (ou com ENABLE_SCHEDULER=1 explícito), nunca durante o build e nunca
// duas vezes no mesmo processo.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const enabled = process.env.NODE_ENV === "production" || process.env.ENABLE_SCHEDULER === "1";
  if (!enabled) return;
  if (process.env.DISABLE_SCHEDULER === "1") return;

  const g = globalThis as unknown as { __cargoSchedulerStarted?: boolean };
  if (g.__cargoSchedulerStarted) return;
  g.__cargoSchedulerStarted = true;

  const { runDueScheduledMessages } = await import("./lib/services/scheduler");
  const { runDueBirthdayMessages } = await import("./lib/services/birthday-message");
  const tick = async () => {
    try {
      await runDueScheduledMessages();
    } catch (err) {
      console.error("[scheduler] tick error:", (err as Error).message);
    }
    // Parabéns de aniversário (10h SP). Isolado das agendas: um erro aqui não
    // atrapalha os boletins de grupo, e vice-versa.
    try {
      await runDueBirthdayMessages();
    } catch (err) {
      console.error("[birthday] tick error:", (err as Error).message);
    }
  };

  // Espera 15s pós-boot (deixa a app subir) e roda a cada 60s.
  setTimeout(tick, 15_000);
  const handle = setInterval(tick, 60_000) as unknown as { unref?: () => void };
  handle.unref?.();
  console.log("[scheduler] in-process scheduler iniciado (tick 60s)");
}
