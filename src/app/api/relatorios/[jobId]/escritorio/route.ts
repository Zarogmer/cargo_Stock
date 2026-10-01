import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getReportActor, parseKind } from "@/lib/report-scope";
import { normalizeOfficeVersion } from "@/lib/report-payload";
import { Prisma } from "@prisma/client";

// Versão do escritório do Cleaning Report (ship_reports.office_version).
//
// O pessoal do escritório ajusta o relatório de última hora pra mandar pro
// cliente SEM mexer no que o supervisor escreveu: a cópia fica numa coluna à
// parte e o PDF passa a sair dela. Só a gestão mexe aqui — o supervisor nem vê
// a aba Gerar Relatórios.
//
// PUT    /api/relatorios/[jobId]/escritorio  { kind, report, holds, activities }
// DELETE /api/relatorios/[jobId]/escritorio?kind=...  → volta a usar o do supervisor

export async function PUT(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const actor = await getReportActor();
  if (!actor) return NextResponse.json({ error: "Sem permissão" }, { status: 403 });
  if (actor.isSupervisor) {
    return NextResponse.json({ error: "A versão pro cliente é editada pelo escritório." }, { status: 403 });
  }

  const { jobId } = await params;
  const body = await req.json();
  const kind = parseKind(body.kind);
  if (!kind) return NextResponse.json({ error: "kind inválido" }, { status: 400 });

  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true } });
  if (!job) return NextResponse.json({ error: "Navio não encontrado" }, { status: 404 });

  const version = normalizeOfficeVersion(body);
  const data = {
    office_version: version as unknown as Prisma.InputJsonValue,
    office_version_by: actor.name,
    office_version_at: new Date(),
  };
  // Relatório ainda não criado pelo supervisor: a versão do escritório nasce
  // num registro vazio (sem porões/atividades do supervisor).
  const report = await prisma.shipReport.upsert({
    where: { job_id_kind: { job_id: jobId, kind } },
    create: { job_id: jobId, kind, created_by: actor.name, ...data },
    update: data,
    select: { id: true, office_version_by: true, office_version_at: true },
  });

  return NextResponse.json({ data: { ok: true, ...report, office_version: version } });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const actor = await getReportActor();
  if (!actor) return NextResponse.json({ error: "Sem permissão" }, { status: 403 });
  if (actor.isSupervisor) {
    return NextResponse.json({ error: "A versão pro cliente é editada pelo escritório." }, { status: 403 });
  }

  const { jobId } = await params;
  const kind = parseKind(req.nextUrl.searchParams.get("kind"));
  if (!kind) return NextResponse.json({ error: "kind inválido" }, { status: 400 });

  await prisma.shipReport.updateMany({
    where: { job_id: jobId, kind },
    data: { office_version: Prisma.DbNull, office_version_by: null, office_version_at: null },
  });
  return NextResponse.json({ data: { ok: true } });
}
