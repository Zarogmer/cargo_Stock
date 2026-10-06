import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import type { Role } from "@/types/database";

// Títulos de item cadastrados pelo usuário no modal da Nota (além dos prontos
// de lib/fiscal-note.ts). Ficam numa linha de app_settings (lista JSON de
// textos) — sem migração de schema.
//
//   GET    → { titles: string[] }
//   POST   { title }  → adiciona
//   DELETE { title }  → remove
const KEY = "fiscal_note_item_titles";

async function readTitles(): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  try {
    const v = JSON.parse(row?.value || "[]");
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}

async function guard(edit: boolean) {
  const session = await auth();
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const role = session.user.role as Role;
  // Cadastrar título: quem pode emitir nota (mesma régua do POST de notas).
  const ok = edit
    ? hasPermission(role, "FINANCEIRO_MOD", "edit") || hasPermission(role, "FINANCEIRO_MOD", "create")
    : hasPermission(role, "FINANCEIRO_MOD", "view");
  if (!ok) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user: session.user };
}

async function save(titles: string[], by: string | null | undefined) {
  const value = JSON.stringify(titles);
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value, updated_by: by ?? null },
    update: { value, updated_by: by ?? null },
  });
}

export async function GET() {
  const g = await guard(false);
  if (g.error) return g.error;
  return NextResponse.json({ titles: await readTitles() });
}

export async function POST(request: NextRequest) {
  const g = await guard(true);
  if (g.error) return g.error;
  const { title } = (await request.json().catch(() => ({}))) as { title?: string };
  const t = (title || "").trim();
  if (!t) return NextResponse.json({ error: "Título vazio" }, { status: 400 });
  const list = await readTitles();
  if (!list.some((x) => x.toLowerCase() === t.toLowerCase())) list.push(t);
  await save(list, g.user?.email);
  return NextResponse.json({ titles: list });
}

export async function DELETE(request: NextRequest) {
  const g = await guard(true);
  if (g.error) return g.error;
  const { title } = (await request.json().catch(() => ({}))) as { title?: string };
  const t = (title || "").trim().toLowerCase();
  const list = (await readTitles()).filter((x) => x.toLowerCase() !== t);
  await save(list, g.user?.email);
  return NextResponse.json({ titles: list });
}
