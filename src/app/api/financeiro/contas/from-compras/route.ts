import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";
import { AUTO_APPROVE_SETTING_KEY, autoApproveReason } from "@/lib/services/payable-status";

// Puxar do Controle de Compras (purchase_orders) para o Contas a Pagar.
// GET  → lista as compras que ainda NÃO viraram título (payable_invoice null).
// POST → cria um título por compra selecionada, com o vínculo purchase_order_id.

// GET /api/financeiro/contas/from-compras — compras disponíveis pra puxar.
export async function GET() {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const purchases = await prisma.purchaseOrder.findMany({
    where: {
      payable_invoice: null,
      // Compra no cartão só marca qual cartão foi usado — a fatura vira 1 boleto
      // à parte, então não entra aqui como título individual.
      payment_method: { notIn: ["CARTÃO DE CRÉDITO", "CARTÃO DE DÉBITO"] },
    },
    orderBy: [{ purchase_date: "desc" }, { created_at: "desc" }],
    take: 300,
    select: {
      id: true,
      description: true,
      supplier: true,
      department: true,
      purchase_date: true,
      total_value: true,
      payment_method: true,
      payment_term_days: true,
      ship_name: true,
      notes: true,
    },
  });

  return NextResponse.json({ purchases });
}

// POST /api/financeiro/contas/from-compras — cria títulos a partir das compras.
// Body: { purchase_ids: string[] }. Casa o FORNECEDOR (texto da compra) com um
// fornecedor cadastrado pelo nome; não achando, guarda como favorecido.
export async function POST(request: NextRequest) {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const body = await request.json().catch(() => null);
  const ids: string[] = Array.isArray(body?.purchase_ids)
    ? body.purchase_ids.filter((x: unknown) => typeof x === "string")
    : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "Nenhuma compra selecionada" }, { status: 400 });
  }

  const autoSetting = await prisma.appSetting.findUnique({
    where: { key: AUTO_APPROVE_SETTING_KEY },
  });

  // Fornecedores cadastrados, pra casar pelo nome (case-insensitive).
  const suppliers = await prisma.supplier.findMany({ select: { id: true, name: true } });
  const byName = new Map(suppliers.map((s) => [s.name.trim().toLowerCase(), s.id]));

  let created = 0;
  let skipped = 0;

  for (const id of ids) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: { payable_invoice: { select: { id: true } } },
    });
    // Já virou título ou sumiu — ignora (idempotente).
    if (!po || po.payable_invoice) {
      skipped++;
      continue;
    }

    const amount = Number(po.total_value) || 0;
    const supplierId = po.supplier ? byName.get(po.supplier.trim().toLowerCase()) ?? null : null;
    const autoReason = autoApproveReason(amount, autoSetting?.value);

    // Vencimento: FATURADO com prazo em dias vence em purchase_date + dias
    // (controle de meses futuros). Sem prazo, cai na própria data da compra
    // (que serve de referência do mês no controle).
    let dueDate: Date | null = po.purchase_date ?? null;
    if (po.payment_method === "FATURADO" && po.payment_term_days && po.purchase_date) {
      const d = new Date(po.purchase_date);
      d.setUTCDate(d.getUTCDate() + po.payment_term_days);
      dueDate = d;
    }

    // Observação: junta navio, forma de pagamento (+ prazo) e a nota original.
    const pgtoLabel =
      po.payment_method === "FATURADO" && po.payment_term_days
        ? `Pagamento: FATURADO ${po.payment_term_days} dias`
        : po.payment_method
          ? `Pagamento: ${po.payment_method}`
          : null;
    const noteParts = [
      po.ship_name ? `Navio: ${po.ship_name}` : null,
      pgtoLabel,
      po.notes || null,
    ].filter(Boolean);

    await prisma.payableInvoice.create({
      data: {
        description: po.description,
        amount: new Prisma.Decimal(amount.toFixed(2)),
        due_date: dueDate,
        supplier_id: supplierId,
        payee_name: supplierId ? null : po.supplier?.trim() || null,
        expense_type: po.department || null,
        notes: noteParts.length ? noteParts.join(" · ") : null,
        origin: "COMPRA",
        purchase_order_id: po.id,
        status: autoReason ? "APROVADO" : "AGUARDANDO_APROVACAO",
        approved_by: autoReason,
        approved_at: autoReason ? new Date() : null,
        created_by: guard.userName,
      },
    });
    created++;
  }

  return NextResponse.json({ created, skipped }, { status: 201 });
}
