import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { COMPRAS_ROLES } from "@/lib/rbac";
import type { Role } from "@/types/database";
import { chaveDV } from "@/lib/services/boleto/nfe-chave";
import { extractDocumentFromPdf, nfeNoteSummary } from "@/lib/services/boleto/nf-extract";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/solicitacoes/nfe-lookup?chave=<44 dígitos>[&full=0]
//
// O código de barras da NF carrega SÓ a chave (CNPJ, número, série,
// competência) — valor, produtos e vencimentos não vêm nele. Esta rota cruza a
// chave escaneada com o que o sistema já conhece:
//   - fornecedor pelo CNPJ (cadastro de Fornecedores);
//   - título do Contas a Pagar da MESMA NF — o import por PDF/e-mail grava a
//     chave em `barcode` — e, com full=1 (padrão), reprocessa o PDF anexado
//     pra devolver valor, emissão, parcelas e produtos, igual ao Importar PDF
//     (anexo escaneado pode passar por OCR: a resposta pode demorar);
//   - compra do Controle já registrada com esta chave (aviso de duplicidade).
// Só LÊ — não grava nada. full=0 pula o reprocesso do anexo (quem importa o
// PDF já tem o documento em mãos e só quer duplicidade + forma de pagamento).
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!COMPRAS_ROLES.includes(session.user.role as Role)) {
    return NextResponse.json({ error: "Sem permissão" }, { status: 403 });
  }

  const chave = (request.nextUrl.searchParams.get("chave") || "").replace(/\D/g, "");
  const full = request.nextUrl.searchParams.get("full") !== "0";
  const modelo = chave.slice(20, 22);
  if (
    chave.length !== 44 ||
    (modelo !== "55" && modelo !== "65") ||
    chaveDV(chave.slice(0, 43)) !== Number(chave[43])
  ) {
    return NextResponse.json({ error: "Chave de acesso inválida" }, { status: 400 });
  }

  const cnpj = chave.slice(6, 20);
  const [supplier, invoice, purchase] = await Promise.all([
    prisma.supplier.findUnique({ where: { cnpj }, select: { id: true, name: true } }),
    prisma.payableInvoice.findFirst({
      where: { barcode: chave },
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        description: true,
        amount: true,
        due_date: true,
        payment_method: true,
        supplier_id: true,
        suppliers: { select: { name: true } },
      },
    }),
    prisma.purchaseOrder.findFirst({
      where: { notes: { contains: chave } },
      orderBy: { created_at: "desc" },
      select: { id: true, description: true, purchase_date: true, total_value: true },
    }),
  ]);

  // Reprocessa o PDF anexado ao título — devolve o MESMO shape do
  // analisar-pdf, então o formulário aplica pelos mesmos caminhos.
  let parsed: Record<string, unknown> | null = null;
  if (full && invoice) {
    const atts = await prisma.invoiceAttachment.findMany({
      where: { invoice_id: invoice.id, mime_type: "application/pdf" },
      orderBy: { created_at: "desc" },
      take: 3,
      select: { content: true },
    });
    for (const att of atts) {
      try {
        const doc = await extractDocumentFromPdf(Buffer.from(att.content));
        // Título pode ter mais de um anexo (boleto + NF): só vale o PDF que é
        // ESTA nota.
        if (doc.nfe?.chave !== chave) continue;
        const ocrNote = doc.ocr ? "lido por OCR (PDF escaneado) — conferir os dados" : null;
        parsed = {
          kind: doc.kind,
          scanned: doc.scanned,
          ocr: doc.ocr,
          description: doc.suggestedDescription,
          amount: doc.amount,
          due_date: doc.dueDate,
          payee_name: doc.nfe?.emitenteName ?? null,
          payee_document: doc.cnpj,
          digitable_line: doc.digitableLine,
          supplier_id: supplier?.id ?? null,
          notes: [doc.nfe ? nfeNoteSummary(doc.nfe) : null, ocrNote].filter(Boolean).join(" · ") || null,
          chave: doc.nfe?.chave ?? null,
          emissao: doc.nfe?.emissao ?? null,
          duplicatas: doc.nfe?.duplicatas ?? [],
          produtos: doc.nfe?.produtos ?? [],
        };
        break;
      } catch {
        // anexo ilegível — tenta o próximo
      }
    }
  }

  return NextResponse.json({
    chave,
    supplier,
    invoice: invoice
      ? {
          description: invoice.description,
          amount: Number(invoice.amount),
          due_date: invoice.due_date ? invoice.due_date.toISOString().slice(0, 10) : null,
          payment_method: invoice.payment_method,
          supplier_name: invoice.suppliers?.name ?? null,
        }
      : null,
    parsed,
    existing_purchase: purchase
      ? {
          id: purchase.id,
          description: purchase.description,
          purchase_date: purchase.purchase_date ? purchase.purchase_date.toISOString().slice(0, 10) : null,
          total_value: Number(purchase.total_value),
        }
      : null,
  });
}
