"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

// ─── Modelo de email ───────────────────────────────────────────────────────
// O corpo é editável como texto puro na tela. Ao enviar, geramos uma versão HTML
// (com o link do site clicável) e copiamos pra área de transferência — o deeplink
// do Outlook não aceita HTML, então o usuário cola (Ctrl+V) no corpo do email no
// Outlook, onde o hyperlink é preservado.

const SITE_URL = "https://cargoshipscleaning.com";

// Anexos hospedados em /public/materiais. O deeplink do Outlook NÃO carrega
// anexos (aceita só to/subject/body), então o botão "Baixar anexos" baixa os 2
// PDFs e o usuário arrasta para a janela do Outlook antes de enviar.
const ATTACHMENTS = [
  {
    label: "Apresentação institucional (PT)",
    href: "/materiais/cargo-ships-2026-pt.pdf",
    filename: "Cargo Ships Cleaning - Apresentacao.pdf",
  },
  {
    label: "Company presentation (EN)",
    href: "/materiais/cargo-ships-2026-en.pdf",
    filename: "Cargo Ships Cleaning - Company Presentation.pdf",
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

Em anexo enviamos nossa apresentação institucional (PT e EN). Conheça mais em nosso site:
${SITE_URL}

Estamos à disposição para atender a sua embarcação com agilidade, segurança e resultado garantido.

Atenciosamente,
Equipe Cargo Ships Cleaning
${SITE_URL}`;
}

// Converte o corpo (texto puro) em HTML pro clipboard: escapa o texto, transforma
// os links http(s) em <a> clicáveis e troca quebras de linha por <br>.
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function bodyToHtml(text: string): string {
  const urlRe = /(https?:\/\/[^\s<]+)/g;
  const inner = text
    .split(urlRe)
    .map((part) =>
      /^https?:\/\//.test(part)
        ? `<a href="${escapeHtml(part)}">${escapeHtml(part)}</a>`
        : escapeHtml(part),
    )
    .join("")
    .replace(/\n/g, "<br>");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">${inner}</div>`;
}

// Copia HTML (rich text) pra área de transferência via seleção temporária. É
// SÍNCRONO (execCommand), então roda dentro do clique e não perde o foco antes de
// abrir o Outlook — o navigator.clipboard.write é async e quebraria isso. Ao colar
// no Outlook, os <a> viram hyperlinks de verdade. Retorna false se falhar.
function copyRichText(html: string): boolean {
  const el = document.createElement("div");
  el.contentEditable = "true";
  el.innerHTML = html;
  el.style.position = "fixed";
  el.style.left = "-9999px";
  el.style.top = "0";
  document.body.appendChild(el);
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  sel?.removeAllRanges();
  document.body.removeChild(el);
  return ok;
}

// Aceita vários emails separados por vírgula ou ponto-e-vírgula e devolve uma
// string limpa separada por vírgula (padrão dos clientes de email). Usado nos
// três campos: Para, Cc e Cco.
function cleanEmails(raw: string): string {
  return raw
    .split(/[,;]/)
    .map((e) => e.trim())
    .filter(Boolean)
    .join(",");
}

// ─── Compositor ───────────────────────────────────────────────────────────────
// Valores iniciais de "to" e "nome" vêm da URL (?to=...&nome=...) — é assim que o
// botão "Enviar email" da aba Clientes chega aqui já preenchido.

export function EmailComposer() {
  const searchParams = useSearchParams();
  const [to, setTo] = useState(() => searchParams.get("to") || "");
  // Cc (com cópia) e Cco (com cópia oculta) — iguais ao Outlook. Aceitam vários
  // emails separados por vírgula e também podem vir pré-preenchidos pela URL.
  const [cc, setCc] = useState(() => searchParams.get("cc") || "");
  const [bcc, setBcc] = useState(() => searchParams.get("bcc") || "");
  const [clientName, setClientName] = useState(() => searchParams.get("nome") || "");
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [body, setBody] = useState(() => buildDefaultBody(searchParams.get("nome") || ""));
  // Feedback do "Preparar Envio": indica que a mensagem foi copiada pra colar.
  const [copied, setCopied] = useState(false);

  // Copia a mensagem como HTML (com o link clicável) e abre o compose do Outlook
  // só com destinatário e assunto — o usuário cola o corpo (Ctrl+V), preservando o
  // hyperlink. Se a cópia falhar, cai no preenchimento antigo (corpo como texto).
  function enviar() {
    const ok = copyRichText(bodyToHtml(body));
    setCopied(ok);
    const ccList = cleanEmails(cc);
    const bccList = cleanEmails(bcc);
    const url =
      "https://outlook.office.com/mail/deeplink/compose" +
      `?to=${encodeURIComponent(cleanEmails(to))}` +
      (ccList ? `&cc=${encodeURIComponent(ccList)}` : "") +
      (bccList ? `&bcc=${encodeURIComponent(bccList)}` : "") +
      `&subject=${encodeURIComponent(subject)}` +
      (ok ? "" : `&body=${encodeURIComponent(body)}`);
    window.open(url, "_blank", "noopener,noreferrer");
  }

  // O deeplink do Outlook não carrega anexos — então baixamos os 2 PDFs para a
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
          <label className="block text-sm font-medium text-text mb-1">Para</label>
          <input
            type="text"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="cliente@empresa.com"
            className={inputClass}
          />
          <p className="text-xs text-text-light mt-1">
            Email do cliente. Para enviar a vários, separe por vírgula.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">
            Cc <span className="text-text-light font-normal">(com cópia)</span>
          </label>
          <input
            type="text"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            placeholder="copia@empresa.com"
            className={inputClass}
          />
          <p className="text-xs text-text-light mt-1">
            Recebe uma cópia — todos veem quem está em Cc. Separe vários por vírgula.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">
            Cco <span className="text-text-light font-normal">(com cópia oculta)</span>
          </label>
          <input
            type="text"
            value={bcc}
            onChange={(e) => setBcc(e.target.value)}
            placeholder="copia.oculta@empresa.com"
            className={inputClass}
          />
          <p className="text-xs text-text-light mt-1">
            Recebe uma cópia sem os outros destinatários verem. Separe vários por vírgula.
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
            onChange={(e) => { setBody(e.target.value); setCopied(false); }}
            rows={16}
            className={`${inputClass} resize-y leading-relaxed`}
          />
        </div>

        {/* Anexos */}
        <div className="rounded-lg border border-border bg-gray-50 p-3">
          <p className="text-xs font-medium text-text mb-2">Anexos (2 PDFs)</p>
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
            Baixar anexos (2 PDFs)
          </button>
          <button
            onClick={restoreTemplate}
            className="px-4 py-2 text-sm text-text-light hover:text-text transition"
          >
            Restaurar modelo
          </button>
        </div>

        {copied && (
          <p className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">
            ✓ Mensagem copiada! No Outlook que abriu, clique no corpo do email e cole com{" "}
            <strong>Ctrl+V</strong> (Cmd+V no Mac) — o link do site já vem clicável. Depois arraste os 2 PDFs.
          </p>
        )}
      </div>

      {/* Dica */}
      <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-800">
        <p className="font-medium mb-1">Como funciona</p>
        <p>
          Clique em <strong>Baixar anexos</strong> para salvar os 2 PDFs no seu computador. Depois
          clique em <strong>Preparar Envio</strong>: a mensagem é copiada (com o link clicável) e o
          Outlook abre no navegador com <strong>Para</strong>, <strong>Cc</strong>, <strong>Cco</strong> e assunto preenchidos. No corpo do email, cole
          com <strong>Ctrl+V</strong> (Cmd+V no Mac) — o link vem clicável. Arraste os 2 PDFs, confira
          tudo e clique em <strong>Enviar</strong> no Outlook. Nada é enviado automaticamente pelo sistema.
        </p>
      </div>
    </div>
  );
}
