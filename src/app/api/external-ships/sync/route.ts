import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  fetchShipsFromSantos,
  AisStreamConfigError,
  AisStreamApiError,
} from "@/lib/services/aisStream";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let vessels;
  try {
    vessels = await fetchShipsFromSantos();
  } catch (err) {
    if (err instanceof AisStreamConfigError) {
      return NextResponse.json(
        { error: err.message, configured: false },
        { status: 503 }
      );
    }
    if (err instanceof AisStreamApiError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode ?? 502 }
      );
    }
    console.error("AIS Stream sync unexpected error:", err);
    return NextResponse.json(
      { error: "Erro inesperado ao sincronizar." },
      { status: 500 }
    );
  }

  // Only persist vessels with an MMSI — that's the deduplication key.
  const withMmsi = vessels.filter((v) => v.mmsi);

  let upserted = 0;
  for (const v of withMmsi) {
    try {
      await prisma.externalShip.upsert({
        where: { mmsi: v.mmsi! },
        // Update only volatile fields. Don't blindly overwrite name —
        // MarineTraffic occasionally returns a blank/placeholder name on
        // a vessel we already have a known one for.
        update: {
          lat: v.lat,
          lng: v.lng,
          status: v.status,
          imo: v.imo ?? undefined,
          source: "aisstream",
          ...(v.name && v.name !== "Sem nome" ? { name: v.name } : {}),
        },
        create: {
          name: v.name,
          mmsi: v.mmsi,
          imo: v.imo,
          lat: v.lat,
          lng: v.lng,
          status: v.status,
          source: "aisstream",
        },
      });
      upserted++;
    } catch (err) {
      console.error("Upsert failed for mmsi", v.mmsi, err);
    }
  }

  return NextResponse.json({
    fetched: vessels.length,
    upserted,
    skippedNoMmsi: vessels.length - withMmsi.length,
  });
}
