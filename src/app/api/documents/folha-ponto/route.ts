import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { xlsxToPdf } from "@/lib/docx-to-pdf";
import { AllocInput, MESES_PT, expandWorkedDates } from "@/lib/folha-ponto";
import { buildFolhaPontoXlsx, FolhaEmployee } from "@/lib/folha-ponto-xlsx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Gera a Folha de Ponto (Apontamento de Cartões) no layout "CARGO SHIPS CLEANING".
// Os dias trabalhados saem dos navios cadastrados (job_allocations): COSTADO usa
// o shift_date do turno; EMBARQUE usa toda a janela do navio (chegada→saída).
// Saída: .xlsx (uma aba por colaborador) ou .pdf (uma página por colaborador).

interface FolhaRequestBody {
  employeeIds?: number[];
  month?: number; // 1-12
  year?: number;
}

// Converte os DateTime (@db.Date, meia-noite UTC) do Prisma em "YYYY-MM-DD".
function isoDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: FolhaRequestBody;
  try {
    body = (await request.json()) as FolhaRequestBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const ids = Array.isArray(body.employeeIds) ? body.employeeIds.filter((n) => Number.isInteger(n)) : [];
  const month = Number(body.month);
  const year = Number(body.year);
  if (ids.length === 0) {
    return NextResponse.json({ error: "Selecione ao menos um colaborador." }, { status: 400 });
  }
  if (!(month >= 1 && month <= 12)) {
    return NextResponse.json({ error: "Mês inválido." }, { status: 400 });
  }
  if (!(year >= 2000 && year <= 2100)) {
    return NextResponse.json({ error: "Ano inválido." }, { status: 400 });
  }

  const [employees, allocations] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.jobAllocation.findMany({
      where: { employee_id: { in: ids }, status: "ATIVO" },
      select: {
        employee_id: true,
        kind: true,
        shift_date: true,
        jobs: { select: { start_date: true, ships: { select: { arrival_date: true, departure_date: true } } } },
      },
    }),
  ]);

  if (employees.length === 0) {
    return NextResponse.json({ error: "Colaborador(es) não encontrado(s)." }, { status: 404 });
  }

  // Agrupa alocações por colaborador.
  const allocByEmp = new Map<number, AllocInput[]>();
  for (const a of allocations) {
    if (a.employee_id == null) continue;
    const list = allocByEmp.get(a.employee_id) || [];
    list.push({
      kind: a.kind === "COSTADO" ? "COSTADO" : "EMBARQUE",
      shift_date: isoDate(a.shift_date),
      ship_arrival: isoDate(a.jobs?.ships?.arrival_date),
      ship_departure: isoDate(a.jobs?.ships?.departure_date),
      job_start: isoDate(a.jobs?.start_date),
    });
    allocByEmp.set(a.employee_id, list);
  }

  const ordered: FolhaEmployee[] = [...employees]
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
    .map((emp) => ({
      id: emp.id,
      name: emp.name,
      worked: expandWorkedDates(allocByEmp.get(emp.id) || [], year, month),
    }));

  const xlsxBuf = buildFolhaPontoXlsx(ordered, year, month);

  const format = request.nextUrl.searchParams.get("format") === "pdf" ? "pdf" : "xlsx";
  const periodo = `${MESES_PT[month - 1]} ${year}`;
  const oneName = ordered.length === 1 ? ` ${ordered[0].name.replace(/[\\/:*?"<>|]+/g, "").trim()}` : "";
  const baseName = `Folha de Ponto${oneName} - ${periodo}`;

  if (format === "pdf") {
    let pdfBuf: Buffer;
    try {
      pdfBuf = await xlsxToPdf(xlsxBuf);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[documents/folha-ponto] PDF conversion failed:", detail);
      return NextResponse.json(
        { error: "Não foi possível gerar o PDF agora. Tente baixar em Excel ou fale com o suporte.", detail },
        { status: 503 },
      );
    }
    const filename = `${baseName}.pdf`;
    const ascii = filename.replace(/[^\x20-\x7E]+/g, "_");
    return new NextResponse(pdfBuf as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
      },
    });
  }

  const filename = `${baseName}.xlsx`;
  const ascii = filename.replace(/[^\x20-\x7E]+/g, "_");
  return new NextResponse(xlsxBuf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
