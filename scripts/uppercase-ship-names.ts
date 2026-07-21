/**
 * One-shot: deixa o nome de TODOS os navios em CAIXA ALTA (ships.name) e
 * sincroniza o nome dos Jobs financeiros vinculados a navio (jobs.name copia
 * o nome do navio na criação). Cadastros novos já salvam em caixa alta desde
 * a mudança no formulário de Navios (navios/page.tsx) — isto aqui corrige o
 * legado ("Majestic Island", "vishva preeti", ...).
 *
 * Run with:  npx tsx scripts/uppercase-ship-names.ts
 *            npx tsx scripts/uppercase-ship-names.ts --dry   (não grava)
 *
 * Idempotente: re-rodar é seguro (só toca quem ainda não está em caixa alta).
 * Escreve em PRODUÇÃO (DATABASE_URL aponta pro Postgres do Railway).
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry");

async function main() {
  const ships = await prisma.ship.findMany({ select: { id: true, name: true } });
  let shipsChanged = 0;
  for (const s of ships) {
    const upper = (s.name || "").trim().toUpperCase();
    if (!upper || upper === s.name) continue;
    console.log(`ship  "${s.name}"  ->  "${upper}"`);
    if (!DRY) await prisma.ship.update({ where: { id: s.id }, data: { name: upper } });
    shipsChanged++;
  }

  // Jobs ligados a navio herdam o nome do navio — mantém os dois em sincronia
  // (o Financeiro exibe jobs.name).
  const jobs = await prisma.job.findMany({
    where: { ship_id: { not: null } },
    select: { id: true, name: true },
  });
  let jobsChanged = 0;
  for (const j of jobs) {
    const upper = (j.name || "").trim().toUpperCase();
    if (!upper || upper === j.name) continue;
    console.log(`job   "${j.name}"  ->  "${upper}"`);
    if (!DRY) await prisma.job.update({ where: { id: j.id }, data: { name: upper } });
    jobsChanged++;
  }

  console.log(
    `${DRY ? "[dry-run] " : ""}${shipsChanged} navio(s) e ${jobsChanged} job(s) ` +
      `${DRY ? "seriam atualizados" : "atualizados"}.`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
