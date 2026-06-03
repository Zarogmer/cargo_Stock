// Resolve o JID do grupo "Compras" no WhatsApp — alvo do aviso automático
// disparado quando uma solicitação de compra é concluída (aprovada).
//
// IMPORTANTE — match EXATO de propósito:
//   Existe um grupo OFICIAL "Compras Cargo Ships" que NÃO deve receber esses
//   avisos ainda (estamos testando no grupo "Compras"). Por isso este resolver
//   casa o nome de forma EXATA (case-insensitive), diferente do resolver de
//   equipes (team-groups.ts), que usa startsWith. Exato garante que "Compras"
//   nunca colida com "Compras Cargo Ships".
//
// Estratégia de resolução (igual ao team-groups, "preguiçosa" + cache):
//   1. Env `WHATSAPP_COMPRAS_JID`  — JID direto (ex.: "12036...@g.us"). Override
//      explícito; pula o lookup por nome.
//   2. Env `WHATSAPP_COMPRAS_NOME` — troca o nome-alvo (default "Compras"). Pra
//      ir ao ar no grupo oficial depois, basta setar "Compras Cargo Ships".
//   3. Lookup no banco — stubs de grupo (systemNotice, from_me) cujo push_name
//      seja EXATAMENTE o nome-alvo. Esses stubs são criados/atualizados em
//      /api/whatsapp/groups (criação) e /groups/sync (sincronização).

import { prisma } from "@/lib/prisma";

const DEFAULT_COMPRAS_GROUP_NAME = "Compras";

// Cache em memória — o JID de um grupo não muda no WhatsApp (mesmo renomeando).
// Restart do processo limpa. clearComprasGroupCache() força refresh.
let cached: string | null = null;

function readEnvJid(): string | null {
  const raw = process.env.WHATSAPP_COMPRAS_JID;
  if (!raw) return null;
  const v = raw.trim();
  if (!v.endsWith("@g.us")) return null;
  return v;
}

export function comprasGroupName(): string {
  return (process.env.WHATSAPP_COMPRAS_NOME || DEFAULT_COMPRAS_GROUP_NAME).trim();
}

async function lookupJid(): Promise<string | null> {
  const want = comprasGroupName();
  const wantNorm = want.toLowerCase();
  // Pré-filtra no banco pelo nome exato (case-insensitive). O re-check em JS
  // (trim + lowercase) é defesa-em-profundidade pra nunca devolver, p.ex.,
  // "Compras Cargo Ships" por engano.
  const candidates = await prisma.whatsappMessage.findMany({
    where: {
      from_me: true,
      message_type: "systemNotice",
      remote_jid: { endsWith: "@g.us" },
      push_name: { equals: want, mode: "insensitive" },
    },
    orderBy: { timestamp_ms: "desc" },
    select: { remote_jid: true, push_name: true },
  });
  for (const c of candidates) {
    if ((c.push_name || "").trim().toLowerCase() === wantNorm) return c.remote_jid;
  }
  return null;
}

// JID do grupo de Compras, ou null se ainda não foi visto pelo app (nesse caso
// o caller deve tolerar e, idealmente, sugerir rodar "Sincronizar grupos").
export async function getComprasGroupJid(): Promise<string | null> {
  if (cached) return cached;
  const fromEnv = readEnvJid();
  if (fromEnv) { cached = fromEnv; return fromEnv; }
  const fromDb = await lookupJid();
  if (fromDb) { cached = fromDb; return fromDb; }
  return null;
}

export function clearComprasGroupCache() {
  cached = null;
}
