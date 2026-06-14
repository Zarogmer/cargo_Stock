/**
 * One-shot: atualiza o VALOR PADRÃO (default_rate) das funções pros valores
 * definidos pela operação (jun/2026), aplicando a TODOS daquela função:
 *   WAP 220 · ESFREGÃO 250 · MAQUINISTA 180 · COZINHEIRO 180 · AJUDANTE 180
 *
 * Replica o editor inline do Financeiro (saveRateInline): encerra a taxa vigente
 * em job_function_rates, abre uma nova (valid_from = hoje) e atualiza o
 * default_rate da função. NÃO mexe em pagamentos em aberto — mesmo comportamento
 * do editor de padrão (só alocações novas usam o valor novo).
 *
 * Como esses passam a ser os valores PADRÃO, os "valores especiais" por pessoa
 * que eu havia gravado pelo doc PAGAS NOS NAVIOS ficam redundantes (iguais ao
 * padrão). O próprio app remove o override quando ele iguala o padrão, então
 * este script também apaga esses 17 especiais — mantém o do supervisor (#59),
 * que é especial de verdade (400 ≠ 300).
 *
 * Idempotente. Escreve em produção. Rodar: npx tsx scripts/update-function-default-rates.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TARGETS: { name: string; rate: number }[] = [
  { name: "WAP", rate: 220 },
  { name: "ESFREGAO", rate: 250 },
  { name: "MAQUINISTA", rate: 180 },
  { name: "COZINHEIRO", rate: 180 },
  { name: "AJUDANTE", rate: 180 },
];

// Especiais criados pelo doc (employee_id, function_id) — ficam redundantes
// quando o padrão da função vira o mesmo valor.
const REDUNDANT_SPECIALS: { id: number; fn: number }[] = [
  { id: 7, fn: 8 }, { id: 21, fn: 8 }, { id: 2, fn: 8 }, { id: 40, fn: 8 },
  { id: 34, fn: 8 }, { id: 20, fn: 8 }, { id: 13, fn: 8 }, { id: 11, fn: 8 },
  { id: 18, fn: 5 }, { id: 10, fn: 5 }, { id: 24, fn: 5 }, { id: 22, fn: 5 },
  { id: 15, fn: 6 }, { id: 43, fn: 6 }, { id: 75, fn: 6 },
  { id: 19, fn: 4 }, { id: 64, fn: 4 },
];

function dateOnly(ms: number): Date {
  return new Date(new Date(ms).toISOString().slice(0, 10) + "T00:00:00.000Z");
}

async function main() {
  const today = dateOnly(Date.now());
  const yesterday = dateOnly(Date.now() - 86_400_000);

  for (const t of TARGETS) {
    const fn = await prisma.jobFunction.findUnique({ where: { name: t.name } });
    if (!fn) { console.log(`! função ${t.name} não encontrada — pulada`); continue; }
    if (Number(fn.default_rate) === t.rate) {
      console.log(`= ${t.name} já está em R$ ${t.rate}`);
      continue;
    }
    await prisma.jobFunctionRate.updateMany({
      where: { function_id: fn.id, valid_until: null },
      data: { valid_until: yesterday },
    });
    await prisma.jobFunctionRate.create({
      data: { function_id: fn.id, rate: t.rate, valid_from: today, notes: "Atualizacao padrao jun/2026" },
    });
    await prisma.jobFunction.update({ where: { id: fn.id }, data: { default_rate: t.rate } });
    console.log(`~ ${t.name}: R$ ${Number(fn.default_rate)} -> R$ ${t.rate}`);
  }

  let removed = 0;
  for (const s of REDUNDANT_SPECIALS) {
    const row = await prisma.employeeFunctionRate.findUnique({
      where: { employee_id_function_id: { employee_id: s.id, function_id: s.fn } },
    });
    if (!row) continue;
    const fn = await prisma.jobFunction.findUnique({ where: { id: s.fn }, select: { default_rate: true } });
    if (fn && Number(row.rate) === Number(fn.default_rate)) {
      await prisma.employeeFunctionRate.delete({
        where: { employee_id_function_id: { employee_id: s.id, function_id: s.fn } },
      });
      removed++;
    }
  }
  console.log(`\nEspeciais redundantes removidos: ${removed} (mantidos os de verdade, ex.: supervisor #59).`);

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
