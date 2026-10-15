import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { normalizeClosingDoc } from "@/lib/fechamento-navio";
import { closingFileName } from "@/lib/fechamento-navio-file";
import { buildFechamentoPdf } from "@/lib/fechamento-navio-pdf";
import type { Role } from "@/types/database";

// POST /api/financeiro/fechamento/pdf → PDF do Fechamento de Navio a partir do
// que está NA TELA (o rascunho, salvo ou não — o mesmo documento que o
// "Salvar fechamento" manda pra job_closings.data). Nada é gravado.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = session.user.role as Role;
  if (!hasPermission(role, "FINANCEIRO_MOD", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const doc = normalizeClosingDoc(body);
  if (!doc) return NextResponse.json({ error: "Fechamento inválido" }, { status: 400 });

  const pdf = await buildFechamentoPdf(doc);
  const filename = closingFileName(doc, "pdf");
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_");
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
