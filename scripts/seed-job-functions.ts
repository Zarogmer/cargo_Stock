/**
 * Pre-populates the job_functions table with the distinct roles
 * already present in the employees table. Default rate = 0; the user
 * sets the actual rates via UI.
 *
 * Run with: npx tsx scripts/seed-job-functions.ts
 *
 * Idempotent: skips functions that already exist.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const distinctRoles = await prisma.employee.findMany({
    where: { role: { not: null } },
    select: { role: true },
    distinct: ["role"],
  });

  const roleNames = distinctRoles
    .map((r) => r.role!)
    .filter((r) => r.trim().length > 0)
    .sort();

  console.log(`Found ${roleNames.length} distinct roles:`, roleNames);

  let created = 0;
  let skipped = 0;

  for (const name of roleNames) {
    const existing = await prisma.jobFunction.findUnique({ where: { name } });
    if (existing) {
      skipped++;
      continue;
    }
    await prisma.jobFunction.create({
      data: {
        name,
        default_rate: 0,
        unit: "POR_NAVIO",
        active: true,
      },
    });
    created++;
  }

  console.log(`\nCreated: ${created}`);
  console.log(`Skipped (already existed): ${skipped}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
