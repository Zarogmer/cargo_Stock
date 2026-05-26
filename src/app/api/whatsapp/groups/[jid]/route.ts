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
    const byId = new Map<number, typeof allEmployees[number]>();
    for (const e of allEmployees) {
      byId.set(e.id, e);
      const digits = (e.phone || "").replace(/\D/g, "");
      if (!digits) continue;
      byPhone.set(digits, e);
      // Also index without the leading 55 so a number stored as 13999999999
      // matches a JID 5513999999999.
      if (digits.startsWith("55")) {
        byPhone.set(digits.slice(2), e);
      }
    }

    // O WhatsApp moderno expõe participantes como LIDs opacos (ex.: 7787…@lid),
    // não como números de telefone — então o cross-reference por phone falha
    // para muitos grupos. Usamos os employee_ids salvos no stub de criação
    // como fonte canônica de quem foi convidado pelo app.
    const createStub = await prisma.whatsappMessage.findFirst({
      where: { remote_jid: jid, message_type: "systemNotice" },
      orderBy: { timestamp_ms: "desc" },
      select: { raw_event: true },
    });
    const stubEmployeeIds: number[] = Array.isArray(
      (createStub?.raw_event as Record<string, unknown> | null)?.employee_ids,
    )
      ? ((createStub!.raw_event as Record<string, unknown>).employee_ids as unknown[])
          .filter((n): n is number => typeof n === "number")
      : [];

    const evolutionParticipants = (info.participants || []).map((p) => {
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

    // Se quase ninguém casou por phone (típico quando o grupo veio em LIDs),
    // troca a lista pelos employees convidados via app. Mantemos os admins
    // do Evolution porque essa info ("Dono") só vem de lá.
    const matchedCount = evolutionParticipants.filter((p) => p.employee).length;
    const useStubAsSource =
      stubEmployeeIds.length > 0 &&
      matchedCount < Math.max(1, evolutionParticipants.length / 2);

    let participants: typeof evolutionParticipants;
    if (useStubAsSource) {
      const adminByEmpId = new Map<number, string | null>();
      for (const p of evolutionParticipants) {
        if (p.employee && p.admin) adminByEmpId.set(p.employee.id, p.admin);
      }
      participants = stubEmployeeIds
        .map((eid) => byId.get(eid))
        .filter((e): e is NonNullable<typeof e> => !!e)
        .map((e) => ({
          jid: "",
          phone: (e.phone || "").replace(/\D/g, ""),
          admin: adminByEmpId.get(e.id) || null,
          employee: { id: e.id, name: e.name, team: e.team, status: e.status },
        }));
    } else {
      participants = evolutionParticipants;
    }

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
