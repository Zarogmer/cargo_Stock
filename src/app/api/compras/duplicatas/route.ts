import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { COMPRAS_ROLES } from "@/lib/rbac";
import type { Role } from "@/types/database";
import { findDuplicatePurchases, type DuplicateCheckInput } from "@/lib/services/purchase-duplicates";

export const dynamic = "force-dynamic";

// POST /api/compras/duplicatas — "essa compra já foi colocada no sistema?"
// Body: DuplicateCheckInput (fornecedor, descrição, nº NF, chave, linha
// digitável, total, data). Devolve os lançamentos parecidos, do mais certo
// (mesma chave/boleto/NF) pro provável (fornecedor + valor + data próxima).
// Só consulta — não grava nada. Usado pelo Nova Compra enquanto a pessoa
// digita e na hora de salvar, e pelo Escanear antes de gravar o lote.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!COMPRAS_ROLES.includes(session.user.role as Role)) {
    return NextResponse.json({ error: "Sem permissão" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Corpo inválido" }, { status: 400 });
  }
  const str = (k: string): string | null => (typeof body[k] === "string" ? (body[k] as string) : null);
  const input: DuplicateCheckInput = {
    supplier: str("supplier"),
    description: str("description"),
    nf_number: str("nf_number"),
    access_key: str("access_key"),
    digitable_line: str("digitable_line"),
    total: typeof body.total === "number" ? body.total : null,
    purchase_date: str("purchase_date"),
    exclude_id: str("exclude_id"),
    exclude_batch_id: str("exclude_batch_id"),
  };

  try {
    const duplicates = await findDuplicatePurchases(input);
    return NextResponse.json({ duplicates });
  } catch (err) {
    console.error("[compras/duplicatas] erro:", err);
    return NextResponse.json({ error: "Falha ao verificar compras parecidas." }, { status: 500 });
  }
}
