import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";
import { parseStatementFile } from "@/lib/services/banking/ofx-file-provider";
import { importStatement } from "@/lib/services/banking/import";

const MAX_SIZE = 15 * 1024 * 1024;

// POST /api/financeiro/extrato/import — multipart FormData:
//   file: o .ofx exportado do banco
//   bank_account_id: conta de destino
// Idempotente: reenviar o mesmo arquivo não duplica movimentações.
export async function POST(request: NextRequest) {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Envie o arquivo no campo \"file\"" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "Arquivo maior que 15 MB" }, { status: 413 });
  }

  let statement;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    statement = parseStatementFile(buffer, file.name || "extrato.ofx");
  } catch (err) {
    await prisma.integrationLog.create({
      data: {
        provider: "OFX",
        operation: "import_extrato",
        ok: false,
        message: (err as Error).message,
        details: { filename: file.name } as object,
      },
    });
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  const warnings: string[] = [];

  // O banco é detectado NO ARQUIVO (não precisa selecionar). Roteia pra conta
  // daquele banco; se veio um id explícito, respeita.
  const explicitId = Number(form?.get("bank_account_id"));
  let account = null as Awaited<ReturnType<typeof prisma.bankAccount.findUnique>> | null;
  if (Number.isInteger(explicitId)) {
    account = await prisma.bankAccount.findUnique({ where: { id: explicitId } });
  } else if (statement.bank === "ITAU" || statement.bank === "SANTANDER") {
    account = await prisma.bankAccount.findFirst({ where: { bank: statement.bank }, orderBy: { id: "asc" } });
    if (!account) {
      return NextResponse.json(
        { error: `Extrato do ${statement.bank}, mas não há conta desse banco cadastrada. Cadastre em Contas bancárias.` },
        { status: 404 }
      );
    }
  } else {
    return NextResponse.json(
      { error: "Não reconheci o banco do arquivo (nem Itaú nem Santander). Verifique o OFX." },
      { status: 422 }
    );
  }
  if (!account) return NextResponse.json({ error: "Conta bancária não encontrada" }, { status: 404 });
  const accountId = account.id;

  if (statement.transactions.length === 0) {
    return NextResponse.json(
      { error: "Nenhuma movimentação encontrada no arquivo", warnings },
      { status: 422 }
    );
  }

  const result = await importStatement(accountId, statement, guard.userName);
  return NextResponse.json({
    result,
    bankDetected: statement.bank,
    accountDetected: statement.accountId,
    openingBalance: statement.openingBalance,
    warnings,
  });
}
