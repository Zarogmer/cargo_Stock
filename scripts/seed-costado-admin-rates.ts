import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// Administrativo do COSTADO — valor fixo por navio, ligado à função AUXILIAR
// OPERACIONAL (o Embarque usa ADMINISTRATIVO). Quem tem valor aqui entra no
// custo de cada Pagamento de Costado. Rodar de novo é seguro (upsert idempotente).
// Só o Lucas por enquanto; o RH configura os demais pela tela Valores › 👤.
const COSTADO_ADMIN_RATES: { employeeId: number; name: string; rate: number }[] = [
  { employeeId: 30, name: "LUCAS NUNES DE BARROS", rate: 150 },
];

async function main() {
  // Função AUXILIAR OPERACIONAL — não mexe se já existir (preserva unit/config).
  const fn = await prisma.jobFunction.findFirst({
    where: { name: { equals: "AUXILIAR OPERACIONAL", mode: "insensitive" } },
  });
  if (!fn) {
    console.error("❌ Função AUXILIAR OPERACIONAL não encontrada — crie em Valores primeiro.");
    process.exit(1);
  }
  // Categoriza como "Administrativo (Costado)" — é assim que o Pagamento de
  // Costado reconhece a função (pela categoria/unit, não pelo nome).
  if (fn.unit !== "ADMIN_COSTADO") {
    await prisma.jobFunction.update({ where: { id: fn.id }, data: { unit: "ADMIN_COSTADO" } });
    console.log(`Função AUXILIAR OPERACIONAL: #${fn.id} unit ${fn.unit} → ADMIN_COSTADO`);
  } else {
    console.log(`Função AUXILIAR OPERACIONAL: #${fn.id} (unit já = ADMIN_COSTADO)`);
  }

  for (const r of COSTADO_ADMIN_RATES) {
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
