/**
 * Padroniza o campo `port` nos dados já gravados (navios, pagamentos, notas
 * fiscais e relatórios de bordo) com a mesma regra das telas:
 * src/lib/port-client-options.ts → canonicalPort().
 *
 *   "Paranagua"                          → "Paranaguá"
 *   "PORTO AÇU"                          → "Porto do Açu"
 *   "Porto Acu / Rio Grande"             → "Porto do Açu / Rio Grande"
 *   "Porto do Açu e Porto de Aratu - BA" → "Porto do Açu / Aratu"
 *   "São Francisco"                      → "São Francisco do Sul"
 *   "Mangaratiba RJ"                     → "Mangaratiba"
 *   "Sepetiba/Vitoria"                   → "Sepetiba / Vitória"
 *
 * Uso (o padrão é simulação; --apply grava):
 *   npx tsx --env-file=.env.local scripts/normalize-ports.ts
 *   npx tsx --env-file=.env.local scripts/normalize-ports.ts --apply
 */
import { PrismaClient } from "@prisma/client";
import { canonicalPort } from "../src/lib/port-client-options";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const TABLES = ["ships", "jobs", "fiscal_notes", "ship_reports"] as const;

async function main() {
  console.log(APPLY ? "MODO: APLICAR (grava no banco)" : "MODO: simulação (use --apply pra gravar)");
  let total = 0;
  for (const table of TABLES) {
    const rows = await prisma.$queryRawUnsafe<{ port: string | null; n: number }[]>(
      `SELECT port, COUNT(*)::int AS n FROM ${table} WHERE port IS NOT NULL GROUP BY port ORDER BY port`,
    );
    for (const { port, n } of rows) {
      const canon = canonicalPort(port);
      if (!canon || canon === port) continue;
      total += n;
      console.log(`${table.padEnd(13)} ${String(n).padStart(3)}× ${JSON.stringify(port)} → ${JSON.stringify(canon)}`);
      if (APPLY) {
        await prisma.$executeRawUnsafe(`UPDATE ${table} SET port = $1 WHERE port = $2`, canon, port);
      }
    }
  }
  console.log(total === 0 ? "Nada a mudar: todos os portos já estão no padrão." : `${total} registro(s) ${APPLY ? "atualizados" : "a atualizar"}.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
