/**
 * Deixa em branco (role = null) a função dos colaboradores cuja função NÃO
 * existe na tabela job_functions (a fonte usada pelo Financeiro). Assim o
 * cadastro de Colaboradores passa a usar exatamente as mesmas funções do
 * Financeiro; o que sobrar fora da lista fica em branco para o RH reatribuir.
 *
 * Simulação (padrão):  npx tsx scripts/cleanup-employee-roles.ts
 * Aplicar de verdade:  npx tsx scripts/cleanup-employee-roles.ts --apply
 *
 * Escreve em PRODUÇÃO (DATABASE_URL do .env aponta pro Railway). A comparação
 * é por nome normalizado (maiúsculas, sem espaços nas pontas).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const norm = (s: string | null | undefined) => (s || "").trim().toUpperCase();

async function main() {
  const functions = await prisma.jobFunction.findMany({ select: { name: true } });
  const validNames = new Set(functions.map((f) => norm(f.name)));
  console.log(`Funções no Financeiro (${validNames.size}):`, [...validNames].sort());

  const employees = await prisma.employee.findMany({
    where: { role: { not: null } },
    select: { id: true, name: true, role: true },
  });

  // Colaboradores cuja função não está na lista do Financeiro (e não é vazia).
  const toBlank = employees.filter((e) => {
    const r = norm(e.role);
    return r !== "" && !validNames.has(r);
  });

  // Quebra por função removida, pra dar visibilidade.
  const byRole = new Map<string, string[]>();
  for (const e of toBlank) {
    const r = norm(e.role);
    if (!byRole.has(r)) byRole.set(r, []);
    byRole.get(r)!.push(e.name);
  }

  console.log(`\nColaboradores com função fora da lista: ${toBlank.length}`);
  for (const [r, names] of [...byRole.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  • ${r} — ${names.length}: ${names.slice(0, 6).join(", ")}${names.length > 6 ? ` … (+${names.length - 6})` : ""}`);
  }

  if (!APPLY) {
    console.log(`\n[SIMULAÇÃO] Nada foi alterado. Rode com --apply para gravar (role = null).`);
    await prisma.$disconnect();
    return;
  }

  if (toBlank.length > 0) {
    const result = await prisma.employee.updateMany({
      where: { id: { in: toBlank.map((e) => e.id) } },
      data: { role: null },
    });
    console.log(`\n[APLICADO] ${result.count} colaboradores ficaram com função em branco.`);
  } else {
    console.log(`\nNada a fazer — todas as funções já batem com o Financeiro.`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
