// Configuração dos avisos automáticos disparados pelas telas de Solicitações e
// Controle de Compras. Antes os destinos eram fixos no código:
//   • Nova solicitação  → DM pra todo colaborador com função "SUPERVISOR".
//   • Compra concluída   → grupo "Compras" (resolvido por nome em compras-group.ts).
//
// Agora moram numa única linha de app_settings (chave abaixo, valor = JSON), pra
// o usuário escolher grupo + funções de destino pela aba Mensagens. Os defaults
// preservam EXATAMENTE o comportamento antigo quando a config ainda não existe.

import { prisma } from "@/lib/prisma";

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

// Destino do aviso de Retorno de material: tem um liga/desliga próprio e um
// grupo opcional (útil pra testes). Quando ligado, o aviso vai SEMPRE por DM
// pro pessoal do setor ADMINISTRATIVO — não se escolhe função aqui.
export interface RetornoNotifyTarget extends NotifyTarget {
  enabled: boolean;
}

export interface NotifyConfig {
  // Disparado quando uma nova solicitação é criada (/api/solicitacoes/notify).
  novaSolicitacao: NotifyTarget;
  // Disparado quando uma compra é concluída/aprovada (/api/solicitacoes/notify-compras).
  compraConcluida: NotifyTarget;
  // Disparado pelo "Enviar quebrados pro WhatsApp" do Embarque/Retorno
  // (/api/retorno/notify).
  retornoMaterial: RetornoNotifyTarget;
  // Disparado pelo "Enviar lista pro WhatsApp" da aba Embarque
  // (/api/embarque/notify) — posta a lista de materiais + rancho no grupo.
  embarqueLista: RetornoNotifyTarget;
}

// Defaults = comportamento legado. Nova solicitação avisa os SUPERVISOR por DM;
// compra concluída cai no resolvedor por nome ("Compras") quando groupJid é null.
export function defaultNotifyConfig(): NotifyConfig {
  return {
    novaSolicitacao: { groups: [], functions: ["SUPERVISOR"] },
    compraConcluida: { groups: [], functions: [] },
    retornoMaterial: { groups: [], functions: [], enabled: true },
    embarqueLista: { groups: [], functions: [], enabled: true },
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

// Valida/normaliza um payload arbitrário no formato NotifyConfig, caindo nos
// defaults pro que estiver faltando ou inválido. Usado tanto na leitura
// (parse do banco) quanto no PUT (sanitiza o que o front mandou).
export function sanitizeNotifyConfig(raw: unknown): NotifyConfig {
  const def = defaultNotifyConfig();
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // enabled: só o false explícito desliga — ausente/inválido fica ligado.
  const enabledOf = (raw: unknown) =>
    !(raw && typeof raw === "object" && (raw as Record<string, unknown>).enabled === false);
  return {
    novaSolicitacao: sanitizeTarget(r.novaSolicitacao, def.novaSolicitacao),
    compraConcluida: sanitizeTarget(r.compraConcluida, def.compraConcluida),
    retornoMaterial: {
      ...sanitizeTarget(r.retornoMaterial, def.retornoMaterial),
      enabled: enabledOf(r.retornoMaterial),
    },
    embarqueLista: {
      ...sanitizeTarget(r.embarqueLista, def.embarqueLista),
      enabled: enabledOf(r.embarqueLista),
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
