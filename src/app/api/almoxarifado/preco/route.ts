import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { COMPRAS_ROLES } from "@/lib/rbac";
import type { Role } from "@/types/database";

// POST /api/almoxarifado/preco — grava o valor unitário (R$) de um item do
// Almoxarifado com o preço da compra que acabou de abastecer o estoque.
//
// Existe porque `unit_value` é coluna sensível: o /api/db apaga o campo do
// payload de quem não é STOCK_VALUE_ROLES, e quem lança compra (RH, Estágio —
// ver COMPRAS_ROLES) não é. Sem isto o preço da compra se perdia e o material
// aparecia valendo R$ 0,00 no custo do navio (Pagamento de Navios › Material).
//
// Sempre sobrescreve: o preço da última compra é o custo de reposição atual.
// Rancho (comida) fica de fora por decisão de negócio — comida não entra no
// custo de material do navio (ver /api/retorno/despesa).
const TABLES: Record<string, "stockItem" | "epi" | "uniform"> = {
  stock_items: "stockItem",
  epis: "epi",
  uniforms: "uniform",
};

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = session.user.role as Role;
  if (!COMPRAS_ROLES.includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const table = typeof body?.table === "string" ? body.table : "";
  const id = Number(body?.id);
  const unitValue = Number(body?.unit_value);
  const model = TABLES[table];
  if (!model || !Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "table e id são obrigatórios" }, { status: 400 });
  }
  // Preço zerado/inválido não apaga o que já estava cadastrado.
  if (!Number.isFinite(unitValue) || unitValue <= 0) {
    return NextResponse.json({ saved: false, reason: "sem valor" });
  }

  const actor = session.user.name || session.user.email || "Sistema";
  await (prisma[model] as { update: (a: unknown) => Promise<unknown> }).update({
    where: { id },
    data: { unit_value: Math.round(unitValue * 100) / 100, updated_by: actor },
  });

  return NextResponse.json({ saved: true, unit_value: unitValue });
}
