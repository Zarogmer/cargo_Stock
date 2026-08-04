import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getReportActor, reportKindsForServices, WORKED_ALLOC_WHERE, type ReportKind } from "@/lib/report-scope";

// Lista os navios (jobs) visíveis nos Relatórios de Bordo.
// - SUPERVISOR: só os jobs em que o colaborador vinculado tem alocação ATIVA;
//   os kinds retornados são os serviços em que ELE está escalado.
// - Gestão: todos os jobs com navio; os kinds vêm das alocações existentes no
//   job (mostra Embarque e/ou Costado conforme a escala do navio).
//
// A escala diz se a pessoa trabalha no EMBARQUE ou no COSTADO; os SERVIÇOS do
// navio (ships.services) dizem quais relatórios aquele embarque gera — lavagem
// de porão, raspagem e/ou pintura, cada um com o seu PDF pro cliente.

export async function GET() {
  const actor = await getReportActor();
  if (!actor) return NextResponse.json({ error: "Sem permissão" }, { status: 403 });

  // job_id → escalas (EMBARQUE/COSTADO) que o ator enxerga no job
  const kindsByJob = new Map<string, Set<"EMBARQUE" | "COSTADO">>();

  if (actor.isSupervisor) {
    if (!actor.employeeId) return NextResponse.json({ data: [] });
    const allocs = await prisma.jobAllocation.findMany({
      where: { employee_id: actor.employeeId, ...WORKED_ALLOC_WHERE },
      select: { job_id: true, kind: true },
    });
    for (const a of allocs) {
      const set = kindsByJob.get(a.job_id) || new Set<"EMBARQUE" | "COSTADO">();
      set.add(a.kind === "COSTADO" ? "COSTADO" : "EMBARQUE");
      kindsByJob.set(a.job_id, set);
    }
    if (kindsByJob.size === 0) return NextResponse.json({ data: [] });
  }

  const jobs = await prisma.job.findMany({
    where: actor.isSupervisor
      ? { id: { in: [...kindsByJob.keys()] } }
      : { ship_id: { not: null } },
    include: {
      ships: {
        select: {
          id: true,
          name: true,
          port: true,
          status: true,
          arrival_date: true,
          departure_date: true,
          cargo_type: true,
          holds_count: true,
          client_name: true,
          assigned_team: true,
          services: true,
        },
      },
      ship_reports: {
        select: { kind: true, status: true, updated_at: true, _count: { select: { photos: true } } },
      },
    },
    orderBy: { created_at: "desc" },
    take: 200,
  });

  if (!actor.isSupervisor) {
    // Gestão: um query só pros kinds de todos os jobs listados.
    const allocs = await prisma.jobAllocation.findMany({
      where: { job_id: { in: jobs.map((j) => j.id) }, ...WORKED_ALLOC_WHERE },
      select: { job_id: true, kind: true },
    });
    for (const a of allocs) {
      const set = kindsByJob.get(a.job_id) || new Set<"EMBARQUE" | "COSTADO">();
      set.add(a.kind === "COSTADO" ? "COSTADO" : "EMBARQUE");
      kindsByJob.set(a.job_id, set);
    }
  }

  // Escala (Embarque/Costado) × serviços do navio → relatórios do card.
  const kindsFor = (jobId: string, services: string[] | null | undefined): ReportKind[] => {
    const scales = kindsByJob.get(jobId);
    if (!scales || scales.size === 0) return [];
    const fromServices = reportKindsForServices(services);
    const out = fromServices.filter((k) => scales.has(k === "COSTADO" ? "COSTADO" : "EMBARQUE"));
    // Escalado no Costado num navio sem serviço COSTADO marcado (legado): o
    // relatório de costado continua aparecendo pra não sumir da mão de ninguém.
    if (scales.has("COSTADO") && !out.includes("COSTADO")) out.push("COSTADO");
    return out;
  };

  const data = jobs
    .filter((j) => j.ships && j.ships.status !== "CANCELADO")
    .map((j) => ({
      job_id: j.id,
      job_name: j.name,
      start_date: j.start_date,
      end_date: j.end_date,
      ship: j.ships,
      kinds: kindsFor(j.id, j.ships?.services),
      reports: j.ship_reports.map((r) => ({
        kind: r.kind,
        status: r.status,
        updated_at: r.updated_at,
        photos: r._count.photos,
      })),
    }))
    // Sem escala nenhuma (job órfão) não tem o que relatar — some da lista.
    .filter((j) => j.kinds.length > 0);

  return NextResponse.json({ data });
}
