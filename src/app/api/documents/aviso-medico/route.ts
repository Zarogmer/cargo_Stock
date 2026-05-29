import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { auth } from "@/lib/auth";
import { docxToPdf } from "@/lib/docx-to-pdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface AvisoMedicoRequestBody {
  nome?: string;
  cpf?: string;
  matricula?: string;
  funcao?: string;
  data?: string; // dd/mm/yyyy
  tipoExame?: string;
}

function safe(s?: string | null): string {
  return (s || "").toString().trim();
}

function todayPtBr(): string {
  return new Date().toLocaleDateString("pt-BR");
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: AvisoMedicoRequestBody;
  try {
    body = (await request.json()) as AvisoMedicoRequestBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const nome = safe(body.nome).toUpperCase();
  const cpf = safe(body.cpf);
  const matricula = safe(body.matricula);
  const funcao = safe(body.funcao);
  const data = safe(body.data) || todayPtBr();
  const tipoExame = (safe(body.tipoExame) || "ADMISSIONAL").toUpperCase();

  if (!nome) {
    return NextResponse.json({ error: "Informe o nome do colaborador." }, { status: 400 });
  }

  let templateBuffer: Buffer;
  try {
    const templatePath = path.join(process.cwd(), "src/lib/templates/aviso-medico-template.docx");
    templateBuffer = await fs.readFile(templatePath);
  } catch (err) {
    return NextResponse.json(
      { error: "Template Aviso Médico não encontrado no servidor.", detail: String(err) },
      { status: 500 }
    );
  }

  const zip = new PizZip(templateBuffer);

  try {
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: "{", end: "}" },
      nullGetter: () => "",
    });

    doc.render({
      NOME: nome,
      CPF: cpf,
      MATRICULA: matricula,
      FUNCAO: funcao,
      DATA: data,
      TIPO_EXAME: tipoExame,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Falha ao renderizar o template Aviso Médico.", detail },
      { status: 500 }
    );
  }

  const docxBuffer = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;

  const format = request.nextUrl.searchParams.get("format") === "pdf" ? "pdf" : "docx";
  const safeName = nome.replace(/[\\/:*?"<>|]+/g, "").trim().replace(/\s+/g, " ") || "FUNCIONARIO";

  let outBuffer: Buffer = docxBuffer;
  let mimeType =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  let ext = "docx";

  if (format === "pdf") {
    try {
      outBuffer = await docxToPdf(docxBuffer);
      mimeType = "application/pdf";
      ext = "pdf";
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        {
          error:
            "Nao foi possivel gerar o PDF agora. Tente baixar em Word ou fale com o suporte.",
          detail,
        },
        { status: 503 },
      );
    }
  }

  const filename = `Aviso Medico ${safeName}.${ext}`;
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
