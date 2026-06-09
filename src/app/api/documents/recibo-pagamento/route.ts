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

interface Recipient {
  nome?: string;
  cpf?: string; // dígitos ou já formatado
}

interface ReciboRequestBody {
  // Compatibilidade: recibo único pode vir com nome/cpf no topo.
  nome?: string;
  cpf?: string;
  // Lote: um recibo por colaborador (mesmo valor/data/navio/tipo).
  recipients?: Recipient[];
  valor?: number | string; // número ou "1.976,28"
  data?: string; // yyyy-mm-dd (data assinada)
  navio?: string;
  tipo?: string; // "Costado" | "N porões"
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

// Nome de arquivo seguro (sem caracteres proibidos no Windows/zip).
function sanitizeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, "").trim().replace(/\s+/g, " ") || "FUNCIONARIO";
}

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

  const valorNum = parseValor(body.valor);
  const dataISO = safe(body.data);
  const navio = safe(body.navio);
  const tipo = safe(body.tipo).toUpperCase();

  if (!Number.isFinite(valorNum) || valorNum <= 0) {
    return NextResponse.json({ error: "Informe um valor válido (maior que zero)." }, { status: 400 });
  }
  if (!dataISO) {
    return NextResponse.json({ error: "Informe a data." }, { status: 400 });
  }

  // Destinatários: lote (recipients) ou único (nome/cpf no topo, compatível).
  const rawRecipients: Recipient[] =
    Array.isArray(body.recipients) && body.recipients.length
      ? body.recipients
      : [{ nome: body.nome, cpf: body.cpf }];
  const recipients = rawRecipients
    .map((r) => ({ nome: safe(r.nome).toUpperCase(), cpf: safe(r.cpf).replace(/\D/g, "") }))
    .filter((r) => r.nome);

  if (recipients.length === 0) {
    return NextResponse.json(
      { error: "Selecione ao menos um colaborador ou informe o nome." },
      { status: 400 }
    );
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

  // Campos comuns a todos os recibos do lote.
  const valorBR = formatValorBR(valorNum);
  const extenso = valorPorExtenso(valorNum);
  const dataExt = formatDataExtenso(dataISO);
  const periodo = formatPeriodoAnterior(dataISO);

  // Renderiza o .docx de um colaborador a partir do template.
  function renderDocx(nome: string, cpfDigits: string): Buffer {
    const zip = new PizZip(templateBuffer);
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
      VALOR: valorBR,
      EXTENSO: extenso,
      DATA: dataExt,
      PERIODO: periodo,
      NAVIO: navio,
      TIPO: tipo,
    });
    return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  }

  const format = request.nextUrl.searchParams.get("format") === "pdf" ? "pdf" : "docx";

  // ----- Recibo único (um colaborador) -----
  if (recipients.length === 1) {
    const r = recipients[0];

    let docxBuffer: Buffer;
    try {
      docxBuffer = renderDocx(r.nome, r.cpf);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: "Falha ao renderizar o template Recibo de Pagamento.", detail },
        { status: 500 }
      );
    }

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
        console.error("[documents/recibo-pagamento] PDF conversion failed:", detail);
        return NextResponse.json(
          { error: "Nao foi possivel gerar o PDF agora. Tente baixar em Word ou fale com o suporte.", detail },
          { status: 503 }
        );
      }
    }

    const filename = `Recibo de Pagamento ${sanitizeFilename(r.nome)}.${ext}`;
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

  // ----- Lote: um recibo por colaborador, empacotados num .zip -----
  const outZip = new PizZip();
  const usedNames = new Set<string>();
  try {
    for (const r of recipients) {
      let buf = renderDocx(r.nome, r.cpf);
      let ext = "docx";
      if (format === "pdf") {
        buf = await docxToPdf(buf);
        ext = "pdf";
      }
      const base = `Recibo de Pagamento ${sanitizeFilename(r.nome)}`;
      let fname = `${base}.${ext}`;
      let n = 2;
      while (usedNames.has(fname)) fname = `${base} (${n++}).${ext}`;
      usedNames.add(fname);
      outZip.file(fname, buf);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[documents/recibo-pagamento] lote falhou:", detail);
    return NextResponse.json(
      {
        error:
          format === "pdf"
            ? "Nao foi possivel gerar os PDFs agora. Tente baixar em Word ou fale com o suporte."
            : "Falha ao gerar os recibos em lote.",
        detail,
      },
      { status: format === "pdf" ? 503 : 500 }
    );
  }

  const zipBuffer = outZip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  const zipName = `Recibos de Pagamento (${recipients.length}).zip`;
  const asciiZip = zipName.replace(/[^\x20-\x7E]+/g, "_");
  return new NextResponse(zipBuffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${asciiZip}"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
      "Cache-Control": "no-store",
    },
  });
}
