/**
 * Classifica os títulos JÁ existentes no Contas a Pagar:
 *   • recurrence = "MENSAL" p/ despesas que repetem todo mês (infra/água,
 *     fornecedores e prestadores, consultorias, impostos, folha, seguros) ou
 *     que já vêm de uma conta mensal (recurring_bill_id). O resto fica "UNICA".
 *   • payment_method herdado da compra de origem; senão lido da observação
 *     ("Pagamento: X"); senão "BOLETO" quando tem linha digitável.
 *
 * Só preenche o que está vazio/na etiqueta padrão — não sobrescreve o que o
 * usuário já ajustou à mão. Uso: npx tsx scripts/backfill-payable-classification.ts [--commit]
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Seções da Demonstração que representam despesa recorrente (mensal).
const MONTHLY_SECTIONS = new Set(["6.1", "6.2", "6.3", "7.1", "9.1", "9.2", "9.3", "12"]);

const KNOWN_METHODS = ["FATURADO", "CARTÃO DE CRÉDITO", "CARTÃO DE DÉBITO", "PIX", "DINHEIRO", "BOLETO", "TRANSFERÊNCIA"];

// Lê a forma de pagamento da observação ("... Pagamento: FATURADO 28/35 dias ...").
function methodFromNotes(notes: string | null): string | null {
  if (!notes) return null;
  const up = notes.toUpperCase();
  const m = up.match(/PAGAMENTO:\s*([A-ZÀ-Ú ]+?)(?:\s+\d|\s+DIAS|·|$)/);
  const raw = m?.[1]?.trim();
  if (!raw) return null;
  return KNOWN_METHODS.find((k) => raw.startsWith(k)) || null;
}

async function main() {
  const commit = process.argv.includes("--commit");
  const invoices = await prisma.payableInvoice.findMany({
    select: {
      id: true, recurrence: true, recurring_bill_id: true, statement_section: true,
      payment_method: true, notes: true, digitable_line: true,
      purchase_order: { select: { payment_method: true } },
    },
  });

  const recCount: Record<string, number> = { MENSAL: 0, UNICA: 0 };
  const payCount: Record<string, number> = {};
  let recChanged = 0, payChanged = 0;

  for (const inv of invoices) {
    const updates: { recurrence?: string; payment_method?: string } = {};

    // Recorrência: só (re)classifica quem ainda está no default "UNICA".
    const isMonthly = inv.recurring_bill_id != null
      || (inv.statement_section != null && MONTHLY_SECTIONS.has(inv.statement_section));
    const targetRec = isMonthly ? "MENSAL" : "UNICA";
    recCount[targetRec]++;
    if (targetRec === "MENSAL" && inv.recurrence !== "MENSAL") {
      updates.recurrence = "MENSAL";
      recChanged++;
    }

    // Forma de pagamento: só preenche o que está vazio.
    if (!inv.payment_method) {
      const method = inv.purchase_order?.payment_method
        || methodFromNotes(inv.notes)
        || (inv.digitable_line ? "BOLETO" : null);
      if (method) {
        updates.payment_method = method;
        payCount[method] = (payCount[method] || 0) + 1;
        payChanged++;
      }
    }

    if (commit && Object.keys(updates).length > 0) {
      await prisma.payableInvoice.update({ where: { id: inv.id }, data: updates });
    }
  }

  console.log(`Títulos: ${invoices.length}`);
  console.log(`Recorrência final: MENSAL ${recCount.MENSAL} · UNICA ${recCount.UNICA} (marcaria ${recChanged} como MENSAL)`);
  console.log(`Forma de pagamento preenchida: ${payChanged}`, JSON.stringify(payCount));
  if (!commit) console.log("\n— DRY RUN — rode com --commit pra aplicar.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
