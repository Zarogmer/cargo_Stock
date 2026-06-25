import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isEvolutionConfigured, getWebhookConfig } from "@/lib/services/evolution-api";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ error: "Evolution API não configurada" }, { status: 503 });
  }
  try {
    const config = await getWebhookConfig();
    return NextResponse.json({ config });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
