// Guarda de autorização das rotas de API do módulo Contas a Pagar/Conciliação.
// Usa a mesma matriz do rbac (FINANCEIRO_MOD) em vez de repetir allowlist de
// roles em cada rota — assim ESTAGIO (view) lê mas não escreve, e mudança de
// permissão acontece num lugar só.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission, type Permission } from "@/lib/rbac";
import type { Role } from "@/types/database";
import type { Session } from "next-auth";

type FinanceAuthResult =
  | { session: Session; userName: string; error?: undefined }
  | { session?: undefined; userName?: undefined; error: NextResponse };

export async function requireFinance(permission: Permission = "view"): Promise<FinanceAuthResult> {
  const session = await auth();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const role = session.user.role as Role;
  if (!hasPermission(role, "FINANCEIRO_MOD", permission)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session, userName: session.user.name || session.user.email || "?" };
}
