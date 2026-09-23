/**
 * Faxina do setor Administrativo (pedido do Guilherme, 23/09/2026):
 *
 *  1. Alocações administrativas ÓRFÃS — colaborador apagado deixa
 *     job_allocations.employee_id = NULL (onDelete: SetNull) e a linha vira um
 *     "—" fantasma na seção Administrativo do Resultado do Navio. Sem gente,
 *     sem custo: some. (Só ADMINISTRATIVO: no operacional a linha órfã ainda
 *     carrega a função e vale como histórico.)
 *
 *  2. Conta de login de quem saiu da empresa (--conta email@...).
 *     O histórico em login_logs fica — é log de auditoria, não cadastro.
 *
 *  3. Função "ADMINISTRATIVO" gravada como CARGO do colaborador. Administrativo
 *     é SETOR, não função: a função ADMINISTRATIVO só existe como carregador
 *     interno de job_allocations.function_id e não aparece em RH › Funções nem
 *     no Financeiro › Valores. Quem tem cargo de verdade (ANALISTA RH, AUXILIAR
 *     DE ESCRITORIO) mantém; o resto fica sem função.
 *
 * Uso (o padrão é simulação; --apply grava):
 *   npx tsx --env-file=.env.local scripts/cleanup-admin-sector.ts
 *   npx tsx --env-file=.env.local scripts/cleanup-admin-sector.ts --apply --conta sandra@cargostock.local
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const contaIdx = process.argv.indexOf("--conta");
const CONTA = contaIdx >= 0 ? process.argv[contaIdx + 1] : null;

async function main() {
  console.log(APPLY ? "MODO: APLICAR (grava no banco)" : "MODO: simulação (use --apply pra gravar)");

  // 1. Alocações administrativas sem colaborador.
  const orfas = await prisma.$queryRawUnsafe<{ id: number; navio: string | null; status: string }[]>(
    `SELECT a.id, COALESCE(s.name, j.name) AS navio, a.status
       FROM job_allocations a
       JOIN jobs j ON j.id = a.job_id
       LEFT JOIN ships s ON s.id = j.ship_id
      WHERE a.employee_id IS NULL AND a.kind = 'ADMINISTRATIVO'
      ORDER BY a.id`,
  );
  console.log(`\n1) Alocações administrativas órfãs: ${orfas.length}`);
  for (const o of orfas) console.log(`   - #${o.id} ${o.navio} (${o.status})`);

  // 2. Conta de login.
  const contas = CONTA
    ? await prisma.$queryRawUnsafe<{ id: string; email: string; full_name: string; role: string }[]>(
        `SELECT id, email, full_name, role::text AS role FROM users WHERE email = $1`, CONTA)
    : [];
  console.log(`\n2) Conta de login a apagar: ${CONTA ? (contas.length ? contas.map((c) => `${c.full_name} <${c.email}> [${c.role}]`).join(", ") : "não encontrada") : "(nenhuma pedida)"}`);

  // 3. Cargo ADMINISTRATIVO gravado no colaborador.
  const cargos = await prisma.$queryRawUnsafe<{ id: number; name: string }[]>(
    `SELECT id, name FROM employees WHERE UPPER(COALESCE(role, '')) = 'ADMINISTRATIVO' ORDER BY name`,
  );
  console.log(`\n3) Colaboradores com "função" ADMINISTRATIVO: ${cargos.length}`);
  for (const c of cargos) console.log(`   - #${c.id} ${c.name} → sem função (fica só o setor)`);

  if (!APPLY) {
    console.log("\nNada gravado. Rode de novo com --apply pra valer.");
    return;
  }

  if (orfas.length > 0) {
    await prisma.jobAllocation.deleteMany({ where: { id: { in: orfas.map((o) => o.id) } } });
  }
  if (contas.length > 0) {
    await prisma.user.deleteMany({ where: { email: CONTA! } });
  }
  if (cargos.length > 0) {
    await prisma.employee.updateMany({ where: { id: { in: cargos.map((c) => c.id) } }, data: { role: null } });
  }
  console.log(`\nPronto: ${orfas.length} alocações órfãs apagadas, ${contas.length} conta(s) removida(s), ${cargos.length} cargo(s) limpo(s).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
