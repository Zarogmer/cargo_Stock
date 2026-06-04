import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Configuração: mínimo de máquinas que devem estar "Disponíveis" no Maquinário.
// Guardado em app_settings (chave/valor). 0 = sem mínimo (sem alerta).
const KEY = "maquinario_min_disponivel";

// GET /api/almoxarifado/maquinario-min → { min }
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  const min = row ? Math.max(0, Math.floor(Number(row.value) || 0)) : 0;
  return NextResponse.json({ min });
}

// PUT /api/almoxarifado/maquinario-min  body: { min } → grava
export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { min?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const min = Math.max(0, Math.floor(Number(body.min) || 0));
  const actor = session.user.id || null;

  await prisma.appSetting.upsert({
    where: { key: KEY },
    update: { value: String(min), updated_by: actor },
    create: { key: KEY, value: String(min), updated_by: actor },
  });
  return NextResponse.json({ min });
}
