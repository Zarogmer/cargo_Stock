import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  fetchPraticagemShips,
  PraticagemConfigError,
  PraticagemFetchError,
  type PraticagemShip,
} from "@/lib/services/praticagemSantos";

export const dynamic = "force-dynamic";

// Cache em memória (60s): o line-up muda devagar e cada leitura loga + baixa a
// página da praticagem, então evitamos martelar o site deles a cada abertura
// do modal. "Atualizar" no front manda ?force=1 pra furar o cache.
let cache: { at: number; ships: PraticagemShip[] } | null = null;
const TTL_MS = 60_000;

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return NextResponse.json({ ships: cache.ships, cachedAt: cache.at, cached: true });
  }

  try {
    const ships = await fetchPraticagemShips();
    cache = { at: Date.now(), ships };
    return NextResponse.json({ ships, cachedAt: cache.at, cached: false });
  } catch (err) {
    if (err instanceof PraticagemConfigError) {
      return NextResponse.json({ error: err.message, configured: false }, { status: 503 });
    }
    if (err instanceof PraticagemFetchError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode ?? 502 });
    }
    console.error("Praticagem fetch unexpected error:", err);
    return NextResponse.json({ error: "Erro inesperado ao buscar a praticagem." }, { status: 500 });
  }
}
