import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  const all = await prisma.employee.findMany({ orderBy: { name: "asc" } });
  console.log(`Total no banco: ${all.length}`);
  console.log(`\nPor status:`);
  const byStatus: Record<string, number> = {};
  for (const e of all) {
    byStatus[e.status ?? "null"] = (byStatus[e.status ?? "null"] ?? 0) + 1;
  }
  console.table(byStatus);

  console.log(`\nPor setor:`);
  const bySector: Record<string, number> = {};
  for (const e of all) {
    bySector[e.sector ?? "null"] = (bySector[e.sector ?? "null"] ?? 0) + 1;
  }
  console.table(bySector);

  console.log(`\nPor função:`);
  const byRole: Record<string, number> = {};
  for (const e of all) {
    byRole[e.role ?? "null"] = (byRole[e.role ?? "null"] ?? 0) + 1;
  }
  console.table(byRole);

  console.log(`\nAmostra (3 funcionários):`);
  for (const e of all.slice(0, 3)) {
    console.log({
      name: e.name,
      cpf: e.cpf,
      status: e.status,
      sector: e.sector,
      role: e.role,
      bank: `${e.bank_name} ag${e.bank_agency} cc${e.bank_account}`,
      sizes: `bota=${e.boot_size} blusa=${e.shirt_size} bermuda=${e.bermuda_size}`,
      aso: `${e.aso_status} (${e.last_aso_date})`,
      training: e.nrs_training,
    });
  }
  await prisma.$disconnect();
}

main();
