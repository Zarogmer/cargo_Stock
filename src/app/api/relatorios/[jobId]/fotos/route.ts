import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { actorCanAccessJob, getReportActor, parseKind } from "@/lib/report-scope";
import {
  deletePhotoObjects,
  parseImageDataUrl,
  photoBucketConfigured,
  photoStorageKey,
  putPhotoObject,
} from "@/lib/photo-storage";

// POST /api/relatorios/[jobId]/fotos — adiciona uma foto ao relatório
// fotográfico. A imagem chega como data URL JPEG já comprimida e com a marca
// d'água da Cargo queimada no cliente (ver src/lib/watermark.ts). Os bytes vão
// pro Bucket do Railway (src/lib/photo-storage.ts); no banco fica só a chave.
// Sem bucket configurado (dev local) a foto entra inline, como antes.

// ~2,7M chars de base64 ≈ 2MB de imagem — bem acima do que o cliente gera
// (JPEG ~1280px q0.75 ≈ 100-250KB), só um teto de segurança.
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

  const parsed = parseImageDataUrl(imageData);
  if (!parsed) return NextResponse.json({ error: "Imagem inválida." }, { status: 400 });
  const useBucket = photoBucketConfigured();

  const PHOTO_META = {
    id: true, hold_label: true, stage: true, caption: true,
    sort_order: true, created_by: true, created_at: true,
  } as const;

  // A linha nasce primeiro (o id dela vira o nome do objeto), depois a imagem
  // sobe pro bucket e a chave é gravada. Se o upload falhar, a linha some de
  // novo — nunca fica foto "vazia" no relatório.
  const photo = await prisma.shipReportPhoto.create({
    data: {
      report_id: report.id,
      hold_label: holdLabel,
      stage,
      caption: body.caption ? String(body.caption) : null,
      image_data: useBucket ? null : imageData,
      mime_type: parsed.mime,
      sort_order: (last?.sort_order ?? -1) + 1,
      created_by: actor.name,
    },
    select: PHOTO_META,
  });
  if (!useBucket) return NextResponse.json({ data: photo });

  const key = photoStorageKey(report.id, photo.id, parsed.mime);
  try {
    await putPhotoObject(key, parsed.bytes, parsed.mime);
    await prisma.shipReportPhoto.update({ where: { id: photo.id }, data: { storage_key: key } });
  } catch (err) {
    console.error("[fotos] falha ao subir foto pro bucket:", err);
    await prisma.shipReportPhoto.delete({ where: { id: photo.id } }).catch(() => {});
    await deletePhotoObjects([key]);
    return NextResponse.json({ error: "Não foi possível guardar a foto. Tente de novo." }, { status: 502 });
  }

  return NextResponse.json({ data: photo });
}
