/**
 * Espelha os lançamentos da Demonstração Financeira (financial_statement_entries,
 * populados pela planilha via scripts/import-demonstracao-financeira.ts) como
 * títulos PAGOS no Contas a Pagar (payable_invoices, origin DEMONSTRACAO) —
 * desde 2026-07 a aba Demonstração Financeira é uma visão dos títulos com
 * statement_section, e o Contas a Pagar mostra tudo.
 *
 *   npx tsx scripts/sync-demonstracao-contas.ts             # dry-run
 *   npx tsx scripts/sync-demonstracao-contas.ts --commit    # grava (PROD)
 *   npx tsx scripts/sync-demonstracao-contas.ts --year=2025 --commit
 *
 * Insert-only e idempotente por "fingerprint" (seção + mês + descrição + valor):
 * cada linha da planilha só entra uma vez, mesmo rodando de novo depois de um
 * reimport (os ids de financial_statement_entries mudam a cada import, então o
 * casamento é por conteúdo, não por id). Limitação: título editado no Contas a
 * Pagar (descrição/valor) deixa de casar e o reimport criaria um duplicado —
 * nesse caso apague o duplicado lá.
 *
 * Escreve em PRODUÇÃO (DATABASE_URL aponta pro Postgres do Railway).
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");

const yearArg = process.argv.find((a) => a.startsWith("--year="));
const YEAR = yearArg ? Number(yearArg.split("=")[1]) : null;

/** Compara descrições ignorando acento, caixa e espaço sobrando. */
function norm(s: string) {
  return s
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();
}

function fmt(n: number) {
  return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Mês de referência YYYY-MM de uma data (UTC — as colunas são DATE puro). */
function refMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function fingerprint(section: string, month: string, description: string, value: number): string {
  return `${section}|${month}|${norm(description)}|${value.toFixed(2)}`;
}

async function main() {
  console.log(`🔁 Sync Demonstração → Contas a Pagar${YEAR ? ` (ano ${YEAR})` : ""}${COMMIT ? "" : "   (dry-run — nada é gravado)"}\n`);

  const entries = await prisma.financialStatementEntry.findMany({
    where: YEAR ? { year: YEAR } : undefined,
    orderBy: [{ year: "asc" }, { month: "asc" }, { source_row: "asc" }],
  });
  if (entries.length === 0) {
    console.log("Nada a sincronizar: financial_statement_entries está vazio no filtro.");
    return;
  }

  // Títulos já com seção — multiset por fingerprint (a planilha pode ter duas
  // linhas idênticas no mesmo mês, ex.: dois pagamentos iguais).
  const existing = await prisma.payableInvoice.findMany({
    where: { statement_section: { not: null } },
    select: { statement_section: true, description: true, amount: true, due_date: true, payment_date: true, created_at: true },
  });
  const have = new Map<string, number>();
  for (const inv of existing) {
    const d = inv.payment_date || inv.due_date || inv.created_at;
    const key = fingerprint(inv.statement_section!, refMonth(d), inv.description, Number(inv.amount));
    have.set(key, (have.get(key) || 0) + 1);
  }

  const toCreate: {
    description: string;
    amount: number;
    due_date: Date;
    payment_date: Date;
    paid_amount: number;
    statement_section: string;
    section: string; // só pro resumo
  }[] = [];

  for (const e of entries) {
    // Sem data na planilha (conta recorrente) → dia 1 do mês da aba.
    const date = e.entry_date ?? new Date(Date.UTC(e.year, e.month - 1, 1));
    const value = Number(e.value);
    const key = fingerprint(e.section, refMonth(date), e.description, value);
    const count = have.get(key) || 0;
    if (count > 0) {
      have.set(key, count - 1); // consome um existente
      continue;
    }
    toCreate.push({
      description: e.description,
      amount: value,
      due_date: date,
      payment_date: date,
      paid_amount: value,
      statement_section: e.section,
      section: e.section,
    });
  }

  console.log(`Lançamentos na demonstração: ${entries.length}`);
  console.log(`Já espelhados no Contas a Pagar: ${entries.length - toCreate.length}`);
  console.log(`A criar: ${toCreate.length}\n`);

  if (toCreate.length > 0) {
    const bySection = new Map<string, { n: number; total: number }>();
    for (const c of toCreate) {
      const agg = bySection.get(c.section) || { n: 0, total: 0 };
      agg.n += 1;
      agg.total += c.amount;
      bySection.set(c.section, agg);
    }
    for (const [sec, agg] of [...bySection.entries()].sort()) {
      console.log(`  ${sec.padEnd(4)} ${String(agg.n).padStart(4)} título(s)   R$ ${fmt(agg.total).padStart(14)}`);
    }
    console.log("");
  }

  if (!COMMIT) {
    console.log("Dry-run: nada gravado. Rode com --commit pra sincronizar.");
    return;
  }

  // PAGO com pagamento na data do lançamento: a planilha registra o que já foi
  // pago no mês — o título nasce quitado, só pra histórico/relatório.
  await prisma.payableInvoice.createMany({
    data: toCreate.map((c) => ({
      description: c.description,
      amount: c.amount,
      due_date: c.due_date,
      payment_date: c.payment_date,
      paid_amount: c.paid_amount,
      statement_section: c.statement_section,
      status: "PAGO" as const,
      origin: "DEMONSTRACAO" as const,
      paid_by: "sync-demonstracao-contas",
      paid_at: new Date(),
      created_by: "sync-demonstracao-contas",
    })),
  });
  console.log(`✅ ${toCreate.length} título(s) criado(s) no Contas a Pagar.`);
}

main()
  .catch((err) => {
    console.error("❌ Erro:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
