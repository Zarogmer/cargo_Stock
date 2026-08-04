import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { actorCanAccessJob, getReportActor, parseKind } from "@/lib/report-scope";

// POST /api/relatorios/[jobId]/fotos — adiciona uma foto ao relatório
// fotográfico. A imagem chega como data URL JPEG já comprimida e com a marca
// d'água da Cargo queimada no cliente (ver src/lib/watermark.ts) e fica inline
// no Postgres (infra só Railway, sem storage externo).

// ~2,7M chars de base64 ≈ 2MB de imagem — bem acima do que o cliente gera
// (JPEG ~1600px q0.8 ≈ 300-500KB), só um teto de segurança.
const MAX_DATA_URL_LENGTH = 2_700_000;

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const actor = await getReportActor();
  if (!actor) return NextResponse.json({ error: "Sem permissão" }, { status: 403 });

  const { jobId } = await params;
  const body = await req.json();
  const kind = parseKind(body.kind);
  if (!kind) return NextResponse.json({ error: "kind inválido" }, { status: 400 });
  if (!(await actorCanAccessJob(actor, jobId, kind))) {
    return NextResponse.json({ error: "Sem permissão neste navio" }, { status: 403 });
  }

  const imageData = String(body.image_data || "");
  if (!/^data:image\/(jpeg|png|webp);base64,/.test(imageData)) {
    return NextResponse.json({ error: "Imagem inválida." }, { status: 400 });
  }
  if (imageData.length > MAX_DATA_URL_LENGTH) {
    return NextResponse.json({ error: "Imagem grande demais (máx ~2MB)." }, { status: 413 });
  }

  // GERAL = foto sem fase de lavagem (locais do ciclo da operação: caminhão,
  // embarque de material, navio... — a fase só existe pra porão/área).
  const stage = ["ANTES", "DURANTE", "DEPOIS", "GERAL"].includes(String(body.stage))
    ? String(body.stage)
    : "ANTES";
  const holdLabel = body.hold_label ? String(body.hold_label) : null;

  // Relatório concluído: supervisor não adiciona mais fotos (gestão pode).
  const existing = await prisma.shipReport.findUnique({
    where: { job_id_kind: { job_id: jobId, kind } },
    select: { status: true },
  });
  if (existing?.status === "COMPLETO" && actor.isSupervisor) {
    return NextResponse.json(
      { error: "Relatório concluído — somente a gestão pode mexer nas fotos." },
      { status: 403 }
    );
  }

  // A foto pode chegar antes de qualquer "Salvar" do relatório — garante o
  // registro-pai na hora.
  const report = await prisma.shipReport.upsert({
    where: { job_id_kind: { job_id: jobId, kind } },
    create: { job_id: jobId, kind, created_by: actor.name },
    update: {},
  });

  const last = await prisma.shipReportPhoto.findFirst({
    where: { report_id: report.id, hold_label: holdLabel, stage },
    orderBy: { sort_order: "desc" },
    select: { sort_order: true },
  });

  const photo = await prisma.shipReportPhoto.create({
    data: {
      report_id: report.id,
      hold_label: holdLabel,
      stage,
      caption: body.caption ? String(body.caption) : null,
      image_data: imageData,
      sort_order: (last?.sort_order ?? -1) + 1,
      created_by: actor.name,
    },
    select: {
      id: true, hold_label: true, stage: true, caption: true,
      sort_order: true, created_by: true, created_at: true,
    },
  });

  return NextResponse.json({ data: photo });
}
