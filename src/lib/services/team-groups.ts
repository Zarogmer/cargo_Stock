// Resolve os JIDs dos grupos fixos "Equipe 1" e "Equipe 2" no WhatsApp.
// EMBARQUE manda as mensagens da operação pra esses 2 grupos (em vez de
// criar um grupo novo por navio). Costado continua criando grupo do navio.
//
// Estratégia de resolução:
//   1. Env vars (`WHATSAPP_EQUIPE_1_JID` / `WHATSAPP_EQUIPE_2_JID`) — override
//      explícito, útil pra ambientes onde o nome do grupo no WhatsApp é
//      diferente de "Equipe 1"/"Equipe 2".
//   2. Lookup no banco — busca stubs de grupo (systemNotice) com push_name
//      igual a "Equipe 1"/"Equipe 2". Stubs são gerados em /groups (criação)
//      e /groups/sync (sincronização), então qualquer grupo já visto pelo
//      app é encontrado aqui.
//
// Resolve "preguiçoso" — só chama o DB se o env var não tiver o JID. Cache
// em memória pra não bater no DB toda vez.

import { prisma } from "@/lib/prisma";

export type TeamKey = "EQUIPE_1" | "EQUIPE_2";

const TEAM_SUBJECTS: Record<TeamKey, string> = {
  EQUIPE_1: "Equipe 1",
  EQUIPE_2: "Equipe 2",
};

const TEAM_ENV_VARS: Record<TeamKey, string> = {
  EQUIPE_1: "WHATSAPP_EQUIPE_1_JID",
  EQUIPE_2: "WHATSAPP_EQUIPE_2_JID",
};

// Cache em memória — JID de grupo não muda no WhatsApp (mesmo trocando o
// nome, o JID continua o mesmo). Process restart limpa.
const cache = new Map<TeamKey, string>();

function readEnvJid(team: TeamKey): string | null {
  const raw = process.env[TEAM_ENV_VARS[team]];
  if (!raw) return null;
  const v = raw.trim();
  if (!v.endsWith("@g.us")) return null;
  return v;
}

async function lookupJid(team: TeamKey): Promise<string | null> {
  const subject = TEAM_SUBJECTS[team];
  const row = await prisma.whatsappMessage.findFirst({
    where: {
      from_me: true,
      message_type: "systemNotice",
      push_name: subject,
      remote_jid: { endsWith: "@g.us" },
    },
    orderBy: { timestamp_ms: "desc" },
    select: { remote_jid: true },
  });
  return row?.remote_jid || null;
}

export async function getTeamGroupJid(team: TeamKey): Promise<string | null> {
  const cached = cache.get(team);
  if (cached) return cached;
  const fromEnv = readEnvJid(team);
  if (fromEnv) {
    cache.set(team, fromEnv);
    return fromEnv;
  }
  const fromDb = await lookupJid(team);
  if (fromDb) {
    cache.set(team, fromDb);
    return fromDb;
  }
  return null;
}

// Devolve os 2 JIDs em paralelo. `null` em qualquer chave significa que o
// grupo ainda não foi encontrado — caller decide se aborta ou tolera.
export async function getTeamGroupJids(): Promise<Record<TeamKey, string | null>> {
  const [e1, e2] = await Promise.all([
    getTeamGroupJid("EQUIPE_1"),
    getTeamGroupJid("EQUIPE_2"),
  ]);
  return { EQUIPE_1: e1, EQUIPE_2: e2 };
}

// Permite forçar refresh do cache (ex.: usuário acabou de criar/renomear o
// grupo no WhatsApp e quer que o próximo lookup pegue o novo JID).
export function clearTeamGroupCache(team?: TeamKey) {
  if (team) cache.delete(team);
  else cache.clear();
}
