"use client";

import { useEffect, useState } from "react";
import { useSync } from "@/lib/offline/sync-context";
import { describeOutboxItem, listOutbox, removeFromOutbox, retryErrors, subscribeSync } from "@/lib/offline/sync";
import type { OutboxItem } from "@/lib/offline/db";

// Faixa de sincronização no topo do sistema. Só aparece quando tem algo a
// dizer: sem internet, lançamentos esperando envio, erro de envio ou sessão
// expirada. Com tudo em dia e online, some.

export function OfflineBar() {
  const { online, pending, errors, syncing, needsLogin, syncNow } = useSync();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<OutboxItem[]>([]);

  const total = pending + errors;
  const visible = !online || total > 0 || needsLogin;

  useEffect(() => {
    if (!open) return;
    const load = () => listOutbox().then(setItems).catch(() => setItems([]));
    load();
    return subscribeSync((e) => {
      if (e.type === "change") load();
    });
  }, [open]);

  if (!visible) return null;

  const tone = !online
    ? "bg-amber-50 border-amber-200 text-amber-900"
    : errors > 0 || needsLogin
      ? "bg-red-50 border-red-200 text-red-800"
      : "bg-blue-50 border-blue-200 text-blue-900";

  const headline = !online
    ? "📴 Sem internet — os lançamentos ficam salvos no celular"
    : needsLogin
      ? "🔒 Sessão expirada — faça login de novo pra enviar os lançamentos"
      : errors > 0
        ? `⚠️ ${errors} lançamento${errors > 1 ? "s" : ""} com erro no envio`
        : syncing
          ? "🔄 Enviando lançamentos..."
          : `☁️ ${pending} lançamento${pending > 1 ? "s" : ""} esperando envio`;

  return (
    <div className={`border-b px-4 py-2 text-sm ${tone}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium flex-1 min-w-0">{headline}</span>
        {total > 0 && (
          <span className="text-xs opacity-80">
            {pending} pendente{pending !== 1 ? "s" : ""}
            {errors > 0 ? ` · ${errors} com erro` : ""}
          </span>
        )}
        {total > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
          >
            {open ? "Ocultar" : "Ver"}
          </button>
        )}
        {needsLogin ? (
          <a
            href="/login"
            className="px-3 py-1 rounded-lg bg-white border border-current/30 text-xs font-semibold hover:bg-gray-50"
          >
            Fazer login
          </a>
        ) : (
          <button
            type="button"
            onClick={() => (errors > 0 ? retryErrors() : syncNow())}
            disabled={!online || syncing || total === 0}
            className="px-3 py-1 rounded-lg bg-white border border-current/30 text-xs font-semibold hover:bg-gray-50 disabled:opacity-50"
          >
            {syncing ? "Enviando..." : "Sincronizar agora"}
          </button>
        )}
      </div>

      {open && items.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {items.map((it) => (
            <li key={it.id} className="flex items-start gap-2 bg-white/60 rounded-lg px-2.5 py-1.5">
              <span className="shrink-0">
                {it.status === "erro" ? "❌" : it.status === "enviando" ? "🔄" : "⏳"}
              </span>
              <span className="flex-1 min-w-0">
                <span className="font-medium">{describeOutboxItem(it)}</span>
                <span className="opacity-70"> · {new Date(it.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                {it.status === "erro" && it.last_error && (
                  <span className="block text-red-700 mt-0.5">{it.last_error}</span>
                )}
              </span>
              {it.status === "erro" && (
                <button
                  type="button"
                  onClick={() => {
                    if (confirm("Descartar este lançamento? Ele não será enviado ao servidor.")) {
                      removeFromOutbox(it.id);
                    }
                  }}
                  className="shrink-0 text-red-700 underline underline-offset-2"
                >
                  Descartar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
