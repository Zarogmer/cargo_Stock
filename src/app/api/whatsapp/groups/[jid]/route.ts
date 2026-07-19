import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findGroupInfo, isEvolutionConfigured } from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";
import { isJidLikeName } from "@/lib/utils";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO", "COMERCIAL", "FINANCEIRO"];

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

    // Mapeia LID → telefone real e LID → pushName usando o histórico de
    // mensagens. O Baileys recente coloca o telefone do remetente em
    // `key.participantPn` mesmo quando `key.participant` é um LID opaco —
    // então cada mensagem antiga é uma chance de aprender quem é aquele LID.
    //
    // Importante: LIDs são GLOBAIS por conta de WhatsApp, então uma mapping
    // aprendida em qualquer outro grupo também serve aqui. Por isso a busca
    // varre TODOS os grupos (até 3000 mensagens recentes), não só este.
    // O pushName, por outro lado, fica restrito a este grupo pra não puxar
    // apelido de outro contexto.
    const groupMessages = await prisma.whatsappMessage.findMany({
      where: {
        remote_jid: { endsWith: "@g.us" },
        from_me: false,
      },
      orderBy: { timestamp_ms: "desc" },
      select: { push_name: true, raw_event: true, remote_jid: true },
      take: 3000,
    });
    const lidToPhone = new Map<string, string>();
    const lidToPushName = new Map<string, string>();
    for (const m of groupMessages) {
      const raw = m.raw_event as Record<string, unknown> | null;
      const data = (raw?.data ?? raw) as Record<string, unknown> | null;
      const key = (data?.key ?? null) as Record<string, unknown> | null;
      const participant = typeof key?.participant === "string" ? key.participant : "";
      if (!participant) continue;
      const partDigits = jidToDigits(participant);
      if (!partDigits) continue;
      if (!lidToPhone.has(partDigits)) {
        const pn = typeof key?.participantPn === "string" ? key.participantPn : "";
        const pnDigits = pn ? jidToDigits(pn) : "";
        if (pnDigits) lidToPhone.set(partDigits, pnDigits);
      }
      // pushName: só usa mensagens DESTE grupo pra não importar apelido de outro
      // contexto, e ignora pushName que é um LID/JID cru (não é nome de verdade).
      if (m.remote_jid === jid && !lidToPushName.has(partDigits)) {
        const name = (m.push_name || "").trim();
        if (name && !isJidLikeName(name)) lidToPushName.set(partDigits, name);
      }
    }

    // Vínculos manuais LID -> telefone (informados pelo usuário em Conversas).
    // Têm prioridade sobre o que foi inferido do histórico (overwrite). Defensivo:
    // se a tabela ainda não existir (db push não rodado), não derruba o painel.
    try {
      const aliases = await prisma.whatsappLidAlias.findMany({ where: { phone: { not: null } } });
      for (const a of aliases) {
        const aLid = a.lid.replace(/\D/g, "");
        const aPhone = (a.phone || "").replace(/\D/g, "");
        if (aLid && aPhone) lidToPhone.set(aLid, aPhone);
      }
    } catch (aliasErr) {
      console.warn("[groups] lid aliases lookup skipped:", (aliasErr as Error).message);
    }

    // Helper: tenta achar um Employee a partir de dígitos de telefone, testando
    // variantes com/sem o prefixo 55 (Brasil).
    function findEmpByPhoneDigits(d: string): typeof allEmployees[number] | null {
      if (!d) return null;
      return (
        byPhone.get(d) ||
        byPhone.get(d.startsWith("55") ? d.slice(2) : `55${d}`) ||
        null
      );
    }

    const evolutionParticipants = (info.participants || []).map((p) => {
      const pj = p.id || "";
      const digits = jidToDigits(pj);
      const isLikelyLid = pj.endsWith("@lid") || digits.length > 13;

      // Step 1: tentativa direta — funciona quando Evolution devolve `xxx@s.whatsapp.net`.
      let emp = !isLikelyLid ? findEmpByPhoneDigits(digits) : null;

      // Step 2: campos extras que algumas versões do Evolution incluem (jid,
      // phoneNumber, pn, lid) — checa cada um caso o `id` venha como LID.
      const extraCandidates: string[] = [];
      const pAny = p as Record<string, unknown>;
      for (const k of ["jid", "phoneNumber", "pn", "lid"]) {
        const v = pAny[k];
        if (typeof v === "string" && v.length > 0) {
          const d = jidToDigits(v);
          if (d && d.length >= 10 && d.length <= 13) extraCandidates.push(d);
        }
      }
      let resolvedPhoneDigits = "";
      if (!emp) {
        for (const d of extraCandidates) {
          const candidate = findEmpByPhoneDigits(d);
          if (candidate) { emp = candidate; resolvedPhoneDigits = d; break; }
          if (!resolvedPhoneDigits) resolvedPhoneDigits = d;
        }
      }

      // Step 3: resolução via histórico de mensagens (LID → phone).
      if (!emp) {
        const phoneFromLid = lidToPhone.get(digits);
        if (phoneFromLid) {
          resolvedPhoneDigits = phoneFromLid;
          emp = findEmpByPhoneDigits(phoneFromLid);
        }
      }

      // Telefone exibido: prefere o cadastrado em Colaboradores (canônico).
      // Caso contrário usa o resolvido via LID. Se nada funcionou e o id é
      // claramente um LID, devolve string vazia pra UI mostrar "—" em vez
      // dos dígitos opacos do LID.
      let displayPhone = "";
      if (emp && emp.phone) {
        displayPhone = emp.phone.replace(/\D/g, "");
      } else if (resolvedPhoneDigits) {
        displayPhone = resolvedPhoneDigits;
      } else if (!isLikelyLid && digits) {
        // Id parecia um telefone real mas não bateu com colaborador — mostra mesmo assim.
        displayPhone = digits;
      }

      return {
        jid: pj,
        phone: displayPhone,
        admin: p.admin || null, // "admin" | "superadmin" | null
        push_name: lidToPushName.get(digits) || null,
        employee: emp ? {
          id: emp.id,
          name: emp.name,
          team: emp.team,
          status: emp.status,
          phone: emp.phone,
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
          push_name: null,
          employee: { id: e.id, name: e.name, team: e.team, status: e.status, phone: e.phone },
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
