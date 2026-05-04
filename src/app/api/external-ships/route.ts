import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ships = await prisma.externalShip.findMany({
    orderBy: { updatedAt: "desc" },
    take: 100,
  });

  return NextResponse.json({ ships });
}
