"use client";

import { useState, useEffect, useCallback } from "react";

// Preferência compartilhada "ao escalar, também avisar no WhatsApp?".
// Fica LIGADA por padrão (comportamento normal de produção). O usuário pode
// desligar pra fazer teste real de escalação SEM disparar mensagem pros
// funcionários — a escolha é lembrada (localStorage) e vale em TODAS as telas
// de escala (modal de Navios, Escalação > Embarque e Escalação > Costado) até
// religar. Desacopla "salvar a escala" de "avisar no WhatsApp".
const KEY = "cargo:escala:enviarWhatsapp";

export function useSendWhatsappPref(): {
  send: boolean;
  setSend: (v: boolean) => void;
} {
  // Default LIGADO. Não lê o localStorage no 1º render pra não dar hydration
  // mismatch no Next — sincroniza logo após montar, no useEffect.
  const [send, setSendState] = useState(true);

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === "0") setSendState(false);
    } catch {
      // localStorage indisponível (SSR/preview) — mantém o padrão ligado.
    }
  }, []);

  const setSend = useCallback((v: boolean) => {
    setSendState(v);
    try {
      localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      // ignore
    }
  }, []);

  return { send, setSend };
}

// Checkbox reutilizável usada nos 3 pontos de escala. Quando desligada fica
// âmbar, deixando explícito que nenhuma mensagem vai sair (evita esquecer no
// modo teste e achar que avisou).
export function EnviarWhatsappToggle({
  send,
  setSend,
  className = "",
}: {
  send: boolean;
  setSend: (v: boolean) => void;
  className?: string;
}) {
  return (
    <label
      className={`flex items-start gap-2 cursor-pointer rounded-lg border px-3 py-2 transition ${
        send ? "border-border bg-white" : "border-amber-300 bg-amber-50"
      } ${className}`}
    >
      <input
        type="checkbox"
        checked={send}
        onChange={(e) => setSend(e.target.checked)}
        className="h-4 w-4 mt-0.5 accent-emerald-600"
      />
      <span className="text-sm leading-snug">
        <span className="font-medium text-text">📲 Avisar no WhatsApp ao escalar</span>
        <span className="block text-[11px] text-text-light">
          {send
            ? "Os escalados serão avisados no WhatsApp."
            : "⚠️ Modo teste: a escala é salva, mas ninguém é avisado."}
        </span>
      </span>
    </label>
  );
}
