import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { auth } from "@/lib/auth";
import { hasModuleAccess } from "@/lib/rbac";
import type { Role } from "@/types/database";
import { isMercadoLivreConfigured, buildMlAuthUrl, ML_STATE_COOKIE } from "@/lib/services/mercado-livre";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function appBaseUrl(req: NextRequest): string {
  return process.env.AUTH_URL?.trim().replace(/\/$/, "") || req.nextUrl.origin;
}

// GET /api/integrations/mercado-livre/connect
// Inicia o OAuth: gera o `state`, guarda num cookie httpOnly e redireciona pro
// Mercado Livre. Só os papéis de Mensagens podem iniciar.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = ((session.user as { role?: string }).role || "") as Role;
  if (!hasModuleAccess(role, "MENSAGENS")) {
    return NextResponse.json({ error: "Sem permissão." }, { status: 403 });
  }

  const base = appBaseUrl(req);
  if (!isMercadoLivreConfigured()) {
    return NextResponse.redirect(`${base}/mensagens?ml=config_missing`);
  }

  const state = randomUUID();
  const res = NextResponse.redirect(buildMlAuthUrl(state));
  res.cookies.set(ML_STATE_COOKIE, state, {
    httpOnly: true,
    secure: base.startsWith("https://"),
    sameSite: "lax", // permite o cookie voltar no redirect de topo vindo do ML
    path: "/",
    maxAge: 600, // 10 min
  });
  return res;
}
