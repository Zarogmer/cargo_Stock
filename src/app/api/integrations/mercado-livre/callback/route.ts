import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasModuleAccess } from "@/lib/rbac";
import type { Role } from "@/types/database";
import { exchangeMlCode, ML_STATE_COOKIE } from "@/lib/services/mercado-livre";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function appBaseUrl(req: NextRequest): string {
  return process.env.AUTH_URL?.trim().replace(/\/$/, "") || req.nextUrl.origin;
}

// GET /api/integrations/mercado-livre/callback?code=...&state=...
// Volta do Mercado Livre. Valida o `state` (CSRF), troca o `code` por tokens e
// salva. Sempre redireciona pra /mensagens?ml=<status> pra UI mostrar o aviso.
export async function GET(req: NextRequest) {
  const base = appBaseUrl(req);
  const dest = (status: string) => {
    const res = NextResponse.redirect(`${base}/mensagens?ml=${status}`);
    res.cookies.delete(ML_STATE_COOKIE);
    return res;
  };

  const session = await auth();
  if (!session?.user) return NextResponse.redirect(`${base}/login`);

  const role = ((session.user as { role?: string }).role || "") as Role;
  if (!hasModuleAccess(role, "MENSAGENS")) return dest("forbidden");

  const url = req.nextUrl;
  if (url.searchParams.get("error")) return dest("denied"); // usuário recusou no ML

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.cookies.get(ML_STATE_COOKIE)?.value;
  if (!code || !state || !cookieState || state !== cookieState) {
    return dest("error");
  }

  try {
    await exchangeMlCode(code, session.user.id || null);
    return dest("ok");
  } catch (err) {
    console.error("[mercado-livre callback] troca de code falhou:", err);
    return dest("error");
  }
}
