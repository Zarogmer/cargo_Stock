/**
 * Devolve o pessoal ADMINISTRATIVO pro custo dos navios.
 *
 * A baixa automática do navio finalizado (releaseFinishedShipAllocations)
 * marcava TODAS as alocações ativas como REMOVIDO — inclusive as de
 * kind=ADMINISTRATIVO, que não são escala, e sim o custo fixo do escritório no
 * navio. Resultado: assim que a data de saída passava, a seção Administrativo
 * do Resultado do Navio zerava. Adicionar à mão não resolvia: a varredura
 * seguinte baixava de novo (por isso há navios com a mesma pessoa repetida).
 *
 * O código já não baixa mais o ADMINISTRATIVO (src/lib/release-finished-ships.ts).
 * Este script conserta o que ficou pra trás:
 *   - por (navio, colaborador), reativa a alocação administrativa MAIS RECENTE
 *     que foi baixada pelo automático ("Navio finalizado…");
 *   - as duplicatas mais antigas da mesma dupla são apagadas (elas só existem
 *     porque o ciclo baixa → readiciona rodou várias vezes);
 *   - remoção feita À MÃO (motivo digitado) não é tocada: quem tirou, tirou.
 *
 * Uso (o padrão é simulação; --apply grava):
 *   npx tsx --env-file=.env.local scripts/restore-admin-allocations.ts
 *   npx tsx --env-file=.env.local scripts/restore-admin-allocations.ts --apply
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

type Row = {
  id: number;
  job_id: string;
  job_name: string | null;
  employee_id: number | null;
  employee_name: string | null;
  status: string;
  rate: unknown;
  added_at: Date;
};

async function main() {
  console.log(APPLY ? "MODO: APLICAR (grava no banco)" : "MODO: simulação (use --apply pra gravar)");

  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT a.id, a.job_id, j.name AS job_name, a.employee_id, e.name AS employee_name,
            a.status, a.rate, a.added_at
       FROM job_allocations a
       JOIN jobs j ON j.id = a.job_id
       LEFT JOIN employees e ON e.id = a.employee_id
      WHERE a.kind = 'ADMINISTRATIVO'
        AND (a.status = 'ATIVO'
             OR (a.status = 'REMOVIDO' AND a.removal_reason LIKE 'Navio finalizado%'))
      ORDER BY a.job_id, a.employee_id, a.added_at`,
  );

  // Uma linha por (navio, colaborador): fica a mais recente.
  const keep = new Map<string, Row>();
  const drop: Row[] = [];
  for (const r of rows) {
    const key = `${r.job_id}-${r.employee_id ?? "null"}`;
    const prev = keep.get(key);
    if (!prev) { keep.set(key, r); continue; }
    // ATIVO ganha de REMOVIDO; empatou, fica a mais nova.
    const winner =
      prev.status === "ATIVO" && r.status !== "ATIVO" ? prev
      : r.status === "ATIVO" && prev.status !== "ATIVO" ? r
      : r.added_at > prev.added_at ? r : prev;
    keep.set(key, winner);
    drop.push(winner === r ? prev : r);
  }

  const reactivate = Array.from(keep.values()).filter((r) => r.status !== "ATIVO");

  const byJob = new Map<string, string>();
  for (const r of rows) byJob.set(r.job_id, r.job_name || r.job_id);

  console.log(`\nAlocações administrativas olhadas: ${rows.length} em ${byJob.size} navios`);
  console.log(`Reativar (REMOVIDO pelo automático → ATIVO): ${reactivate.length}`);
  console.log(`Apagar duplicatas do ciclo baixa/readiciona: ${drop.length}\n`);

  for (const r of reactivate) {
    console.log(`  + #${r.id} ${r.employee_name || "?"} — ${byJob.get(r.job_id)} (R$ ${Number(r.rate)})`);
  }
  if (drop.length > 0) {
    console.log("");
    for (const r of drop) {
      console.log(`  - #${r.id} ${r.employee_name || "?"} — ${byJob.get(r.job_id)} (duplicata, added_at ${r.added_at.toISOString().slice(0, 16)})`);
    }
  }

  if (!APPLY) {
    console.log("\nNada gravado. Rode de novo com --apply pra valer.");
    return;
  }

  if (drop.length > 0) {
    await prisma.jobAllocation.deleteMany({ where: { id: { in: drop.map((r) => r.id) } } });
  }
  if (reactivate.length > 0) {
    await prisma.jobAllocation.updateMany({
      where: { id: { in: reactivate.map((r) => r.id) } },
      data: { status: "ATIVO", removed_at: null, removed_by: null, removal_reason: null },
    });
  }
  console.log(`\nPronto: ${reactivate.length} reativadas, ${drop.length} duplicatas apagadas.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
