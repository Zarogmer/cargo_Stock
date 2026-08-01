// Custo dos navios (Pagamento de Navios) — matemática compartilhada entre a
// página do Financeiro e o Painel Financeiro. Extraída de
// src/app/(dashboard)/financeiro/page.tsx pra existir UMA conta só:
//   EMBARQUE: rate (valor/porão) × holds_count, por funcionário (qty não importa).
//   COSTADO:  rate (valor/turno) × quantidade — cada linha = 1 turno.
//   ADMINISTRATIVO: valor fixo por operação.
// Puro/sem Prisma — roda no cliente.

import { pickFunctionByName } from "@/lib/jobUnits";
import type { Job, JobAllocation, JobFunction, Employee, Ship } from "@/types/database";

// Serviços de Embarque do navio (ships.services). Raspagem e Pintura são os
// "extras" pagos por porão a todo o operacional; a lavagem é o padrão.
export const EMBARQUE_SERVICE_LABELS: Record<string, string> = {
  LAVAGEM_PORAO: "Lavagem",
  RASPAGEM: "Raspagem",
  PINTURA: "Pintura",
};

export function isServiceExtra(s: string): boolean {
  return s === "RASPAGEM" || s === "PINTURA";
}

export function calcAllocBase(a: JobAllocation, holdsCount: number | null): number {
  const k = a.kind || "EMBARQUE";
  const qty = a.quantity;
  const rate = Number(a.rate);
  const extra = Number(a.extra_value || 0);
  if (k === "EMBARQUE") {
    const holds = Math.max(1, Number(holdsCount || 1));
    // Raspagem/Pintura: valor/porão do serviço extra do navio, somado à limpeza
    // de todo o operacional (enriquecido por prepareFinanceAllocations).
    const serviceExtra = Number(a.service_extra_rate || 0);
    return (rate + serviceExtra) * holds + extra;
  }
  if (k === "ADMINISTRATIVO") {
    // Administrativo: valor fixo por operação — não multiplica por porões nem
    // turnos. Cada navio paga o valor cheio da pessoa.
    return rate + extra;
  }
  if (k === "COSTADO") {
    return rate * qty + extra;
  }
  return rate * qty + extra;
}

export function calcJobCost(job: Job, allocations: JobAllocation[], adjustments: { job_id: string; type: string; amount: string | number }[]): {
  base: number;     // soma dos pagamentos base + rateios
  adj: number;      // ajustes (adicionais menos reduções)
  total: number;
} {
  const jobAllocs = allocations.filter((a) => a.job_id === job.id);
  const jobAdjs = adjustments.filter((a) => a.job_id === job.id);
  const base = jobAllocs.reduce((sum, a) => sum + calcAllocBase(a, job.holds_count), 0);
  const adj = jobAdjs.reduce(
    (sum, a) => sum + (a.type === "ADICIONAL" ? Number(a.amount) : -Number(a.amount)),
    0
  );
  return { base, adj, total: base + adj };
}

// EMBARQUE: faz a função e o valor de cada escala virem SEMPRE do cadastro do
// colaborador (cargo em RH › Colaboradores + valor especial/padrão da função),
// e não de um snapshot gravado na alocação. Assim todo navio reflete o cadastro
// atual, sem valor "preso" por navio. Não grava nada — ajusta só em memória, na
// leitura, então não reescreve histórico. Costado fica de fora: lá todos entram
// na função fixa "COSTADO" (valor único definido em Valores).
// Exceção: colaborador escalado 2+ vezes no MESMO navio (ex.: MAQUINISTA e
// ESFREGÃO) foi escalado de propósito em funções diferentes — cada linha mantém
// a função da escala (senão as duas virariam o cargo do RH) e só o valor é
// atualizado pelo cadastro daquela função.
export function applyCadastroToAllocations(
  allocs: JobAllocation[],
  employees: Employee[],
  functions: JobFunction[],
  specialRates: Map<string, number>,
): JobAllocation[] {
  const empById = new Map<number, Employee>(employees.map((e) => [e.id, e]));
  const fnById = new Map<number, JobFunction>(functions.map((f) => [f.id, f]));
  const embarkCount = new Map<string, number>();
  for (const a of allocs) {
    if ((a.kind || "EMBARQUE") !== "EMBARQUE" || a.employee_id == null) continue;
    const k = `${a.job_id}|${a.employee_id}`;
    embarkCount.set(k, (embarkCount.get(k) || 0) + 1);
  }
  return allocs.map((a) => {
    // Override travado pelo executivo (só neste navio): mantém function_id/rate
    // como ele definiu, não deriva do cadastro.
    if (a.function_locked) return a;
    if ((a.kind || "EMBARQUE") !== "EMBARQUE" || a.employee_id == null) return a;
    const multi = (embarkCount.get(`${a.job_id}|${a.employee_id}`) || 0) > 1;
    let fn: JobFunction | undefined;
    if (multi) {
      fn = fnById.get(a.function_id);
    } else {
      const role = (empById.get(a.employee_id)?.role || "").trim().toUpperCase();
      if (!role) return a;
      // Cargo é pago por porão no Embarque → prefere a função da seção EMBARQUE
      // quando o mesmo nome existe em mais de uma unidade.
      fn = pickFunctionByName(functions, role, "EMBARQUE");
    }
    if (!fn) return a;
    const special = specialRates.get(`${a.employee_id}-${fn.id}`);
    const rate = special != null ? special : Number(fn.default_rate);
    if (!Number.isFinite(rate)) return a;
    return { ...a, function_id: fn.id, rate, job_functions: { name: fn.name, unit: fn.unit } };
  });
}

// Pipeline completo de leitura: cadastro aplicado + serviço extra do navio
// (Raspagem/Pintura) somado por porão a todo o operacional de Embarque. O
// valor/porão vem do default_rate da função de mesmo nome cadastrada em Valores.
export function prepareFinanceAllocations(
  rawAllocs: JobAllocation[],
  employees: Employee[],
  functions: JobFunction[],
  specialRates: Map<string, number>,
  jobs: Job[],
  ships: Pick<Ship, "id" | "services">[],
): JobAllocation[] {
  const withCadastro = applyCadastroToAllocations(rawAllocs, employees, functions, specialRates);
  const shipById = new Map(ships.map((s) => [s.id, s]));
  const serviceFnRate = (svc: string): number => {
    const f = pickFunctionByName(functions, svc, "EMBARQUE");
    return f ? Number(f.default_rate || 0) : 0;
  };
  const jobServiceExtra = new Map<string, number>();
  for (const j of jobs) {
    if (!j.ship_id) continue;
    const services = shipById.get(j.ship_id)?.services || [];
    const extra = services.filter(isServiceExtra).reduce((s, svc) => s + serviceFnRate(svc), 0);
    if (extra > 0) jobServiceExtra.set(j.id, extra);
  }
  return withCadastro.map((a) => {
    // Só operacional de Embarque; Administrativo (custo fixo) fica fora.
    if ((a.kind || "EMBARQUE") !== "EMBARQUE") return a;
    const extraRate = jobServiceExtra.get(a.job_id) || 0;
    if (extraRate <= 0) return a;
    // Se a própria função da pessoa JÁ é o serviço (RASPAGEM/PINTURA), não soma
    // de novo — evita dobrar o valor.
    const fnName = (a.job_functions?.name || "").trim().toUpperCase();
    if (isServiceExtra(fnName)) return a;
    return { ...a, service_extra_rate: extraRate };
  });
}
