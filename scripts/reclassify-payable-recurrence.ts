/**
 * Reclassifica a recorrência (MENSAL x UNICA) de TODOS os títulos do Contas a
 * Pagar segundo a definição da diretoria de "conta mensal":
 *
 *   MENSAL = só o que repete fixo todo mês:
 *     • 6.1 Infraestrutura  → aluguel, água, luz, net...
 *     • 7.1 Impostos/Encargos e Taxas
 *     • 9.1 Salário Enc. e Ben.
 *     • 10  Distribuição aos Sócios → prolabore/retiradas
 *     • prestadores fixos que caem em "Diversos" (ex.: Sandra) via MONTHLY_NAME_RE
 *   UNICA = todo o resto — fornecedores (6.2), consultorias/processos (6.3),
 *           férias/prêmios (9.2/9.3), seguros (12), patrimônio (11), diversos...
 *
 * Faz re-baseline completo: acerta cada título pra bater com a regra (promove e
 * rebaixa). Nunca mexe em título gerado por conta mensal (recurring_bill_id).
 * Dry-run por padrão; use --commit pra aplicar.
 *
 *   npx tsx scripts/reclassify-payable-recurrence.ts          (dry-run)
 *   npx tsx scripts/reclassify-payable-recurrence.ts --commit
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Seções que representam despesa fixa mensal (o resto vira UNICA).
const MONTHLY_SECTIONS = new Set(["6.1", "7.1", "9.1", "10"]);

// Prestadores fixos mensais que a planilha lança fora das seções acima
// (ex.: "Pagto a Sandra de L.S. do Carmo" cai em 6.4 Diversos).
const MONTHLY_NAME_RE = /sandra/i;

function isMonthly(inv: { statement_section: string | null; description: string; recurring_bill_id: number | null }): boolean {
  if (inv.recurring_bill_id != null) return true; // veio de conta mensal
  if (MONTHLY_NAME_RE.test(inv.description)) return true;
  return inv.statement_section != null && MONTHLY_SECTIONS.has(inv.statement_section);
}

async function main() {
  const commit = process.argv.includes("--commit");

  const invoices = await prisma.payableInvoice.findMany({
    select: {
      id: true, description: true, recurrence: true, recurring_bill_id: true,
      statement_section: true,
    },
  });

  const toMensal: typeof invoices = [];
  const toUnica: typeof invoices = [];
  for (const inv of invoices) {
    if (inv.recurring_bill_id != null) continue; // gerado por conta mensal — não toca
    const target = isMonthly(inv) ? "MENSAL" : "UNICA";
    if (inv.recurrence === target) continue;
    (target === "MENSAL" ? toMensal : toUnica).push(inv);
  }

  const bySec = (rows: typeof invoices) => {
    const m: Record<string, number> = {};
    for (const r of rows) m[r.statement_section || "(sem)"] = (m[r.statement_section || "(sem)"] || 0) + 1;
    return Object.entries(m).sort().map(([k, v]) => `${k}:${v}`).join("  ");
  };

  console.log(`Títulos: ${invoices.length}`);
  console.log(`\n→ MENSAL (${toMensal.length})   por seção: ${bySec(toMensal)}`);
  console.log(`→ UNICA  (${toUnica.length})   por seção: ${bySec(toUnica)}`);

  if (commit) {
    if (toMensal.length) {
      await prisma.payableInvoice.updateMany({ where: { id: { in: toMensal.map((i) => i.id) } }, data: { recurrence: "MENSAL" } });
    }
    if (toUnica.length) {
      await prisma.payableInvoice.updateMany({ where: { id: { in: toUnica.map((i) => i.id) } }, data: { recurrence: "UNICA" } });
    }
    console.log(`\n✓ Aplicado: ${toMensal.length} → MENSAL, ${toUnica.length} → UNICA.`);
  } else {
    console.log("\n— DRY RUN — rode com --commit pra aplicar.");
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
