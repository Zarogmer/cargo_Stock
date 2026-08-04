import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { actorCanAccessJob, getReportActor, parseKind, WORKED_ALLOC_WHERE } from "@/lib/report-scope";
import { buildCleaningReportPdf, buildEvaluationPdf, buildPhotoReportPdf } from "@/lib/report-pdf";
import { EVAL_CRITERIA, EvaluationPrintRow, formatDayMonthYear, reportFileName } from "@/lib/report-format";

// GET /api/relatorios/[jobId]/pdf?kind=EMBARQUE|COSTADO&tipo=cleaning|fotos|avaliacao
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
        supervisorName: actor.name,
      });
      return pdfResponse(
        pdf,
        reportFileName(isCostado ? "Hull Side Cleaning Report" : "Cargo Hold Cleaning Report", vesselName, dateStr)
      );
    }

    if (tipo === "fotos") {
      // image_data só é lido aqui (o JSON da tela traz apenas metadados).
      const photos = report
        ? await prisma.shipReportPhoto.findMany({
            where: { report_id: report.id },
            orderBy: [{ hold_label: "asc" }, { stage: "asc" }, { sort_order: "asc" }, { id: "asc" }],
            select: { id: true, hold_label: true, stage: true, caption: true, image_data: true },
          })
        : [];
      const pdf = await buildPhotoReportPdf({
        vesselName,
        kind,
        reportDate: report?.report_date?.toISOString() ?? null,
        photos,
        sections: report?.sections ?? [],
      });
      return pdfResponse(
        pdf,
        reportFileName(
          isCostado ? "Hull Side Photographic Report" : "Cargo Hold Photographic Report",
          vesselName,
          dateStr
        )
      );
    }

    // avaliacao — mesma equipe da aba Avaliações: escalados no serviço, sem o
    // supervisor (ele avalia, não é avaliado) e só quem já tem alguma nota.
    const allocs = await prisma.jobAllocation.findMany({
      where: { job_id: jobId, kind, employee_id: { not: null }, ...WORKED_ALLOC_WHERE },
      include: {
        employees: { select: { id: true, name: true, role: true } },
        job_functions: { select: { name: true } },
      },
      orderBy: { added_at: "asc" },
    });
    const evaluations = await prisma.performanceEvaluation.findMany({ where: { job_id: jobId, kind } });

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
