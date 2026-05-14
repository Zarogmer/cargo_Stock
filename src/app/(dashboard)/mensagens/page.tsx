"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";

interface StatusResponse {
  configured?: boolean;
  status?: { instance?: { state?: string } };
  error?: string;
}

export default function MensagensPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

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
    const interval = setInterval(loadStatus, 10000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, text }),
      });
      const body = await res.json();
      if (res.ok) {
        setMessage({ kind: "ok", text: `Mensagem enviada para ${to}.` });
        setText("");
      } else {
        setMessage({ kind: "err", text: body.error || "Erro ao enviar." });
      }
    } catch (err) {
      setMessage({ kind: "err", text: (err as Error).message });
    } finally {
      setSending(false);
    }
  }

  const stateRaw = status?.status?.instance?.state;
  const isConnected = stateRaw === "open";
  const isConfigured = status?.configured !== false;

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      <h1 className="text-2xl font-bold text-text">Mensagens 📨</h1>
      <p className="text-sm text-text-light">
        Envie mensagens de WhatsApp pelo número da empresa.
      </p>

      {/* Status banner */}
      {loadingStatus ? (
        <div className="bg-gray-50 border border-border rounded-lg px-3 py-2 text-sm text-text-light">
          Verificando conexão...
        </div>
      ) : !isConfigured ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900">
          WhatsApp não configurado no servidor — avise a equipe de tecnologia.
        </div>
      ) : !isConnected ? (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-900">
          WhatsApp desconectado — peça pra equipe de tecnologia reconectar antes de enviar.
        </div>
      ) : (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm text-emerald-900 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          WhatsApp conectado e pronto pra enviar.
        </div>
      )}

      {message && (
        <div className={`rounded-lg px-3 py-2 text-sm border ${
          message.kind === "ok"
            ? "bg-emerald-50 border-emerald-200 text-emerald-900"
            : "bg-red-50 border-red-200 text-red-900"
        }`}>
          {message.text}
        </div>
      )}

      {/* Send form */}
      <section className="bg-card rounded-2xl border border-border p-6">
        <h2 className="text-base font-semibold mb-4">Nova mensagem</h2>
        <form onSubmit={handleSend} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Número (com DDD, sem +55)
            </label>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="13988309100"
              required
              disabled={!isConnected || sending}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none disabled:bg-gray-50 disabled:text-gray-500"
            />
            <p className="text-xs text-text-light mt-1">
              Pode digitar só os dígitos — o +55 do Brasil é adicionado automaticamente.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Mensagem</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              required
              disabled={!isConnected || sending}
              placeholder="Escreva a mensagem aqui..."
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setText(""); setTo(""); setMessage(null); }}
              disabled={sending}
            >
              Limpar
            </Button>
            <Button type="submit" disabled={!isConnected || sending}>
              {sending ? "Enviando..." : "Enviar"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
