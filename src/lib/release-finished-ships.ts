import { db } from "@/lib/db";

// Marca como REMOVIDO todas as job_allocations ATIVAS de navios cuja
// departure_date já passou. Sem isso, um funcionário continua aparecendo como
// "Embarcado" mesmo depois do navio sair — o RH precisa do controle correto
// pra alocar pessoal em novas escalas.
//
// É idempotente: roda sempre no carregamento das telas de Navios e
// Colaboradores. Custa O(N) onde N é o número de navios já saídos com job
// vinculado, mas só toca em allocations que ainda estão ATIVAS.
export async function releaseFinishedShipAllocations(actor: string): Promise<{ ships: number; allocations: number }> {
  const today = new Date().toISOString().slice(0, 10);

  // Navios já com data de saída no passado. Pulamos os já CANCELADOS — o
  // delete cascade do app já lida com esses.
  const shipsRes = await db
    .from("ships")
    .select("id, departure_date, status")
    .lt("departure_date", today);

  const ships: Array<{ id: string; departure_date: string | null; status: string }> = shipsRes.data || [];
  if (ships.length === 0) return { ships: 0, allocations: 0 };

  const shipIds = ships.map((s) => s.id);
  const jobsRes = await db.from("jobs").select("id, ship_id").in("ship_id", shipIds);
  const jobs: Array<{ id: string; ship_id: string }> = jobsRes.data || [];
  if (jobs.length === 0) return { ships: ships.length, allocations: 0 };

  const now = new Date().toISOString();
  let touched = 0;
  for (const job of jobs) {
    const upd: any = await db
      .from("job_allocations")
      .update({ status: "REMOVIDO", removed_at: now, removed_by: actor, removal_reason: "Navio finalizado (data de saída no passado)" })
      .eq("job_id", job.id)
      .eq("status", "ATIVO");
    if (!upd.error) touched++;
  }
  return { ships: ships.length, allocations: touched };
}
