"use client";

// Conciliação Bancária (Itaú/Santander) — módulo em construção por fases
// (docs/financeiro/01-plano.md). Fase 3 traz a importação de extrato (OFX/CNAB)
// e a Fase 4 o motor de matching; por ora é o esqueleto navegável da Fase 1.

import { useAuth } from "@/lib/auth-context";
import { hasModuleAccess } from "@/lib/rbac";

export function ConciliacaoPage() {
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
          <span className="text-lg font-semibold text-text-light">Conciliação Bancária</span>
        </div>
        <p className="text-text-light text-sm mt-0.5">
          Extrato bancário (Itaú e Santander) casado com as contas a pagar
        </p>
      </div>

      <div className="bg-card border border-border rounded-xl p-8 text-center">
        <p className="text-text font-semibold">Em construção</p>
        <p className="text-text-light text-sm mt-1">
          Fase 3 do módulo: importação de extrato por arquivo (OFX e CNAB
          240/400), depois o motor de conciliação automática com fila de revisão
          e, por fim, a sincronização direta com as APIs dos bancos.
        </p>
      </div>
    </div>
  );
}
