import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  findGroupInfo,
  isEvolutionConfigured,
  normalizeBRNumber,
  updateGroupParticipants,
} from "@/lib/services/evolution-api";
import { clearTeamGroupCache, getTeamGroupJid } from "@/lib/services/team-groups";

const ALLOWED_ROLES = ["TECNOLOGIA", "GESTOR", "EXECUTIVO", "COMERCIAL"];

// POST /api/whatsapp/groups/diagnose
//
// Diagnóstico manual pra entender por que um número não foi adicionado num
// grupo de equipe. Recebe { team, phone } e retorna:
//   1. JID resolvido pro grupo
//   2. Status atual de membros (busca via findGroupInfo)
//   3. Resposta crua da Evolution ao tentar adicionar (action=add)
//   4. Status pós-add (refaz findGroupInfo)
//
// Útil pra distinguir entre:
//   - código não chamou Evolution
//   - Evolution aceitou mas WhatsApp recusou (privacidade do número)
//   - número não existe no WhatsApp
//   - grupo errado / JID errado
//
// Restrito a TECNOLOGIA/GESTOR/EXECUTIVO porque expõe info sensível
// (membros do grupo, telefones).
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ error: "Evolution API não configurada" }, { status: 503 });
  }

  let body: { team?: string; phone?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const team = body.team === "EQUIPE_1" || body.team === "EQUIPE_2" || body.team === "EQUIPE_4" ? body.team : null;
  const phoneRaw = (body.phone || "").trim();
  if (!team || !phoneRaw) {
    return NextResponse.json({ error: "Campos obrigatórios: team (EQUIPE_1|EQUIPE_2|EQUIPE_4) e phone" }, { status: 400 });
  }

  const phoneNorm = normalizeBRNumber(phoneRaw);
  const expectedJidPart = `${phoneNorm}@s.whatsapp.net`;

  // 1. Resolve JID do grupo
  clearTeamGroupCache(team);
  const jid = await getTeamGroupJid(team);
  if (!jid) {
    return NextResponse.json({
      step: "lookup",
      ok: false,
      error: `Grupo da ${team} não encontrado em whatsapp_messages. Rode Sincronizar grupos.`,
      team,
    });
  }

  // 2. Status atual do grupo (membros antes do add)
  let infoBefore: unknown = null;
  let memberBefore = false;
  try {
    const info = await findGroupInfo(jid);
    infoBefore = {
      subject: info?.subject,
      size: info?.size,
      participantCount: info?.participants?.length ?? 0,
    };
    memberBefore = (info?.participants ?? []).some((p) => {
      const pid = (p?.id || "").replace(/\D/g, "");
      return pid === phoneNorm;
    });
  } catch (err) {
    infoBefore = { error: (err as Error).message };
  }

  // 3. Tenta o add
  let addResponse: unknown = null;
  let addError: string | null = null;
  try {
    addResponse = await updateGroupParticipants(jid, "add", [phoneRaw]);
  } catch (err) {
    addError = (err as Error).message;
  }

  // 4. Status após o add
  let infoAfter: unknown = null;
  let memberAfter = false;
  try {
    const info = await findGroupInfo(jid);
    infoAfter = {
      subject: info?.subject,
      size: info?.size,
      participantCount: info?.participants?.length ?? 0,
    };
    memberAfter = (info?.participants ?? []).some((p) => {
      const pid = (p?.id || "").replace(/\D/g, "");
      return pid === phoneNorm;
    });
  } catch (err) {
    infoAfter = { error: (err as Error).message };
  }

  return NextResponse.json({
    team,
    phone: { raw: phoneRaw, normalized: phoneNorm, expectedJid: expectedJidPart },
    jid,
    infoBefore,
    memberBefore,
    addResponse,
    addError,
    infoAfter,
    memberAfter,
    verdict: memberAfter
      ? "ADICIONADO COM SUCESSO"
      : memberBefore
        ? "JÁ ERA MEMBRO ANTES DO TESTE"
        : "NÃO FOI ADICIONADO — veja addResponse pra entender o motivo",
  });
}
