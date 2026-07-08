import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { xlsxToPdf } from "@/lib/docx-to-pdf";
import { AllocInput, JornadaFilter, expandWorkedDates, periodoFileLabel, rangeDayCount } from "@/lib/folha-ponto";
import { buildFolhaPontoXlsx, FolhaEmployee } from "@/lib/folha-ponto-xlsx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Gera a Folha de Ponto (Apontamento de Cartões) no layout "CARGO SHIPS CLEANING".
// Os dias trabalhados saem dos navios cadastrados (job_allocations): COSTADO usa
// o shift_date do turno; EMBARQUE usa toda a janela do navio (chegada→saída).
// A folha cobre um período livre de datas (startDate..endDate, pode cruzar meses);
// `shipId` (opcional) restringe aos dias trabalhados naquele navio.
// Saída: .xlsx (uma aba por colaborador) ou .pdf (uma página por colaborador).

interface FolhaRequestBody {
  employeeIds?: number[];
  startDate?: string; // YYYY-MM-DD (início do período, inclusivo)
  endDate?: string; // YYYY-MM-DD (fim do período, inclusivo)
  jornada?: string; // "EMBARQUE" | "COSTADO" | "AMBAS" — filtra a folha por tipo
  shipId?: string; // filtro por navio: só as alocações desse navio entram
}

// Período máximo da folha (~4 meses) — evita planilhas absurdas por engano.
const MAX_RANGE_DAYS = 124;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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
  const startDate = typeof body.startDate === "string" ? body.startDate : "";
  const endDate = typeof body.endDate === "string" ? body.endDate : "";
  const shipId = typeof body.shipId === "string" && body.shipId ? body.shipId : null;
  const jornada: JornadaFilter =
    body.jornada === "COSTADO" ? "COSTADO"
    : body.jornada === "EMBARQUE" ? "EMBARQUE"
    : "AMBAS";
  if (ids.length === 0) {
    return NextResponse.json({ error: "Selecione ao menos um colaborador." }, { status: 400 });
  }
  if (!ISO_DATE.test(startDate) || !ISO_DATE.test(endDate)) {
    return NextResponse.json({ error: "Período inválido: informe as datas de início e fim." }, { status: 400 });
  }
  if (endDate < startDate) {
    return NextResponse.json({ error: "Período inválido: a data final é anterior à inicial." }, { status: 400 });
  }
  if (rangeDayCount(startDate, endDate) > MAX_RANGE_DAYS) {
    return NextResponse.json({ error: `Período muito longo: o máximo é ${MAX_RANGE_DAYS} dias.` }, { status: 400 });
  }

  // Filtro por navio: valida o navio e restringe as alocações aos jobs dele.
  let shipName: string | undefined;
  if (shipId) {
    const ship = await prisma.ship.findUnique({ where: { id: shipId }, select: { name: true } });
    if (!ship) {
      return NextResponse.json({ error: "Navio não encontrado." }, { status: 404 });
    }
    shipName = ship.name;
  }

  const [employees, allocations] = await Promise.all([
    prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.jobAllocation.findMany({
      where: {
        employee_id: { in: ids },
        // Só operacional: o admin (kind=ADMINISTRATIVO) entra no custo do
        // Embarque mas não trabalha a bordo — não tem folha de ponto do navio.
        kind: { not: "ADMINISTRATIVO" },
        // Conta como trabalhada (igual ao Financeiro / allocCountsAsWorked):
        // ATIVO ou REMOVIDO por navio finalizado — este último é o caso de
        // navio já saído, que é o comum da folha.
        OR: [
          { status: "ATIVO" },
          { status: "REMOVIDO", removal_reason: { startsWith: "Navio finalizado" } },
        ],
        ...(shipId ? { jobs: { ship_id: shipId } } : {}),
      },
      select: {
        employee_id: true,
        kind: true,
        shift_date: true,
        shift_period: true,
        jobs: { select: { start_date: true, ships: { select: { arrival_date: true, departure_date: true, services: true } } } },
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
      shift_period: a.shift_period ?? null,
      ship_services: a.jobs?.ships?.services ?? null,
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
      worked: expandWorkedDates(allocByEmp.get(emp.id) || [], startDate, endDate),
    }));

  const xlsxBuf = buildFolhaPontoXlsx(ordered, startDate, endDate, jornada, shipName);

  const format = request.nextUrl.searchParams.get("format") === "pdf" ? "pdf" : "xlsx";
  const periodo = periodoFileLabel(startDate, endDate);
  const tipoLabel = jornada === "COSTADO" ? "Costado" : jornada === "EMBARQUE" ? "Embarque" : "Ambas";
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "").trim();
  const shipPart = shipName ? ` ${safe(shipName)}` : "";
  const oneName = ordered.length === 1 ? ` ${safe(ordered[0].name)}` : "";
  const baseName = `Folha de Ponto ${tipoLabel}${shipPart}${oneName} - ${periodo}`;

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
