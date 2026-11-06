// Configuração dos avisos automáticos disparados pelas telas de Solicitações e
// Controle de Compras. Antes os destinos eram fixos no código:
//   • Nova solicitação  → DM pra todo colaborador com função "SUPERVISOR".
//   • Compra concluída   → grupo "Compras" (resolvido por nome em compras-group.ts).
//
// Agora moram numa única linha de app_settings (chave abaixo, valor = JSON), pra
// o usuário escolher grupo + funções de destino pela aba Mensagens. Os defaults
// preservam EXATAMENTE o comportamento antigo quando a config ainda não existe.

import { prisma } from "@/lib/prisma";
import { MAX_TEMPLATE_LENGTH } from "@/lib/notify-message-templates";

export const NOTIFY_CONFIG_KEY = "solicitacoes_notify_config";

// Um grupo do WhatsApp que recebe o aviso (jid + nome pra exibir/histórico).
export interface NotifyGroup {
  jid: string;
  label: string | null;
}

// Um "destino" de aviso: zero+ grupos do WhatsApp e/ou um conjunto de funções
// (os colaboradores cuja função bate recebem DM). Nomes de função são guardados
// como vêm de job_functions; o casamento com Employee.role é case-insensitive
// (ver normalizeFunctionName).
export interface NotifyTarget {
  groups: NotifyGroup[];
  functions: string[];
}

// Destino dos avisos de Checklist: liga/desliga próprio, o GRUPO como
// destino principal e uma caixinha opcional que também manda por DM pro
// pessoal ATIVO do setor ADMINISTRATIVO (não se escolhe função aqui).
export interface RetornoNotifyTarget extends NotifyTarget {
  enabled: boolean;
  // true = além do grupo, manda DM pra cada um do setor Administrativo.
  dmAdmin: boolean;
  // Texto da mensagem editado em Mensagens; null = padrão do código
  // (ver src/lib/notify-message-templates.ts).
  template: string | null;
}

// Uma pessoa que recebe o aviso por DM (WhatsApp direto). employeeId aponta
// pro colaborador quando foi escolhida da lista; null = número digitado à mão.
export interface NotifyPerson {
  employeeId: number | null;
  name: string;
  phone: string;
}

// Destino do aviso "Compras registradas": além do grupo/Administrativo, uma
// lista de PESSOAS que recebem a versão COM valores e total por DM (a Rose do
// Executivo, por ex.). Os grupos recebem o groupTemplate (sem valores).
export interface CompraNotifyTarget extends RetornoNotifyTarget {
  people: NotifyPerson[];
  // Texto que vai pros GRUPOS (sem valores); null = padrão do código.
  groupTemplate: string | null;
  // Foto da nota (Escanear): as pessoas sempre recebem; os grupos só com esta
  // caixinha ligada — a foto mostra os valores que o texto do grupo esconde.
  photoToGroups: boolean;
}

export interface NotifyConfig {
  // Disparado quando uma nova solicitação é criada (/api/solicitacoes/notify).
  novaSolicitacao: NotifyTarget;
  // Disparado quando uma compra é concluída/aprovada (/api/solicitacoes/notify-compras).
  compraConcluida: NotifyTarget;
  // Disparado pelo "Enviar quebrados pro WhatsApp" do Checklist
  // (/api/retorno/notify).
  retornoMaterial: RetornoNotifyTarget;
  // Disparado pelo "Enviar lista pro WhatsApp" da aba Embarque
  // (/api/embarque/notify) — posta a lista de materiais + rancho no grupo.
  embarqueLista: RetornoNotifyTarget;
  // Disparado ao salvar compra(s) no Controle de Compras (Nova Compra,
  // Escanear, Importar PDF) — /api/compras/notify posta a lista SEM valores
  // nos grupos e manda a versão COM valores por DM pras pessoas marcadas.
  compraRegistrada: CompraNotifyTarget;
}

// Defaults = comportamento legado. Nova solicitação avisa os SUPERVISOR por DM;
// compra concluída cai no resolvedor por nome ("Compras") quando groupJid é null.
export function defaultNotifyConfig(): NotifyConfig {
  return {
    novaSolicitacao: { groups: [], functions: ["SUPERVISOR"] },
    compraConcluida: { groups: [], functions: [] },
    retornoMaterial: { groups: [], functions: [], enabled: true, dmAdmin: false, template: null },
    embarqueLista: { groups: [], functions: [], enabled: true, dmAdmin: false, template: null },
    compraRegistrada: { groups: [], functions: [], enabled: true, dmAdmin: false, template: null, people: [], groupTemplate: null, photoToGroups: false },
  };
}

// Normaliza um nome de função pra comparar com Employee.role (trim + maiúsculas).
export function normalizeFunctionName(name: string): string {
  return (name || "").trim().toUpperCase();
}

// Grupos: aceita o formato novo (array `groups` de {jid,label}) e migra o antigo
// (`groupJid`/`groupLabel`, um grupo só) pra não perder config já salva. Só JIDs
// de grupo (...@g.us), sem duplicar.
function sanitizeGroups(r: Record<string, unknown>): NotifyGroup[] {
  const out: NotifyGroup[] = [];
  const seen = new Set<string>();
  const push = (jidRaw: unknown, labelRaw: unknown) => {
    if (typeof jidRaw !== "string") return;
    const jid = jidRaw.trim();
    if (!jid.endsWith("@g.us") || seen.has(jid)) return;
    seen.add(jid);
    const label = typeof labelRaw === "string" && labelRaw.trim() ? labelRaw.trim() : null;
    out.push({ jid, label });
  };
  if (Array.isArray(r.groups)) {
    for (const g of r.groups) {
      if (g && typeof g === "object") {
        const o = g as Record<string, unknown>;
        push(o.jid, o.label);
      }
    }
  }
  if (out.length === 0) push(r.groupJid, r.groupLabel); // legado: 1 grupo
  return out;
}

function sanitizeTarget(raw: unknown, fallback: NotifyTarget): NotifyTarget {
  if (!raw || typeof raw !== "object") {
    return { groups: [...fallback.groups], functions: [...fallback.functions] };
  }
  const r = raw as Record<string, unknown>;

  const groups = sanitizeGroups(r);

  // Funções: lista de strings não-vazias, sem duplicar (por nome normalizado),
  // preservando o texto original pra exibição.
  const functions: string[] = [];
  if (Array.isArray(r.functions)) {
    const seen = new Set<string>();
    for (const f of r.functions) {
      if (typeof f !== "string") continue;
      const trimmed = f.trim();
      if (!trimmed) continue;
      const norm = normalizeFunctionName(trimmed);
      if (seen.has(norm)) continue;
      seen.add(norm);
      functions.push(trimmed);
    }
  }

  return { groups, functions };
}

// Pessoas (DM com valores): nome + telefone com pelo menos 10 dígitos, sem
// repetir número. employeeId só quando for inteiro positivo.
function sanitizePeople(raw: unknown): NotifyPerson[] {
  const out: NotifyPerson[] = [];
  const seen = new Set<string>();
  const list = raw && typeof raw === "object" ? (raw as Record<string, unknown>).people : null;
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const phone = typeof o.phone === "string" ? o.phone.trim() : "";
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10 || seen.has(digits)) continue;
    seen.add(digits);
    const name = typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 80) : phone;
    const employeeId = typeof o.employeeId === "number" && Number.isInteger(o.employeeId) && o.employeeId > 0
      ? o.employeeId
      : null;
    out.push({ employeeId, name, phone });
  }
  return out;
}

// Valida/normaliza um payload arbitrário no formato NotifyConfig, caindo nos
// defaults pro que estiver faltando ou inválido. Usado tanto na leitura
// (parse do banco) quanto no PUT (sanitiza o que o front mandou).
export function sanitizeNotifyConfig(raw: unknown): NotifyConfig {
  const def = defaultNotifyConfig();
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // enabled: só o false explícito desliga — ausente/inválido fica ligado.
  const enabledOf = (raw: unknown) =>
    !(raw && typeof raw === "object" && (raw as Record<string, unknown>).enabled === false);
  // dmAdmin: só o true explícito liga a DM pro Administrativo (o destino
  // principal é o grupo; a DM é a caixinha opcional).
  const dmAdminOf = (raw: unknown) =>
    !!(raw && typeof raw === "object" && (raw as Record<string, unknown>).dmAdmin === true);
  // template: texto não-vazio (cortado no limite); vazio/ausente = padrão.
  const templateOf = (raw: unknown, field = "template") => {
    const t = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[field] : null;
    if (typeof t !== "string" || !t.trim()) return null;
    return t.replace(/\r\n?/g, "\n").slice(0, MAX_TEMPLATE_LENGTH);
  };
  return {
    novaSolicitacao: sanitizeTarget(r.novaSolicitacao, def.novaSolicitacao),
    compraConcluida: sanitizeTarget(r.compraConcluida, def.compraConcluida),
    retornoMaterial: {
      ...sanitizeTarget(r.retornoMaterial, def.retornoMaterial),
      enabled: enabledOf(r.retornoMaterial),
      dmAdmin: dmAdminOf(r.retornoMaterial),
      template: templateOf(r.retornoMaterial),
    },
    embarqueLista: {
      ...sanitizeTarget(r.embarqueLista, def.embarqueLista),
      enabled: enabledOf(r.embarqueLista),
      dmAdmin: dmAdminOf(r.embarqueLista),
      template: templateOf(r.embarqueLista),
    },
    compraRegistrada: {
      ...sanitizeTarget(r.compraRegistrada, def.compraRegistrada),
      enabled: enabledOf(r.compraRegistrada),
      dmAdmin: dmAdminOf(r.compraRegistrada),
      template: templateOf(r.compraRegistrada),
      people: sanitizePeople(r.compraRegistrada),
      groupTemplate: templateOf(r.compraRegistrada, "groupTemplate"),
      // Só o true explícito manda a foto da nota nos grupos.
      photoToGroups: !!(r.compraRegistrada && typeof r.compraRegistrada === "object"
        && (r.compraRegistrada as Record<string, unknown>).photoToGroups === true),
    },
  };
}

// Lê a config do banco (app_settings). Nunca lança: em ausência ou JSON inválido
// devolve os defaults (comportamento legado).
export async function readNotifyConfig(): Promise<NotifyConfig> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: NOTIFY_CONFIG_KEY } });
    if (!row?.value) return defaultNotifyConfig();
    return sanitizeNotifyConfig(JSON.parse(row.value));
  } catch {
    return defaultNotifyConfig();
  }
}
