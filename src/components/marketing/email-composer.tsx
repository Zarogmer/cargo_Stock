"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
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

// Assunto com o navio escolhido na Barra entre parênteses, quando houver.
function buildSubject(vesselName?: string): string {
  return vesselName ? `${DEFAULT_SUBJECT} (${vesselName})` : DEFAULT_SUBJECT;
}

function buildDefaultBody(clientName: string, vesselName?: string): string {
  const trimmed = clientName.trim();
  const greeting = trimmed ? `Prezados (${trimmed}),` : "Prezados,";
  // Quando há um navio escolhido na Barra (AIS), abrimos citando a embarcação —
  // deixa a prospecção específica daquele navio que está em Santos.
  const vesselLine = vesselName
    ? `\n\nIdentificamos a embarcação ${vesselName} em Santos e gostaríamos de oferecer nossos serviços de lavagem e limpeza de porão durante a estadia no porto.`
    : "";
  return `${greeting}${vesselLine}

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

// Navio vindo da Barra (cache do AIS Stream, via /api/external-ships) — mesma
// fonte do botão "Selecionar da Barra" da tela de Navios.
interface BarraShip {
  id: string;
  name: string;
  mmsi: string | null;
  imo: string | null;
  status: string | null;
  updatedAt: string;
}

const VESSEL_STATUS_LABELS: Record<string, string> = {
  underway: "Em movimento",
  underway_sailing: "Em movimento",
  anchored: "Ancorado",
  moored: "Atracado",
  fishing: "Pesqueiro",
  not_under_command: "Sem comando",
  restricted_maneuverability: "Manobra restrita",
  constrained_by_draught: "Calado restrito",
  aground: "Encalhado",
  undefined: "Indefinido",
};

function vesselStatusLabel(s: string | null): string {
  if (!s) return "—";
  return VESSEL_STATUS_LABELS[s] ?? s;
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

  // ── Navio da Barra (AIS) ──────────────────────────────────────────────────
  // Navio escolhido em "Selecionar da Barra". Personaliza assunto/corpo com a
  // embarcação. `templateVessel` é o navio usado no corpo-modelo atual (mesmo
  // papel do templateName) pra saber se ainda podemos reescrever sem apagar edição.
  const [selectedVessel, setSelectedVessel] = useState<BarraShip | null>(null);
  const [templateVessel, setTemplateVessel] = useState("");
  const [showBarra, setShowBarra] = useState(false);
  const [vessels, setVessels] = useState<BarraShip[]>([]);
  const [vesselLoading, setVesselLoading] = useState(false);
  const [vesselSyncing, setVesselSyncing] = useState(false);
  const [vesselError, setVesselError] = useState<string | null>(null);
  const [vesselSyncMsg, setVesselSyncMsg] = useState<string | null>(null);
  const [vesselSearch, setVesselSearch] = useState("");
  const [pickInModal, setPickInModal] = useState<BarraShip | null>(null);

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

  // Navios da Barra: lê o cache do AIS (mesma fonte do botão em Navios).
  const loadVessels = useCallback(async () => {
    setVesselLoading(true);
    setVesselError(null);
    try {
      const res = await fetch("/api/external-ships", { cache: "no-store" });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `Erro ${res.status}`);
      }
      const b = await res.json();
      setVessels(b.ships || []);
    } catch (e: any) {
      setVesselError(e.message || "Erro ao carregar navios.");
    } finally {
      setVesselLoading(false);
    }
  }, []);

  // Sugestões filtradas pelo texto do campo Nome (casa nome, empresa ou email).
  const matches = useMemo(() => {
    const q = clientName.trim().toLowerCase();
    const list = q
      ? clients.filter((c) => [c.name, c.company, c.email].some((v) => (v || "").toLowerCase().includes(q)))
      : clients;
    return list.slice(0, 8);
  }, [clients, clientName]);

  // Filtro do modal da Barra (nome, MMSI ou IMO).
  const filteredVessels = useMemo(() => {
    const q = vesselSearch.trim().toLowerCase();
    if (!q) return vessels;
    return vessels.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.mmsi || "").includes(q) ||
        (s.imo || "").includes(q),
    );
  }, [vessels, vesselSearch]);

  // Escolher um cliente: joga os emails cadastrados no campo "Para" e fixa o nome.
  // Se o corpo ainda for o modelo padrão (não editado), atualiza a saudação.
  function selectClient(c: ClientOption) {
    const display = c.company || c.name;
    setTo(cleanEmails(c.email || ""));
    // Só reescreve a saudação se o corpo ainda for o modelo padrão (não editado).
    if (body === buildDefaultBody(templateName, templateVessel)) {
      setBody(buildDefaultBody(display, templateVessel));
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
    setSubject(buildSubject(selectedVessel?.name));
    setBody(buildDefaultBody(clientName, selectedVessel?.name));
    setTemplateName(clientName);
    setTemplateVessel(selectedVessel?.name || "");
  }

  function openBarra() {
    setShowBarra(true);
    setVesselSearch("");
    setPickInModal(null);
    setVesselError(null);
    setVesselSyncMsg(null);
    loadVessels();
  }

  // "Atualizar": captura navios ao vivo do AIS Stream (mesma rota do Navios).
  async function syncVessels() {
    setVesselSyncing(true);
    setVesselSyncMsg(null);
    setVesselError(null);
    try {
      const res = await fetch("/api/external-ships/sync", { method: "POST" });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error || `Erro ${res.status}`);
      setVesselSyncMsg(`${b.upserted} navio(s) atualizado(s).`);
      await loadVessels();
    } catch (e: any) {
      setVesselError(e.message || "Erro ao sincronizar.");
    } finally {
      setVesselSyncing(false);
    }
  }

  // Confirma o navio escolhido: bota o nome no assunto e abre o corpo citando a
  // embarcação — mas só reescreve assunto/corpo se ainda estiverem no modelo
  // (não sobrescreve o que o usuário editou à mão).
  function confirmVessel() {
    const v = pickInModal;
    if (!v) return;
    if (body === buildDefaultBody(templateName, templateVessel)) {
      setBody(buildDefaultBody(templateName, v.name));
    }
    const subjectIsTemplate =
      subject === DEFAULT_SUBJECT || subject === buildSubject(templateVessel);
    if (subjectIsTemplate) setSubject(buildSubject(v.name));
    setTemplateVessel(v.name);
    setSelectedVessel(v);
    setCopied(false);
    setShowBarra(false);
  }

  function clearVessel() {
    if (body === buildDefaultBody(templateName, templateVessel)) {
      setBody(buildDefaultBody(templateName));
    }
    const subjectIsTemplate =
      subject === DEFAULT_SUBJECT || subject === buildSubject(templateVessel);
    if (subjectIsTemplate) setSubject(DEFAULT_SUBJECT);
    setTemplateVessel("");
    setSelectedVessel(null);
    setCopied(false);
  }

  const inputClass =
    "w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm bg-card";

  return (
    <div className="space-y-6 max-w-3xl">
      <p className="text-text-light text-sm">
        Convide clientes a conhecer a Cargo Ships Cleaning e o site cargoshipscleaning.com.
      </p>

      {/* Selecionar da Barra: traz um navio que está em Santos (AIS) e deixa o
          email específico daquele navio. O email/contato continua vindo do
          cliente cadastrado (aba Clientes) — o AIS não fornece email. */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={openBarra}
          className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg hover:bg-gray-50 transition text-sm font-medium text-text"
          title="Escolher um navio que está na barra de Santos (AIS) e personalizar o email"
        >
          <span aria-hidden>📡</span>
          Selecionar da Barra
        </button>
        {selectedVessel && (
          <span className="inline-flex items-center gap-1.5 text-xs bg-primary/10 text-primary border border-primary/20 rounded-full pl-3 pr-1.5 py-1">
            <span aria-hidden>🚢</span>
            <span className="font-medium">{selectedVessel.name}</span>
            {selectedVessel.status && (
              <span className="opacity-70">· {vesselStatusLabel(selectedVessel.status)}</span>
            )}
            <button
              type="button"
              onClick={clearVessel}
              title="Remover navio"
              className="ml-0.5 w-5 h-5 grid place-items-center rounded-full hover:bg-primary/20"
            >
              ✕
            </button>
          </span>
        )}
      </div>

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

      {/* Modal "Selecionar da Barra" — navios ao vivo do AIS (Porto de Santos),
          mesma fonte/rotas do botão da tela de Navios. */}
      {showBarra && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="p-5 border-b border-border flex items-center justify-between gap-3">
              <div>
                <h2 className="font-bold text-lg text-text">Selecionar da Barra</h2>
                <p className="text-xs text-text-light mt-0.5">
                  Navios próximos ao Porto de Santos (AIS Stream). Escolher um deixa o email específico daquele navio.
                </p>
              </div>
              <button
                onClick={() => setShowBarra(false)}
                className="p-1.5 hover:bg-gray-100 rounded-lg transition text-text-light"
              >
                ✕
              </button>
            </div>

            {/* Toolbar */}
            <div className="p-5 pb-3 space-y-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Buscar por nome, MMSI ou IMO..."
                  value={vesselSearch}
                  onChange={(e) => setVesselSearch(e.target.value)}
                  className="flex-1 px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 bg-card"
                />
                <button
                  onClick={syncVessels}
                  disabled={vesselSyncing}
                  className="px-3 py-2 text-sm bg-card border border-border text-text rounded-lg hover:bg-gray-50 transition disabled:opacity-50 whitespace-nowrap"
                  title="Capturar navios ao vivo do AIS Stream"
                >
                  {vesselSyncing ? "Atualizando..." : "🔄 Atualizar"}
                </button>
              </div>
              {vesselSyncMsg && (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  {vesselSyncMsg}
                </p>
              )}
              {vesselError && (
                <p className="text-xs text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {vesselError}
                </p>
              )}
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto px-5">
              {vesselLoading ? (
                <div className="py-12 text-center text-text-light text-sm">Carregando...</div>
              ) : filteredVessels.length === 0 ? (
                <div className="py-12 text-center">
                  <p className="text-3xl mb-2">📡</p>
                  <p className="text-sm text-text-light">
                    {vessels.length === 0
                      ? "Nenhum navio em cache. Clique em Atualizar."
                      : "Nenhum navio corresponde à busca."}
                  </p>
                </div>
              ) : (
                <ul className="space-y-2 pb-2">
                  {filteredVessels.map((s) => {
                    const isSel = pickInModal?.id === s.id;
                    return (
                      <li key={s.id}>
                        <button
                          onClick={() => setPickInModal(s)}
                          className={`w-full text-left p-3 rounded-xl border transition ${
                            isSel ? "border-primary bg-primary/5" : "border-border hover:bg-gray-50"
                          }`}
                        >
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold text-text truncate">{s.name}</h3>
                            {s.status && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-blue-100 text-blue-700">
                                {vesselStatusLabel(s.status)}
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-3 mt-1 text-[11px] text-text-light">
                            {s.mmsi && <span>MMSI: <span className="font-mono">{s.mmsi}</span></span>}
                            {s.imo && <span>IMO: <span className="font-mono">{s.imo}</span></span>}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Footer */}
            <div className="p-5 border-t border-border flex justify-end gap-3">
              <button
                onClick={() => setShowBarra(false)}
                className="px-4 py-2 text-sm text-text-light hover:text-text hover:bg-gray-100 rounded-lg transition"
              >
                Cancelar
              </button>
              <button
                onClick={confirmVessel}
                disabled={!pickInModal}
                className="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-dark transition disabled:opacity-50"
              >
                Usar este navio
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
