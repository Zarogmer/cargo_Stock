/**
 * One-shot: grava os "valores especiais" (employee_function_rates) dos
 * colaboradores que trabalham nos navios de limpeza de porão, conforme o doc
 * "PAGAS NOS NAVIOS DE LIMPEZA DE PORÃO" (lista de nomes por função) e os novos
 * valores padrão definidos pela operação (jun/2026):
 *   WAP 220 · ESFREGÃO 250 · MAQUINISTA 180 · COZINHEIRO 180
 *
 * Os IDs abaixo foram resolvidos a partir do doc + cadastro (ver decisões:
 * Elias #11 entra como WAP; Luiz Gonçalo não existia e é criado aqui).
 * O valor especial é gravado na FUNÇÃO QUE O DOC INDICA, mesmo onde o role do
 * cadastro diverge (Jean/Robson/Madson/etc.).
 *
 * Idempotente: upsert por (employee_id, function_id). Escreve em produção.
 * Rodar: npx tsx scripts/update-special-rates-navios.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// função → id em job_functions (produção)
const FN = { WAP: 8, ESFREGAO: 5, MAQUINISTA: 6, COZINHEIRO: 4 } as const;
const NOTE = "Atualizacao doc PAGAS NOS NAVIOS";

// (employeeId, nome [referência], functionId, valor)
const PLAN: { id: number; name: string; fn: number; rate: number }[] = [
  // WAP = 220
  { id: 7, name: "CARLISON LUIZ NASCIMENTO", fn: FN.WAP, rate: 220 },
  { id: 21, name: "JEDSON DIEGO GOMES LIMA", fn: FN.WAP, rate: 220 },
  { id: 2, name: "ADINAELSON FERREIRA DE SOUZA", fn: FN.WAP, rate: 220 },
  { id: 40, name: "PEDRO HENRIQUE ARAUJO DA CUNHA", fn: FN.WAP, rate: 220 },
  { id: 34, name: "MANOEL VICTOR DE SOUZA SANTIAGO", fn: FN.WAP, rate: 220 },
  { id: 20, name: "JEAN GOMES DOS SANTOS SILVA", fn: FN.WAP, rate: 220 },
  { id: 13, name: "ELTON MEDRADO ABREU", fn: FN.WAP, rate: 220 },
  { id: 11, name: "ELIAS MEDRADO ABREU", fn: FN.WAP, rate: 220 },
  // ESFREGÃO = 250
  { id: 18, name: "ISAIAS FRANCISCO SANTOS", fn: FN.ESFREGAO, rate: 250 },
  { id: 10, name: "DEIVIDE FERREIRA DA SILVA", fn: FN.ESFREGAO, rate: 250 },
  { id: 24, name: "JOSUE FERREIRA ARAUJO", fn: FN.ESFREGAO, rate: 250 },
  { id: 22, name: "JOÃO VICTOR DOS SANTOS", fn: FN.ESFREGAO, rate: 250 },
  // MAQUINISTA = 180  (Luiz Gonçalo é criado e adicionado em runtime)
  { id: 15, name: "GUILHERME LIMA DAMIAO RIBEIRO", fn: FN.MAQUINISTA, rate: 180 },
  { id: 43, name: "ROBSON DA SILVA LARANJEIRA JUNIOR", fn: FN.MAQUINISTA, rate: 180 },
  // COZINHEIRO = 180
  { id: 19, name: "IVAN RODRIGUES DE FREITAS", fn: FN.COZINHEIRO, rate: 180 },
  { id: 64, name: "MADSON DA SILVA ALVES DE PINHO", fn: FN.COZINHEIRO, rate: 180 },
];

async function main() {
  // 1) Luiz Gonçalo (maquinista) — não existia no cadastro. Cria só com nome + função.
  let luiz = await prisma.employee.findFirst({ where: { name: "LUIZ GONÇALO" } });
  if (!luiz) {
    luiz = await prisma.employee.create({
      data: { name: "LUIZ GONÇALO", role: "MAQUINISTA", status: "ATIVO", updated_by: "sistema" },
    });
    console.log(`+ colaborador criado #${luiz.id} LUIZ GONÇALO (MAQUINISTA)`);
  } else {
    console.log(`= colaborador LUIZ GONÇALO já existe (#${luiz.id})`);
  }

  const plan = [...PLAN, { id: luiz.id, name: "LUIZ GONÇALO", fn: FN.MAQUINISTA, rate: 180 }];

  // 2) Upsert dos valores especiais.
  let created = 0;
  let updated = 0;
  for (const p of plan) {
    const existing = await prisma.employeeFunctionRate.findUnique({
      where: { employee_id_function_id: { employee_id: p.id, function_id: p.fn } },
    });
    await prisma.employeeFunctionRate.upsert({
      where: { employee_id_function_id: { employee_id: p.id, function_id: p.fn } },
      create: { employee_id: p.id, function_id: p.fn, rate: p.rate, notes: NOTE },
      update: { rate: p.rate, notes: NOTE },
    });
    if (existing) {
      updated++;
      console.log(`~ #${p.id} ${p.name} fn${p.fn}: R$ ${Number(existing.rate)} -> R$ ${p.rate}`);
    } else {
      created++;
      console.log(`+ #${p.id} ${p.name} fn${p.fn}: R$ ${p.rate}`);
    }
  }

  console.log(`\nOK. valores especiais criados: ${created}, atualizados: ${updated}, total: ${plan.length}`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
