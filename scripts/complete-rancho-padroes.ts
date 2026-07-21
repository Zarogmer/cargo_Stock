/**
 * Preenche o PADRÃO (default_quantity) que falta no Rancho.
 *
 * Situação que motivou o script (auditado em 21/07/2026):
 *   - Equipe 1 e Equipe 2: os 41 alimentos com padrão preenchido.
 *   - Equipe Turbo: só Açúcar (10) e Batata (5) — os outros 39 zerados, então
 *     a lista de embarque da Turbo saía praticamente vazia.
 *   - Disponível (EQUIPE_3, a lista-mãe que o botão "Preparar" copia): só 2
 *     alimentos cadastrados, o que deixava o "Preparar" inútil.
 *
 * Regra usada: padrão da Turbo = MAIOR entre Equipe 1 e Equipe 2.
 *   - Nos 38 alimentos em que as duas equipes já são iguais, isso é só copiar.
 *   - Nos 3 em que divergem (Água 25/30, Coxa e Sobre Coxa 9/10, Peito de
 *     Frango 9/10) fica o maior — a Turbo é a equipe grande, "leva mais comida".
 *   - Confere com o que já estava configurado à mão na Turbo: Açúcar e Batata
 *     valem exatamente o mesmo que nas outras equipes.
 * Nada é inventado: todo valor sai de uma equipe já configurada por alguém.
 *
 * Não mexe em quantidade em estoque — só no padrão (quanto a equipe leva).
 * Itens que já têm padrão na Turbo são preservados.
 *
 * Run with:  npx tsx scripts/complete-rancho-padroes.ts
 *            npx tsx scripts/complete-rancho-padroes.ts --dry   (não grava)
 *
 * Idempotente. Escreve em PRODUÇÃO (DATABASE_URL = Postgres do Railway).
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry");

const MASTER = "EQUIPE_3"; // "Disponível" — lista-mãe do Rancho
const SOURCES = ["EQUIPE_1", "EQUIPE_2"] as const;
const TARGET = "EQUIPE_4"; // Equipe Turbo

const norm = (s: string) => (s || "").trim().toLowerCase();

async function main() {
  const rows = await prisma.stockItem.findMany({
    where: { team: { in: [...SOURCES, TARGET, MASTER] } },
    select: {
      id: true, name: true, team: true, unit: true, category: true,
      default_quantity: true,
    },
  });

  // Padrão de referência por alimento = maior valor entre Equipe 1 e Equipe 2.
  const refByName = new Map<string, { name: string; qty: number; unit: string; category: (typeof rows)[number]["category"] }>();
  for (const r of rows) {
    if (!SOURCES.includes(r.team as (typeof SOURCES)[number])) continue;
    const qty = r.default_quantity || 0;
    if (qty <= 0) continue;
    const key = norm(r.name);
    const prev = refByName.get(key);
    if (!prev || qty > prev.qty) {
      refByName.set(key, { name: r.name, qty, unit: r.unit, category: r.category });
    }
  }
  console.log(`${refByName.size} alimento(s) com padrão de referência (maior entre Equipe 1 e 2).\n`);

  // ── 1) Equipe Turbo: preencher o padrão que está zerado ──
  let turboUpd = 0;
  for (const r of rows) {
    if (r.team !== TARGET) continue;
    if ((r.default_quantity || 0) > 0) continue; // já configurado — não toca
    const ref = refByName.get(norm(r.name));
    if (!ref) continue;
    console.log(`Turbo  ${r.name.padEnd(28)} 0 -> ${ref.qty}`);
    if (!DRY) {
      await prisma.stockItem.update({
        where: { id: r.id },
        data: { default_quantity: ref.qty, updated_by: "Sistema (padrão do rancho)" },
      });
    }
    turboUpd++;
  }

  // ── 2) Disponível (lista-mãe): criar o que falta, com o mesmo padrão ──
  const masterHave = new Set(rows.filter((r) => r.team === MASTER).map((r) => norm(r.name)));
  let masterIns = 0;
  for (const [key, ref] of refByName) {
    if (masterHave.has(key)) continue;
    console.log(`Master ${ref.name.padEnd(28)} + padrão ${ref.qty}`);
    if (!DRY) {
      await prisma.stockItem.create({
        data: {
          name: ref.name,
          category: ref.category,
          unit: ref.unit,
          quantity: 0,
          default_quantity: ref.qty,
          min_quantity: 0,
          team: MASTER,
          updated_by: "Sistema (padrão do rancho)",
        },
      });
    }
    masterIns++;
  }

  console.log(
    `\n${DRY ? "[dry-run] " : ""}Turbo: ${turboUpd} padrão(ões) ${DRY ? "seriam preenchidos" : "preenchidos"}. ` +
      `Disponível: ${masterIns} alimento(s) ${DRY ? "seriam criados" : "criados"}.`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
