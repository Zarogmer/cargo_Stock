import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  readBirthdayConfig,
  writeBirthdayConfig,
  sanitizeBirthdayConfig,
} from "@/lib/services/birthday-message";

// Papéis que podem EDITAR a mensagem de aniversário — os mesmos que gerenciam a
// aba Mensagens (ver MENSAGENS em src/lib/rbac.ts). Defesa em profundidade: a UI
// já só aparece pra esses papéis, mas o PUT recusa qualquer outro mesmo assim.
const EDIT_ROLES = new Set(["TECNOLOGIA", "EXECUTIVO", "FINANCEIRO"]);

// GET /api/birthday-message → { config } (com defaults aplicados).
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const config = await readBirthdayConfig();
  return NextResponse.json({ config });
}

// PUT /api/birthday-message  body: { enabled, template } → grava (upsert).
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const role = (session.user as { role?: string }).role || "";
  if (!EDIT_ROLES.has(role)) {
    return NextResponse.json({ error: "Sem permissão para alterar a mensagem de aniversário." }, { status: 403 });
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
  const config = sanitizeBirthdayConfig(raw);
  await writeBirthdayConfig(config, session.user.id || null);

  return NextResponse.json({ config });
}
