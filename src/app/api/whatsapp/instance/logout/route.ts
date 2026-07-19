import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isEvolutionConfigured, logoutInstance } from "@/lib/services/evolution-api";
import { friendlyEvolutionError } from "@/lib/services/evolution-errors";

export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["TECNOLOGIA", "GESTOR", "EXECUTIVO", "COMERCIAL"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ error: "Evolution API não configurada" }, { status: 503 });
  }
  try {
    const result = await logoutInstance();
    return NextResponse.json({ success: true, result });
  } catch (err) {
    const raw = (err as Error).message;
    const friendly = friendlyEvolutionError(raw);
    // For logout, "Connection Closed" usually means the session is already
    // dead — hint to the user that the right next step is "Recriar (reset)".
    const hint = raw.toLowerCase().includes("connection closed")
      ? `${friendly} Use o botão "Recriar (reset)" pra forçar a recriação da instância.`
      : friendly;
    return NextResponse.json({ error: hint }, { status: 502 });
  }
}
