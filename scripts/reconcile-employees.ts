/**
 * Reconciliação pontual planilha × sistema (decisões do Guilherme em 12/06/2026):
 *   1) Marcelo Albuquerque Fernandes (#35) saiu → marcar INATIVO.
 *   2) Excluir a duplicata da Rosemary (#72, sem CPF — a oficial #56 fica).
 *   3) Excluir o registro inválido "CARGO SHIPS CLEANING" (#73, sem CPF).
 *
 * Cada ação tem GUARDA: só executa se o registro daquele id ainda bater com o
 * nome/CPF esperado (defesa contra id trocado). Dry-run por padrão.
 *
 * Uso:
 *   npx tsx scripts/reconcile-employees.ts            (dry-run)
 *   npx tsx scripts/reconcile-employees.ts --apply    (grava em produção)
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const digits = (v: string | null | undefined) => (v || "").replace(/\D/g, "");
const nameHas = (name: string | null | undefined, frag: string) =>
  (name || "").toLowerCase().includes(frag);

async function main() {
  const actions: { label: string; run: () => Promise<unknown> }[] = [];

  // 1) Marcelo #35 → INATIVO
  const marcelo = await prisma.employee.findUnique({
    where: { id: 35 },
    select: { id: true, name: true, cpf: true, status: true },
  });
  if (marcelo && digits(marcelo.cpf) === "25400620833" && nameHas(marcelo.name, "marcelo albuquerque")) {
    if (marcelo.status === "INATIVO") {
      console.log(`• #35 "${marcelo.name}" já está INATIVO — nada a fazer.`);
    } else {
      actions.push({
        label: `#35 "${marcelo.name}": ${marcelo.status} → INATIVO`,
        run: () => prisma.employee.update({ where: { id: 35 }, data: { status: "INATIVO", updated_by: "reconcile-script" } }),
      });
    }
  } else {
    console.warn(`! #35 não confere com Marcelo — achei: ${JSON.stringify(marcelo)} — PULANDO.`);
  }

  // 2) Rosemary duplicada #72 (sem CPF) → excluir
  const rose = await prisma.employee.findUnique({
    where: { id: 72 },
    select: { id: true, name: true, cpf: true },
  });
  if (rose && !digits(rose.cpf) && nameHas(rose.name, "rosemary")) {
    actions.push({
      label: `Excluir duplicata #72 "${rose.name}" (sem CPF) — oficial #56 mantida`,
      run: () => prisma.employee.delete({ where: { id: 72 } }),
    });
  } else {
    console.warn(`! #72 não confere com Rosemary duplicada — achei: ${JSON.stringify(rose)} — PULANDO.`);
  }

  // 3) "CARGO SHIPS CLEANING" #73 (sem CPF) → excluir
  const cargo = await prisma.employee.findUnique({
    where: { id: 73 },
    select: { id: true, name: true, cpf: true },
  });
  if (cargo && !digits(cargo.cpf) && nameHas(cargo.name, "cargo ships")) {
    actions.push({
      label: `Excluir registro inválido #73 "${cargo.name}" (não é pessoa)`,
      run: () => prisma.employee.delete({ where: { id: 73 } }),
    });
  } else {
    console.warn(`! #73 não confere com 'CARGO SHIPS CLEANING' — achei: ${JSON.stringify(cargo)} — PULANDO.`);
  }

  console.log(`\nAções a aplicar (${actions.length}):`);
  for (const a of actions) console.log(`  - ${a.label}`);

  if (!APPLY) {
    console.log(`\n[dry-run] Nada gravado. Rode com --apply para aplicar em produção.`);
    await prisma.$disconnect();
    return;
  }

  console.log("");
  for (const a of actions) {
    await a.run();
    console.log(`✅ ${a.label}`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
