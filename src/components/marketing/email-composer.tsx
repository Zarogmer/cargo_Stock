"use client";

import { useState, useEffect, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { db } from "@/lib/db";

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

// Equipe Cargo Ships que entra SEMPRE em Cco (cópia oculta): toda prospecção
// enviada pinga pra equipe interna sem o cliente ver. Pré-preenchido no campo
// Cco ao abrir o compositor (editável, caso precise tirar alguém pontualmente).
const FIXED_BCC = [
  "bpn@cargoships.com.br",
  "camila@cargoships.com.br",
  "comercial@cargoships.com.br",
  "rose@cargoships.com.br",
  "sandra@cargoships.com.br",
].join(",");

// Junta listas de email (vírgula/;) removendo duplicados (case-insensitive).
function mergeEmails(...parts: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    for (const e of part.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
      const key = e.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(e);
      }
    }
  }
  return out.join(",");
}

// Cliente cadastrado (aba Clientes) usado no autocomplete do campo Nome. `email`
// pode trazer vários endereços separados por vírgula.
interface ClientOption {
  id: number;
  name: string;
  company: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
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
  // Cco já abre com a equipe Cargo Ships (FIXED_BCC) — sempre presente — mais
  // qualquer bcc vindo da URL, sem duplicar.
  const [bcc, setBcc] = useState(() => mergeEmails(searchParams.get("bcc") || "", FIXED_BCC));
  const [clientName, setClientName] = useState(() => searchParams.get("nome") || "");
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [body, setBody] = useState(() => buildDefaultBody(searchParams.get("nome") || ""));
  // Nome que gerou o corpo-modelo atual. Se o corpo ainda for exatamente esse
  // modelo, tratamos como "não editado" e podemos trocar a saudação ao escolher
  // outro cliente; se o usuário mexeu no texto, não sobrescrevemos.
  const [templateName, setTemplateName] = useState(() => searchParams.get("nome") || "");
  // Feedback do "Preparar Envio": indica que a mensagem foi copiada pra colar.
  const [copied, setCopied] = useState(false);

  // Clientes cadastrados (aba Clientes) pro autocomplete do campo Nome. Carregado
  // uma vez ao montar — é o que permite "digitar o nome e puxar os emails".
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [showSug, setShowSug] = useState(false);
  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await db.from("marketing_clients").select("*").order("name");
      if (active) setClients((data as ClientOption[]) || []);
    })();
    return () => { active = false; };
  }, []);

  // Sugestões filtradas pelo texto do campo Nome (casa nome, empresa ou email).
  const matches = useMemo(() => {
    const q = clientName.trim().toLowerCase();
    const list = q
      ? clients.filter((c) => [c.name, c.company, c.email].some((v) => (v || "").toLowerCase().includes(q)))
      : clients;
    return list.slice(0, 8);
  }, [clients, clientName]);

  // Escolher um cliente: joga os emails cadastrados no campo "Para" e fixa o nome.
  // Se o corpo ainda for o modelo padrão (não editado), atualiza a saudação.
  function selectClient(c: ClientOption) {
    const display = c.company || c.name;
    setTo(cleanEmails(c.email || ""));
    // Só reescreve a saudação se o corpo ainda for o modelo padrão (não editado).
    if (body === buildDefaultBody(templateName)) {
      setBody(buildDefaultBody(display));
      setTemplateName(display);
    }
    setClientName(display);
    setCopied(false);
    setShowSug(false);
  }

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
    setTemplateName(clientName);
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
        {/* Cliente: autocomplete dos cadastrados. Escolher um puxa os emails pro
            campo "Para" automaticamente. */}
        <div className="relative">
          <label className="block text-sm font-medium text-text mb-1">
            Nome do cliente / empresa <span className="text-text-light font-normal">(puxa os emails)</span>
          </label>
          <input
            type="text"
            value={clientName}
            onChange={(e) => { setClientName(e.target.value); setShowSug(true); }}
            onFocus={() => setShowSug(true)}
            onBlur={() => setTimeout(() => setShowSug(false), 150)}
            placeholder="Digite e escolha um cliente cadastrado…"
            autoComplete="off"
            className={inputClass}
          />
          {showSug && matches.length > 0 && (
            <ul className="absolute z-20 mt-1 w-full max-h-64 overflow-auto bg-card border border-border rounded-lg shadow-lg py-1">
              {matches.map((c) => {
                const emails = cleanEmails(c.email || "");
                const count = emails ? emails.split(",").length : 0;
                const place = [c.city, c.state].filter(Boolean).join("/");
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); selectClient(c); }}
                      className="w-full text-left px-3 py-2 hover:bg-primary/5 transition"
                    >
                      <span className="block text-sm font-medium text-text">
                        {c.company || c.name}
                        {count > 1 && (
                          <span className="ml-2 text-xs font-normal text-primary">{count} emails</span>
                        )}
                      </span>
                      <span className="block text-xs text-text-light truncate">
                        {emails || "sem email cadastrado"}{place ? `  ·  ${place}` : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-xs text-text-light mt-1">
            Escolha um cliente e os emails cadastrados entram em <strong>Para</strong> automaticamente. Cadastre clientes na aba Clientes.
          </p>
        </div>

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
            A equipe Cargo Ships já entra aqui por padrão.
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
          <a
            href={SITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg hover:bg-gray-50 transition text-sm font-medium text-text"
            title="Abrir o site da Cargo Ships Cleaning em uma nova aba"
          >
            <span aria-hidden>🌐</span>
            Acessar site
          </a>
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
