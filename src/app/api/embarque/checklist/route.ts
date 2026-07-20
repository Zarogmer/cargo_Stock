import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { xlsxToPdf } from "@/lib/docx-to-pdf";
import {
  buildEmbarkChecklistXlsx,
  checklistFileName,
  ChecklistInfo,
  ChecklistItem,
} from "@/lib/embark-checklist-xlsx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Gera a "LISTA DE MATERIAIS EQUIPE" (layout do Check List.xlsx) pra baixar em
// Excel (editável) ou PDF (via LibreOffice, igual à Folha de Ponto).
//   mode "embarque" → preenchida (navio/porto/equipe/produto/data + quantidades)
//   mode "retorno"  → só a lista (cabeçalho em branco pra preencher à mão)

interface ChecklistRequestBody {
  mode?: string;
  shipName?: string;
  port?: string | null;
  teamLabel?: string | null;
  cargoType?: string | null;
  dateIso?: string | null;
  materials?: ChecklistItem[];
  rancho?: ChecklistItem[];
}

function sanitizeItems(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((i): i is ChecklistItem => !!i && typeof i === "object" && typeof (i as ChecklistItem).name === "string")
    .map((i) => ({
      name: i.name.trim(),
      qty: Number.isFinite(Number(i.qty)) ? Number(i.qty) : 0,
      unit: typeof i.unit === "string" ? i.unit : null,
    }))
    .filter((i) => i.name);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ChecklistRequestBody;
  try {
    body = (await request.json()) as ChecklistRequestBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const materials = sanitizeItems(body.materials);
  const rancho = sanitizeItems(body.rancho);
  if (materials.length === 0 && rancho.length === 0) {
    return NextResponse.json({ error: "Lista vazia — nada pra gerar." }, { status: 400 });
  }

  const info: ChecklistInfo = {
    mode: body.mode === "retorno" ? "retorno" : "embarque",
    shipName: typeof body.shipName === "string" ? body.shipName : null,
    port: typeof body.port === "string" ? body.port : null,
    teamLabel: typeof body.teamLabel === "string" ? body.teamLabel : null,
    cargoType: typeof body.cargoType === "string" ? body.cargoType : null,
    dateIso: typeof body.dateIso === "string" ? body.dateIso : null,
  };

  const xlsxBuf = buildEmbarkChecklistXlsx(info, materials, rancho);
  const format = request.nextUrl.searchParams.get("format") === "pdf" ? "pdf" : "xlsx";

  if (format === "pdf") {
    let pdfBuf: Buffer;
    try {
      pdfBuf = await xlsxToPdf(xlsxBuf);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[embarque/checklist] PDF conversion failed:", detail);
      return NextResponse.json(
        { error: "Não foi possível gerar o PDF agora. Tente baixar em Excel ou fale com o suporte.", detail },
        { status: 503 },
      );
    }
    const filename = checklistFileName(info, "pdf");
    const ascii = filename.replace(/[^\x20-\x7E]+/g, "_");
    return new NextResponse(pdfBuf as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
      },
    });
  }

  const filename = checklistFileName(info, "xlsx");
  const ascii = filename.replace(/[^\x20-\x7E]+/g, "_");
  return new NextResponse(xlsxBuf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
