import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  NOTIFY_CONFIG_KEY,
  readNotifyConfig,
  sanitizeNotifyConfig,
} from "@/lib/services/solicitacoes-notify-config";

// Papéis que podem EDITAR a config dos avisos — os mesmos que enxergam a aba
// Mensagens (ver MENSAGENS em src/lib/rbac.ts). Defesa em profundidade: a UI já
// só aparece pra esses papéis, mas o PUT recusa qualquer outro mesmo assim.
const EDIT_ROLES = new Set(["TECNOLOGIA", "ESTAGIO", "EXECUTIVO", "COMERCIAL", "FINANCEIRO"]);

// GET /api/solicitacoes/notify-config → NotifyConfig (com defaults aplicados).
// Qualquer usuário autenticado pode ler.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const config = await readNotifyConfig();
  return NextResponse.json({ config });
}

// PUT /api/solicitacoes/notify-config  body: NotifyConfig → grava (upsert).
// Restrito aos papéis que gerenciam Mensagens.
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = (session.user as { role?: string }).role || "";
  if (!EDIT_ROLES.has(role)) {
    return NextResponse.json({ error: "Sem permissão para alterar a configuração." }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  // Aceita { config: {...} } ou o próprio objeto no corpo.
  const raw = body && typeof body === "object" && "config" in body
    ? (body as { config: unknown }).config
    : body;
  const config = sanitizeNotifyConfig(raw);
  const actor = session.user.id || null;

  await prisma.appSetting.upsert({
    where: { key: NOTIFY_CONFIG_KEY },
    update: { value: JSON.stringify(config), updated_by: actor },
    create: { key: NOTIFY_CONFIG_KEY, value: JSON.stringify(config), updated_by: actor },
  });

  return NextResponse.json({ config });
}
