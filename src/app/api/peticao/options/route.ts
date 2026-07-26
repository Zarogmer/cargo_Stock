import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Listas cadastráveis da Petição (Gates, Meios de Transporte e Agências). Ficam
// em app_settings (chave/valor JSON) pra não exigir migração de schema. As
// Agências cadastradas aqui se somam aos clientes já usados nos navios — as duas
// telas (Petição e Navios) mostram a mesma lista unificada.
const KEYS = {
  gate: "peticao_gates",
  transporte: "peticao_transportes",
  agencia: "peticao_agencias",
} as const;

// Agências ocultadas: o dropdown de Agência junta sementes fixas + clientes dos
// navios + agências salvas aqui. Como não dá pra "apagar" uma semente ou um
// cliente de navio, guardamos aqui as agências que o usuário removeu, e o front
// as filtra do dropdown (independente da fonte). Adicionar de novo desoculta.
const AGENCIA_HIDDEN_KEY = "peticao_agencias_hidden";

type Kind = keyof typeof KEYS;

function isKind(v: unknown): v is Kind {
  return v === "gate" || v === "transporte" || v === "agencia";
}

// Lê uma lista do app_settings por chave; tolera ausência/JSON inválido → [].
async function readByKey(key: string): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
  } catch {
    /* ignora e devolve [] */
  }
  return [];
}

async function writeByKey(key: string, list: string[], actor: string | null): Promise<void> {
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
    where: { key },
    update: { value, updated_by: actor },
    create: { key, value, updated_by: actor },
  });
}

const readList = (kind: Kind) => readByKey(KEYS[kind]);
const writeList = (kind: Kind, list: string[], actor: string | null) => writeByKey(KEYS[kind], list, actor);

// GET → { gates: string[], transportes: string[], agencias: string[] }
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [gates, transportes, agencias, agenciasHidden] = await Promise.all([
    readList("gate"),
    readList("transporte"),
    readList("agencia"),
    readByKey(AGENCIA_HIDDEN_KEY),
  ]);
  return NextResponse.json({ gates, transportes, agencias, agenciasHidden });
}

// POST { kind: "gate"|"transporte"|"agencia", name } → adiciona e devolve a lista atualizada.
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

  // Adicionar uma agência a desoculta (some da lista de suprimidas).
  let hidden: string[] | undefined;
  if (body.kind === "agencia") {
    const h = (await readByKey(AGENCIA_HIDDEN_KEY)).filter((s) => s.toLowerCase() !== name.toLowerCase());
    await writeByKey(AGENCIA_HIDDEN_KEY, h, actor);
    hidden = h;
  }

  return NextResponse.json({ list: await readList(body.kind), ...(hidden ? { hidden } : {}) });
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

  // Remover uma agência a oculta: como ela pode vir de semente/cliente de navio
  // (não só da lista salva), guardamos na lista de suprimidas pra sumir do menu.
  let hidden: string[] | undefined;
  if (kind === "agencia") {
    const h = await readByKey(AGENCIA_HIDDEN_KEY);
    h.push(name);
    await writeByKey(AGENCIA_HIDDEN_KEY, h, actor);
    hidden = await readByKey(AGENCIA_HIDDEN_KEY);
  }

  return NextResponse.json({ list, ...(hidden ? { hidden } : {}) });
}
