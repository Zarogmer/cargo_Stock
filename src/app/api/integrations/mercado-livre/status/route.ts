import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasModuleAccess } from "@/lib/rbac";
import type { Role } from "@/types/database";
import { getMlStatus } from "@/lib/services/mercado-livre";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/integrations/mercado-livre/status
// Estado da integração pra UI (aba Mensagens): configurado por env? conta
// conectada? qual user_id e até quando o token vale. Só os papéis de Mensagens.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = ((session.user as { role?: string }).role || "") as Role;
  if (!hasModuleAccess(role, "MENSAGENS")) {
    return NextResponse.json({ error: "Sem permissão." }, { status: 403 });
  }

  const status = await getMlStatus();
  return NextResponse.json(status);
}
