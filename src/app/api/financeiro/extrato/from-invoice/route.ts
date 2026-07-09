import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

// POST /api/financeiro/extrato/from-invoice  { bank_account_id, invoice_id }
// Adiciona um título da Contas a Pagar como uma LINHA no extrato da conta
// (banco) escolhida — pra entrar na conciliação/planilha pagamentos que não
// vieram no OFX (dinheiro, pix, outro banco). Já entra marcado como conciliado.
// Idempotente: adicionar o mesmo título duas vezes cai no dedupe.
export async function POST(request: NextRequest) {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const body = await request.json().catch(() => null);
  const bankAccountId = Number(body?.bank_account_id);
  const invoiceId = String(body?.invoice_id || "");
  if (!Number.isInteger(bankAccountId) || !invoiceId) {
    return NextResponse.json({ error: "Informe bank_account_id e invoice_id" }, { status: 400 });
  }

  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "Conta bancária não encontrada" }, { status: 404 });

  const inv = await prisma.payableInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv) return NextResponse.json({ error: "Título não encontrado" }, { status: 404 });

  // Data: pagamento > vencimento > criação. Valor: débito (negativo).
  const when = inv.payment_date ?? inv.due_date ?? inv.created_at;
  const posted = new Date(when);
  const value = Number(inv.paid_amount ?? inv.amount);
  const amount = new Prisma.Decimal((-Math.abs(value)).toFixed(2));
  const description = inv.description;

  const iso = posted.toISOString().slice(0, 10);
  const cents = Math.round(Math.abs(value) * 100);
  const norm = description.replace(/\s+/g, " ").trim().toUpperCase();
  const dedupe_hash = createHash("sha256").update(`${bankAccountId}|${iso}|${-cents}|${norm}|manual`).digest("hex");

  try {
    const tx = await prisma.bankTransaction.create({
      data: {
        bank_account_id: bankAccountId,
        posted_at: posted,
        amount,
        description,
        payee_name: inv.payee_name,
        payee_document: inv.payee_document,
        external_id: null,
        dedupe_hash,
        reconcilable: true,
        source: "OFX_FILE", // não há enum MANUAL; marcamos a origem no raw
        raw: { manual: true, from: "CONTAS_A_PAGAR", invoice_id: invoiceId } as Prisma.InputJsonValue,
        imported_by: guard.userName,
        review_status: "CONCILIADO",
        review_note: description,
        reviewed_by: guard.userName,
        reviewed_at: new Date(),
      },
    });
    return NextResponse.json({ transaction_id: tx.id, status: "created" });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json({ status: "duplicate", error: "Este título já está no extrato desta conta." }, { status: 409 });
    }
    throw err;
  }
}
