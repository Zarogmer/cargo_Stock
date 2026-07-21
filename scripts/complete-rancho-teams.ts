/**
 * Completa o Rancho das equipes: garante que TODA equipe real (EQUIPE_1,
 * EQUIPE_2 e EQUIPE_4/Turbo) tenha uma linha de cada alimento cadastrado no
 * Rancho, mesmo que com quantidade zero.
 *
 * Por quê: cada alimento do Rancho é uma linha por equipe (stock_items.team).
 * A Equipe Turbo nasceu depois e ficou com só 2 alimentos, então a conferência
 * de volta (Embarque/Retorno › Retorno) não tinha o que checar — só aparecia
 * o que a lista do navio mandou levar. Com a lista completa dá pra registrar
 * qualquer item que voltou, estragou ou sumiu.
 *
 * O que faz: para cada nome de alimento que existe em ALGUMA equipe do Rancho,
 * cria a linha que estiver faltando nas demais com quantity = 0 e
 * default_quantity = 0 — o "padrão" (quanto a equipe leva) é decisão de quem
 * opera e continua sendo definido na tela do Rancho.
 *
 * Run with:  npx tsx scripts/complete-rancho-teams.ts
 *            npx tsx scripts/complete-rancho-teams.ts --dry   (não grava)
 *
 * Idempotente: re-rodar não cria nada de novo. Escreve em PRODUÇÃO
 * (DATABASE_URL aponta pro Postgres do Railway).
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry");

// Equipes reais do Rancho. EQUIPE_3 é a lista-mãe ("Disponível"), não uma
// equipe que embarca — fica de fora.
const REAL_TEAMS = ["EQUIPE_1", "EQUIPE_2", "EQUIPE_4"] as const;
const RANCHO_TEAMS = [...REAL_TEAMS, "EQUIPE_3"];
const TEAM_LABEL: Record<string, string> = {
  EQUIPE_1: "Equipe 1",
  EQUIPE_2: "Equipe 2",
  EQUIPE_4: "Equipe Turbo",
};

const norm = (s: string) => (s || "").trim().toLowerCase();

async function main() {
  const items = await prisma.stockItem.findMany({
    where: { team: { in: RANCHO_TEAMS } },
    select: { id: true, name: true, category: true, unit: true, team: true },
  });

  // Um representante por nome de alimento (pra copiar categoria e unidade).
  const repByName = new Map<string, (typeof items)[number]>();
  for (const it of items) {
    const key = norm(it.name);
    if (!repByName.has(key)) repByName.set(key, it);
  }

  // O que cada equipe já tem.
  const haveByTeam = new Map<string, Set<string>>();
  for (const t of REAL_TEAMS) haveByTeam.set(t, new Set());
  for (const it of items) {
    if (it.team && haveByTeam.has(it.team)) haveByTeam.get(it.team)!.add(norm(it.name));
  }

  console.log(`${repByName.size} alimento(s) distinto(s) no Rancho.`);

  let created = 0;
  for (const team of REAL_TEAMS) {
    const have = haveByTeam.get(team)!;
    const missing = [...repByName.entries()].filter(([key]) => !have.has(key));
    console.log(`\n${TEAM_LABEL[team]}: tem ${have.size}, faltam ${missing.length}.`);
    for (const [, rep] of missing) {
      console.log(`  + ${rep.name}`);
      if (!DRY) {
        await prisma.stockItem.create({
          data: {
            name: rep.name,
            category: rep.category,
            unit: rep.unit,
            quantity: 0,
            default_quantity: 0,
            min_quantity: 0,
            team,
            updated_by: "Sistema (completar rancho)",
          },
        });
      }
      created++;
    }
  }

  console.log(
    `\n${DRY ? "[dry-run] " : ""}${created} linha(s) ${DRY ? "seriam criadas" : "criadas"}.`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
