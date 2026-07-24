import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { auth } from "@/lib/auth";
import { docxToPdf } from "@/lib/docx-to-pdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface EmpRow {
  nome?: string;
  cpf?: string;
  rg?: string;
  nasc?: string;
  isps?: string;
}
interface EquipRow {
  item?: string;
  qtd?: string;
  desc?: string;
}

interface PeticaoBody {
  data?: string; // dd/mm/yyyy (já formatada)
  navio?: string; // "NOME / BANDEIRA / IMO"
  periodo?: string; // "dd/mm/yyyy a dd/mm/yyyy"
  agencia?: string;
  transporte?: string;
  gate?: string;
  motivo?: string;
  employees?: EmpRow[];
  equipamentos?: EquipRow[];
}

function safe(s?: string | null): string {
  return (s || "").toString().trim();
}

function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, "").trim().replace(/\s+/g, " ") || "PETICAO";
}

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: PeticaoBody;
  try {
    body = (await request.json()) as PeticaoBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const employees = (Array.isArray(body.employees) ? body.employees : [])
    .map((e) => ({
      NOME: safe(e.nome).toUpperCase(),
      CPF: safe(e.cpf),
      RG: safe(e.rg),
      NASC: safe(e.nasc),
      ISPS: safe(e.isps),
    }))
    .filter((e) => e.NOME);

  if (employees.length === 0) {
    return NextResponse.json(
      { error: "Selecione ao menos um colaborador." },
      { status: 400 }
    );
  }

  const navio = safe(body.navio);
  if (!navio) {
    return NextResponse.json({ error: "Informe o navio (Navio / Bandeira / IMO)." }, { status: 400 });
  }

  const equipamentos = (Array.isArray(body.equipamentos) ? body.equipamentos : [])
    .map((q) => ({ ITEM: safe(q.item), QTD: safe(q.qtd), DESC: safe(q.desc) }))
    .filter((q) => q.DESC);

  let templateBuffer: Buffer;
  try {
    const templatePath = path.join(process.cwd(), "src/lib/templates/peticao-template.docx");
    templateBuffer = await fs.readFile(templatePath);
  } catch (err) {
    return NextResponse.json(
      { error: "Template da Petição não encontrado no servidor.", detail: String(err) },
      { status: 500 }
    );
  }

  let docxBuffer: Buffer;
  try {
    const zip = new PizZip(templateBuffer);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: "{", end: "}" },
      nullGetter: () => "",
    });
    doc.render({
      DATA: safe(body.data),
      NAVIO: navio,
      PERIODO: safe(body.periodo),
      AGENCIA: safe(body.agencia),
      TRANSPORTE: safe(body.transporte),
      GATE: safe(body.gate),
      MOTIVO: safe(body.motivo) || "Realização de Limpeza de Porões.",
      EMP: employees,
      EQUIP: equipamentos,
    });
    docxBuffer = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Falha ao renderizar o template da Petição.", detail },
      { status: 500 }
    );
  }

  const format = request.nextUrl.searchParams.get("format") === "pdf" ? "pdf" : "docx";
  // Nome do arquivo usa o 1º pedaço do navio (antes da 1ª barra).
  const shipLabel = navio.split("/")[0].trim() || "NAVIO";
  let outBuffer: Buffer = docxBuffer;
  let mimeType = DOCX_MIME;
  let ext = "docx";

  if (format === "pdf") {
    try {
      outBuffer = await docxToPdf(docxBuffer);
      mimeType = "application/pdf";
      ext = "pdf";
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[documents/peticao] PDF conversion failed:", detail);
      return NextResponse.json(
        { error: "Nao foi possivel gerar o PDF agora. Tente baixar em Word ou fale com o suporte.", detail },
        { status: 503 }
      );
    }
  }

  const filename = `Autorizacao de Acesso a Barra - ${sanitizeFilename(shipLabel)}.${ext}`;
  const asciiFallback = filename.replace(/[^\x20-\x7E]+/g, "_");
  return new NextResponse(outBuffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
