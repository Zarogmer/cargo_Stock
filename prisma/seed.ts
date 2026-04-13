import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding database...");

  // Create default users (matching existing Supabase auth users)
  // Update the passwords below to match your actual passwords
  const users = [
    {
      email: "chico@cargostock.local",
      full_name: "Chico",
      role: "EXECUTIVO" as const,
      password: "cargo2024", // Change this to the actual password
    },
    {
      email: "guigui12306@gmail.com",
      full_name: "Guilherme",
      role: "TECNOLOGIA" as const,
      password: "cargo2024", // Change this to the actual password
    },
  ];

  for (const u of users) {
    const password_hash = await bcrypt.hash(u.password, 12);
    await prisma.user.upsert({
      where: { email: u.email },
      update: { full_name: u.full_name, role: u.role, password_hash },
      create: {
        email: u.email,
        full_name: u.full_name,
        role: u.role,
        password_hash,
      },
    });
    console.log(`  User: ${u.email} (${u.role})`);
  }

  console.log("Seed complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
