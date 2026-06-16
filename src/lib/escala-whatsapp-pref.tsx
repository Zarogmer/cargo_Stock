"use client";

import { useState, useEffect, useCallback } from "react";

// Preferência compartilhada "ao escalar, também avisar no WhatsApp?".
// Fica DESLIGADA por padrão: escalar NÃO manda mensagem. Avisar no WhatsApp é
// OPT-IN — o usuário marca a caixa quando quiser que os escalados sejam
// avisados. A escolha é lembrada (localStorage) e vale em TODAS as telas de
// escala (modal de Navios, Escalação > Embarque e Escalação > Costado) até
// desmarcar. Desacopla "salvar a escala" de "avisar no WhatsApp".
const KEY = "cargo:escala:enviarWhatsapp";

export function useSendWhatsappPref(): {
  send: boolean;
  setSend: (v: boolean) => void;
} {
  // Default DESLIGADO (escalar sem avisar). Não lê o localStorage no 1º render
  // pra não dar hydration mismatch no Next — sincroniza logo após montar.
  const [send, setSendState] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(KEY) === "1") setSendState(true);
    } catch {
      // localStorage indisponível (SSR/preview) — mantém o padrão desligado.
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

// Checkbox reutilizável usada nos 3 pontos de escala. Avisar é OPT-IN: por
// padrão fica desmarcada (só escala). Quando marcada fica verde, sinalizando a
// ação extra de disparar a mensagem pros escalados.
//
// Os textos têm padrão genérico ("avisar no WhatsApp"), mas podem ser
// sobrescritos por quem chama. O modal de Navios usa isso pra deixar o rótulo
// ciente do contexto: no Costado a ação é CRIAR um grupo novo do navio; no
// Embarque é só avisar os grupos pré-prontos das equipes. As telas de
// Escalação não passam nada e mantêm o texto genérico.
export function EnviarWhatsappToggle({
  send,
  setSend,
  className = "",
  label = "📲 Também avisar no WhatsApp ao escalar",
  sentHint = "Os escalados serão avisados no WhatsApp.",
  idleHint = "Apenas escala — ninguém será avisado no WhatsApp.",
}: {
  send: boolean;
  setSend: (v: boolean) => void;
  className?: string;
  label?: string;
  sentHint?: string;
  idleHint?: string;
}) {
  return (
    <label
      className={`flex items-start gap-2 cursor-pointer rounded-lg border px-3 py-2 transition ${
        send ? "border-emerald-300 bg-emerald-50" : "border-border bg-white"
      } ${className}`}
    >
      <input
        type="checkbox"
        checked={send}
        onChange={(e) => setSend(e.target.checked)}
        className="h-4 w-4 mt-0.5 accent-emerald-600"
      />
      <span className="text-sm leading-snug">
        <span className="font-medium text-text">{label}</span>
        <span className="block text-[11px] text-text-light">
          {send ? sentHint : idleHint}
        </span>
      </span>
    </label>
  );
}
