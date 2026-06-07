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
  const dest = (status: string, reason?: string) => {
    const qs = reason ? `?ml=${status}&reason=${encodeURIComponent(reason.slice(0, 180))}` : `?ml=${status}`;
    const res = NextResponse.redirect(`${base}/mensagens${qs}`);
    res.cookies.delete(ML_STATE_COOKIE);
    return res;
  };

  const session = await auth();
  if (!session?.user) return NextResponse.redirect(`${base}/login`);

  const role = ((session.user as { role?: string }).role || "") as Role;
  if (!hasModuleAccess(role, "MENSAGENS")) return dest("forbidden");

  const url = req.nextUrl;
  const oauthError = url.searchParams.get("error");
  if (oauthError) return dest("denied", url.searchParams.get("error_description") || oauthError);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = req.cookies.get(ML_STATE_COOKIE)?.value;
  if (!code || !state || !cookieState || state !== cookieState) {
    // "state" inválido: o cookie de segurança não voltou (cookies bloqueados,
    // janela anônima, sessão expirada) ou não bateu — não é erro de credencial.
    console.error("[mercado-livre callback] state inválido", {
      hasCode: !!code, hasState: !!state, hasCookie: !!cookieState, match: state === cookieState,
    });
    return dest("state");
  }

  try {
    await exchangeMlCode(code, session.user.id || null);
    return dest("ok");
  } catch (err) {
    const msg = (err as Error).message || "erro desconhecido";
    console.error("[mercado-livre callback] troca de code falhou:", msg);
    return dest("error", msg);
  }
}
