"use client";

// Captura de boletos por e-mail (Microsoft Graph) — Fase 5c do módulo. Cadastro
// das caixas monitoradas + sincronização manual. Enquanto o Graph não está
// configurado (credenciais do Azure), mostra o aviso e a captura fica inerte;
// o pipeline (parser + criação de título) já é testável pelo "Importar boleto
// (PDF)" na tela de Contas a Pagar.

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, hasModuleAccess } from "@/lib/rbac";
import { Button } from "@/components/ui/button";

interface EmailAccount {
  id: number;
  mailbox: string;
  tenant_id: string | null;
  enabled: boolean;
  last_sync_at: string | null;
  last_status: string | null;
}

const inputCls =
  "border border-border rounded-lg px-3 py-2 text-sm bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40";

function fmtDateTime(iso: string | null): string {
  if (!iso) return "nunca";
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export function EmailBoletosPage() {
  const { profile } = useAuth();
  const role = profile?.role || "FINANCEIRO";
  const canView = hasModuleAccess(role, "FINANCEIRO_MOD");
  const canEdit =
    hasPermission(role, "FINANCEIRO_MOD", "edit") || hasPermission(role, "FINANCEIRO_MOD", "create");

  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [graphConfigured, setGraphConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [newMailbox, setNewMailbox] = useState("");
  const [newTenant, setNewTenant] = useState("");
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/financeiro/email/contas").then((r) => r.json());
      setAccounts((res.accounts as EmailAccount[]) || []);
      setGraphConfigured(!!res.graphConfigured);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  async function addMailbox() {
    if (!newMailbox.includes("@")) return alert("Informe um e-mail válido");
    setSaving(true);
    try {
      const res = await fetch("/api/financeiro/email/contas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailbox: newMailbox, tenant_id: newTenant || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return alert(data.error || "Erro ao cadastrar caixa");
      setNewMailbox("");
      setNewTenant("");
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function toggle(acc: EmailAccount) {
    await fetch(`/api/financeiro/email/contas/${acc.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !acc.enabled }),
    });
    await load();
  }

  async function removeMailbox(acc: EmailAccount) {
    if (!confirm(`Remover a caixa ${acc.mailbox} do monitoramento?`)) return;
    await fetch(`/api/financeiro/email/contas/${acc.id}`, { method: "DELETE" });
    await load();
  }

  async function syncNow() {
    setSyncing(true);
    try {
      const res = await fetch("/api/financeiro/email/sync", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return alert(data.error || "Erro ao sincronizar");
      const s = data.sync || {};
      const j = data.jobs || {};
      if (s.configured === false) {
        alert("Graph ainda não configurado — nada a sincronizar. A fila foi processada mesmo assim.");
      } else {
        alert(
          `Sincronização: ${s.mailboxes ?? 0} caixa(s), ${s.enqueued ?? 0} mensagem(ns) na fila.\n` +
            `Fila processada: ${j.done ?? 0} concluído(s), ${j.failed ?? 0} com erro.` +
            (s.errors?.length ? `\n\nErros:\n${s.errors.join("\n")}` : "")
        );
      }
      await load();
    } finally {
      setSyncing(false);
    }
  }

  if (!canView) {
    return (
      <div className="max-w-7xl mx-auto">
        <p className="text-text-light">Você não tem acesso a este módulo.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-text">Financeiro 💰</h1>
            <span className="text-text-light">›</span>
            <span className="text-lg font-semibold text-text-light">Boletos por e-mail</span>
          </div>
          <p className="text-text-light text-sm mt-0.5">
            Caixas monitoradas — boletos anexados viram título em Contas a Pagar automaticamente
          </p>
        </div>
        {canEdit && (
          <Button variant="secondary" onClick={syncNow} disabled={syncing}>
            {syncing ? "Sincronizando..." : "Sincronizar agora"}
          </Button>
        )}
      </div>

      {!graphConfigured && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
          <p className="font-medium">Microsoft Graph ainda não configurado.</p>
          <p className="mt-1">
            Aguardando o registro do app no Azure e o consentimento do admin do Microsoft 365 do
            cliente (variáveis <code>GRAPH_CLIENT_ID</code>, <code>GRAPH_CLIENT_SECRET</code>,{" "}
            <code>GRAPH_TENANT_ID</code>). Enquanto isso, você já pode cadastrar as caixas aqui e
            testar o reconhecimento de boletos pelo botão <b>Importar boleto (PDF)</b> em Contas a Pagar.
          </p>
        </div>
      )}

      {/* Cadastro */}
      {canEdit && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-text">Adicionar caixa</p>
          <div className="flex gap-3 flex-wrap items-end">
            <div className="flex-1 min-w-[220px]">
              <label className="text-xs text-text-light">E-mail da caixa</label>
              <input
                value={newMailbox}
                onChange={(e) => setNewMailbox(e.target.value)}
                placeholder="cargoships@cargoships.com"
                className={`${inputCls} w-full`}
              />
            </div>
            <div className="flex-1 min-w-[220px]">
              <label className="text-xs text-text-light">Tenant ID (opcional)</label>
              <input
                value={newTenant}
                onChange={(e) => setNewTenant(e.target.value)}
                placeholder="usa GRAPH_TENANT_ID se vazio"
                className={`${inputCls} w-full`}
              />
            </div>
            <Button onClick={addMailbox} disabled={saving}>
              {saving ? "Salvando..." : "Adicionar"}
            </Button>
          </div>
        </div>
      )}

      {/* Lista */}
      {loading ? (
        <p className="p-8 text-center text-text-light text-sm">Carregando...</p>
      ) : accounts.length === 0 ? (
        <div className="bg-card border border-border rounded-xl p-8 text-center text-text-light text-sm">
          Nenhuma caixa cadastrada.
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map((acc) => (
            <div key={acc.id} className="bg-card border border-border rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="font-medium text-text">{acc.mailbox}</p>
                <p className="text-xs text-text-light">
                  última sync: {fmtDateTime(acc.last_sync_at)}
                  {acc.last_status ? ` · ${acc.last_status}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs px-2 py-0.5 rounded-full ${
                    acc.enabled ? "bg-emerald-100 text-emerald-700" : "bg-gray-200 text-gray-600"
                  }`}
                >
                  {acc.enabled ? "ativa" : "pausada"}
                </span>
                {canEdit && (
                  <>
                    <Button variant="secondary" size="sm" onClick={() => toggle(acc)}>
                      {acc.enabled ? "Pausar" : "Ativar"}
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => removeMailbox(acc)}>
                      Remover
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
