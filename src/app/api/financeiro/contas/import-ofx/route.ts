import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { Prisma, type BankKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";
import { parseOfx } from "@/lib/services/banking/ofx";
import { looksLikeOfx } from "@/lib/services/banking/ofx-file-provider";

const MAX_SIZE = 15 * 1024 * 1024;
const BANK_LABEL: Record<BankKind, string> = { ITAU: "Itaú", SANTANDER: "Santander", OUTRO: "Outro" };

// POST /api/financeiro/contas/import-ofx — multipart { file }
// Gera contas a pagar (status PAGO) a partir dos DÉBITOS do extrato: cada
// pagamento vira uma linha do controle, com fornecedor/valor/banco/data de
// pagamento vindos do OFX. Vencimento e NF ficam pra completar (o OFX não tem).
// Idempotente por import_hash. Créditos e transferências internas são ignorados.
export async function POST(request: NextRequest) {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Envie o arquivo no campo \"file\"" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) return NextResponse.json({ error: "Arquivo maior que 15 MB" }, { status: 413 });

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!looksLikeOfx(buffer)) {
    return NextResponse.json({ error: "Arquivo não reconhecido como OFX (.ofx)" }, { status: 400 });
  }

  const statement = parseOfx(buffer.toString("latin1"));
  const bankLabel = BANK_LABEL[statement.bank];

  // Só débitos conciliáveis (pagamentos de verdade); crédito = recebimento,
  // transferência interna = sweep automático.
  const debits = statement.transactions.filter((t) => t.amount < 0 && t.reconcilable);

  const seen = new Map<string, number>();
  let created = 0;
  let duplicates = 0;

  for (const t of debits) {
    const iso = t.postedAt.toISOString().slice(0, 10);
    const cents = Math.round(Math.abs(t.amount) * 100);
    const base = `${statement.bank}|${iso}|${cents}|${(t.description || "").toUpperCase().replace(/\s+/g, " ").trim()}`;
    const occ = seen.get(base) ?? 0;
    seen.set(base, occ + 1);
    const importHash = createHash("sha256").update(`${base}|${occ}`).digest("hex");

    // Casa fornecedor por CNPJ, se veio no memo.
    let supplierId: number | null = null;
    if (t.payeeDocument) {
      const sup = await prisma.supplier.findUnique({ where: { cnpj: t.payeeDocument }, select: { id: true } });
      supplierId = sup?.id ?? null;
    }

    const value = new Prisma.Decimal(Math.abs(t.amount).toFixed(2));
    try {
      await prisma.payableInvoice.create({
        data: {
          description: t.payeeName || t.description || "Pagamento",
          amount: value,
          paid_amount: value,
          payment_date: t.postedAt,
          bank: bankLabel,
          payee_name: t.payeeName,
          payee_document: t.payeeDocument,
          supplier_id: supplierId,
          origin: "EXTRATO",
          status: "PAGO",
          paid_by: `Extrato ${bankLabel}`,
          paid_at: t.postedAt,
          import_hash: importHash,
          created_by: guard.userName,
        },
      });
      created++;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") duplicates++;
      else throw err;
    }
  }

  await prisma.integrationLog.create({
    data: {
      provider: "OFX",
      operation: "import_contas_pagar",
      ok: true,
      message: `${bankLabel}: ${created} pagamento(s) novo(s), ${duplicates} já existiam (de ${debits.length} débitos)`,
    },
  });

  return NextResponse.json({
    bank: statement.bank,
    created,
    duplicates,
    debits: debits.length,
    skippedCredits: statement.transactions.filter((t) => t.amount > 0).length,
  });
}
