"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";

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
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [qr, setQr] = useState<{ base64?: string; code?: string; pairingCode?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [testTo, setTestTo] = useState("");
  const [testText, setTestText] = useState("Teste do Cargo Stock");

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

  async function handleCreate() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/whatsapp/instance/create", { method: "POST" });
      const body = await res.json();
      if (res.ok) {
        setMessage({ kind: "ok", text: "Instância criada/verificada com sucesso." });
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
      if (res.ok && body.result) {
        setQr(body.result);
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

  async function handleTestSend(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo, text: testText }),
      });
      const body = await res.json();
      if (res.ok) {
        setMessage({ kind: "ok", text: "Mensagem enviada." });
      } else {
        setMessage({ kind: "err", text: body.error || "Erro" });
      }
    } catch (err) {
      setMessage({ kind: "err", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const stateRaw = status?.status?.instance?.state;
  const stateLabel = stateRaw === "open" ? "Conectado" : stateRaw === "connecting" ? "Conectando..." : stateRaw === "close" ? "Desconectado" : stateRaw || "—";
  const stateCls = stateRaw === "open"
    ? "bg-emerald-100 text-emerald-700"
    : stateRaw === "connecting"
      ? "bg-amber-100 text-amber-700"
      : "bg-gray-100 text-gray-700";

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-text">WhatsApp 💬</h1>

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
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={loadStatus} disabled={loadingStatus}>
              ↻ Atualizar
            </Button>
            {stateRaw === "open" && (
              <Button size="sm" variant="danger" onClick={handleLogout} disabled={busy}>
                Desconectar
              </Button>
            )}
          </div>
        </div>

        {(status?.configured !== false && stateRaw !== "open") && (
          <div className="border-t border-border pt-3 flex gap-2 flex-wrap">
            <Button size="sm" onClick={handleCreate} disabled={busy}>
              1. Criar instância (se ainda não existe)
            </Button>
            <Button size="sm" variant="success" onClick={handleConnect} disabled={busy}>
              2. Gerar QR Code
            </Button>
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

      {/* Test send */}
      {stateRaw === "open" && (
        <section className="bg-card rounded-2xl border border-border p-6">
          <h2 className="text-base font-semibold mb-3">Enviar mensagem de teste</h2>
          <form onSubmit={handleTestSend} className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">Número (com DDD, sem +55)</label>
              <input
                type="text"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="13988309100"
                required
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Mensagem</label>
              <textarea
                value={testText}
                onChange={(e) => setTestText(e.target.value)}
                rows={3}
                required
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none"
              />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? "Enviando..." : "Enviar"}
            </Button>
          </form>
        </section>
      )}
    </div>
  );
}
