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

  // Média histórica de cada membro nos OUTROS navios — só pra gestão (o
  // supervisor avalia sem ver o que os colegas deram antes). Média das médias
  // POR NAVIO (job): Embarque e Costado do mesmo navio são duas avaliações,
  // mas contam como UM navio (senão o navio pesaria em dobro e o "N navios"
  // do badge mentiria). Critérios 0 = não avaliado ficam de fora.
  const CRITERIA = ["productivity", "quality", "teamwork", "safety", "initiative", "punctuality", "technical"] as const;
  let history: Record<number, { avg: number; count: number }> | undefined;
  if (!actor.isSupervisor && team.length > 0) {
    const past = await prisma.performanceEvaluation.findMany({
      where: { employee_id: { in: team.map((t) => t.employee_id) }, NOT: { job_id: jobId } },
    });
    // employee → job → soma/qtde das médias das avaliações daquele navio
    const byEmp = new Map<number, Map<string, { sum: number; n: number }>>();
    for (const e of past) {
      const rated = CRITERIA.map((c) => e[c]).filter((v) => v > 0);
      if (rated.length === 0) continue;
      const avg = rated.reduce((s, v) => s + v, 0) / rated.length;
      const jobs = byEmp.get(e.employee_id) || new Map<string, { sum: number; n: number }>();
      byEmp.set(e.employee_id, jobs);
      const j = jobs.get(e.job_id) || { sum: 0, n: 0 };
      jobs.set(e.job_id, { sum: j.sum + avg, n: j.n + 1 });
    }
    history = {};
    for (const [emp, jobs] of byEmp) {
      const shipAvgs = [...jobs.values()].map((j) => j.sum / j.n);
      history[emp] = {
        avg: shipAvgs.reduce((s, v) => s + v, 0) / shipAvgs.length,
        count: shipAvgs.length,
      };
    }
  }

  return NextResponse.json({
    data: {
      job: { id: job.id, name: job.name, start_date: job.start_date, end_date: job.end_date },
      ship: job.ships,
      kind,
      report,
      team,
      evaluations,
      history,
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
  // Limites de sanidade: o SUPERVISOR tem escrita aqui — sem teto, um payload
  // gigante inflaria o Postgres e tornaria tela/PDF inutilizáveis. Navio real
  // tem ≤ ~9 porões e algumas dezenas de atividades; 60 linhas sobra.
  const MAX_ROWS = 60;
  const clip = (v: unknown, max: number) => (v ? String(v).slice(0, max) : null);
  const holds = (Array.isArray(body.holds) ? body.holds : []).slice(0, MAX_ROWS);
  const activities = (Array.isArray(body.activities) ? body.activities : []).slice(0, MAX_ROWS);

  // Embarque com nº de porões no cadastro do navio (aba Navios): o relatório
  // não pode EXCEDER o cadastro — supervisor não adiciona porão a mais (a tela
  // já esconde o Adicionar; aqui é a blindagem pra chamada direta na API).
  // Menos linhas pode (relatório antigo/parcial).
  if (kind === "EMBARQUE") {
    const jobShip = await prisma.job.findUnique({
      where: { id: jobId },
      select: { ships: { select: { holds_count: true } } },
    });
    const maxHolds = jobShip?.ships?.holds_count || 0;
    const namedHolds = holds.filter((h: Record<string, unknown>) => String(h.label || "").trim()).length;
    if (maxHolds > 0 && namedHolds > maxHolds) {
      return NextResponse.json(
        { error: `O navio tem ${maxHolds} porões no cadastro (aba Navios) — remova os porões a mais antes de salvar.` },
        { status: 400 }
      );
    }
  }

  const headerData = {
    report_date: r.report_date ? new Date(String(r.report_date)) : null,
    port: clip(r.port, 120),
    status: r.status === "COMPLETO" ? "COMPLETO" : "EM_ANDAMENTO",
    remarks: clip(r.remarks, 4000),
    etc_date: clip(r.etc_date, 60),
    etc_time: clip(r.etc_time, 60),
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
          label: String(h.label).trim().slice(0, 120),
          status: ["PENDENTE", "EM_ANDAMENTO", "COMPLETO"].includes(String(h.status))
            ? String(h.status)
            : "PENDENTE",
          start_time: clip(h.start_time, 40),
          end_time: clip(h.end_time, 40),
          salt_start: clip(h.salt_start, 40),
          salt_end: clip(h.salt_end, 40),
          fresh_start: clip(h.fresh_start, 40),
          fresh_end: clip(h.fresh_end, 40),
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
          time_range: clip(a.time_range, 40),
          activity: String(a.activity).trim().slice(0, 300),
          hold_label: clip(a.hold_label, 120),
          sort_order: i,
        })),
    }),
  ]);

  return NextResponse.json({ data: { ok: true, report_id: report.id } });
}
