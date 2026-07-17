/**
 * Relatório de Vales — adiantamento ao funcionário e o desconto dele no navio.
 *
 * Espelha o "Relatório de Vales <ano>.xlsx" da diretoria: o funcionário pega
 * dinheiro adiantado (ADIANTAMENTO: "Folha 04/07/2026", "Pegou com a Rose") e
 * isso volta depois, descontado no pagamento de um navio (DESCONTAR-NAVIO). O
 * "TOTAL A DESCONTAR" da planilha é o saldo: adiantado − já descontado.
 *
 * Regra que vale pra tudo aqui: o vale NÃO mexe no custo do navio. O dinheiro
 * saiu quando o vale foi criado; descontar no navio só reduz o que a pessoa
 * recebe naquele pagamento. Por isso o desconto entra na coluna ADIANTAMENTO da
 * Folha de Pagamento e não em Base/Extra/Total.
 */

export interface Advance {
  id: number;
  employee_id: number;
  advance_date: string;
  amount: string; // Prisma Decimal serializa como string
  origin: string;
  notes: string | null;
  created_by: string;
  created_at: string;
}

export interface AdvanceDiscount {
  id: number;
  advance_id: number;
  job_id: string;
  employee_id: number;
  amount: string;
  created_by: string;
  created_at: string;
}

/** Quanto já foi descontado de um vale. */
export function discountedOf(advanceId: number, discounts: AdvanceDiscount[]): number {
  return discounts
    .filter((d) => d.advance_id === advanceId)
    .reduce((s, d) => s + Number(d.amount), 0);
}

/** Saldo em aberto de um vale: o que falta descontar. */
export function balanceOf(advance: Advance, discounts: AdvanceDiscount[]): number {
  return +(Number(advance.amount) - discountedOf(advance.id, discounts)).toFixed(2);
}

/** Vales com saldo — os únicos que podem ser descontados num navio. */
export function openAdvances(advances: Advance[], discounts: AdvanceDiscount[]): Advance[] {
  return advances.filter((a) => balanceOf(a, discounts) > 0);
}

/** Saldo devedor total de um funcionário (o "TOTAL A DESCONTAR" da planilha). */
export function employeeBalance(
  employeeId: number, advances: Advance[], discounts: AdvanceDiscount[],
): number {
  return +advances
    .filter((a) => a.employee_id === employeeId)
    .reduce((s, a) => s + balanceOf(a, discounts), 0)
    .toFixed(2);
}

/** Total adiantado a um funcionário (o "TOTAL ADIANTADO" da planilha). */
export function employeeAdvanced(employeeId: number, advances: Advance[]): number {
  return +advances
    .filter((a) => a.employee_id === employeeId)
    .reduce((s, a) => s + Number(a.amount), 0)
    .toFixed(2);
}

/**
 * Quanto está sendo descontado de um funcionário num navio — a coluna
 * ADIANTAMENTO da Folha de Pagamento. Soma os descontos de todos os vales dele
 * naquele navio.
 */
export function jobDiscountFor(
  jobId: string, employeeId: number | null, discounts: AdvanceDiscount[],
): number {
  if (employeeId == null) return 0;
  return +discounts
    .filter((d) => d.job_id === jobId && d.employee_id === employeeId)
    .reduce((s, d) => s + Number(d.amount), 0)
    .toFixed(2);
}
