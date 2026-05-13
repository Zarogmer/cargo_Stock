import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isEvolutionConfigured, getInstanceStatus } from "@/lib/services/evolution-api";

// GET /api/whatsapp/status — returns the Evolution instance state ("open" when
// WhatsApp is connected, "close" when disconnected) so the UI can show a badge.
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEvolutionConfigured()) {
    return NextResponse.json({ configured: false }, { status: 200 });
  }
  try {
    const status = await getInstanceStatus();
    return NextResponse.json({ configured: true, status });
  } catch (err) {
    return NextResponse.json({ configured: true, error: (err as Error).message }, { status: 502 });
  }
}
