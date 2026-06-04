import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPurchaseList } from "@/lib/services/purchase-list";

// GET /api/almoxarifado/compras — lista de reposição (itens abaixo do mínimo
// nos 3 inventários + quanto comprar). Consumida pela aba Compras e pela seção
// do Dashboard. Qualquer usuário autenticado pode ver (informação interna).
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const items = await getPurchaseList();
    return NextResponse.json({ items });
  } catch (err) {
    console.error("compras GET error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
