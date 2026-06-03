import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { auth } from "@/lib/auth";
import { docxToPdf } from "@/lib/docx-to-pdf";
import {
  valorPorExtenso,
  formatValorBR,
  formatDataExtenso,
  formatPeriodoAnterior,
  formatCpf,
} from "@/lib/recibo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ReciboRequestBody {
  nome?: string;
  cpf?: string; // dígitos ou já formatado
  valor?: number | string; // número ou "1.976,28"
  data?: string; // yyyy-mm-dd (data assinada)
  navio?: string;
  tipo?: string; // COSTADO | EMBARQUE
}

function safe(s?: string | null): string {
  return (s || "").toString().trim();
}

// Aceita número ("500") ou string pt-BR ("1.976,28") e devolve o número.
function parseValor(v: number | string | undefined): number {
  if (typeof v === "number") return v;
  const cleaned = safe(v).replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  return parseFloat(cleaned);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ReciboRequestBody;
  try {
    body = (await request.json()) as ReciboRequestBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const nome = safe(body.nome).toUpperCase();
  const cpfDigits = safe(body.cpf).replace(/\D/g, "");
  const valorNum = parseValor(body.valor);
  const dataISO = safe(body.data);
  const navio = safe(body.navio);
  const tipo = safe(body.tipo).toUpperCase();

  if (!nome) {
    return NextResponse.json({ error: "Selecione um funcionário ou informe o nome." }, { status: 400 });
  }
  if (!Number.isFinite(valorNum) || valorNum <= 0) {
    return NextResponse.json({ error: "Informe um valor válido (maior que zero)." }, { status: 400 });
  }
  if (!dataISO) {
    return NextResponse.json({ error: "Informe a data." }, { status: 400 });
  }

  let templateBuffer: Buffer;
  try {
    const templatePath = path.join(process.cwd(), "src/lib/templates/recibo-pagamento-template.docx");
    templateBuffer = await fs.readFile(templatePath);
  } catch (err) {
    return NextResponse.json(
      { error: "Template Recibo de Pagamento não encontrado no servidor.", detail: String(err) },
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
      CPF: formatCpf(cpfDigits),
      CPFNUM: cpfDigits,
      VALOR: formatValorBR(valorNum),
      EXTENSO: valorPorExtenso(valorNum),
      DATA: formatDataExtenso(dataISO),
      PERIODO: formatPeriodoAnterior(dataISO),
      NAVIO: navio,
      TIPO: tipo,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Falha ao renderizar o template Recibo de Pagamento.", detail },
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
      console.error("[documents/recibo-pagamento] PDF conversion failed:", detail);
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

  const filename = `Recibo de Pagamento ${safeName}.${ext}`;
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
