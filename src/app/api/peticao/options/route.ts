import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Listas cadastráveis da Petição (Gates e Meios de Transporte). Ficam em
// app_settings (chave/valor JSON) pra não exigir migração de schema. As Agências
// NÃO moram aqui: reusam a lista de clientes já cadastrada nos navios.
const KEYS = {
  gate: "peticao_gates",
  transporte: "peticao_transportes",
} as const;

type Kind = keyof typeof KEYS;

function isKind(v: unknown): v is Kind {
  return v === "gate" || v === "transporte";
}

// Lê uma lista do app_settings; tolera ausência/JSON inválido devolvendo [].
async function readList(kind: Kind): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEYS[kind] } });
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* ignora e devolve [] */
  }
  return [];
}

async function writeList(kind: Kind, list: string[], actor: string | null): Promise<void> {
  // Ordena (pt-BR) e remove duplicados (case-insensitive, mantendo a 1ª grafia).
  const seen = new Set<string>();
  const clean = list
    .map((s) => s.trim())
    .filter((s) => {
      if (!s) return false;
      const k = s.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const value = JSON.stringify(clean);
  await prisma.appSetting.upsert({
    where: { key: KEYS[kind] },
    update: { value, updated_by: actor },
    create: { key: KEYS[kind], value, updated_by: actor },
  });
}

// GET → { gates: string[], transportes: string[] }
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [gates, transportes] = await Promise.all([readList("gate"), readList("transporte")]);
  return NextResponse.json({ gates, transportes });
}

// POST { kind: "gate"|"transporte", name } → adiciona e devolve a lista atualizada.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { kind?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  if (!isKind(body.kind)) return NextResponse.json({ error: "kind inválido" }, { status: 400 });
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Informe o nome." }, { status: 400 });

  const actor = session.user.id || null;
  const list = await readList(body.kind);
  list.push(name);
  await writeList(body.kind, list, actor);
  return NextResponse.json({ list: await readList(body.kind) });
}

// DELETE ?kind=gate&name=... → remove e devolve a lista atualizada.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const kind = req.nextUrl.searchParams.get("kind");
  const name = (req.nextUrl.searchParams.get("name") || "").trim();
  if (!isKind(kind)) return NextResponse.json({ error: "kind inválido" }, { status: 400 });
  if (!name) return NextResponse.json({ error: "Informe o nome." }, { status: 400 });

  const actor = session.user.id || null;
  const list = (await readList(kind)).filter((s) => s.toLowerCase() !== name.toLowerCase());
  await writeList(kind, list, actor);
  return NextResponse.json({ list });
}
