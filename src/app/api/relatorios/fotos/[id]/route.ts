import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { actorCanAccessJob, getReportActor, parseKind } from "@/lib/report-scope";
import { REPORT_KINDS, type ReportKindName } from "@/lib/report-format";
import { deletePhotoObjects, loadPhotoBytes } from "@/lib/photo-storage";

// GET  /api/relatorios/fotos/[id] — serve a imagem em si (bytes), pra usar em
//      <img src>. O JSON do relatório traz só metadados; 90 fotos em base64
//      num payload só seria pesado demais. Os bytes vêm do Bucket do Railway
//      (ou do formato antigo inline, se a foto ainda não migrou) — o bucket é
//      privado, então a permissão do navio é checada aqui antes de servir.
// PATCH /api/relatorios/fotos/[id] — edita legenda/porão/etapa.
// DELETE /api/relatorios/fotos/[id] — remove a foto.

async function loadPhotoWithAccess(id: number) {
  const actor = await getReportActor();
  if (!actor) return { error: NextResponse.json({ error: "Sem permissão" }, { status: 403 }) };

  const photo = await prisma.shipReportPhoto.findUnique({
    where: { id },
    include: { reports: { select: { job_id: true, kind: true, status: true } } },
  });
  if (!photo) return { error: NextResponse.json({ error: "Foto não encontrada" }, { status: 404 }) };

  const kind = parseKind(photo.reports.kind) || "EMBARQUE";
  if (!(await actorCanAccessJob(actor, photo.reports.job_id, kind))) {
    return { error: NextResponse.json({ error: "Sem permissão" }, { status: 403 }) };
  }
  return { photo, kind, actor };
}

// Relatório concluído: supervisor não altera nem apaga foto (ver a imagem — o
// GET — continua liberado). A gestão segue podendo mexer. O serviço aparece no
// aviso porque a foto pode ser de um bloco compartilhado: quem está na Raspagem
// não entenderia um "relatório concluído" sem saber que o travado é o da
// Lavagem, onde a foto do caminhão foi enviada.
function lockedForActor(result: {
  photo: { reports: { status: string } };
  kind: ReportKindName;
  actor: { isSupervisor: boolean };
}) {
  if (result.photo.reports.status !== "COMPLETO" || !result.actor.isSupervisor) return null;
  return NextResponse.json(
    {
      error: `Relatório de ${REPORT_KINDS[result.kind].label} concluído — somente a gestão pode mexer nessas fotos.`,
    },
    { status: 403 }
  );
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadPhotoWithAccess(Number(id));
  if ("error" in result) return result.error;

  const image = await loadPhotoBytes(result.photo);
  if (!image) return NextResponse.json({ error: "Imagem não encontrada" }, { status: 404 });

  const buffer = image.bytes;
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": image.mime,
      "Content-Length": String(buffer.length),
      // Foto não muda depois de subir (edição = apagar e subir outra) — pode
      // cachear no navegador e poupar o Postgres nas re-aberturas do relatório.
      "Cache-Control": "private, max-age=86400",
    },
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadPhotoWithAccess(Number(id));
  if ("error" in result) return result.error;
  const lockError = lockedForActor(result);
  if (lockError) return lockError;

  const body = await req.json();
  const data: Record<string, unknown> = {};
  if (body.caption !== undefined) data.caption = body.caption ? String(body.caption) : null;
  if (body.hold_label !== undefined) data.hold_label = body.hold_label ? String(body.hold_label) : null;
  if (body.stage !== undefined && ["ANTES", "DURANTE", "DEPOIS", "GERAL"].includes(String(body.stage))) {
    data.stage = String(body.stage);
  }

  const photo = await prisma.shipReportPhoto.update({
    where: { id: Number(id) },
    data,
    select: {
      id: true, hold_label: true, stage: true, caption: true,
      sort_order: true, created_by: true, created_at: true,
    },
  });
  return NextResponse.json({ data: photo });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await loadPhotoWithAccess(Number(id));
  if ("error" in result) return result.error;
  const lockError = lockedForActor(result);
  if (lockError) return lockError;

  await prisma.shipReportPhoto.delete({ where: { id: Number(id) } });
  await deletePhotoObjects([result.photo.storage_key]);
  return NextResponse.json({ data: { ok: true } });
}
