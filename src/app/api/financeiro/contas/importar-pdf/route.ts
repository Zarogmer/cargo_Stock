import { NextRequest, NextResponse } from "next/server";
import { requireFinance } from "@/lib/financeiro-api";
import { ingestDocumentPdf } from "@/lib/services/boleto/doc-ingest";

const MAX_SIZE = 15 * 1024 * 1024;
const MAX_FILES = 40;

// POST /api/financeiro/contas/importar-pdf — multipart { file: 1..N PDFs }
// Lê cada PDF (boleto ou nota fiscal), cria o título em Contas a Pagar com o
// arquivo anexado e os campos extraídos. Ideal pra jogar uma pasta de notas
// de uma vez. Dedupe por SHA-256 e por linha digitável.
export async function POST(request: NextRequest) {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const form = await request.formData().catch(() => null);
  const files = (form?.getAll("file") || []).filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'Envie ao menos um PDF no campo "file"' }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json({ error: `Máximo de ${MAX_FILES} arquivos por vez` }, { status: 413 });
  }

  const results = [];
  for (const file of files) {
    if (file.size > MAX_SIZE) {
      results.push({ status: "error", filename: file.name, error: "maior que 15 MB" });
      continue;
    }
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const r = await ingestDocumentPdf(buffer, file.name || "documento.pdf", guard.userName);
      results.push(r);
    } catch (err) {
      results.push({ status: "error", filename: file.name, error: (err as Error).message });
    }
  }

  const created = results.filter((r) => r.status === "created").length;
  const scanned = results.filter((r) => r.status === "scanned").length;
  const duplicates = results.filter((r) => r.status === "duplicate").length;
  const errors = results.filter((r) => r.status === "error").length;
  const needsAmount = results.filter((r) => "needsAmount" in r && r.needsAmount).length;

  return NextResponse.json({ created, scanned, duplicates, errors, needsAmount, results });
}
