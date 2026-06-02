"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

// ─── Modelo de email ───────────────────────────────────────────────────────
// Texto puro: os deeplinks do Outlook / mailto não suportam HTML de forma
// confiável. O usuário pode editar tudo na tela antes de abrir o Outlook.

const SITE_URL = "https://cargoships.com.br";

const DEFAULT_SUBJECT = "Cargo Ships Cleaning — Lavagem de porão e serviços a bordo";

function buildDefaultBody(clientName: string): string {
  const trimmed = clientName.trim();
  const greeting = trimmed ? `Prezados (${trimmed}),` : "Prezados,";
  return `${greeting}

Somos a Cargo Ships Cleaning, especializada em limpeza e lavagem de porão de navios de carga nos portos brasileiros.

Nossos serviços:
• Lavagem de porão
• Limpeza de costado
• Serviços a bordo durante a estadia no porto

Conheça nosso trabalho e saiba mais em nosso site:
${SITE_URL}

Estamos à disposição para atender a sua embarcação com agilidade e segurança.

Atenciosamente,
Equipe Cargo Ships Cleaning
${SITE_URL}`;
}

// ─── Compositor ───────────────────────────────────────────────────────────────
// Valores iniciais de "to" e "nome" vêm da URL (?to=...&nome=...) — é assim que o
// botão "Enviar email" da aba Clientes chega aqui já preenchido.

export function EmailComposer() {
  const searchParams = useSearchParams();
  const [to, setTo] = useState(() => searchParams.get("to") || "");
  const [clientName, setClientName] = useState(() => searchParams.get("nome") || "");
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [body, setBody] = useState(() => buildDefaultBody(searchParams.get("nome") || ""));
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Aceita vários destinatários separados por vírgula ou ponto-e-vírgula e
  // devolve uma string limpa separada por vírgula (padrão dos clientes de email).
  function recipientList(): string {
    return to
      .split(/[,;]/)
      .map((e) => e.trim())
      .filter(Boolean)
      .join(",");
  }

  // Abre o compose do Outlook Web com tudo já preenchido. O usuário confere e
  // clica em Enviar — o email sai da conta Outlook que ele estiver logado.
  function openOutlookWeb() {
    const url =
      "https://outlook.office.com/mail/deeplink/compose" +
      `?to=${encodeURIComponent(recipientList())}` +
      `&subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // Abre o app de email padrão do computador (no Windows com Outlook instalado,
  // é o próprio Outlook). Endereços vão crus; só assunto e corpo são encodados.
  // O Outlook desktop renderiza as quebras de linha de forma mais confiável com
  // CRLF (%0D%0A) do que só com LF — por isso normalizamos o corpo antes.
  function openMailto() {
    const crlfBody = body.replace(/\r?\n/g, "\r\n");
    const url =
      `mailto:${recipientList()}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(crlfBody)}`;
    window.location.href = url;
  }

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setFeedback(null);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFeedback("Não foi possível copiar automaticamente. Selecione o texto e copie manualmente.");
    }
  }

  function restoreTemplate() {
    setSubject(DEFAULT_SUBJECT);
    setBody(buildDefaultBody(clientName));
    setFeedback(null);
  }

  const inputClass =
    "w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm bg-card";

  return (
    <div className="space-y-6 max-w-3xl">
      <p className="text-text-light text-sm">
        Convide clientes a conhecer a Cargo Ships Cleaning e o site cargoships.com.br.
      </p>

      {/* Formulário */}
      <div className="bg-card rounded-xl border border-border p-5 space-y-4">
        <div>
          <label className="block text-sm font-medium text-text mb-1">Email do cliente</label>
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="cliente@empresa.com"
            className={inputClass}
          />
          <p className="text-xs text-text-light mt-1">
            Para enviar a vários, separe os emails por vírgula.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">
            Nome do cliente / empresa <span className="text-text-light font-normal">(opcional)</span>
          </label>
          <input
            type="text"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            placeholder="Ex: Transatlântica"
            className={inputClass}
          />
          <p className="text-xs text-text-light mt-1">
            Usado na saudação quando você clicar em &ldquo;Restaurar modelo&rdquo;.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">Assunto</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className={inputClass}
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">Mensagem</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={16}
            className={`${inputClass} resize-y leading-relaxed`}
          />
        </div>

        {/* Ações */}
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            onClick={openMailto}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-dark transition text-sm font-medium shadow-sm"
          >
            <span aria-hidden>📧</span>
            Abrir no Outlook
          </button>
          <button
            onClick={openOutlookWeb}
            className="flex items-center gap-2 px-4 py-2 bg-card border border-border text-text rounded-lg hover:bg-gray-50 transition text-sm font-medium shadow-sm"
          >
            <span aria-hidden>🌐</span>
            Abrir no navegador (web)
          </button>
          <button
            onClick={copyBody}
            className="flex items-center gap-2 px-4 py-2 bg-card border border-border text-text rounded-lg hover:bg-gray-50 transition text-sm font-medium shadow-sm"
          >
            <span aria-hidden>{copied ? "✅" : "📋"}</span>
            {copied ? "Copiado!" : "Copiar texto"}
          </button>
          <button
            onClick={restoreTemplate}
            className="px-4 py-2 text-sm text-text-light hover:text-text transition"
          >
            Restaurar modelo
          </button>
        </div>

        {feedback && <p className="text-xs text-amber-600">{feedback}</p>}
      </div>

      {/* Dica */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-800 space-y-2">
        <div>
          <p className="font-medium mb-1">Como funciona</p>
          <p>
            O botão abre o Outlook com o email já preenchido (destinatário, assunto e texto).
            Confira e clique em <strong>Enviar</strong> — o email sai da sua conta normal do Outlook.
            Nada é enviado automaticamente pelo sistema.
          </p>
        </div>
        <p className="text-xs text-blue-700">
          Se ao clicar abrir o navegador em vez do programa Outlook, defina o Outlook como app de
          email padrão do Windows: <strong>Configurações → Aplicativos → Aplicativos padrão → Email</strong>.
        </p>
      </div>
    </div>
  );
}
