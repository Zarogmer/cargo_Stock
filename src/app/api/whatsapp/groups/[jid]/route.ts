import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findGroupInfo, isEvolutionConfigured } from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// "5513999999999@s.whatsapp.net" → "5513999999999"
// Also strips the @lid suffix that newer Baileys versions sometimes emit.
function jidToDigits(jid: string): string {
  return jid.replace(/@.*$/, "").replace(/\D/g, "");
}

// GET /api/whatsapp/groups/[jid]
// Returns enriched info about a WhatsApp group: Evolution metadata + the ship
// it's linked to (if any) + cross-referenced employee names so participants
// show as people instead of bare phone numbers.
export async function GET(
  _req: Request,
  context: { params: Promise<{ jid: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ error: "Evolution API não configurada" }, { status: 503 });
  }

  const { jid: rawJid } = await context.params;
  const jid = decodeURIComponent(rawJid);
  if (!jid.endsWith("@g.us")) {
    return NextResponse.json({ error: "JID não é de grupo" }, { status: 400 });
  }

  try {
    const info = await findGroupInfo(jid);

    // Cross-reference participants with employees by phone digits. We grab
    // every employee row once (typically small) and build a map by
    // normalized phone, including a 12-digit BR fallback (without the 55
    // country code) since phones can be stored either way.
    const allEmployees = await prisma.employee.findMany({
      where: { phone: { not: null } },
      select: { id: true, name: true, phone: true, team: true, status: true },
    });
    const byPhone = new Map<string, typeof allEmployees[number]>();
    for (const e of allEmployees) {
      const digits = (e.phone || "").replace(/\D/g, "");
      if (!digits) continue;
      byPhone.set(digits, e);
      // Also index without the leading 55 so a number stored as 13999999999
      // matches a JID 5513999999999.
      if (digits.startsWith("55")) {
        byPhone.set(digits.slice(2), e);
      }
    }

    const participants = (info.participants || []).map((p) => {
      const pj = p.id || "";
      const digits = jidToDigits(pj);
      const emp =
        byPhone.get(digits) ||
        byPhone.get(digits.startsWith("55") ? digits.slice(2) : `55${digits}`) ||
        null;
      return {
        jid: pj,
        phone: digits,
        admin: p.admin || null, // "admin" | "superadmin" | null
        employee: emp ? {
          id: emp.id,
          name: emp.name,
          team: emp.team,
          status: emp.status,
        } : null,
      };
    });

    // Sort: admins/superadmins first, then by employee name (or phone).
    participants.sort((a, b) => {
      const aAdmin = a.admin ? 0 : 1;
      const bAdmin = b.admin ? 0 : 1;
      if (aAdmin !== bAdmin) return aAdmin - bAdmin;
      const aLabel = a.employee?.name || a.phone;
      const bLabel = b.employee?.name || b.phone;
      return aLabel.localeCompare(bLabel, "pt-BR");
    });

    // Linked ship — the auto-schedule job uses this JID, so we want to
    // surface it on the info panel.
    const ship = await prisma.ship.findFirst({
      where: { whatsapp_group_jid: jid },
      select: {
        id: true,
        name: true,
        status: true,
        port: true,
        arrival_date: true,
        departure_date: true,
      },
    });

    return NextResponse.json({
      jid,
      subject: info.subject || null,
      description: (info as Record<string, unknown>).desc as string | null || null,
      // Evolution returns creation as seconds-since-epoch; normalize to ms.
      created_at_ms: typeof info.creation === "number" ? info.creation * 1000 : null,
      owner: (info as Record<string, unknown>).owner as string | null || null,
      size: info.size ?? participants.length,
      participants,
      ship,
    });
  } catch (err) {
    return NextResponse.json({ error: friendlyEvolutionError((err as Error).message) }, { status: 502 });
  }
}
