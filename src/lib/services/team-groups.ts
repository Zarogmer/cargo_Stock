// Resolve os JIDs dos grupos fixos "Equipe 1", "Equipe 2" e "Equipe Turbo" no
// WhatsApp. EMBARQUE manda as mensagens da operação pra esses grupos (em vez
// de criar um grupo novo por navio). Costado continua criando grupo do navio.
//
// Estratégia de resolução:
//   1. Env vars (`WHATSAPP_EQUIPE_1_JID` / `WHATSAPP_EQUIPE_2_JID` /
//      `WHATSAPP_EQUIPE_4_JID`) — override explícito, útil pra ambientes onde
//      o nome do grupo no WhatsApp é diferente.
//   2. Lookup no banco — busca stubs de grupo (systemNotice) cujo push_name
//      comece com "Equipe 1"/"Equipe1" (ou 2, ou "Equipe Turbo"), de forma
//      flexível: aceita espaço opcional, case insensitive, e sufixos
//      arbitrários (ex.: "Equipe1 / teste", "Equipe 1 - principal"). Stubs são
//      gerados em /groups (criação) e /groups/sync (sincronização), então
//      qualquer grupo já visto pelo app é encontrado aqui.
//
// Resolve "preguiçoso" — só chama o DB se o env var não tiver o JID. Cache
// em memória pra não bater no DB toda vez.

import { prisma } from "@/lib/prisma";

// EQUIPE_4 = "Equipe Turbo" (mesma chave do Rancho; EQUIPE_3 é a aba "Total"
// da comida, não uma equipe real — nunca entra aqui).
export type TeamKey = "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_4";

const TEAM_ENV_VARS: Record<TeamKey, string> = {
  EQUIPE_1: "WHATSAPP_EQUIPE_1_JID",
  EQUIPE_2: "WHATSAPP_EQUIPE_2_JID",
  EQUIPE_4: "WHATSAPP_EQUIPE_4_JID",
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

// Regex pra reconhecer o nome do grupo da equipe. Aceita variações:
//   "Equipe 1", "Equipe1", "equipe 1 / teste", "EQUIPE1 - principal",
//   "Equipe Turbo", "EquipeTurbo - oficial"
// O (?!\d) evita falso positivo em "Equipe 10" virando EQUIPE_1.
function teamSubjectRegex(team: TeamKey): RegExp {
  if (team === "EQUIPE_4") return /^\s*equipe\s*turbo/i;
  const num = team === "EQUIPE_1" ? "1" : "2";
  return new RegExp(`^\\s*equipe\\s*${num}(?!\\d)`, "i");
}

async function lookupJid(team: TeamKey): Promise<string | null> {
  const re = teamSubjectRegex(team);
  // Pré-filtra no banco pelos stubs que começam com "Equipe" (qualquer caixa);
  // o regex em JS faz o match exato com a fronteira de dígito. Pega o mais
  // recente — se houver mais de um grupo com o nome, o último sincronizado
  // ganha (provavelmente é o que o usuário acabou de criar/renomear).
  const candidates = await prisma.whatsappMessage.findMany({
    where: {
      from_me: true,
      message_type: "systemNotice",
      remote_jid: { endsWith: "@g.us" },
      push_name: { startsWith: "Equipe", mode: "insensitive" },
    },
    orderBy: { timestamp_ms: "desc" },
    select: { remote_jid: true, push_name: true },
  });
  for (const c of candidates) {
    if (c.push_name && re.test(c.push_name)) return c.remote_jid;
  }
  return null;
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

// Devolve os JIDs das equipes em paralelo. `null` em qualquer chave significa
// que o grupo ainda não foi encontrado — caller decide se aborta ou tolera.
export async function getTeamGroupJids(): Promise<Record<TeamKey, string | null>> {
  const [e1, e2, e4] = await Promise.all([
    getTeamGroupJid("EQUIPE_1"),
    getTeamGroupJid("EQUIPE_2"),
    getTeamGroupJid("EQUIPE_4"),
  ]);
  return { EQUIPE_1: e1, EQUIPE_2: e2, EQUIPE_4: e4 };
}

// Permite forçar refresh do cache (ex.: usuário acabou de criar/renomear o
// grupo no WhatsApp e quer que o próximo lookup pegue o novo JID).
export function clearTeamGroupCache(team?: TeamKey) {
  if (team) cache.delete(team);
  else cache.clear();
}
