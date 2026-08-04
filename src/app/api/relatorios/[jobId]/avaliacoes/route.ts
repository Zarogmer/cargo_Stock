import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { actorCanAccessJob, getReportActor, parseKind, WORKED_ALLOC_WHERE } from "@/lib/report-scope";

// PUT /api/relatorios/[jobId]/avaliacoes — grava as avaliações de desempenho
// dos colaboradores escalados no serviço (upsert por job+kind+colaborador).
// Notas de 1 a 5 por critério; 0 = critério ainda não avaliado.
// SÓ o SUPERVISOR lança nota (a gestão vê em modo leitura na tela) e ninguém
// avalia quem está escalado como SUPERVISOR — nem ele a si mesmo.

const CRITERIA = [
  "productivity",
  "quality",
  "teamwork",
  "safety",
  "initiative",
  "punctuality",
  "technical",
] as const;

function clampRating(v: unknown): number {
  const n = Math.round(Number(v) || 0);
  return Math.max(0, Math.min(5, n));
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const actor = await getReportActor();
  if (!actor) return NextResponse.json({ error: "Sem permissão" }, { status: 403 });
  if (!actor.isSupervisor) {
    return NextResponse.json({ error: "Só o supervisor escalado lança avaliações." }, { status: 403 });
  }

  const { jobId } = await params;
  const body = await req.json();
  const kind = parseKind(body.kind);
  if (!kind) return NextResponse.json({ error: "kind inválido" }, { status: 400 });
  if (!(await actorCanAccessJob(actor, jobId, kind))) {
    return NextResponse.json({ error: "Sem permissão neste navio" }, { status: 403 });
  }

  const evals = Array.isArray(body.evaluations) ? body.evaluations : [];

  // Só aceita avaliação de quem está de fato escalado neste serviço do navio —
  // e nunca de quem está escalado como SUPERVISOR (mesma régua da tela).
  const allocs = await prisma.jobAllocation.findMany({
    where: { job_id: jobId, kind, employee_id: { not: null }, ...WORKED_ALLOC_WHERE },
    select: {
      employee_id: true,
      job_functions: { select: { name: true } },
      employees: { select: { role: true } },
    },
  });
  const allowed = new Set(
    allocs
      .filter((a) => (a.job_functions?.name || a.employees?.role || "").trim().toUpperCase() !== "SUPERVISOR")
      .map((a) => a.employee_id)
  );

  let saved = 0;
  for (const e of evals) {
    const employeeId = Number(e.employee_id);
    if (!allowed.has(employeeId)) continue;

    const ratings: Record<string, number> = {};
    for (const c of CRITERIA) ratings[c] = clampRating(e[c]);
    const data = {
      ...ratings,
      comments: e.comments ? String(e.comments) : null,
      evaluated_by: actor.name,
    };

    await prisma.performanceEvaluation.upsert({
      where: { job_id_kind_employee_id: { job_id: jobId, kind, employee_id: employeeId } },
      create: { job_id: jobId, kind, employee_id: employeeId, ...data },
      update: data,
    });
    saved++;
  }

  return NextResponse.json({ data: { ok: true, saved } });
}
