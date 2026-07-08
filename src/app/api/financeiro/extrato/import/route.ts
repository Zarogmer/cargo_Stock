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
  const accountId = Number(form?.get("bank_account_id"));
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Envie o arquivo no campo \"file\"" }, { status: 400 });
  }
  if (!Number.isInteger(accountId)) {
    return NextResponse.json({ error: "Selecione a conta bancária de destino" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "Arquivo maior que 15 MB" }, { status: 413 });
  }

  const account = await prisma.bankAccount.findUnique({ where: { id: accountId } });
  if (!account) return NextResponse.json({ error: "Conta bancária não encontrada" }, { status: 404 });

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

  // Aviso (não bloqueia) se o banco/conta do arquivo diverge da conta escolhida
  // — evita jogar extrato do Itaú numa conta marcada como Santander.
  const warnings: string[] = [];
  if (statement.bank !== "OUTRO" && account.bank !== "OUTRO" && statement.bank !== account.bank) {
    warnings.push(
      `O arquivo parece ser do ${statement.bank}, mas a conta selecionada é ${account.bank}.`
    );
  }
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
