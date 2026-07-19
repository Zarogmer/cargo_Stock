"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";

const ADMIN_ROLES = new Set(["TECNOLOGIA", "GESTOR", "EXECUTIVO", "COMERCIAL"]);

interface StatusResponse {
  configured?: boolean;
  status?: { instance?: { state?: string } };
  error?: string;
}

interface ConnectResponse {
  success?: boolean;
  result?: { base64?: string; code?: string; pairingCode?: string };
  error?: string;
}

export default function WhatsappPage() {
  const { profile } = useAuth();
  const isAdmin = !!profile && ADMIN_ROLES.has(profile.role);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [qr, setQr] = useState<{ base64?: string; code?: string; pairingCode?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Webhook section
  const [webhookConfig, setWebhookConfig] = useState<Record<string, unknown> | null>(null);
  const [loadingWebhook, setLoadingWebhook] = useState(false);
  const [webhookErr, setWebhookErr] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch("/api/whatsapp/status");
      const body = await res.json();
      setStatus(body);
    } catch (err) {
      setStatus({ error: (err as Error).message });
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 5000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  // Pull a QR code (base64) out of whatever shape Evolution sends — varies
  // slightly between endpoints. Returns null if none present.
  function extractQr(raw: unknown): { base64?: string; code?: string; pairingCode?: string } | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (r.base64 || r.code || r.pairingCode) {
      return r as { base64?: string; code?: string; pairingCode?: string };
    }
    if (r.qrcode && typeof r.qrcode === "object") {
      return r.qrcode as { base64?: string; code?: string; pairingCode?: string };
    }
    if (r.result) return extractQr(r.result);
    return null;
  }

  async function handleCreate() {
    setBusy(true);
    setMessage(null);
    setQr(null);
    try {
      const res = await fetch("/api/whatsapp/instance/create", { method: "POST" });
      const body = await res.json();
      if (res.ok) {
        // Evolution returns the QR right in the create response — surface it
        // immediately so the user doesn't need a second click.
        const qrFromCreate = extractQr(body.result);
        if (qrFromCreate?.base64 || qrFromCreate?.code) {
          setQr(qrFromCreate);
          setMessage({ kind: "ok", text: "QR Code gerado. Escaneie no WhatsApp." });
        } else {
          setMessage({ kind: "ok", text: "Instância pronta — clique em 'Gerar QR Code' se precisar reconectar." });
        }
        loadStatus();
      } else {
        setMessage({ kind: "err", text: body.error || "Erro" });
      }
    } catch (err) {
      setMessage({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleConnect() {
    setBusy(true);
    setMessage(null);
    setQr(null);
    try {
      const res = await fetch("/api/whatsapp/instance/connect");
      const body = (await res.json()) as ConnectResponse;
      if (res.ok) {
        const qr = extractQr(body.result);
        if (qr) {
          setQr(qr);
        } else {
          const raw = JSON.stringify(body.result ?? body).slice(0, 300);
          setMessage({ kind: "err", text: `Sem QR na resposta — use "Recriar (reset)". Evolution respondeu: ${raw}` });
        }
      } else {
        setMessage({ kind: "err", text: body.error || "Erro" });
      }
    } catch (err) {
      setMessage({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleReset() {
    if (!confirm("Deletar e recriar a instância? Isso vai gerar um QR Code novo.")) return;
    setBusy(true);
    setMessage(null);
    setQr(null);
    try {
      const res = await fetch("/api/whatsapp/instance/reset", { method: "POST" });
      const body = await res.json();
      if (res.ok) {
        const qrFromReset = extractQr(body.result);
        if (qrFromReset?.base64 || qrFromReset?.code) {
          setQr(qrFromReset);
          setMessage({ kind: "ok", text: "Instância recriada. Escaneie o QR Code." });
        } else {
          const raw = JSON.stringify(body.result).slice(0, 300);
          setMessage({ kind: "err", text: `Recriou mas sem QR. Evolution respondeu: ${raw}` });
        }
        loadStatus();
      } else {
        setMessage({ kind: "err", text: body.error || "Erro" });
      }
    } catch (err) {
      setMessage({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    if (!confirm("Desconectar o WhatsApp da instância? Será necessário escanear o QR Code novamente.")) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/whatsapp/instance/logout", { method: "POST" });
      const body = await res.json();
      if (res.ok) {
        setMessage({ kind: "ok", text: "Desconectado." });
        setQr(null);
        loadStatus();
      } else {
        setMessage({ kind: "err", text: body.error || "Erro" });
      }
    } catch (err) {
      setMessage({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const loadWebhookStatus = useCallback(async () => {
    setLoadingWebhook(true);
    setWebhookErr(null);
    try {
      const res = await fetch("/api/whatsapp/webhook/status");
      const body = await res.json();
      if (res.ok) setWebhookConfig(body.config as Record<string, unknown>);
      else setWebhookErr(body.error || `HTTP ${res.status}`);
    } catch (err) {
      setWebhookErr((err as Error).message);
    } finally {
      setLoadingWebhook(false);
    }
  }, []);

  async function handleRegisterWebhook() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/whatsapp/webhook/register", { method: "POST" });
      const body = await res.json();
      if (res.ok) {
        setMessage({ kind: "ok", text: "Webhook registrado no Evolution." });
        loadWebhookStatus();
      } else {
        setMessage({ kind: "err", text: body.error || "Erro" });
      }
    } catch (err) {
      setMessage({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (isAdmin) loadWebhookStatus();
  }, [isAdmin, loadWebhookStatus]);

  const stateRaw = status?.status?.instance?.state;
  const stateLabel = stateRaw === "open" ? "Conectado" : stateRaw === "connecting" ? "Conectando..." : stateRaw === "close" ? "Desconectado" : stateRaw || "—";
  const stateCls = stateRaw === "open"
    ? "bg-emerald-100 text-emerald-700"
    : stateRaw === "connecting"
      ? "bg-amber-100 text-amber-700"
      : "bg-gray-100 text-gray-700";

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-text">WhatsApp API 💬</h1>
      <p className="text-sm text-text-light">
        Conexão e webhook do WhatsApp. Pra mandar mensagens use a aba <strong>Mensagens</strong>; pra ver conversas, <strong>Conversas</strong>.
      </p>

      {/* Status card */}
      <section className="bg-card rounded-2xl border border-border p-6 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-xs uppercase tracking-wider text-text-light font-semibold">Status</p>
            {loadingStatus ? (
              <p className="text-sm text-text-light mt-1">Carregando...</p>
            ) : status?.configured === false ? (
              <p className="text-sm text-text-light mt-1">
                Evolution API não configurada — variáveis <code className="text-xs bg-gray-100 px-1 rounded">EVOLUTION_*</code> ausentes.
              </p>
            ) : status?.error ? (
              <p className="text-sm text-danger mt-1">⚠️ {status.error}</p>
            ) : (
              <p className="mt-1">
                <span className={`text-sm px-2 py-0.5 rounded-full font-semibold ${stateCls}`}>{stateLabel}</span>
              </p>
            )}
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="secondary" onClick={loadStatus} disabled={loadingStatus}>
              ↻ Atualizar
            </Button>
            {isAdmin && stateRaw === "open" && (
              <>
                <Button size="sm" variant="danger" onClick={handleLogout} disabled={busy}>
                  Desconectar
                </Button>
                <Button size="sm" variant="danger" onClick={handleReset} disabled={busy} title="Use quando o status diz 'Conectado' mas envios falham com Connection Closed">
                  Recriar (reset)
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Recovery path — shown only when the instance is NOT open. When open
            but stuck (status=open + operations failing), the admin also has
            "Recriar (reset)" in the top-right action bar above. */}
        {isAdmin && (status?.configured !== false && stateRaw !== "open") && (
          <div className="border-t border-border pt-3 flex gap-2 flex-wrap">
            <Button size="sm" onClick={handleCreate} disabled={busy}>
              1. Criar instância (se ainda não existe)
            </Button>
            <Button size="sm" variant="success" onClick={handleConnect} disabled={busy}>
              2. Gerar QR Code
            </Button>
            <Button size="sm" variant="danger" onClick={handleReset} disabled={busy}>
              3. Recriar (reset)
            </Button>
          </div>
        )}

        {!isAdmin && stateRaw !== "open" && (
          <div className="border-t border-border pt-3">
            <p className="text-xs text-text-light">
              WhatsApp desconectado — peça para a equipe de tecnologia reconectar.
            </p>
          </div>
        )}
      </section>

      {message && (
        <div className={`rounded-lg px-3 py-2 text-sm border ${
          message.kind === "ok"
            ? "bg-emerald-50 border-emerald-200 text-emerald-900"
            : "bg-red-50 border-red-200 text-red-900"
        }`}>
          {message.text}
        </div>
      )}

      {/* QR Code */}
      {qr && (
        <section className="bg-card rounded-2xl border border-border p-6">
          <h2 className="text-base font-semibold mb-2">Escaneie o QR Code</h2>
          <p className="text-xs text-text-light mb-4">
            Abra o WhatsApp → Aparelhos conectados → Conectar um aparelho → aponte a câmera pra esse QR.
          </p>
          {qr.base64 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qr.base64} alt="QR Code WhatsApp" className="w-72 h-72 mx-auto" />
          ) : qr.code ? (
            <pre className="text-[10px] bg-gray-100 p-3 rounded overflow-auto">{qr.code}</pre>
          ) : (
            <p className="text-sm text-text-light">QR não disponível — pode ser que a instância já esteja conectada.</p>
          )}
          {qr.pairingCode && (
            <p className="text-xs text-center mt-3 text-text-light">
              Código de pareamento: <strong className="font-mono">{qr.pairingCode}</strong>
            </p>
          )}
        </section>
      )}

      {/* Webhook (admin) */}
      {isAdmin && (
        <section className="bg-card rounded-2xl border border-border p-6 space-y-3">
          <div className="flex items-baseline justify-between flex-wrap gap-2">
            <div>
              <h2 className="text-base font-semibold">Webhook do Evolution</h2>
              <p className="text-xs text-text-light mt-0.5">
                O Evolution chama essa URL toda vez que chega/sai mensagem — é o que alimenta a aba <strong>Conversas</strong>.
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={loadWebhookStatus} disabled={loadingWebhook}>
                ↻ Verificar
              </Button>
              <Button size="sm" onClick={handleRegisterWebhook} disabled={busy}>
                Registrar webhook
              </Button>
            </div>
          </div>
          {loadingWebhook ? (
            <p className="text-xs text-text-light">Verificando...</p>
          ) : webhookErr ? (
            <p className="text-xs text-red-700">⚠️ {webhookErr}</p>
          ) : webhookConfig ? (
            (() => {
              const url = (webhookConfig.url as string) || "";
              const events = (webhookConfig.events as string[]) || [];
              const enabled = !!webhookConfig.enabled;
              const isOurs = url.includes("/api/whatsapp/webhook");
              return (
                <div className="text-xs space-y-1 font-mono bg-gray-50 border border-border rounded-lg p-3">
                  <p>
                    Status:{" "}
                    {enabled && isOurs ? (
                      <span className="text-emerald-700 font-semibold">✓ ativo</span>
                    ) : (
                      <span className="text-red-700 font-semibold">⚠️ {!enabled ? "desativado" : "URL externa"}</span>
                    )}
                  </p>
                  <p className="break-all">URL: {url || "<vazio>"}</p>
                  <p>Eventos: {events.length ? events.join(", ") : "<nenhum>"}</p>
                </div>
              );
            })()
          ) : (
            <p className="text-xs text-text-light">Clique em &quot;Verificar&quot; pra ver o status.</p>
          )}
        </section>
      )}
    </div>
  );
}
