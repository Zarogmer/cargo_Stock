import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  buildTemplate,
  type ProntidaoTeam,
  type TemplateKind,
} from "@/lib/services/message-templates";

// Mesmos papéis que veem grupos/estoque nas outras rotas de WhatsApp — este
// endpoint expõe estoque de EPI/uniforme e prontidão, então não fica aberto a
// qualquer usuário logado.
const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

const VALID_KINDS: TemplateKind[] = ["EPI", "UNIFORME", "PRONTIDAO"];
const VALID_TEAMS: ProntidaoTeam[] = ["EQUIPE_1", "EQUIPE_2", "EQUIPE_3", "ALL"];

// GET /api/whatsapp/templates?kind=EPI|UNIFORME|PRONTIDAO[&team=EQUIPE_1|ALL]
// Renderiza o texto do template com os dados ao vivo. Usado pela UI de Mensagens
// pra pré-visualizar/inserir o boletim no textarea antes de enviar pro grupo.
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const kind = (request.nextUrl.searchParams.get("kind") || "") as TemplateKind;
  if (!VALID_KINDS.includes(kind)) {
    return NextResponse.json({ error: "kind inválido (use EPI, UNIFORME ou PRONTIDAO)" }, { status: 400 });
  }

  const teamParam = (request.nextUrl.searchParams.get("team") || "ALL") as ProntidaoTeam;
  const team = VALID_TEAMS.includes(teamParam) ? teamParam : "ALL";

  try {
    const text = await buildTemplate(kind, team);
    return NextResponse.json({ text });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
