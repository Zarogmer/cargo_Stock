import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { syncRetornoDespesa } from "@/lib/retorno-despesa";
import type { Role } from "@/types/database";

// POST /api/retorno/despesa — sincroniza a despesa "Material perdido" do navio
// com o retorno confirmado: lost_qty × valor unitário de cada item. O cálculo
// mora em src/lib/retorno-despesa.ts (compartilhado com /api/retorno/valor,
// que re-sincroniza ao editar o valor unitário no Pagamento de Navios).
//
// Roda no servidor porque unit_value é coluna sensível (o /api/db a esconde de
// quem não é gestão) — quem confirma o retorno nem sempre pode VER o preço,
// mas o prejuízo tem que entrar no custo do navio mesmo assim.
//
// Devolve também `perPerson`: o valor dividido pela equipe do navio, que o
// Pagamento de Navios mostra na coluna "Desc. Geral" de cada colaborador.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = session.user.role as Role;
  // Mesma permissão de quem confirma o retorno na tela de Embarque/Retorno.
  if (!hasPermission(role, "EMBARQUE", "embarcar")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const actor = session.user.name || session.user.email || "Sistema";

  const body = await request.json().catch(() => null);
  const shipId = typeof body?.ship_id === "string" ? body.ship_id : "";
  const team = typeof body?.team === "string" ? body.team : "";
  if (!shipId || !team) {
    return NextResponse.json({ error: "ship_id e team são obrigatórios" }, { status: 400 });
  }

  const result = await syncRetornoDespesa(shipId, team, actor);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  const { ok: _ok, ...payload } = result;
  return NextResponse.json(payload);
}
