import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { actorCanAccessJob, getReportActor, parseKind, WORKED_ALLOC_WHERE } from "@/lib/report-scope";

// GET /api/relatorios/[jobId]?kind=EMBARQUE|COSTADO
// Tudo que a tela do relatório precisa: navio, relatório (porões + atividades),
// fotos (só metadados — a imagem vem por /api/relatorios/fotos/[id]), equipe
// escalada no serviço e avaliações já feitas.
export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const actor = await getReportActor();
  if (!actor) return NextResponse.json({ error: "Sem permissão" }, { status: 403 });

  const { jobId } = await params;
  const kind = parseKind(req.nextUrl.searchParams.get("kind"));
  if (!kind) return NextResponse.json({ error: "kind inválido" }, { status: 400 });
  if (!(await actorCanAccessJob(actor, jobId, kind))) {
    return NextResponse.json({ error: "Sem permissão neste navio" }, { status: 403 });
  }

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: {
      ships: {
        select: {
          id: true, name: true, port: true, status: true, arrival_date: true,
          departure_date: true, cargo_type: true, holds_count: true, client_name: true,
        },
      },
    },
  });
  if (!job) return NextResponse.json({ error: "Navio não encontrado" }, { status: 404 });

  const report = await prisma.shipReport.findUnique({
    where: { job_id_kind: { job_id: jobId, kind } },
    include: {
      holds: { orderBy: { sort_order: "asc" } },
      activities: { orderBy: { sort_order: "asc" } },
      photos: {
        select: {
          id: true, hold_label: true, stage: true, caption: true,
          sort_order: true, created_by: true, created_at: true,
        },
        orderBy: [{ hold_label: "asc" }, { stage: "asc" }, { sort_order: "asc" }, { id: "asc" }],
      },
    },
  });

  // Equipe escalada neste serviço (uma linha por colaborador — no Costado a
  // mesma pessoa tem várias alocações, uma por turno).
  const allocs = await prisma.jobAllocation.findMany({
    where: { job_id: jobId, kind, employee_id: { not: null }, ...WORKED_ALLOC_WHERE },
    include: {
      employees: { select: { id: true, name: true, role: true } },
      job_functions: { select: { name: true } },
    },
    orderBy: { added_at: "asc" },
  });
  const seen = new Set<number>();
  const team: { employee_id: number; name: string; function_name: string | null }[] = [];
  for (const a of allocs) {
    if (!a.employees || seen.has(a.employees.id)) continue;
    seen.add(a.employees.id);
    team.push({
      employee_id: a.employees.id,
      name: a.employees.name,
      function_name: a.job_functions?.name || a.employees.role || null,
    });
  }
  team.sort((x, y) => x.name.localeCompare(y.name));

  const evaluations = await prisma.performanceEvaluation.findMany({
    where: { job_id: jobId, kind },
  });

  return NextResponse.json({
    data: {
      job: { id: job.id, name: job.name, start_date: job.start_date, end_date: job.end_date },
      ship: job.ships,
      kind,
      report,
      team,
      evaluations,
    },
  });
}

// PUT /api/relatorios/[jobId] — salva o cabeçalho do relatório + porões/áreas +
// atividades de uma vez (substitui as listas inteiras; simples e atômico).
export async function PUT(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const actor = await getReportActor();
  if (!actor) return NextResponse.json({ error: "Sem permissão" }, { status: 403 });

  const { jobId } = await params;
  const body = await req.json();
  const kind = parseKind(body.kind);
  if (!kind) return NextResponse.json({ error: "kind inválido" }, { status: 400 });
  if (!(await actorCanAccessJob(actor, jobId, kind))) {
    return NextResponse.json({ error: "Sem permissão neste navio" }, { status: 403 });
  }

  const r = (body.report || {}) as Record<string, unknown>;
  const holds = Array.isArray(body.holds) ? body.holds : [];
  const activities = Array.isArray(body.activities) ? body.activities : [];

  const headerData = {
    report_date: r.report_date ? new Date(String(r.report_date)) : null,
    port: r.port ? String(r.port) : null,
    status: r.status === "COMPLETO" ? "COMPLETO" : "EM_ANDAMENTO",
    remarks: r.remarks ? String(r.remarks) : null,
    etc_date: r.etc_date ? String(r.etc_date) : null,
    etc_time: r.etc_time ? String(r.etc_time) : null,
  };

  const report = await prisma.shipReport.upsert({
    where: { job_id_kind: { job_id: jobId, kind } },
    create: { job_id: jobId, kind, created_by: actor.name, ...headerData },
    update: headerData,
  });

  await prisma.$transaction([
    prisma.shipReportHold.deleteMany({ where: { report_id: report.id } }),
    prisma.shipReportHold.createMany({
      data: holds
        .filter((h: Record<string, unknown>) => String(h.label || "").trim())
        .map((h: Record<string, unknown>, i: number) => ({
          report_id: report.id,
          label: String(h.label).trim(),
          status: ["PENDENTE", "EM_ANDAMENTO", "COMPLETO"].includes(String(h.status))
            ? String(h.status)
            : "PENDENTE",
          start_time: h.start_time ? String(h.start_time) : null,
          end_time: h.end_time ? String(h.end_time) : null,
          completion_pct: Math.max(0, Math.min(100, Number(h.completion_pct) || 0)),
          sort_order: i,
        })),
    }),
    prisma.shipReportActivity.deleteMany({ where: { report_id: report.id } }),
    prisma.shipReportActivity.createMany({
      data: activities
        .filter((a: Record<string, unknown>) => String(a.activity || "").trim())
        .map((a: Record<string, unknown>, i: number) => ({
          report_id: report.id,
          time_range: a.time_range ? String(a.time_range) : null,
          activity: String(a.activity).trim(),
          hold_label: a.hold_label ? String(a.hold_label) : null,
          sort_order: i,
        })),
    }),
  ]);

  return NextResponse.json({ data: { ok: true, report_id: report.id } });
}
