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
  // ISO-8601 completo: o Prisma REJEITA "YYYY-MM-DD" puro em filtro de data
  // (espera ISO DateTime). Usamos a meia-noite de hoje pra pegar quem saiu
  // ANTES de hoje (data de saída estritamente no passado).
  const todayStartISO = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

  // Navios já com data de saída no passado. Pulamos os já CANCELADOS — o
  // delete cascade do app já lida com esses.
  const shipsRes = await db
    .from("ships")
    .select("id, departure_date, status")
    .lt("departure_date", todayStartISO);

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

// Promove a EM_OPERACAO os navios ainda AGENDADOS cuja data de embarque
// (arrival_date) já chegou ou passou. A operação começa no embarque, então o
// navio deixa de ser "Agendado" e passa a "Em Operação" sozinho — sem precisar
// abrir o navio e mudar na mão. Idempotente: roda no carregamento da tela de
// Navios e só toca em quem ainda está AGENDADO (CONCLUIDO/CANCELADO ficam como
// estão; navio sem data de embarque também não é promovido — null não casa o
// filtro). Devolve quantos navios foram promovidos.
export async function promoteStartedShips(): Promise<number> {
  // ISO-8601 completo (o Prisma rejeita "YYYY-MM-DD" puro em filtro de data).
  // "agora" inclui o dia de hoje: arrival_date é data-only (00:00), então um
  // navio que embarca hoje já entra (00:00 <= agora).
  const nowISO = new Date().toISOString();
  const res: any = await db
    .from("ships")
    .update({ status: "EM_OPERACAO" })
    .eq("status", "AGENDADO")
    .lte("arrival_date", nowISO);
  if (res?.error) return 0;
  return Number(res?.data?.count) || 0;
}
