import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import type { Role } from "@/types/database";
import bcrypt from "bcryptjs";

// Cadastro de logins de SUPERVISOR pelo RH (aba Rh › Usuários). Esta rota SÓ
// cria/edita/apaga usuários com papel SUPERVISOR — os demais papéis seguem
// sendo gerenciados pela Tecnologia, fora daqui. Quem pode operar: qualquer
// papel que cria colaboradores (RH, Gestor, Executivo, Financeiro, Tecnologia).

async function requireManager() {
  const session = await auth();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Não autenticado" }, { status: 401 }) };
  }
  const role = (session.user as { role?: Role }).role as Role;
  if (!hasPermission(role, "COLABORADORES", "create")) {
    return { error: NextResponse.json({ error: "Sem permissão" }, { status: 403 }) };
  }
  return { session, role };
}

const SELECT = {
  id: true,
  email: true,
  full_name: true,
  employee_id: true,
  created_at: true,
  employees: { select: { name: true, role: true } },
} as const;

export async function GET() {
  const guard = await requireManager();
  if ("error" in guard) return guard.error;

  const users = await prisma.user.findMany({
    where: { role: "SUPERVISOR" },
    select: SELECT,
    orderBy: { full_name: "asc" },
  });
  return NextResponse.json({ data: users });
}

export async function POST(request: NextRequest) {
  const guard = await requireManager();
  if ("error" in guard) return guard.error;

  try {
    const body = await request.json();
    const email = String(body.email || "").toLowerCase().trim();
    const password = String(body.password || "");
    const full_name = String(body.full_name || "").trim();
    const employee_id = body.employee_id ? Number(body.employee_id) : null;

    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "Informe um email válido (é o login)." }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ error: "A senha deve ter pelo menos 6 caracteres." }, { status: 400 });
    }
    if (!full_name) {
      return NextResponse.json({ error: "Informe o nome completo." }, { status: 400 });
    }
    if (!employee_id) {
      // Sem colaborador vinculado o supervisor não enxerga navio nenhum — a
      // escala é a fonte da visibilidade dele.
      return NextResponse.json({ error: "Selecione o colaborador vinculado." }, { status: 400 });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password_hash, full_name, role: "SUPERVISOR", employee_id },
      select: SELECT,
    });
    return NextResponse.json({ data: user });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "P2002") {
      return NextResponse.json({ error: "Já existe um usuário com este email." }, { status: 409 });
    }
    console.error("POST /api/rh/usuarios:", err);
    return NextResponse.json({ error: "Erro ao criar usuário." }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const guard = await requireManager();
  if ("error" in guard) return guard.error;

  try {
    const body = await request.json();
    const id = String(body.id || "");
    if (!id) return NextResponse.json({ error: "id obrigatório" }, { status: 400 });

    // Trava de segurança: por aqui só se mexe em SUPERVISOR (o RH não pode
    // trocar a senha de um Executivo, por exemplo).
    const target = await prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!target || target.role !== "SUPERVISOR") {
      return NextResponse.json({ error: "Usuário não encontrado." }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (body.full_name !== undefined) {
      const v = String(body.full_name).trim();
      if (!v) return NextResponse.json({ error: "Informe o nome completo." }, { status: 400 });
      data.full_name = v;
    }
    if (body.email !== undefined) {
      const v = String(body.email).toLowerCase().trim();
      if (!v.includes("@")) return NextResponse.json({ error: "Email inválido." }, { status: 400 });
      data.email = v;
    }
    if (body.employee_id !== undefined) {
      data.employee_id = body.employee_id ? Number(body.employee_id) : null;
    }
    if (body.password) {
      const p = String(body.password);
      if (p.length < 6) {
        return NextResponse.json({ error: "A senha deve ter pelo menos 6 caracteres." }, { status: 400 });
      }
      data.password_hash = await bcrypt.hash(p, 10);
    }

    const user = await prisma.user.update({ where: { id }, data, select: SELECT });
    return NextResponse.json({ data: user });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "P2002") {
      return NextResponse.json({ error: "Já existe um usuário com este email." }, { status: 409 });
    }
    console.error("PATCH /api/rh/usuarios:", err);
    return NextResponse.json({ error: "Erro ao salvar usuário." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await requireManager();
  if ("error" in guard) return guard.error;

  try {
    const id = request.nextUrl.searchParams.get("id") || "";
    if (!id) return NextResponse.json({ error: "id obrigatório" }, { status: 400 });

    const target = await prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!target || target.role !== "SUPERVISOR") {
      return NextResponse.json({ error: "Usuário não encontrado." }, { status: 404 });
    }

    await prisma.user.delete({ where: { id } });
    return NextResponse.json({ data: { ok: true } });
  } catch (err) {
    console.error("DELETE /api/rh/usuarios:", err);
    return NextResponse.json({ error: "Erro ao excluir usuário." }, { status: 500 });
  }
}
