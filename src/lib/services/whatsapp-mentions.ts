import { prisma } from "@/lib/prisma";
import { isJidLikeName } from "@/lib/utils";

// Resolve as menções de uma conversa do WhatsApp ("@<número>" no texto) para
// nomes legíveis. Em grupos, o WhatsApp marca cada pessoa pelo número da
// parte-usuário do JID — que normalmente é um LID de privacidade (ex.:
// "142593534988406@lid"), não o telefone. Sozinho, o LID não diz quem é; aqui
// cruzamos com o histórico do grupo (que registra LID -> telefone) e com o
// cadastro de colaboradores pra mostrar o nome de quem foi mencionado/convocado.

// Só dígitos. "5513991814767@s.whatsapp.net" -> "5513991814767"; "abc@lid" -> "".
function onlyDigits(s: string | null | undefined): string {
  return (s || "").replace(/\D/g, "");
}

// "5513991814767" -> "(13) 99181-4767" (tira o 55 do país quando presente).
function formatBrPhone(digits: string): string {
  const local = digits.length >= 12 && digits.startsWith("55") ? digits.slice(2) : digits;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return digits;
}

// No texto, uma menção materializa como "@<número>", onde <número> é a parte
// usuário do JID mencionado — telefone (@s.whatsapp.net) ou LID (@lid). Quando a
// mensagem chega como `conversation`, o mentionedJid não vem junto, então
// casamos pelo próprio número que ficou no texto. Mínimo de 8 dígitos pra não
// confundir com anos/quantias soltas.
const MENTION_RE = /@(\d{8,})/g;

export function extractMentionNumbers(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) out.add(m[1]);
  return [...out];
}

// número (dígitos, como aparece depois do @) -> nome de exibição.
export type MentionMap = Record<string, string>;

// Resolve números mencionados (telefones ou LIDs) para nomes. Ordem por número:
//   1. vínculo manual LID -> telefone (whatsapp_lid_aliases);
//   2. telefone que casa direto com um colaborador (menção por telefone);
//   3. histórico do grupo: key.participant (LID) -> key.participantAlt/Pn
//      (telefone) + pushName, extraído via JSON no Postgres pra não puxar o
//      raw_event inteiro (campo pesado).
// Nome final preferido: colaborador cadastrado > pushName do WhatsApp > telefone.
export async function resolveMentionNames(
  numbers: string[],
  remoteJid: string | null,
): Promise<MentionMap> {
  const wanted = Array.from(new Set(numbers.map(onlyDigits).filter((d) => d.length >= 8)));
  if (wanted.length === 0) return {};

  // (1) colaboradores: telefone(dígitos) -> nome, com variantes com/sem 55.
  const emps = await prisma.employee.findMany({
    where: { phone: { not: null } },
    select: { name: true, phone: true },
  });
  const empByPhone = new Map<string, string>();
  for (const e of emps) {
    const d = onlyDigits(e.phone);
    if (!d) continue;
    if (!empByPhone.has(d)) empByPhone.set(d, e.name);
    const alt = d.startsWith("55") ? d.slice(2) : `55${d}`;
    if (!empByPhone.has(alt)) empByPhone.set(alt, e.name);
  }
  const empName = (digits: string | null | undefined): string | null => {
    const d = onlyDigits(digits);
    if (!d) return null;
    const alt = d.startsWith("55") ? d.slice(2) : `55${d}`;
    return empByPhone.get(d) || empByPhone.get(alt) || null;
  };

  // (2) histórico do grupo: LID -> { telefone, pushName }. Escopado ao grupo
  //     aberto (usa o índice remote_jid) e extraindo só 3 campos via JSON.
  //     participantAlt é onde esta versão do Evolution guarda o telefone do
  //     remetente quando o grupo usa LID; participantPn é o fallback histórico.
  const lidInfo = new Map<string, { phone: string | null; pushName: string | null }>();
  if (remoteJid && remoteJid.endsWith("@g.us")) {
    const rows = await prisma.$queryRaw<
      Array<{ participant: string | null; phone: string | null; push_name: string | null }>
    >`
      SELECT
        raw_event->'data'->'key'->>'participant' AS participant,
        COALESCE(
          raw_event->'data'->'key'->>'participantAlt',
          raw_event->'data'->'key'->>'participantPn'
        ) AS phone,
        push_name
      FROM whatsapp_messages
      WHERE remote_jid = ${remoteJid}
        AND from_me = false
        AND raw_event->'data'->'key'->>'participant' IS NOT NULL
      ORDER BY timestamp_ms DESC
      LIMIT 1500
    `;
    for (const row of rows) {
      const lid = onlyDigits(row.participant);
      if (!lid) continue;
      const cur = lidInfo.get(lid) ?? { phone: null, pushName: null };
      // Linhas vêm da mais recente pra mais antiga: guarda o 1º valor não-nulo.
      if (!cur.phone && row.phone) cur.phone = onlyDigits(row.phone);
      if (!cur.pushName && row.push_name && !isJidLikeName(row.push_name)) cur.pushName = row.push_name;
      lidInfo.set(lid, cur);
    }
  }

  // (3) vínculos manuais LID -> telefone (só os LIDs que precisamos).
  const aliasRows = await prisma.whatsappLidAlias.findMany({
    where: { lid: { in: wanted } },
    select: { lid: true, phone: true },
  });
  const aliasPhone = new Map<string, string>();
  for (const a of aliasRows) if (a.phone) aliasPhone.set(a.lid, onlyDigits(a.phone));

  // Resolve cada número.
  const out: MentionMap = {};
  for (const num of wanted) {
    // a) vínculo manual tem prioridade (alguém já identificou esse LID).
    const ap = aliasPhone.get(num);
    if (ap) { out[num] = empName(ap) || formatBrPhone(ap); continue; }
    // b) menção por telefone que casa direto com um colaborador.
    const direct = empName(num);
    if (direct) { out[num] = direct; continue; }
    // c) histórico do grupo (LID -> telefone/pushName).
    const info = lidInfo.get(num);
    if (info) {
      const name = empName(info.phone) || info.pushName || (info.phone ? formatBrPhone(info.phone) : null);
      if (name) { out[num] = name; continue; }
    }
    // não resolvido — fica de fora; a UI mantém o "@número" cru.
  }
  return out;
}
