import { NextRequest, NextResponse } from "next/server";
import { requireFinance } from "@/lib/financeiro-api";
import { ingestBoletoPdf } from "@/lib/services/boleto/ingest";

const MAX_SIZE = 10 * 1024 * 1024;

// POST /api/financeiro/boletos/upload — multipart FormData { file }.
// Lê o boleto, extrai valor/vencimento/CNPJ e cria o título (RECEBIDO). É o
// mesmo pipeline que a captura por e-mail usa; aqui na mão, útil desde já.
export async function POST(request: NextRequest) {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Envie o arquivo no campo \"file\"" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "Arquivo maior que 10 MB" }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
    return NextResponse.json({ error: "O arquivo não é um PDF válido" }, { status: 400 });
  }

  const result = await ingestBoletoPdf(buffer, {
    origin: "MANUAL",
    createdBy: guard.userName,
    filename: file.name || "boleto.pdf",
  });

  return NextResponse.json(result, { status: result.status === "created" ? 201 : 200 });
}
