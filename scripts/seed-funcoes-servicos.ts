/**
 * Cria as funções que faltavam no Financeiro › Valores (pedido de 2026-07-21):
 *
 *   - RASPAGEM  (Embarque, por porão)  — extra que acontece junto da lavagem;
 *     o pessoal ganha por porão raspado. default_rate 200 (ajustável em Valores).
 *   - PINTURA   (Embarque, por porão)  — mesma ideia: extra por porão pintado.
 *   - AUXILIAR OPERACIONAL (Mensalista) — salário fixo, junto do Analista RH.
 *
 * Raspagem/Pintura são funções por porão (unit=PORAO) porque no navio elas se
 * pagam como as demais do Embarque: quem faz recebe uma alocação a mais dessa
 * função (além do WAP/Ajudante/etc.), então o ganho por serviço fica separado.
 * Auxiliar Operacional é mensalista (unit=MENSALISTA), não entra em escalação.
 *
 * Idempotente: checa por nome (case-insensitive), não duplica, não mexe em quem
 * já existe. Run:  npx tsx scripts/seed-funcoes-servicos.ts
 *                  npx tsx scripts/seed-funcoes-servicos.ts --dry
 *
 * Escreve em PRODUÇÃO (DATABASE_URL = Postgres do Railway).
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry");

interface Seed {
  name: string;
  description: string;
  default_rate: number;
  unit: string; // PORAO | MENSALISTA | TURNO
}

const SEEDS: Seed[] = [
  {
    name: "RASPAGEM",
    description: "Serviço de raspagem do porão — extra do Embarque, pago por porão.",
    default_rate: 200,
    unit: "PORAO",
  },
  {
    name: "PINTURA",
    description: "Serviço de pintura do porão — extra do Embarque, pago por porão.",
    default_rate: 200,
    unit: "PORAO",
  },
  {
    name: "AUXILIAR OPERACIONAL",
    description: "Auxiliar operacional — mensalista (salário fixo).",
    default_rate: 0,
    unit: "MENSALISTA",
  },
];

async function main() {
  const existing = await prisma.jobFunction.findMany({ select: { name: true } });
  const have = new Set(existing.map((f) => f.name.trim().toUpperCase()));

  let created = 0;
  for (const s of SEEDS) {
    if (have.has(s.name.toUpperCase())) {
      console.log(`= já existe: ${s.name}`);
      continue;
    }
    console.log(`+ criar: ${s.name} — R$ ${s.default_rate.toFixed(2)} · ${s.unit}`);
    if (!DRY) {
      await prisma.jobFunction.create({
        data: {
          name: s.name,
          description: s.description,
          default_rate: s.default_rate,
          unit: s.unit,
          active: true,
        },
      });
    }
    created++;
  }

  console.log(`\n${DRY ? "[dry-run] " : ""}${created} função(ões) ${DRY ? "seriam criadas" : "criadas"}.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
