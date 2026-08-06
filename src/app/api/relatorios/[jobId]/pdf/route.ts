import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  actorCanAccessJob,
  baseKind,
  getReportActor,
  parseKind,
  siblingBlockReportIds,
  WORKED_ALLOC_WHERE,
} from "@/lib/report-scope";
import { buildCleaningReportPdf, buildEvaluationPdf, buildPhotoReportPdf } from "@/lib/report-pdf";
import {
  EVAL_CRITERIA,
  EvaluationPrintRow,
  REPORT_KINDS,
  ReportKindName,
  SHARED_BLOCK_LABELS,
  SectionMeta,
  formatDayMonthYear,
  reportFileName,
} from "@/lib/report-format";

// GET /api/relatorios/[jobId]/pdf?kind=EMBARQUE|COSTADO|RASPAGEM|PINTURA&tipo=cleaning|fotos|avaliacao
//
// Devolve o PDF pronto (attachment) — o navegador baixa direto, igual aos
// documentos do RH. O conteúdo é o que está SALVO no banco: a tela avisa pra
// salvar antes de gerar.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const actor = await getReportActor();
  if (!actor) return NextResponse.json({ error: "Sem permissão" }, { status: 403 });

  const { jobId } = await params;
  const kind = parseKind(req.nextUrl.searchParams.get("kind"));
  const tipo = String(req.nextUrl.searchParams.get("tipo") || "");
  if (!kind) return NextResponse.json({ error: "kind inválido" }, { status: 400 });
  if (!["cleaning", "fotos", "avaliacao"].includes(tipo)) {
    return NextResponse.json({ error: "tipo inválido" }, { status: 400 });
  }
  if (!(await actorCanAccessJob(actor, jobId, kind))) {
    return NextResponse.json({ error: "Sem permissão neste navio" }, { status: 403 });
  }

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    include: { ships: { select: { name: true, port: true } } },
  });
  if (!job) return NextResponse.json({ error: "Navio não encontrado" }, { status: 404 });

  const report = await prisma.shipReport.findUnique({
    where: { job_id_kind: { job_id: jobId, kind } },
    include: {
      holds: { orderBy: { sort_order: "asc" } },
      activities: { orderBy: { sort_order: "asc" } },
      sections: { orderBy: [{ sort_order: "asc" }, { id: "asc" }] },
    },
  });

  const vesselName = job.ships?.name || job.name || "—";
  const dateStr = formatDayMonthYear(report?.report_date?.toISOString() ?? null);
  const isCostado = kind === "COSTADO";

  try {
    if (tipo === "cleaning") {
      // A assinatura é do supervisor DO NAVIO (quem foi escalado com a função
      // SUPERVISOR), não de quem clicou em baixar — o RH/gestão gera o PDF com
      // frequência e o nome deles não pode ir pra assinatura do relatório.
      const supervisorName = (await shipSupervisorName(jobId, kind)) || report?.created_by || actor.name;
      const pdf = await buildCleaningReportPdf({
        vesselName,
        kind,
        reportDate: report?.report_date?.toISOString() ?? null,
        port: report?.port || job.ships?.port || null,
        complete: report?.status === "COMPLETO",
        holds: report?.holds ?? [],
        activities: report?.activities ?? [],
        remarks: report?.remarks ?? null,
        etcDate: report?.etc_date ?? null,
        etcTime: report?.etc_time ?? null,
        supervisorName,
      });
      return pdfResponse(
        pdf,
        reportFileName(
          isCostado ? "Hull Side Cleaning Report" : `${REPORT_KINDS[kind].titleEn} Report`,
          vesselName,
          dateStr
        )
      );
    }

    if (tipo === "fotos") {
      // Mesmo conteúdo da aba Fotos: as fotos deste relatório mais os blocos do
      // ciclo da operação guardados nos relatórios irmãos do navio (o
      // carregamento do caminhão é um só e sai nos três PDFs). image_data só é
      // lido aqui — o JSON da tela traz apenas metadados.
      const siblings = await siblingBlockReportIds(jobId, kind);
      const PHOTO_FIELDS = { id: true, hold_label: true, stage: true, caption: true, image_data: true };
      const [ownPhotos, sharedPhotos, sharedSections] = await Promise.all([
        report
          ? prisma.shipReportPhoto.findMany({ where: { report_id: report.id }, select: PHOTO_FIELDS })
          : [],
        siblings.length
          ? prisma.shipReportPhoto.findMany({
              where: { report_id: { in: siblings }, hold_label: { in: SHARED_BLOCK_LABELS } },
              select: PHOTO_FIELDS,
            })
          : [],
        siblings.length
          ? prisma.shipReportSection.findMany({
              where: { report_id: { in: siblings }, label: { in: SHARED_BLOCK_LABELS } },
              select: { label: true, caption: true, sort_order: true },
              orderBy: [{ sort_order: "asc" }, { id: "asc" }],
            })
          : [],
      ]);
      const photos = [...ownPhotos, ...sharedPhotos].sort((a, b) => a.id - b.id);
      const sections: SectionMeta[] = [...(report?.sections ?? [])];
      const seenLabels = new Set(sections.map((s) => s.label));
      for (const s of sharedSections) {
        if (seenLabels.has(s.label)) continue;
        seenLabels.add(s.label);
        sections.push(s);
      }
      const pdf = await buildPhotoReportPdf({
        vesselName,
        kind,
        reportDate: report?.report_date?.toISOString() ?? null,
        photos,
        sections,
      });
      return pdfResponse(
        pdf,
        reportFileName(
          isCostado
            ? "Hull Side Photographic Report"
            : `${REPORT_KINDS[kind].titleEn} Photographic Report`,
          vesselName,
          dateStr
        )
      );
    }

    // avaliacao — mesma equipe da aba Avaliações: escalados no serviço, sem o
    // supervisor (ele avalia, não é avaliado) e só quem já tem alguma nota.
    const allocs = await prisma.jobAllocation.findMany({
      where: { job_id: jobId, kind: baseKind(kind), employee_id: { not: null }, ...WORKED_ALLOC_WHERE },
      include: {
        employees: { select: { id: true, name: true, role: true } },
        job_functions: { select: { name: true } },
      },
      orderBy: { added_at: "asc" },
    });
    // A avaliação da equipe é uma só por navio+escala: Raspagem e Pintura leem
    // a do Embarque (é o mesmo time, avaliado uma vez).
    const evaluations = await prisma.performanceEvaluation.findMany({
      where: { job_id: jobId, kind: baseKind(kind) },
    });

    const seen = new Set<number>();
    const rows: EvaluationPrintRow[] = [];
    for (const a of allocs) {
      if (!a.employees || seen.has(a.employees.id)) continue;
      seen.add(a.employees.id);
      const functionName = a.job_functions?.name || a.employees.role || null;
      if ((functionName || "").trim().toUpperCase() === "SUPERVISOR") continue;
      const e = evaluations.find((x) => x.employee_id === a.employees!.id);
      if (!e) continue;
      const row: EvaluationPrintRow = {
        name: a.employees.name,
        function_name: functionName,
        productivity: e.productivity,
        quality: e.quality,
        teamwork: e.teamwork,
        safety: e.safety,
        initiative: e.initiative,
        punctuality: e.punctuality,
        technical: e.technical,
        comments: e.comments || null,
      };
      if (EVAL_CRITERIA.some((c) => Number(row[c.key]) > 0)) rows.push(row);
    }
    rows.sort((x, y) => x.name.localeCompare(y.name));

    const pdf = await buildEvaluationPdf({
      vesselName,
      reportDate: report?.report_date?.toISOString() ?? null,
      rows,
    });
    return pdfResponse(pdf, reportFileName("Avaliação de Desempenho", vesselName, dateStr));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[relatorios/pdf] falhou:", detail);
    return NextResponse.json({ error: "Não foi possível gerar o PDF agora.", detail }, { status: 500 });
  }
}

// Supervisor escalado neste navio+serviço: quem entra na assinatura do
// Cleaning Report. Vem da escalação (função SUPERVISOR), igual ao critério que
// a aba Avaliações usa pra tirar o supervisor da lista de avaliados.
async function shipSupervisorName(jobId: string, kind: ReportKindName): Promise<string | null> {
  const allocs = await prisma.jobAllocation.findMany({
    where: { job_id: jobId, kind: baseKind(kind), employee_id: { not: null }, ...WORKED_ALLOC_WHERE },
    include: {
      employees: { select: { name: true, role: true } },
      job_functions: { select: { name: true } },
    },
    orderBy: { added_at: "asc" },
  });
  for (const a of allocs) {
    if (!a.employees) continue;
    const fn = (a.job_functions?.name || a.employees.role || "").trim().toUpperCase();
    if (fn === "SUPERVISOR") return a.employees.name;
  }
  return null;
}

function pdfResponse(bytes: Uint8Array, baseName: string): NextResponse {
  const filename = `${baseName}.pdf`;
  const ascii = filename.replace(/[^\x20-\x7E]+/g, "_");
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
