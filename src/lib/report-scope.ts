import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasModuleAccess } from "@/lib/rbac";
import type { Role } from "@/types/database";

// Escopo dos Relatórios de Bordo (/api/relatorios):
// - Papéis de gestão (com módulo RELATORIOS no rbac) enxergam todos os navios.
// - SUPERVISOR enxerga só os jobs em que o colaborador vinculado
//   (users.employee_id) tem alocação ATIVA — e o serviço (kind) da alocação
//   define qual relatório ele pode mexer: EMBARQUE, COSTADO ou os dois.

export type ReportKind = "EMBARQUE" | "COSTADO";

export function parseKind(value: unknown): ReportKind | null {
  return value === "EMBARQUE" || value === "COSTADO" ? value : null;
}

// Alocação que "conta como trabalho" (mesma régua de countsAsWorked em
// src/lib/release-finished-ships.ts, em forma de filtro Prisma): ATIVA, ou
// baixada AUTOMATICAMENTE quando o navio finalizou (removal_reason começa com
// "Navio finalizado"). Sem isso o supervisor perderia o navio da lista assim
// que ele concluísse — justamente quando as fotos do "depois" e a avaliação
// da equipe são fechadas. Remoção manual (substituição) continua de fora.
export const WORKED_ALLOC_WHERE: Prisma.JobAllocationWhereInput = {
  OR: [
    { status: "ATIVO" },
    { status: "REMOVIDO", removal_reason: { startsWith: "Navio finalizado" } },
  ],
};

export interface ReportActor {
  userId: string;
  name: string;
  role: Role;
  isSupervisor: boolean;
  // employee vinculado (só preenchido pro SUPERVISOR — é a chave do escopo)
  employeeId: number | null;
}

export async function getReportActor(): Promise<ReportActor | null> {
  const session = await auth();
  if (!session?.user) return null;
  const role = (session.user as { role?: Role }).role as Role;
  if (!hasModuleAccess(role, "RELATORIOS")) return null;

  const isSupervisor = role === "SUPERVISOR";
  let employeeId: number | null = null;
  if (isSupervisor) {
    // O employee_id não viaja no JWT — busca no banco a cada request (barato e
    // garante que desvincular o colaborador corta o acesso na hora).
    const user = await prisma.user.findUnique({
      where: { id: session.user.id as string },
      select: { employee_id: true },
    });
    employeeId = user?.employee_id ?? null;
  }

  return {
    userId: session.user.id as string,
    name: session.user.name || session.user.email || "?",
    role,
    isSupervisor,
    employeeId,
  };
}

// Em quais serviços (kinds) o ator pode mexer neste job. Gestão: todos;
// supervisor: os kinds das alocações "trabalhadas" do colaborador dele no job.
export async function actorKindsForJob(actor: ReportActor, jobId: string): Promise<ReportKind[]> {
  if (!actor.isSupervisor) return ["EMBARQUE", "COSTADO"];
  if (!actor.employeeId) return [];
  const allocs = await prisma.jobAllocation.findMany({
    where: { job_id: jobId, employee_id: actor.employeeId, ...WORKED_ALLOC_WHERE },
    select: { kind: true },
  });
  const kinds = new Set<ReportKind>();
  for (const a of allocs) kinds.add(a.kind === "COSTADO" ? "COSTADO" : "EMBARQUE");
  return [...kinds];
}

export async function actorCanAccessJob(
  actor: ReportActor,
  jobId: string,
  kind: ReportKind
): Promise<boolean> {
  if (!actor.isSupervisor) return true;
  const kinds = await actorKindsForJob(actor, jobId);
  return kinds.includes(kind);
}
