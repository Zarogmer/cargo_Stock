import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { fetchAllGroups, isEvolutionConfigured } from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// POST /api/whatsapp/groups/sync
// Fetches every WhatsApp group the connected number belongs to (via Evolution)
// and inserts a "systemNotice" stub message for any group that doesn't have
// one yet. The stub carries the group subject in push_name so the Conversas
// list can label it. Already-stubbed groups have their subject refreshed in
// case it changed since the last sync.
//
// Why this exists: the Conversas list is derived from whatsapp_messages, which
// is populated by the webhook. Groups created externally (or before this
// feature) never receive a webhook event by themselves — only their first
// message does. This endpoint backfills so admins can see all groups
// immediately.
export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ error: "Evolution API não configurada" }, { status: 503 });
  }

  try {
    const groups = await fetchAllGroups();
    const instance = process.env.EVOLUTION_INSTANCE || "default";
    const baseTs = Date.now();

    let added = 0;
    let updated = 0;
    let skipped = 0;

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const jid = g.id;
      const subject = g.subject?.trim() || null;
      if (!jid || !jid.endsWith("@g.us")) {
        skipped++;
        continue;
      }

      // Existing create/sync stub? If so, refresh the subject in case it
      // changed; otherwise create a new one.
      const existingStub = await prisma.whatsappMessage.findFirst({
        where: {
          remote_jid: jid,
          from_me: true,
          message_type: "systemNotice",
        },
        orderBy: { timestamp_ms: "desc" },
        select: { id: true, push_name: true },
      });

      if (existingStub) {
        if (subject && existingStub.push_name !== subject) {
          try {
            await prisma.whatsappMessage.update({
              where: { id: existingStub.id },
              data: { push_name: subject },
            });
            updated++;
          } catch (err) {
            console.warn("[groups-sync] subject update failed:", jid, (err as Error).message);
          }
        }
        continue;
      }

      try {
        await prisma.whatsappMessage.create({
          data: {
            message_id: `system-sync-${jid}-${baseTs + i}`,
            instance_name: instance,
            remote_jid: jid,
            from_me: true,
            push_name: subject,
            message_type: "systemNotice",
            text: "✨ Grupo sincronizado",
            timestamp_ms: BigInt(baseTs + i),
            raw_event: { source: "groups-sync", subject, size: g.size ?? null },
          },
        });
        added++;
      } catch (err) {
        console.warn("[groups-sync] stub insert failed:", jid, (err as Error).message);
      }
    }

    return NextResponse.json({
      status: "ok",
      total: groups.length,
      added,
      updated,
      skipped,
    });
  } catch (err) {
    return NextResponse.json({ error: friendlyEvolutionError((err as Error).message) }, { status: 502 });
  }
}
