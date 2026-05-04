import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import type { Role, ShipStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const VALID_STATUSES: ShipStatus[] = [
  "AGENDADO",
  "EM_OPERACAO",
  "CONCLUIDO",
  "CANCELADO",
];

interface CreateShipBody {
  name?: string;
  arrival_date?: string | null;
  departure_date?: string | null;
  port?: string | null;
  status?: ShipStatus;
  assigned_team?: string | null;
  notes?: string | null;
  externalShipId?: string | null;
}

function parseDate(input: string | null | undefined): Date | null {
  if (!input) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user as { role?: Role }).role;
  if (!role || !hasPermission(role, "NAVIOS", "create")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: CreateShipBody;
  try {
    body = (await request.json()) as CreateShipBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  let name = body.name?.trim() ?? "";
  const externalShipId = body.externalShipId?.trim() || null;

  // If linking to an external ship, fetch it and adopt its name when none provided.
  if (externalShipId) {
    const ext = await prisma.externalShip.findUnique({
      where: { id: externalShipId },
    });
    if (!ext) {
      return NextResponse.json(
        { error: "Navio externo não encontrado." },
        { status: 404 }
      );
    }
    if (!name) name = ext.name;
  }

  if (!name) {
    return NextResponse.json(
      { error: "Nome do navio é obrigatório." },
      { status: 400 }
    );
  }

  const status: ShipStatus = body.status && VALID_STATUSES.includes(body.status)
    ? body.status
    : "AGENDADO";

  const ship = await prisma.ship.create({
    data: {
      name,
      arrival_date: parseDate(body.arrival_date),
      departure_date: parseDate(body.departure_date),
      port: body.port?.trim() || null,
      status,
      assigned_team: body.assigned_team || null,
      notes: body.notes?.trim() || null,
      created_by: session.user.name || session.user.email || "sistema",
      externalShipId,
    },
  });

  return NextResponse.json({ ship }, { status: 201 });
}
