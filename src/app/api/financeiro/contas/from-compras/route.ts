import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { requireFinance } from "@/lib/financeiro-api";
import { hasPermission, canAccessFinanceiroBanco, COMPRAS_ROLES } from "@/lib/rbac";
import type { Role } from "@/types/database";
import { AUTO_APPROVE_SETTING_KEY, autoApproveReason } from "@/lib/services/payable-status";

// Puxar do Controle de Compras (purchase_orders) para o Contas a Pagar.
// GET  → lista as compras que ainda NÃO viraram título (sem payable_invoices).
// POST → cria os títulos por compra selecionada, com o vínculo purchase_order_id.
// FATURADO parcelado (payment_terms) gera um título por parcela, com o valor
// dividido igualmente entre elas.
// TODA compra entra — inclusive cartão de crédito/débito (pedido de 2026-08:
// o gestor lança a compra e o Financeiro confere no Contas a Pagar). O título
// do cartão carrega o final/fechamento na observação pra conferir com a fatura,
// que continua chegando como boleto à parte.

// GET /api/financeiro/contas/from-compras — compras disponíveis pra puxar.
export async function GET() {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const purchases = await prisma.purchaseOrder.findMany({
    where: {
      payable_invoices: { none: {} },
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
      payment_terms: true,
      ship_name: true,
      notes: true,
      batch_id: true,
    },
  });

  // Lote do Escanear já lançado: o título aponta só pra 1ª compra do lote, as
  // demais não têm título próprio de propósito — não podem voltar pra lista.
  const batchIds = [...new Set(purchases.map((p) => p.batch_id).filter((b): b is string => !!b))];
  const doneBatches = batchIds.length
    ? new Set(
        (await prisma.payableInvoice.findMany({
          where: { purchase_batch_id: { in: batchIds } },
          select: { purchase_batch_id: true },
        })).map((i) => i.purchase_batch_id),
      )
    : new Set<string | null>();

  return NextResponse.json({ purchases: purchases.filter((p) => !p.batch_id || !doneBatches.has(p.batch_id)) });
}

// POST /api/financeiro/contas/from-compras — cria títulos a partir das compras.
// Body: { purchase_ids: string[] }. Casa o FORNECEDOR (texto da compra) com um
// fornecedor cadastrado pelo nome; não achando, guarda como favorecido.
// created conta TÍTULOS (uma compra parcelada em 3 soma 3).
// Compras do mesmo lote (batch_id — itens de UMA nota lida pelo Escanear) viram
// UM lançamento com a soma do lote (um título, ou um por parcela), apontando
// pra 1ª compra do lote e marcado com purchase_batch_id.
// Diferente do GET (só Financeiro), o POST aceita também os papéis de Compras:
// toda compra salva no Controle de Compras é lançada automaticamente aqui, e
// quem registra (ex.: Gestor/RH) nem sempre acessa o módulo bancário.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = session.user.role as Role;
  const isFinance = canAccessFinanceiroBanco(role) && hasPermission(role, "FINANCEIRO_MOD", "create");
  if (!isFinance && !COMPRAS_ROLES.includes(role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const userName = session.user.name || session.user.email || "?";

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
  const seenBatches = new Set<string>();

  for (const id of ids) {
    let po = await prisma.purchaseOrder.findUnique({
      where: { id },
      include: {
        payable_invoices: { select: { id: true } },
        // Cartão usado na compra (final + fechamento) — vai pra observação do
        // título, pro Financeiro conferir com a fatura.
        card: { select: { last4: true, closing_day: true, label: true } },
      },
    });
    // Já virou título ou sumiu — ignora (idempotente).
    if (!po || po.payable_invoices.length > 0) {
      skipped++;
      continue;
    }

    // Lote: junta as compras do lote num lançamento só. A 1ª compra (mais
    // antiga) é a âncora do título; forma de pagamento/parcelas vêm dela (o
    // Escanear grava as mesmas em todas).
    let batchItems: { description: string; total_value: number }[] = [];
    let amount = Number(po.total_value) || 0;
    if (po.batch_id) {
      if (seenBatches.has(po.batch_id)) { skipped++; continue; }
      seenBatches.add(po.batch_id);
      const already = await prisma.payableInvoice.count({ where: { purchase_batch_id: po.batch_id } });
      if (already > 0) { skipped++; continue; }
      const siblings = await prisma.purchaseOrder.findMany({
        where: { batch_id: po.batch_id },
        orderBy: { created_at: "asc" },
        include: {
          payable_invoices: { select: { id: true } },
          card: { select: { last4: true, closing_day: true, label: true } },
        },
      });
      if (siblings.some((s) => s.payable_invoices.length > 0)) { skipped++; continue; }
      po = siblings[0] ?? po;
      batchItems = siblings.map((s) => ({ description: s.description, total_value: Number(s.total_value) || 0 }));
      amount = batchItems.reduce((sum, s) => sum + s.total_value, 0);
    }
    const isBatch = batchItems.length > 1;
    const baseDescription = isBatch
      ? `${po.supplier?.trim() || "Compra"} — ${batchItems.length} itens`
      : po.description;
    const supplierId = po.supplier ? byName.get(po.supplier.trim().toLowerCase()) ?? null : null;

    // Parcelas do FATURADO: payment_terms (novo) ou o payment_term_days legado
    // como parcela única. Fora do FATURADO (ou sem data da compra) não parcela.
    const terms =
      po.payment_method === "FATURADO" && po.purchase_date
        ? po.payment_terms.length > 0
          ? po.payment_terms
          : po.payment_term_days
            ? [po.payment_term_days]
            : []
        : [];

    // Observação: junta navio, forma de pagamento (+ prazos/cartão) e a nota
    // original. No cartão, o final + dia de fechamento ajudam a casar o título
    // com a fatura quando ela chegar.
    const cardLabel = po.card
      ? ` (${po.card.label?.trim() || `final ${po.card.last4}`} · fecha dia ${po.card.closing_day})`
      : "";
    const pgtoLabel =
      po.payment_method === "FATURADO" && terms.length > 0
        ? `Pagamento: FATURADO ${terms.join("/")} dias`
        : po.payment_method
          ? `Pagamento: ${po.payment_method}${cardLabel}`
          : null;
    const itemsLabel = isBatch
      ? `Itens: ${batchItems.slice(0, 10).map((it) => it.description).join(", ")}${batchItems.length > 10 ? ` e mais ${batchItems.length - 10}` : ""}`
      : null;
    const noteParts = [
      po.ship_name ? `Navio: ${po.ship_name}` : null,
      // Nº da NF vem da coluna própria (o Escanear não escreve mais na observação).
      po.nf_number ? `NF ${po.nf_number}` : null,
      pgtoLabel,
      itemsLabel,
      po.notes || null,
    ].filter(Boolean);

    // Valor de cada parcela: divisão igual em centavos; a última absorve a sobra
    // do arredondamento pra fechar exatamente no total da compra.
    const totalCents = Math.round(amount * 100);
    const n = Math.max(1, terms.length);
    const baseCents = Math.floor(totalCents / n);

    for (let i = 0; i < n; i++) {
      const parcelCents = i === n - 1 ? totalCents - baseCents * (n - 1) : baseCents;
      const parcelAmount = parcelCents / 100;
      const autoReason = autoApproveReason(parcelAmount, autoSetting?.value);

      // Vencimento: FATURADO vence em purchase_date + dias da parcela (controle
      // de meses futuros). Sem prazo, cai na própria data da compra (que serve
      // de referência do mês no controle).
      let dueDate: Date | null = po.purchase_date ?? null;
      if (terms.length > 0 && po.purchase_date) {
        const d = new Date(po.purchase_date);
        d.setUTCDate(d.getUTCDate() + terms[i]);
        dueDate = d;
      }

      await prisma.payableInvoice.create({
        data: {
          description: terms.length > 1 ? `${baseDescription} — parcela ${i + 1}/${n}` : baseDescription,
          amount: new Prisma.Decimal(parcelAmount.toFixed(2)),
          due_date: dueDate,
          supplier_id: supplierId,
          payee_name: supplierId ? null : po.supplier?.trim() || null,
          expense_type: po.department || null,
          // Contas a Pagar e Controle de Compras conversam: o título herda a
          // forma de pagamento da compra (FATURADO/PIX/DINHEIRO/...).
          payment_method: po.payment_method || null,
          notes: noteParts.length ? noteParts.join(" · ") : null,
          // Herda equipe/navio da compra pra permitir filtrar os títulos por eles.
          team: po.team || null,
          ship_id: po.ship_id || null,
          ship_name: po.ship_name || null,
          origin: "COMPRA",
          purchase_order_id: po.id,
          purchase_batch_id: po.batch_id || null,
          status: autoReason ? "APROVADO" : "AGUARDANDO_APROVACAO",
          approved_by: autoReason,
          approved_at: autoReason ? new Date() : null,
          created_by: userName,
        },
      });
      created++;
    }
  }

  return NextResponse.json({ created, skipped }, { status: 201 });
}
