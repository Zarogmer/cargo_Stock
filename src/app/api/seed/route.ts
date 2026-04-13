import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

// One-time seed endpoint - creates initial users
// ACCESS: GET /api/seed
// DELETE THIS FILE after seeding!
export async function GET() {
  try {
    const users = [
      {
        email: "chico@cargostock.local",
        full_name: "Chico",
        role: "EXECUTIVO" as const,
        password: "cargo2024",
      },
      {
        email: "guigui12306@gmail.com",
        full_name: "Guilherme",
        role: "TECNOLOGIA" as const,
        password: "cargo2024",
      },
    ];

    const created = [];

    for (const u of users) {
      const password_hash = await bcrypt.hash(u.password, 12);
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
      created.push({ email: user.email, role: user.role });
    }

    return NextResponse.json({
      success: true,
      message: "Users created! Delete /api/seed after this.",
      users: created,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
