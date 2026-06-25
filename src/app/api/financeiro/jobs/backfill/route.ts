import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO", "FINANCEIRO"];

// POST /api/financeiro/jobs/backfill
// For every Ship that doesn't have a Job linked to it, create one with status
// ABERTO inheriting the ship's metadata (port, cargo_type, holds_count, dates,
// client_name). Idempotent — ships that already have a Job are skipped.
//
// Returns: { status: "ok", created: N, skipped: N, total: N }
export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    // Pull ships + the set of ship_ids that already have at least one Job
    // so we can skip them in a single pass (avoids N queries).
    const [ships, jobsWithShip] = await Promise.all([
      prisma.ship.findMany({
        select: {
          id: true,
          name: true,
          arrival_date: true,
          departure_date: true,
          port: true,
          cargo_type: true,
          holds_count: true,
          client_name: true,
        },
      }),
      prisma.job.findMany({
        where: { ship_id: { not: null } },
        select: { ship_id: true },
      }),
    ]);

    const linked = new Set(jobsWithShip.map((j) => j.ship_id).filter(Boolean) as string[]);
    const createdBy = session.user.name || "sistema";

    let created = 0;
    let skipped = 0;

    for (const s of ships) {
      if (linked.has(s.id)) {
        skipped++;
        continue;
      }
      try {
        await prisma.job.create({
          data: {
            name: s.name,
            ship_id: s.id,
            // start_date is required on the Job model — fall back to today
            // for ships that never had an arrival date set.
            start_date: s.arrival_date ?? new Date(),
            end_date: s.departure_date ?? null,
            status: "ABERTO",
            client: s.client_name ?? null,
            cargo_type: s.cargo_type ?? null,
            holds_count: s.holds_count ?? null,
            port: s.port ?? null,
            created_by: createdBy,
          },
        });
        created++;
      } catch (err) {
        // Don't abort the whole batch on a single failure — log and continue.
        console.warn("[jobs-backfill] failed for ship", s.id, (err as Error).message);
      }
    }

    return NextResponse.json({
      status: "ok",
      total: ships.length,
      created,
      skipped,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Erro no backfill." },
      { status: 500 },
    );
  }
}
