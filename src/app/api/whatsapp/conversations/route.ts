import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeBRNumber } from "@/lib/services/evolution-api";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO", "COMERCIAL", "FINANCEIRO"];

// GET /api/whatsapp/conversations
// Returns list of conversations (one per remote_jid) ordered by latest message
// descending. Each row carries the latest message preview + a count of unread
// (from_me=false and never marked read) messages.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // Distinct-on-remote_jid: take the latest message per conversation, sorted
    // by timestamp desc overall. Done as raw SQL because Prisma's groupBy can't
    // return arbitrary columns from the picked row.
    //
    // "systemNotice" stubs (inserted on group create/sync) carry the group
    // subject in push_name. They're treated as fallback content only — once
    // a real message arrives, the latest CTE prefers it over the stub.
    const rows = await prisma.$queryRaw<Array<{
      remote_jid: string;
      push_name: string | null;
      text: string | null;
      message_type: string;
      from_me: boolean;
      timestamp_ms: bigint;
      message_count: bigint;
    }>>`
      WITH latest AS (
        -- Prefer real messages over stubs for the "last message" preview.
        -- ORDER BY clause: (1) group by remote_jid, (2) put non-stubs first,
        -- (3) most recent first. DISTINCT ON keeps the first row per partition.
        SELECT DISTINCT ON (remote_jid)
          remote_jid,
          text,
          message_type,
          from_me,
          timestamp_ms
        FROM whatsapp_messages
        ORDER BY
          remote_jid,
          (from_me = true AND message_type = 'systemNotice') ASC,
          -- Reações não viram o "preview" da conversa (igual ao WhatsApp): só
          -- caem aqui se não houver nenhuma outra mensagem no grupo.
          (message_type = 'reactionMessage') ASC,
          timestamp_ms DESC
      ),
      contact_name AS (
        -- Only consider push_name from messages received from the contact
        -- (from_me=false), so we never label a conversation with our own
        -- profile name ("Cargo Ships") just because we sent the last message.
        SELECT DISTINCT ON (remote_jid)
          remote_jid,
          push_name
        FROM whatsapp_messages
        WHERE from_me = false
          AND push_name IS NOT NULL
          AND push_name <> ''
        ORDER BY remote_jid, timestamp_ms DESC
      ),
      group_label AS (
        -- Our create/sync stubs carry the group's subject in push_name. This
        -- is what we want to show as the group's display name — group names
        -- don't change with whoever sent the latest message.
        SELECT DISTINCT ON (remote_jid)
          remote_jid,
          push_name
        FROM whatsapp_messages
        WHERE remote_jid LIKE '%@g.us'
          AND from_me = true
          AND message_type = 'systemNotice'
          AND push_name IS NOT NULL
          AND push_name <> ''
        ORDER BY remote_jid, timestamp_ms DESC
      ),
      counts AS (
        -- Exclude stubs so freshly-synced groups show "0 mensagens" until
        -- there's real activity.
        SELECT
          remote_jid,
          COUNT(*) FILTER (WHERE NOT (from_me = true AND message_type = 'systemNotice'))::bigint AS message_count
        FROM whatsapp_messages
        GROUP BY remote_jid
      )
      SELECT
        l.*,
        CASE
          WHEN l.remote_jid LIKE '%@g.us' THEN COALESCE(g.push_name, n.push_name)
          ELSE n.push_name
        END AS push_name,
        c.message_count
      FROM latest l
      LEFT JOIN contact_name n USING (remote_jid)
      LEFT JOIN group_label g USING (remote_jid)
      JOIN counts c USING (remote_jid)
      ORDER BY l.timestamp_ms DESC
      LIMIT 200
    `;

    const conversations = rows.map((r) => ({
      remote_jid: r.remote_jid,
      push_name: r.push_name,
      last_text: r.text,
      last_message_type: r.message_type,
      last_from_me: r.from_me,
      last_timestamp_ms: r.timestamp_ms.toString(),
      message_count: Number(r.message_count),
      is_group: r.remote_jid.endsWith("@g.us"),
    }));

    // Fallback de nome pra DMs sem contato resolvido. Quando NÓS iniciamos a
    // conversa (ex.: cotação automática a um fornecedor) e o contato ainda não
    // respondeu, não há push_name de entrada (from_me=false) — a lista mostraria
    // só o número cru. Aqui casamos o número do JID com o cadastro: contato de
    // fornecedor ou telefone de funcionário. Só roda quando há alguma DM nesse
    // estado e nunca sobrescreve um nome que o próprio contato já mandou.
    const namelessDms = conversations.filter(
      (c) => !c.is_group && !(c.push_name && c.push_name.trim()),
    );
    if (namelessDms.length > 0) {
      const [suppliers, employees] = await Promise.all([
        prisma.supplier.findMany({
          where: { contact: { not: null } },
          select: { name: true, contact: true },
        }),
        prisma.employee.findMany({
          where: { phone: { not: null } },
          select: { name: true, phone: true },
        }),
      ]);
      // Número no formato WhatsApp (DDI 55 + 9º dígito, igual ao usado no envio)
      // -> nome do cadastro. Funcionários primeiro; fornecedor sobrepõe — a
      // conversa em geral nasce no módulo de compras e é esse nome que o usuário
      // espera ver. normalizeBRNumber ignora contatos sem número (e-mail, "—").
      const nameByNumber = new Map<string, string>();
      for (const e of employees) {
        const n = normalizeBRNumber(e.phone || "");
        if (n && !nameByNumber.has(n)) nameByNumber.set(n, e.name);
      }
      for (const s of suppliers) {
        const n = normalizeBRNumber(s.contact || "");
        if (n) nameByNumber.set(n, s.name);
      }
      for (const c of namelessDms) {
        const num = c.remote_jid.replace(/@.*$/, "");
        const name = nameByNumber.get(num) ?? nameByNumber.get(normalizeBRNumber(num));
        if (name) c.push_name = name;
      }
    }

    return NextResponse.json({ conversations });
  } catch (err) {
    console.error("conversations GET error:", err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
