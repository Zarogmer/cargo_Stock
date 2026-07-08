import { NextRequest, NextResponse } from "next/server";
import type { BankKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

const BANKS: BankKind[] = ["ITAU", "SANTANDER", "OUTRO"];

// GET /api/financeiro/contas-bancarias — contas + contagem de movimentações.
export async function GET() {
  const guard = await requireFinance("view");
  if (guard.error) return guard.error;

  const accounts = await prisma.bankAccount.findMany({
    orderBy: [{ active: "desc" }, { nickname: "asc" }],
    include: { _count: { select: { transactions: true } } },
  });
  return NextResponse.json({ accounts });
}

// POST /api/financeiro/contas-bancarias — cadastra uma conta.
export async function POST(request: NextRequest) {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "JSON inválido" }, { status: 400 });

  const bank = String(body.bank || "").toUpperCase() as BankKind;
  const nickname = String(body.nickname || "").trim();
  if (!BANKS.includes(bank)) return NextResponse.json({ error: "Banco inválido" }, { status: 400 });
  if (!nickname) return NextResponse.json({ error: "Informe um apelido para a conta" }, { status: 400 });

  const account = await prisma.bankAccount.create({
    data: {
      bank,
      nickname,
      agency: body.agency ? String(body.agency).trim() : null,
      account_number: body.account_number ? String(body.account_number).trim() : null,
      created_by: guard.userName,
    },
    include: { _count: { select: { transactions: true } } },
  });
  return NextResponse.json({ account }, { status: 201 });
}
