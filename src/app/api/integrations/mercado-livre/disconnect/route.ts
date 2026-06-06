import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasModuleAccess } from "@/lib/rbac";
import type { Role } from "@/types/database";
import { clearMlTokens } from "@/lib/services/mercado-livre";

export const runtime = "nodejs";

// POST /api/integrations/mercado-livre/disconnect
// Esquece os tokens salvos (a empresa precisa reconectar pra usar de novo).
export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = ((session.user as { role?: string }).role || "") as Role;
  if (!hasModuleAccess(role, "MENSAGENS")) {
    return NextResponse.json({ error: "Sem permissão." }, { status: 403 });
  }

  await clearMlTokens();
  return NextResponse.json({ ok: true });
}
