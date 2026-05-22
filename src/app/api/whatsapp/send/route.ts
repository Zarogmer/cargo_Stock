import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isEvolutionConfigured, sendWhatsappText } from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";

// POST { to: string, text: string } — sends a WhatsApp text via Evolution API.
// Requires authentication. Returns 503 when Evolution is not configured so the
// caller can fall back gracefully.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ error: "Evolution API não configurada" }, { status: 503 });
  }

  let body: { to?: string; text?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const to = body.to?.trim();
  const text = body.text?.trim();
  if (!to || !text) {
    return NextResponse.json({ error: "Campos 'to' e 'text' são obrigatórios" }, { status: 400 });
  }

  try {
    const result = await sendWhatsappText(to, text);
    return NextResponse.json({ success: true, result });
  } catch (err) {
    return NextResponse.json({ error: friendlyEvolutionError((err as Error).message) }, { status: 502 });
  }
}
