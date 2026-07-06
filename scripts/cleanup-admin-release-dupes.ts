import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Deduplica as linhas ADMINISTRATIVO acumuladas pelo vaivém entre o auto-add
// do Financeiro e a liberação de navio finalizado (release-finished-ships.ts):
// em navio já saído, o admin era re-inserido num load e marcado REMOVIDO
// ("Navio finalizado ...") no seguinte — o MV GCL PARADIP chegou a ~15 cópias
// da mesma pessoa. O código de leitura já ignora as duplicatas
// (dedupeWorkedAllocations), este script só tira o lixo do banco.
//
// Regra por (job, funcionário): mantém UMA linha de presença — a ATIVA se
// existir, senão a REMOVIDO "Navio finalizado" mais recente (id maior) — e
// apaga as demais REMOVIDO "Navio finalizado". Remoção manual (substituição,
// falta) e SUBSTITUIDO nunca são tocadas.
//
// ⚠️  DATABASE_URL aponta pra PRODUÇÃO. Dry-run por padrão; só apaga com:
//     npx tsx scripts/cleanup-admin-release-dupes.ts --apply
const APPLY = process.argv.includes("--apply");
const RELEASE_REASON_PREFIX = "Navio finalizado";

async function main() {
  const rows = await prisma.jobAllocation.findMany({
    where: { kind: "ADMINISTRATIVO" },
    select: {
      id: true,
      job_id: true,
      employee_id: true,
      status: true,
      removal_reason: true,
      jobs: { select: { name: true } },
      employees: { select: { name: true } },
    },
    orderBy: { id: "asc" },
  });

  const isReleased = (r: { status: string; removal_reason: string | null }) =>
    r.status === "REMOVIDO" && (r.removal_reason || "").startsWith(RELEASE_REASON_PREFIX);

  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    if (r.employee_id == null) continue;
    const key = `${r.job_id}|${r.employee_id}`;
    const group = byKey.get(key) || [];
    group.push(r);
    byKey.set(key, group);
  }

  const toDelete: number[] = [];
  for (const group of byKey.values()) {
    const released = group.filter(isReleased);
    if (released.length === 0) continue;
    const hasActive = group.some((r) => r.status === "ATIVO");
    // ATIVA presente = ela é a presença; senão a liberada mais recente fica.
    const keep = hasActive ? null : released[released.length - 1];
    const extras = released.filter((r) => r !== keep);
    if (extras.length === 0) continue;
    const sample = group[0];
    console.log(
      `${sample.jobs?.name || sample.job_id} — ${sample.employees?.name || `#${sample.employee_id}`}: ` +
      `${group.length} linha(s), apagando ${extras.length} duplicata(s) REMOVIDO "${RELEASE_REASON_PREFIX}..." ` +
      `(mantém ${hasActive ? "a ATIVA" : `#${keep!.id}`})`,
    );
    toDelete.push(...extras.map((r) => r.id));
  }

  if (toDelete.length === 0) {
    console.log("Nada a limpar — nenhuma duplicata encontrada.");
    return;
  }
  if (!APPLY) {
    console.log(`\nDry-run: ${toDelete.length} linha(s) seriam apagadas. Rode com --apply pra executar.`);
    return;
  }
  const res = await prisma.jobAllocation.deleteMany({ where: { id: { in: toDelete } } });
  console.log(`\n✓ ${res.count} linha(s) apagada(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
