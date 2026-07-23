import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { docxToPdf } from "@/lib/docx-to-pdf";
import { buildListagemDocx, ListagemEmployee, ListagemVariant } from "@/lib/listagem-docx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Gera a "Listagem de Embarque" (logo Cargo + tabela de funcionários) em .docx
// ou .pdf. O usuário escolhe só os colaboradores e a variante da coluna de
// identificação: SANTOS (ISPS CODE) ou FORA (RG). Os demais dados vêm da aba
// Colaboradores.

interface ListagemRequestBody {
  employeeIds?: number[];
  variant?: string; // "SANTOS" | "FORA"
}

// Converte o @db.Date (meia-noite UTC) do Prisma em "yyyy-mm-dd".
function isoDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ListagemRequestBody;
  try {
    body = (await request.json()) as ListagemRequestBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const ids = Array.isArray(body.employeeIds)
    ? body.employeeIds.filter((n) => Number.isInteger(n))
    : [];
  const variant: ListagemVariant = body.variant === "FORA" ? "FORA" : "SANTOS";

  if (ids.length === 0) {
    return NextResponse.json({ error: "Selecione ao menos um colaborador." }, { status: 400 });
  }

  const rows = await prisma.employee.findMany({
    where: { id: { in: ids } },
    select: { name: true, cpf: true, rg: true, isps_code: true, birth_date: true },
  });

  if (rows.length === 0) {
    return NextResponse.json({ error: "Colaborador(es) não encontrado(s)." }, { status: 404 });
  }

  const employees: ListagemEmployee[] = rows.map((e) => ({
    name: e.name,
    cpf: e.cpf,
    rg: e.rg,
    isps_code: e.isps_code,
    birth_date: isoDate(e.birth_date),
  }));

  const docxBuf = await buildListagemDocx(employees, variant);

  const format = request.nextUrl.searchParams.get("format") === "pdf" ? "pdf" : "docx";
  const variantLabel = variant === "SANTOS" ? "Santos" : "Fora de Santos";
  const baseName = `Listagem de Embarque - ${variantLabel}`;

  if (format === "pdf") {
    let pdfBuf: Buffer;
    try {
      pdfBuf = await docxToPdf(docxBuf);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[documents/listagem] PDF conversion failed:", detail);
      return NextResponse.json(
        { error: "Não foi possível gerar o PDF agora. Tente baixar em Word ou fale com o suporte.", detail },
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

  const filename = `${baseName}.docx`;
  const ascii = filename.replace(/[^\x20-\x7E]+/g, "_");
  return new NextResponse(docxBuf as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
