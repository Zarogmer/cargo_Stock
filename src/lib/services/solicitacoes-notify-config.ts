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

// Um "destino" de aviso: um grupo do WhatsApp (opcional) e/ou um conjunto de
// funções (os colaboradores cuja função bate recebem DM). Nomes de função são
// guardados como vêm de job_functions; o casamento com Employee.role é
// case-insensitive (ver normalizeFunctionName).
export interface NotifyTarget {
  groupJid: string | null;
  groupLabel: string | null;
  functions: string[];
}

export interface NotifyConfig {
  // Disparado quando uma nova solicitação é criada (/api/solicitacoes/notify).
  novaSolicitacao: NotifyTarget;
  // Disparado quando uma compra é concluída/aprovada (/api/solicitacoes/notify-compras).
  compraConcluida: NotifyTarget;
}

// Defaults = comportamento legado. Nova solicitação avisa os SUPERVISOR por DM;
// compra concluída cai no resolvedor por nome ("Compras") quando groupJid é null.
export function defaultNotifyConfig(): NotifyConfig {
  return {
    novaSolicitacao: { groupJid: null, groupLabel: null, functions: ["SUPERVISOR"] },
    compraConcluida: { groupJid: null, groupLabel: null, functions: [] },
  };
}

// Normaliza um nome de função pra comparar com Employee.role (trim + maiúsculas).
export function normalizeFunctionName(name: string): string {
  return (name || "").trim().toUpperCase();
}

function sanitizeTarget(raw: unknown, fallback: NotifyTarget): NotifyTarget {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const r = raw as Record<string, unknown>;

  // Grupo: só aceita JID de grupo (...@g.us); qualquer outra coisa vira null.
  let groupJid: string | null = null;
  if (typeof r.groupJid === "string" && r.groupJid.trim().endsWith("@g.us")) {
    groupJid = r.groupJid.trim();
  }
  const groupLabel =
    groupJid && typeof r.groupLabel === "string" && r.groupLabel.trim()
      ? r.groupLabel.trim()
      : null;

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

  return { groupJid, groupLabel, functions };
}

// Valida/normaliza um payload arbitrário no formato NotifyConfig, caindo nos
// defaults pro que estiver faltando ou inválido. Usado tanto na leitura
// (parse do banco) quanto no PUT (sanitiza o que o front mandou).
export function sanitizeNotifyConfig(raw: unknown): NotifyConfig {
  const def = defaultNotifyConfig();
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    novaSolicitacao: sanitizeTarget(r.novaSolicitacao, def.novaSolicitacao),
    compraConcluida: sanitizeTarget(r.compraConcluida, def.compraConcluida),
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
