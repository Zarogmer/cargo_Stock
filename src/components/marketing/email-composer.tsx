"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

// ─── Modelo de email ───────────────────────────────────────────────────────
// Texto puro: os deeplinks do Outlook / mailto não suportam HTML de forma
// confiável. O usuário pode editar tudo na tela antes de abrir o Outlook.

const SITE_URL = "https://cargoshipscleaning.com";

// Anexos hospedados em /public/materiais. O deeplink do Outlook NÃO carrega
// anexos (aceita só to/subject/body), então o botão "Baixar anexos" baixa os 3
// PDFs e o usuário arrasta para a janela do Outlook antes de enviar.
const ATTACHMENTS = [
  {
    label: "Apresentação institucional (PT)",
    href: "/materiais/apresentacao-cargo-ships-cleaning-pt.pdf",
    filename: "Cargo Ships Cleaning - Apresentacao.pdf",
  },
  {
    label: "Company presentation (EN)",
    href: "/materiais/cargo-ships-cleaning-company-presentation-en.pdf",
    filename: "Cargo Ships Cleaning - Company Presentation.pdf",
  },
  {
    label: "Proposta — limpeza de porão (Santos)",
    href: "/materiais/proposta-limpeza-de-porao-santos.pdf",
    filename: "Cargo Ships Cleaning - Proposta Limpeza de Porao.pdf",
  },
];

const DEFAULT_SUBJECT = "Cargo Ships Cleaning — Lavagem de porão e serviços a bordo";

function buildDefaultBody(clientName: string): string {
  const trimmed = clientName.trim();
  const greeting = trimmed ? `Prezados (${trimmed}),` : "Prezados,";
  return `${greeting}

A Cargo Ships Cleaning é especializada em limpeza e lavagem de porão de navios de carga (bulk carriers), com mais de 30 anos de atuação nos principais portos do Brasil e da América do Sul.

Por que trabalhar conosco:
• No Cure, No Pay — se o porão não for aprovado na inspeção, o risco financeiro é 100% nosso
• Produtos 100% biodegradáveis, sem risco de contaminação para o navio, a carga e o mar
• Equipe própria, certificada e com seguro de responsabilidade civil
• Liberação e autorização junto à Autoridade Portuária inclusas

Nossos serviços:
• Lavagem e limpeza de porão (cargo hold cleaning)
• Limpeza de costado
• Remoção de ferrugem e pintura de porão (sob demanda)
• Serviços a bordo durante a estadia no porto

Em anexo enviamos nossa apresentação institucional e uma proposta modelo. Conheça mais em nosso site:
${SITE_URL}

Estamos à disposição para atender a sua embarcação com agilidade, segurança e resultado garantido.

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

  // Aceita vários destinatários separados por vírgula ou ponto-e-vírgula e
  // devolve uma string limpa separada por vírgula (padrão dos clientes de email).
  function recipientList(): string {
    return to
      .split(/[,;]/)
      .map((e) => e.trim())
      .filter(Boolean)
      .join(",");
  }

  // Abre o compose do Outlook na web com tudo já preenchido. O usuário confere e
  // clica em Enviar — o email sai da conta Outlook em que ele estiver logado.
  function enviar() {
    const url =
      "https://outlook.office.com/mail/deeplink/compose" +
      `?to=${encodeURIComponent(recipientList())}` +
      `&subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // O deeplink do Outlook não carrega anexos — então baixamos os 3 PDFs para a
  // máquina do usuário, que arrasta os arquivos para a janela do Outlook.
  function baixarAnexos() {
    ATTACHMENTS.forEach((att, i) => {
      // Pequeno atraso entre downloads para o navegador não agrupar/bloquear.
      setTimeout(() => {
        const a = document.createElement("a");
        a.href = att.href;
        a.download = att.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      }, i * 400);
    });
  }

  function restoreTemplate() {
    setSubject(DEFAULT_SUBJECT);
    setBody(buildDefaultBody(clientName));
  }

  const inputClass =
    "w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm bg-card";

  return (
    <div className="space-y-6 max-w-3xl">
      <p className="text-text-light text-sm">
        Convide clientes a conhecer a Cargo Ships Cleaning e o site cargoshipscleaning.com.
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

        {/* Anexos */}
        <div className="rounded-lg border border-border bg-gray-50 p-3">
          <p className="text-xs font-medium text-text mb-2">Anexos (3 PDFs)</p>
          <ul className="space-y-1">
            {ATTACHMENTS.map((att) => (
              <li key={att.href} className="flex items-center gap-1.5 text-xs text-text-light">
                <span aria-hidden>📄</span>
                <a
                  href={att.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-primary hover:underline"
                >
                  {att.label}
                </a>
              </li>
            ))}
          </ul>
        </div>

        {/* Ações */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button
            onClick={enviar}
            className="flex items-center gap-2 px-5 py-2 bg-primary text-white rounded-lg hover:bg-primary-dark transition text-sm font-medium shadow-sm"
          >
            <span aria-hidden>✉️</span>
            Preparar Envio
          </button>
          <button
            onClick={baixarAnexos}
            className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg hover:bg-gray-50 transition text-sm font-medium text-text"
          >
            <span aria-hidden>📎</span>
            Baixar anexos (3 PDFs)
          </button>
          <button
            onClick={restoreTemplate}
            className="px-4 py-2 text-sm text-text-light hover:text-text transition"
          >
            Restaurar modelo
          </button>
        </div>
      </div>

      {/* Dica */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-800">
        <p className="font-medium mb-1">Como funciona</p>
        <p>
          Clique em <strong>Baixar anexos</strong> para salvar os 3 PDFs no seu computador. Depois
          clique em <strong>Preparar Envio</strong>: o Outlook abre no navegador já com o email preenchido
          (destinatário, assunto e texto). Arraste os 3 PDFs para a janela do Outlook, confira tudo e
          clique em <strong>Enviar</strong> no Outlook — o email sai da sua conta normal. Nada é
          enviado automaticamente pelo sistema.
        </p>
      </div>
    </div>
  );
}
