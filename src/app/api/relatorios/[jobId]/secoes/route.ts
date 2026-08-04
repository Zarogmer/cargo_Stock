import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { actorCanAccessJob, getReportActor, parseKind } from "@/lib/report-scope";

// Blocos do relatório fotográfico (aba Fotos). Os blocos fixos — locais do
// ciclo da operação e os porões do cadastro do navio — são montados pela tela e
// não precisam existir aqui; esta rota cuida da legenda do bloco e dos blocos
// criados à mão pelo supervisor.
//
// POST   /api/relatorios/[jobId]/secoes  { kind, label, caption? } — cria/atualiza
// DELETE /api/relatorios/[jobId]/secoes?kind=&label=              — remove bloco

async function loadReport(jobId: string, kindRaw: unknown) {
  const actor = await getReportActor();
  if (!actor) return { error: NextResponse.json({ error: "Sem permissão" }, { status: 403 }) };

  const kind = parseKind(kindRaw);
  if (!kind) return { error: NextResponse.json({ error: "kind inválido" }, { status: 400 }) };
  if (!(await actorCanAccessJob(actor, jobId, kind))) {
    return { error: NextResponse.json({ error: "Sem permissão neste navio" }, { status: 403 }) };
  }

  const report = await prisma.shipReport.upsert({
    where: { job_id_kind: { job_id: jobId, kind } },
    create: { job_id: jobId, kind, created_by: actor.name },
    update: {},
    select: { id: true, status: true },
  });

  // Relatório concluído: supervisor não mexe mais nos blocos (gestão pode).
  if (report.status === "COMPLETO" && actor.isSupervisor) {
    return {
      error: NextResponse.json(
        { error: "Relatório concluído — somente a gestão pode mexer nos blocos." },
        { status: 403 }
      ),
    };
  }
  return { report };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const body = await req.json();
  const result = await loadReport(jobId, body.kind);
  if ("error" in result) return result.error;

  const label = String(body.label || "").trim().slice(0, 80);
  if (!label) return NextResponse.json({ error: "Dê um nome pro bloco." }, { status: 400 });

  const caption = body.caption === undefined ? undefined : String(body.caption || "").trim() || null;

  const last = await prisma.shipReportSection.findFirst({
    where: { report_id: result.report.id },
    orderBy: { sort_order: "desc" },
    select: { sort_order: true },
  });

  const section = await prisma.shipReportSection.upsert({
    where: { report_id_label: { report_id: result.report.id, label } },
    create: { report_id: result.report.id, label, caption: caption ?? null, sort_order: (last?.sort_order ?? -1) + 1 },
    update: caption === undefined ? {} : { caption },
    select: { id: true, label: true, caption: true, sort_order: true },
  });

  return NextResponse.json({ data: section });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const label = String(req.nextUrl.searchParams.get("label") || "").trim();
  const result = await loadReport(jobId, req.nextUrl.searchParams.get("kind"));
  if ("error" in result) return result.error;

  // Bloco com foto dentro não some sem querer — as fotos precisam sair antes.
  const photos = await prisma.shipReportPhoto.count({
    where: { report_id: result.report.id, hold_label: label },
  });
  if (photos > 0) {
    return NextResponse.json(
      { error: `Este bloco ainda tem ${photos} foto(s). Apague as fotos antes de remover o bloco.` },
      { status: 409 }
    );
  }

  await prisma.shipReportSection.deleteMany({
    where: { report_id: result.report.id, label },
  });
  return NextResponse.json({ data: { ok: true } });
}
