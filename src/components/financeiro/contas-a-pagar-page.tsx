"use client";

// Contas a Pagar (fornecedores/boletos) — módulo em construção por fases
// (docs/financeiro/01-plano.md). Esta página vira o CRUD de títulos com máquina
// de estados na Fase 2; por ora é o esqueleto navegável criado na Fase 1.

import { useAuth } from "@/lib/auth-context";
import { hasModuleAccess } from "@/lib/rbac";

export function ContasAPagarPage() {
  const { profile } = useAuth();
  const role = profile?.role || "FINANCEIRO";

  if (!hasModuleAccess(role, "FINANCEIRO_MOD")) {
    return (
      <div className="max-w-7xl mx-auto">
        <p className="text-text-light">Você não tem acesso a este módulo.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <h1 className="text-2xl font-bold text-text">Financeiro 💰</h1>
          <span className="text-text-light">›</span>
          <span className="text-lg font-semibold text-text-light">Contas a Pagar</span>
        </div>
        <p className="text-text-light text-sm mt-0.5">
          Boletos recebidos, aprovação e pagamento de fornecedores
        </p>
      </div>

      <div className="bg-card border border-border rounded-xl p-8 text-center">
        <p className="text-text font-semibold">Em construção</p>
        <p className="text-text-light text-sm mt-1">
          Fase 2 do módulo: lançamento de títulos, anexos de boleto (PDF),
          aprovação e trilha de auditoria. Depois entram a captura automática por
          e-mail e a conciliação bancária.
        </p>
      </div>
    </div>
  );
}
