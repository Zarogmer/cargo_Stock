import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasModuleAccess } from "@/lib/rbac";
import { SHARED_PHOTO_KINDS, sharesPhotoBlocks, type ReportKindName } from "@/lib/report-format";
import type { Role } from "@/types/database";

// Escopo dos Relatórios de Bordo (/api/relatorios):
// - Papéis de gestão (com módulo RELATORIOS no rbac) enxergam todos os navios.
// - SUPERVISOR enxerga só os jobs em que o colaborador vinculado
//   (users.employee_id) tem alocação ATIVA — e o serviço (kind) da alocação
//   define qual relatório ele pode mexer: EMBARQUE, COSTADO ou os dois.

export type ReportKind = ReportKindName;

const ALL_KINDS: ReportKind[] = ["EMBARQUE", "COSTADO", "RASPAGEM", "PINTURA"];

export function parseKind(value: unknown): ReportKind | null {
  return ALL_KINDS.includes(value as ReportKind) ? (value as ReportKind) : null;
}

// Qual escalação sustenta o relatório. Raspagem e Pintura são serviços do
// EMBARQUE: a equipe é a mesma do embarque (job_allocations.kind = EMBARQUE),
// só o relatório é separado. Sem isso o supervisor perderia o acesso e a
// equipe/assinatura sairiam vazias nesses dois relatórios.
export function baseKind(kind: ReportKind): "EMBARQUE" | "COSTADO" {
  return kind === "COSTADO" ? "COSTADO" : "EMBARQUE";
}

// Relatórios que o navio tem, pelos serviços do cadastro (ships.services).
// Navio sem serviço marcado (legado) continua com o relatório de Embarque.
export function reportKindsForServices(services: string[] | null | undefined): ReportKind[] {
  const set = new Set((services || []).map((s) => String(s).toUpperCase()));
  if (set.has("COSTADO")) return ["COSTADO"];
  const kinds: ReportKind[] = [];
  if (set.has("LAVAGEM_PORAO") || set.size === 0) kinds.push("EMBARQUE");
  if (set.has("RASPAGEM")) kinds.push("RASPAGEM");
  if (set.has("PINTURA")) kinds.push("PINTURA");
  return kinds.length > 0 ? kinds : ["EMBARQUE"];
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

// Em quais ESCALAS (Embarque/Costado) o ator pode mexer neste job. Gestão:
// todas; supervisor: as das alocações "trabalhadas" do colaborador dele no job.
// Raspagem/Pintura seguem a escala de Embarque (ver baseKind).
export async function actorKindsForJob(actor: ReportActor, jobId: string): Promise<("EMBARQUE" | "COSTADO")[]> {
  if (!actor.isSupervisor) return ["EMBARQUE", "COSTADO"];
  if (!actor.employeeId) return [];
  const allocs = await prisma.jobAllocation.findMany({
    where: { job_id: jobId, employee_id: actor.employeeId, ...WORKED_ALLOC_WHERE },
    select: { kind: true },
  });
  const kinds = new Set<"EMBARQUE" | "COSTADO">();
  for (const a of allocs) kinds.add(a.kind === "COSTADO" ? "COSTADO" : "EMBARQUE");
  return [...kinds];
}

// Relatórios IRMÃOS que dividem os blocos do ciclo da operação com este — os
// outros serviços de porão do MESMO navio (ver SHARED_PHOTO_KINDS). A foto do
// carregamento do caminhão continua guardada no relatório em que foi enviada;
// é a leitura que junta os irmãos, então nada precisa ser duplicado nem
// migrado. Só entram relatórios que já existem.
export async function siblingBlockReportIds(jobId: string, kind: ReportKind): Promise<string[]> {
  if (!sharesPhotoBlocks(kind)) return [];
  const siblings = await prisma.shipReport.findMany({
    where: { job_id: jobId, kind: { in: SHARED_PHOTO_KINDS.filter((k) => k !== kind) } },
    select: { id: true },
  });
  return siblings.map((s) => s.id);
}

export async function actorCanAccessJob(
  actor: ReportActor,
  jobId: string,
  kind: ReportKind
): Promise<boolean> {
  // Raspagem/Pintura só existem se o navio contratou o serviço — vale pra
  // gestão também (senão dava pra abrir um relatório de pintura em navio só de
  // lavagem chamando a API na mão). Embarque/Costado ficam de fora da checagem:
  // navio antigo pode estar sem `services` preenchido e o relatório dele já
  // existe.
  if (kind === "RASPAGEM" || kind === "PINTURA") {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { ships: { select: { services: true } } },
    });
    if (!reportKindsForServices(job?.ships?.services).includes(kind)) return false;
  }
  if (!actor.isSupervisor) return true;
  const kinds = await actorKindsForJob(actor, jobId);
  return kinds.includes(baseKind(kind));
}
