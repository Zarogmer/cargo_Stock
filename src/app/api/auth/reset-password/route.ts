import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";

export async function POST(request: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Supervisor nao troca a propria senha: quem define e o RH.
    if (session.user.role === "SUPERVISOR") {
      return NextResponse.json(
        { error: "Sua senha e definida pelo RH." },
        { status: 403 }
      );
    }

    const { password } = await request.json();

    if (!password || password.length < 6) {
      return NextResponse.json(
        { error: "A senha deve ter pelo menos 6 caracteres." },
        { status: 400 }
      );
    }

    const password_hash = await bcrypt.hash(password, 12);

    await prisma.user.update({
      where: { id: session.user.id },
      data: { password_hash },
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error("Reset password error:", error);
    return NextResponse.json(
      { error: "Erro interno ao alterar senha." },
      { status: 500 }
    );
  }
}
