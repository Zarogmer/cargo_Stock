import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasModuleAccess } from "@/lib/rbac";
import type { Role } from "@/types/database";

// GET /api/rh/avaliacoes?employee_id=N — histórico de avaliações de desempenho
// que o colaborador recebeu nos navios (preenchidas pelos supervisores nos
// Relatórios de Bordo). Consumido pelo detalhe do colaborador em Rh ›
// Colaboradores. Restrito a quem enxerga o RH (SUPERVISOR e MANUTENCAO ficam
// de fora — supervisor avalia, mas o histórico consolidado é da gestão).

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  const role = (session.user as { role?: Role }).role as Role;
  if (!hasModuleAccess(role, "COLABORADORES")) {
    return NextResponse.json({ error: "Sem permissão" }, { status: 403 });
  }

  const employeeId = Number(request.nextUrl.searchParams.get("employee_id"));
  if (!employeeId) return NextResponse.json({ error: "employee_id obrigatório" }, { status: 400 });

  const evaluations = await prisma.performanceEvaluation.findMany({
    where: { employee_id: employeeId },
    include: {
      jobs: {
        select: {
          name: true,
          start_date: true,
          ships: { select: { name: true } },
        },
      },
    },
    orderBy: { updated_at: "desc" },
  });

  const data = evaluations.map((e) => ({
    id: e.id,
    job_id: e.job_id,
    kind: e.kind,
    ship_name: e.jobs.ships?.name || e.jobs.name,
    job_date: e.jobs.start_date,
    productivity: e.productivity,
    quality: e.quality,
    teamwork: e.teamwork,
    safety: e.safety,
    initiative: e.initiative,
    punctuality: e.punctuality,
    technical: e.technical,
    comments: e.comments,
    evaluated_by: e.evaluated_by,
    updated_at: e.updated_at,
  }));

  return NextResponse.json({ data });
}
