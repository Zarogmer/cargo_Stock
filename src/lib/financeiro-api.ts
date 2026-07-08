// Guarda de autorização das rotas de API do módulo bancário do Financeiro
// (Contas a Pagar, Conciliação, Boletos, Painel). Além da permissão
// FINANCEIRO_MOD, exige que o papel esteja em FINANCEIRO_BANCO_ROLES — dados de
// banco/saldo/extrato são sensíveis, então Estágio (que vê o resto do
// Financeiro) NÃO acessa. Todas as rotas do módulo novo usam este guard.

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission, canAccessFinanceiroBanco, type Permission } from "@/lib/rbac";
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
  if (!canAccessFinanceiroBanco(role) || !hasPermission(role, "FINANCEIRO_MOD", permission)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { session, userName: session.user.name || session.user.email || "?" };
}
