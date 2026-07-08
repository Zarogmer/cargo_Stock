"use client";

// Painel financeiro — visão geral do módulo bancário. Fica DENTRO do Financeiro
// (não no Dashboard principal, pedido do Guilherme) e só pra EXEC/FIN/TEC.
// Junta contas a pagar, conciliação, saldos e a auditoria de integrações.

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { canAccessFinanceiroBanco } from "@/lib/rbac";
import { formatCurrency } from "@/lib/utils";

interface PainelData {
  contasPagar: {
    faltaPagar: number;
    vencidasCount: number;
    vencendo7Count: number;
    vencendo7Sum: number;
    pagoMes: number;
    recebidosCount: number;
  };
  conciliacao: { sugeridas: number; confirmadas: number; naoConciliadas: number };
  saldos: Array<{ id: number; nickname: string; bank: string; balance: number }>;
  proximosVencimentos: Array<{
    id: string;
    description: string;
    amount: number;
    due_date: string | null;
    supplier: string | null;
    overdue: boolean;
  }>;
  logs: Array<{ id: number; provider: string; operation: string; ok: boolean; message: string | null; created_at: string }>;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function PainelFinanceiroPage() {
  const { profile } = useAuth();
  const role = profile?.role || "FINANCEIRO";
  const canView = canAccessFinanceiroBanco(role);

  const [data, setData] = useState<PainelData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/financeiro/painel").then((r) => r.json());
      if (res.contasPagar) setData(res as PainelData);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  if (!canView) {
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
          <span className="text-lg font-semibold text-text-light">Painel</span>
        </div>
        <p className="text-text-light text-sm mt-0.5">Visão geral de contas a pagar, conciliação e bancos</p>
      </div>

      {loading || !data ? (
        <p className="p-8 text-center text-text-light text-sm">Carregando...</p>
      ) : (
        <>
          {/* Cards principais */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs text-text-light">Falta pagar</p>
              <p className="text-xl font-bold text-amber-600">{formatCurrency(data.contasPagar.faltaPagar)}</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs text-text-light">Vencidas</p>
              <p className={`text-xl font-bold ${data.contasPagar.vencidasCount > 0 ? "text-red-600" : "text-text"}`}>
                {data.contasPagar.vencidasCount}
              </p>
              <p className="text-xs text-text-light">título(s) em atraso</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs text-text-light">Vencendo em 7 dias</p>
              <p className="text-xl font-bold text-amber-600">{formatCurrency(data.contasPagar.vencendo7Sum)}</p>
              <p className="text-xs text-text-light">{data.contasPagar.vencendo7Count} título(s)</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs text-text-light">Pago no mês</p>
              <p className="text-xl font-bold text-emerald-600">{formatCurrency(data.contasPagar.pagoMes)}</p>
            </div>
          </div>

          {/* Conciliação + boletos */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs text-text-light">Boletos recebidos</p>
              <p className="text-xl font-bold text-blue-600">{data.contasPagar.recebidosCount}</p>
              <p className="text-xs text-text-light">aguardando processo</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs text-text-light">Conciliados</p>
              <p className="text-xl font-bold text-emerald-600">{data.conciliacao.confirmadas}</p>
            </div>
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs text-text-light">Sugestões na fila</p>
              <p className={`text-xl font-bold ${data.conciliacao.sugeridas > 0 ? "text-amber-600" : "text-text"}`}>
                {data.conciliacao.sugeridas}
              </p>
            </div>
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-xs text-text-light">Débitos pendentes</p>
              <p className="text-xl font-bold text-text">{data.conciliacao.naoConciliadas}</p>
              <p className="text-xs text-text-light">sem conciliar/marcar</p>
            </div>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            {/* Saldos por conta */}
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-sm font-semibold text-text mb-3">Saldos por conta</p>
              {data.saldos.length === 0 ? (
                <p className="text-xs text-text-light">Nenhuma conta com movimentação.</p>
              ) : (
                <ul className="space-y-2">
                  {data.saldos.map((s) => (
                    <li key={s.id} className="flex justify-between text-sm">
                      <span className="text-text-light">{s.nickname}</span>
                      <span className={`font-semibold ${s.balance < 0 ? "text-red-600" : "text-text"}`}>
                        {formatCurrency(s.balance)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Próximos vencimentos */}
            <div className="bg-card border border-border rounded-xl p-4">
              <p className="text-sm font-semibold text-text mb-3">Próximos vencimentos</p>
              {data.proximosVencimentos.length === 0 ? (
                <p className="text-xs text-text-light">Nada em aberto. 🎉</p>
              ) : (
                <ul className="space-y-1.5">
                  {data.proximosVencimentos.map((v) => (
                    <li key={v.id} className="flex justify-between items-center gap-2 text-sm">
                      <span className="truncate text-text-light">{v.supplier || v.description}</span>
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        <span className={v.overdue ? "text-red-600 font-medium" : "text-text-light"}>
                          {fmtDate(v.due_date)}
                          {v.overdue && " ⚠"}
                        </span>
                        <span className="font-medium text-text">{formatCurrency(v.amount)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Auditoria de integrações */}
          <div className="bg-card border border-border rounded-xl overflow-x-auto">
            <p className="text-sm font-semibold text-text px-4 pt-4">Auditoria de integrações</p>
            {data.logs.length === 0 ? (
              <p className="p-4 text-xs text-text-light">Sem registros ainda.</p>
            ) : (
              <table className="w-full text-sm mt-2">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-text-light">
                    <th className="px-4 py-2 font-medium">Quando</th>
                    <th className="px-4 py-2 font-medium">Origem</th>
                    <th className="px-4 py-2 font-medium">Operação</th>
                    <th className="px-4 py-2 font-medium">Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {data.logs.map((l) => (
                    <tr key={l.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 whitespace-nowrap text-text-light">{fmtDateTime(l.created_at)}</td>
                      <td className="px-4 py-2 text-text">{l.provider}</td>
                      <td className="px-4 py-2 text-text-light">{l.operation}</td>
                      <td className="px-4 py-2">
                        <span className={l.ok ? "text-emerald-700" : "text-red-600"} title={l.message || ""}>
                          {l.ok ? "✓" : "✗"} {l.message ? l.message.slice(0, 80) : ""}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
