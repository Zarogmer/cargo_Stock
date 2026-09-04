import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { COMPRAS_ROLES } from "@/lib/rbac";
import type { Role } from "@/types/database";
import { chaveDV } from "@/lib/services/boleto/nfe-chave";
import { extractDocumentFromPdf, nfeNoteSummary } from "@/lib/services/boleto/nf-extract";
import { lookupCnpjReceita, companyNamesMatch, formatCnpj, type ReceitaCnpj } from "@/lib/services/boleto/cnpj-receita";

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
//   - compra do Controle já registrada com esta chave (aviso de duplicidade);
//   - CNPJ fora do cadastro (só com full=1): consulta pública da Receita
//     (BrasilAPI → minhareceita.org) e devolve razão social/fantasia. Se um
//     fornecedor de MESMO nome existe sem CNPJ, grava o CNPJ nele (vincula);
//     se ninguém casa, CADASTRA o fornecedor — próximo scan já casa direto, e
//     o Contas a Pagar ganha a chave de casamento (boleto/extrato).
// full=0 pula o reprocesso do anexo e a Receita (quem importa o PDF já tem o
// documento em mãos e só quer duplicidade + forma de pagamento).
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

  // Fornecedor fora do cadastro (scanner, full=1): consulta pública da Receita
  // pelo CNPJ embutido na chave. Nome igual já cadastrado sem CNPJ → vincula;
  // ninguém parecido → cadastra (com razão social, endereço, e-mail e telefone
  // da Receita). Dois ou mais parecidos → ambíguo, não grava nada e o form só
  // recebe os dados da Receita pra preencher o campo.
  let supplierInfo: { id: number; name: string; created?: boolean; linked?: boolean } | null = supplier;
  let receita: ReceitaCnpj | null = null;
  if (!supplierInfo && full) {
    const actor = session.user.name || session.user.email || "Leitura de NF";
    try {
      receita = await lookupCnpjReceita(cnpj);
      if (receita) {
        const r = receita;
        const all = await prisma.supplier.findMany({ select: { id: true, name: true, cnpj: true } });
        const candidates = all.filter(
          (s) => !s.cnpj && (companyNamesMatch(s.name, r.razao) || (r.fantasia ? companyNamesMatch(s.name, r.fantasia) : false)),
        );
        if (candidates.length === 1) {
          await prisma.supplier.update({ where: { id: candidates[0].id }, data: { cnpj, updated_by: actor } });
          supplierInfo = { id: candidates[0].id, name: candidates[0].name, linked: true };
        } else if (candidates.length === 0) {
          const created = await prisma.supplier.create({
            data: {
              name: r.fantasia || r.razao,
              cnpj,
              contact: r.telefone,
              address: r.endereco,
              email: r.email,
              notes: `Cadastrado automaticamente pela leitura da NF (CNPJ ${formatCnpj(cnpj)} · razão social: ${r.razao})`,
              created_by: actor,
              updated_by: actor,
            },
            select: { id: true, name: true },
          });
          supplierInfo = { ...created, created: true };
        }
      }
    } catch {
      // Receita fora do ar, ou corrida no unique do CNPJ (dois scans juntos):
      // tenta reler o cadastro; no pior caso segue sem fornecedor.
      try {
        const again = await prisma.supplier.findUnique({ where: { cnpj }, select: { id: true, name: true } });
        if (again) supplierInfo = again;
      } catch { /* segue sem fornecedor */ }
    }
  }

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
          supplier_id: supplierInfo?.id ?? null,
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
    supplier: supplierInfo,
    // Dados públicos do emitente (Receita) — o form usa pra mostrar/preencher.
    receita: receita
      ? { razao: receita.razao, fantasia: receita.fantasia, municipio: receita.municipio, uf: receita.uf }
      : null,
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
