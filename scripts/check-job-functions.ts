import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
async function run() {
  const fns = await p.jobFunction.findMany();
  console.log("Total job_functions:", fns.length);
  for (const f of fns) {
    console.log(`  ${f.name} | ${f.default_rate} | ${f.unit} | active=${f.active}`);
  }
  await p.$disconnect();
}
run();
