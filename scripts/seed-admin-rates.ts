import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Pessoal administrativo pago por operação (navio). Quem tem valor aqui entra
// automaticamente no custo de cada Pagamento de Embarque (ver Financeiro). Os
// valores foram informados pelo RH. Rodar de novo é seguro (upsert idempotente).
const ADMIN_RATES: { employeeId: number; name: string; rate: number }[] = [
  { employeeId: 30, name: "LUCAS NUNES DE BARROS", rate: 150 },
  { employeeId: 6, name: "CAMILA FERREIRA DA SILVA", rate: 200 },
];

async function main() {
  // 1) Garante a função ADMINISTRATIVO (valor fixo por operação).
  const fn = await prisma.jobFunction.upsert({
    where: { name: "ADMINISTRATIVO" },
    update: {},
    create: {
      name: "ADMINISTRATIVO",
      description:
        "Pessoal administrativo — valor fixo por operação (navio). Entra no custo, fora da folha/Pluxee.",
      default_rate: 0,
      unit: "POR_OPERACAO",
      active: true,
    },
  });
  console.log(`Função ADMINISTRATIVO: #${fn.id}`);

  // 2) Valor especial por pessoa (employee_function_rates).
  for (const r of ADMIN_RATES) {
    const emp = await prisma.employee.findUnique({ where: { id: r.employeeId } });
    if (!emp) {
      console.log(`  ⚠️  #${r.employeeId} (${r.name}) não encontrado — pulado`);
      continue;
    }
    await prisma.employeeFunctionRate.upsert({
      where: { employee_id_function_id: { employee_id: r.employeeId, function_id: fn.id } },
      update: { rate: r.rate },
      create: { employee_id: r.employeeId, function_id: fn.id, rate: r.rate },
    });
    console.log(`  ✓ ${emp.name} (#${emp.id}) = R$ ${r.rate} [sector=${emp.sector} status=${emp.status}]`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
