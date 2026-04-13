import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

// One-time seed endpoint - creates all users
// ACCESS: GET /api/seed
// DELETE THIS FILE after seeding!
export async function GET() {
  try {
    const PASSWORD = "cargo2026";

    const users = [
      { email: "camila@cargostock.local", full_name: "Camila", role: "RH" as const },
      { email: "chico@cargostock.local", full_name: "Chico", role: "EXECUTIVO" as const },
      { email: "damiao@cargostock.local", full_name: "Damião", role: "MANUTENCAO" as const },
      { email: "diogo@cargostock.local", full_name: "Diogo", role: "MANUTENCAO" as const },
      { email: "guigui12306@gmail.com", full_name: "Guilherme", role: "TECNOLOGIA" as const },
      { email: "josue@cargostock.local", full_name: "Josué", role: "MANUTENCAO" as const },
      { email: "lucas@cargostock.local", full_name: "Lucas", role: "MANUTENCAO" as const },
      { email: "rose@cargostock.local", full_name: "Rose", role: "RH" as const },
      { email: "sandra@cargostock.local", full_name: "Sandra", role: "FINANCEIRO" as const },
    ];

    const password_hash = await bcrypt.hash(PASSWORD, 12);
    const created = [];

    for (const u of users) {
      const user = await prisma.user.upsert({
        where: { email: u.email },
        update: { full_name: u.full_name, role: u.role, password_hash },
        create: {
          email: u.email,
          full_name: u.full_name,
          role: u.role,
          password_hash,
        },
      });
      created.push({ email: user.email, name: user.full_name, role: user.role });
    }

    return NextResponse.json({
      success: true,
      message: `${created.length} users created with password: ${PASSWORD}`,
      users: created,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
