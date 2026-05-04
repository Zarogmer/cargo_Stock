import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

async function run() {
  const r = await p.employee.updateMany({
    where: { role: "INATIVO" },
    data: { role: null },
  });
  console.log("Cleaned roles:", r.count);
  await p.$disconnect();
}
run();
