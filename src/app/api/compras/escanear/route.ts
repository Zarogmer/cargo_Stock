import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { COMPRAS_ROLES } from "@/lib/rbac";
import type { Role } from "@/types/database";
import { lookupCnpjReceita, companyNamesMatch, formatCnpj } from "@/lib/services/boleto/cnpj-receita";
import { findDuplicatePurchases, type DuplicateMatch } from "@/lib/services/purchase-duplicates";
import { STOCK_UNITS, normalizeStockUnit, isPackUnit } from "@/lib/stock-units";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Leitura pela IA leva de 10 s a ~1 min com várias fotos.
export const maxDuration = 120;

// POST /api/compras/escanear — multipart { files: imagem(ns) e/ou PDF }
//
// "Escanear" do Controle de Compras: o usuário fotografa a nota fiscal, o
// cupom, o boleto ou o recibo (pode ser mais de uma foto da MESMA compra — NF
// + boleto, frente e verso) e o Claude lê tudo: fornecedor, CNPJ, data,
// valores, forma de pagamento, vencimentos, linha digitável e os ITENS. Não
// grava compra nenhuma — devolve o rascunho pro usuário revisar e salvar.
// O que grava: fornecedor novo pelo CNPJ (vincula
// a um cadastro de mesmo nome sem CNPJ, ou cadastra pela Receita).

const PAYMENT_METHODS = ["FATURADO", "CARTÃO DE CRÉDITO", "CARTÃO DE DÉBITO", "PIX", "DINHEIRO", "BOLETO", "TRANSFERÊNCIA"];

const MAX_FILES = 8;
const MAX_BYTES = 20 * 1024 * 1024; // por arquivo (o cliente já reduz as fotos)

const nullableString = { type: ["string", "null"] };
const nullableNumber = { type: ["number", "null"] };

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    document_type: { type: "string", enum: ["NFE", "NFCE", "CUPOM", "BOLETO", "RECIBO", "PEDIDO", "OUTRO"] },
    supplier_name: nullableString,
    supplier_cnpj: nullableString,
    issue_date: nullableString,
    total_amount: nullableNumber,
    // Validado contra PAYMENT_METHODS na saída (o prompt lista as opções).
    payment_method: nullableString,
    due_dates: { type: "array", items: { type: "string" } },
    digitable_line: nullableString,
    nf_number: nullableString,
    access_key: nullableString,
    // Rodapé "CÁLCULO DO IMPOSTO" / "VALOR TOTAL DA NOTA" da DANFE.
    products_total: nullableNumber,
    freight: nullableNumber,
    insurance: nullableNumber,
    discount: nullableNumber,
    other_expenses: nullableNumber,
    ipi_total: nullableNumber,
    icms_base_total: nullableNumber,
    icms_total: nullableNumber,
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          quantity: nullableNumber,
          unit: nullableString,
          pack_qty: nullableNumber,
          pack_unit: nullableString,
          unit_value: nullableNumber,
          total_value: nullableNumber,
          // Colunas fiscais da linha da DANFE — um campo pra cada coluna, pra
          // base/ICMS não irem parar em quantidade ou valor unitário.
          ncm: nullableString,
          cst: nullableString,
          cfop: nullableString,
          icms_base: nullableNumber,
          icms_value: nullableNumber,
          icms_rate: nullableNumber,
          ipi_value: nullableNumber,
          ipi_rate: nullableNumber,
        },
        required: [
          "description", "quantity", "unit", "pack_qty", "pack_unit", "unit_value", "total_value",
          "ncm", "cst", "cfop", "icms_base", "icms_value", "icms_rate", "ipi_value", "ipi_rate",
        ],
        additionalProperties: false,
      },
    },
    notes: nullableString,
    warnings: nullableString,
  },
  required: [
    "document_type", "supplier_name", "supplier_cnpj", "issue_date", "total_amount", "payment_method",
    "due_dates", "digitable_line", "nf_number", "access_key",
    "products_total", "freight", "insurance", "discount", "other_expenses", "ipi_total", "icms_base_total", "icms_total",
    "items", "notes", "warnings",
  ],
  additionalProperties: false,
};

interface AiItem {
  description: string;
  quantity: number | null;
  unit: string | null;
  pack_qty: number | null;
  pack_unit: string | null;
  unit_value: number | null;
  total_value: number | null;
  ncm: string | null;
  cst: string | null;
  cfop: string | null;
  icms_base: number | null;
  icms_value: number | null;
  icms_rate: number | null;
  ipi_value: number | null;
  ipi_rate: number | null;
}
interface AiResult {
  document_type: string;
  supplier_name: string | null;
  supplier_cnpj: string | null;
  issue_date: string | null;
  total_amount: number | null;
  payment_method: string | null;
  due_dates: string[];
  digitable_line: string | null;
  nf_number: string | null;
  access_key: string | null;
  products_total: number | null;
  freight: number | null;
  insurance: number | null;
  discount: number | null;
  other_expenses: number | null;
  ipi_total: number | null;
  icms_base_total: number | null;
  icms_total: number | null;
  items: AiItem[];
  notes: string | null;
  warnings: string | null;
}

// Rodapé da nota que vai junto de cada compra do lote (purchase_orders.nf_totals).
export interface NfTotals {
  products_total: number | null;
  freight: number | null;
  insurance: number | null;
  discount: number | null;
  other_expenses: number | null;
  ipi_total: number | null;
  icms_base_total: number | null;
  icms_total: number | null;
  total: number | null;
}

function buildPrompt(today: string): string {
  return `Você lê documentos de compra de uma empresa brasileira (Cargo Ships Cleaning, limpeza de navios) para lançar no Controle de Compras.

As imagens/arquivos a seguir são TODOS da MESMA compra (ex.: a nota fiscal e o boleto dela, ou várias páginas/fotos do mesmo cupom). Junte as informações num resultado só.

Extraia:
- document_type: NFE (DANFE), NFCE (cupom fiscal eletrônico/NFC-e), CUPOM (cupom não fiscal), BOLETO, RECIBO, PEDIDO (orçamento/pedido) ou OUTRO. Havendo NF e boleto, use o tipo da nota.
- supplier_name: o vendedor/emitente/beneficiário (nome fantasia se aparecer, senão razão social). Nunca a Cargo Ships Cleaning, que é a compradora.
- supplier_cnpj: CNPJ (ou CPF) do vendedor, só dígitos.
- issue_date: data da compra/emissão em YYYY-MM-DD.
- total_amount: valor total a pagar do documento (VALOR TOTAL DA NOTA, com frete/desconto já aplicados), número em reais.
- Rodapé "CÁLCULO DO IMPOSTO" da DANFE, cada campo no seu lugar: BASE DE CÁLCULO DO ICMS → icms_base_total; VALOR DO ICMS → icms_total; VALOR TOTAL DOS PRODUTOS → products_total; VALOR DO FRETE → freight; VALOR DO SEGURO → insurance; DESCONTO → discount; OUTRAS DESPESAS ACESSÓRIAS → other_expenses; VALOR DO IPI → ipi_total; VALOR TOTAL DA NOTA → total_amount. Cupom/boleto/recibo sem esse quadro: null (products_total pode ser o subtotal dos itens se aparecer).
- payment_method: um de ${PAYMENT_METHODS.join(", ")}; FATURADO quando a nota tem fatura/duplicatas a prazo. null se não der para saber.
- due_dates: vencimentos das parcelas/duplicatas ou do boleto, em YYYY-MM-DD, em ordem. Vazio se não houver.
- digitable_line: linha digitável do boleto (47 ou 48 dígitos, só dígitos), se aparecer legível.
- nf_number e access_key (chave de acesso de 44 dígitos, só dígitos) quando for nota fiscal.
- items: cada produto/serviço comprado, com a descrição como está no documento (pode corrigir abreviações óbvias), quantidade, unidade, valor unitário e valor total da linha. Copie quantidade, valor unitário e valor total EXATAMENTE como impressos na linha (quantidade pode ter 3 casas, ex.: 9.335 KG) — não recalcule nem arredonde. Boleto ou recibo sem itens: um item só descrevendo o que foi pago (ex.: "Boleto - <beneficiário>") com o valor total.
  - Na DANFE, a tabela "DADOS DO PRODUTO / SERVIÇOS" tem as colunas NESTA ORDEM: DESCRIÇÃO DO PRODUTO/SERVIÇO | NCM/SH | CST | CFOP | UNID. | QUANTIDADE | VALOR UNITÁRIO | VALOR TOTAL | BASE CÁLC. ICMS | VALOR ICMS | VALOR IPI | ALÍQ. ICMS | ALÍQ. IPI. Leia a linha da esquerda pra direita e ponha cada coluna no seu campo: ncm, cst, cfop, unit, quantity, unit_value, total_value, icms_base, icms_value, ipi_value, icms_rate, ipi_rate. BASE CÁLC. ICMS e VALOR ICMS NUNCA são quantidade nem valor unitário: a base é menor ou igual ao VALOR TOTAL da linha e o ICMS é uma fração dela (ex.: 9.335 KG × 22.99 = 214.61, base 125.18, ICMS 15.02, alíquota 12). Linha sem alguma dessas colunas (cupom, recibo): null.
  - Conferência de CADA linha: quantity × unit_value tem que dar total_value (tolerância 0.02). Se não der, releia a linha — você provavelmente pegou um número da coluna vizinha.
  - unit: a unidade EM QUE a quantidade e o valor unitário estão na nota (coluna UN/UNID.), convertida para um destes códigos: ${STOCK_UNITS.map((u) => `${u.value} (${u.label})`).join(", ")}. Nas notas: PC/PÇ = UN (peça), PT/PCT = PCT (pacote), MT = M, LT = L, FD = FARDO, GL = GALAO, RL = ROLO, JG/CJ = KIT. Cupom sem coluna de unidade: deduza pela descrição.
  - ATENÇÃO À EMBALAGEM: o valor unitário muitas vezes é de uma caixa/pacote/fardo, não de uma peça (ex.: "OVOS CX 30 DZ" a R$ 250 é UMA CAIXA, não um ovo; "TERMINAL C/100 PCS" vendido em PT é um pacote de 100). Quando a unidade for embalagem (CX, PCT, FARDO, SACO, KIT, ROLO, GALAO) e a descrição disser o conteúdo, preencha pack_qty (quantos vêm em CADA embalagem) e pack_unit (o código da unidade de dentro: UN, DZ, KG, L, M...). Exemplos: "CX C/100 PCS" → pack_qty 100, pack_unit UN; "FILME PVC 28CM X 100M" em rolo → 100, M; "LIMPA PEDRA GL 5 L" → unit GALAO, pack_qty 5, pack_unit L; "OVOS CX 30 DZ" → 30, DZ; "ÁGUA FD 12X500ML" → unit FARDO, 12, UN. Se a unidade não for embalagem ou o conteúdo não estiver escrito, pack_qty e pack_unit ficam null — não chute.
- notes: curto, só o que importa para o financeiro (frete, desconto, nº do pedido). null se nada.
- warnings: em português, o que ficou ilegível ou incerto (ex.: "valor unitário do item 3 cortado na foto"). null se tudo legível.

CONFERÊNCIA OBRIGATÓRIA antes de responder: some os total_value dos itens e compare com products_total (ou, sem ele, com o total do documento); e confira que products_total + freight + insurance + other_expenses + ipi_total − discount = total_amount. Se não fechar (tolerância de 0.02), releia os dígitos das linhas — o erro costuma ser 1 ou 7, 3 ou 8, 0 ou 6 trocados, ou a vírgula no lugar errado — e corrija; se mesmo assim não fechar, explique em warnings qual linha ficou em dúvida.

Regras: números com ponto decimal (1234.56), nunca vírgula. Não invente: o que não estiver no documento fica null. Datas de 2 dígitos no ano são 20xx. Hoje é ${today}.`;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  return t || null;
}

function digits(s: string | null | undefined): string {
  return (s || "").replace(/\D/g, "");
}

function isoOrNull(s: string | null | undefined): string | null {
  const v = (s || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!COMPRAS_ROLES.includes(session.user.role as Role)) {
    return NextResponse.json({ error: "Sem permissão" }, { status: 403 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "A leitura por IA não está configurada no servidor (falta a variável ANTHROPIC_API_KEY no Railway)." },
      { status: 503 },
    );
  }

  const form = await request.formData().catch(() => null);
  const files = (form?.getAll("files") || []).filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return NextResponse.json({ error: "Tire ao menos uma foto do documento." }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Máximo de ${MAX_FILES} fotos por leitura.` }, { status: 400 });

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) return NextResponse.json({ error: `"${f.name}" passa de 20 MB.` }, { status: 400 });
    const data = Buffer.from(await f.arrayBuffer()).toString("base64");
    if (f.type === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
    } else if (f.type === "image/jpeg" || f.type === "image/png" || f.type === "image/webp" || f.type === "image/gif") {
      content.push({ type: "image", source: { type: "base64", media_type: f.type, data } });
    } else {
      return NextResponse.json({ error: `Formato não suportado: ${f.type || f.name}. Use foto (JPG/PNG) ou PDF.` }, { status: 400 });
    }
  }
  const now = new Date();
  const today = new Date(now.getTime() - 3 * 3600_000).toISOString().slice(0, 10); // horário de Brasília
  content.push({ type: "text", text: buildPrompt(today) });

  const client = new Anthropic();
  let result: AiResult;
  try {
    const response = await client.beta.messages.create({
      // Sonnet 5.5: o Haiku errava dígitos em foto de DANFE (valores que não
      // fechavam com o total). Sonnet lê melhor e ainda custa ~5x menos que o Opus.
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: RESULT_SCHEMA },
      },
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal") {
      return NextResponse.json({ error: "A IA não conseguiu analisar estas imagens. Tente outra foto." }, { status: 422 });
    }
    if (response.stop_reason === "max_tokens") {
      return NextResponse.json({ error: "Documento grande demais para ler de uma vez — tente menos fotos por leitura." }, { status: 422 });
    }
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    result = JSON.parse(text) as AiResult;
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "Muitas leituras ao mesmo tempo — espere alguns segundos e tente de novo." }, { status: 429 });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return NextResponse.json({ error: "Chave da IA inválida no servidor (ANTHROPIC_API_KEY)." }, { status: 503 });
    }
    if (err instanceof Anthropic.BadRequestError) {
      console.error("[compras/escanear] bad request:", err.message);
      return NextResponse.json({ error: "A IA recusou o arquivo (imagem corrompida ou grande demais)." }, { status: 400 });
    }
    if (err instanceof Anthropic.APIError) {
      console.error("[compras/escanear] API error:", err.status, err.message);
      return NextResponse.json({ error: "Serviço de IA indisponível agora — tente de novo em instantes." }, { status: 502 });
    }
    console.error("[compras/escanear] erro:", err);
    return NextResponse.json({ error: "Não consegui ler o documento — tente outra foto." }, { status: 500 });
  }

  // Normaliza o que veio da IA (datas/dígitos/itens vazios).
  const cnpj = digits(result.supplier_cnpj);
  const accessKey = digits(result.access_key);
  const digitableLine = digits(result.digitable_line);
  const items = (Array.isArray(result.items) ? result.items : [])
    .filter((it) => it && typeof it.description === "string" && it.description.trim())
    .map((it) => {
      const unit = normalizeStockUnit(it.unit);
      const packQty = isPackUnit(unit) && typeof it.pack_qty === "number" && it.pack_qty > 0 ? it.pack_qty : null;
      return {
        description: it.description.trim(),
        quantity: typeof it.quantity === "number" && it.quantity > 0 ? it.quantity : null,
        unit,
        // Conteúdo da embalagem ("CX com 30 DZ") — só pra unidade de embalagem.
        pack_qty: packQty,
        pack_unit: packQty != null ? normalizeStockUnit(it.pack_unit) || "UN" : null,
        unit_value: num(it.unit_value),
        total_value: num(it.total_value),
        ncm: str(it.ncm),
        cst: str(it.cst),
        cfop: str(it.cfop),
        icms_base: num(it.icms_base),
        icms_value: num(it.icms_value),
        icms_rate: num(it.icms_rate),
        ipi_value: num(it.ipi_value),
        ipi_rate: num(it.ipi_rate),
      };
    });
  const totalAmount = num(result.total_amount);
  const nfTotals: NfTotals = {
    products_total: num(result.products_total),
    freight: num(result.freight),
    insurance: num(result.insurance),
    discount: num(result.discount),
    other_expenses: num(result.other_expenses),
    ipi_total: num(result.ipi_total),
    icms_base_total: num(result.icms_base_total),
    icms_total: num(result.icms_total),
    total: totalAmount,
  };

  // Fornecedor: cadastro pelo CNPJ → (fora do cadastro) Receita, vinculando a
  // um cadastro de mesmo nome sem CNPJ ou cadastrando → por último, o nome
  // lido bate com um cadastro existente.
  let supplier: { id: number; name: string; status: "cadastro" | "novo" | "vinculado" } | null = null;
  const actor = session.user.name || session.user.email || "Escanear (IA)";
  if (cnpj.length === 14 || cnpj.length === 11) {
    const found = await prisma.supplier.findUnique({ where: { cnpj }, select: { id: true, name: true } });
    if (found) supplier = { ...found, status: "cadastro" };
    else if (cnpj.length === 14) {
      try {
        const r = await lookupCnpjReceita(cnpj);
        if (r) {
          const all = await prisma.supplier.findMany({ select: { id: true, name: true, cnpj: true } });
          const candidates = all.filter(
            (s) => !s.cnpj && (companyNamesMatch(s.name, r.razao) || (r.fantasia ? companyNamesMatch(s.name, r.fantasia) : false)),
          );
          if (candidates.length === 1) {
            await prisma.supplier.update({ where: { id: candidates[0].id }, data: { cnpj, updated_by: actor } });
            supplier = { id: candidates[0].id, name: candidates[0].name, status: "vinculado" };
          } else if (candidates.length === 0) {
            const created = await prisma.supplier.create({
              data: {
                name: r.fantasia || r.razao,
                cnpj,
                contact: r.telefone,
                address: r.endereco,
                email: r.email,
                notes: `Cadastrado automaticamente pelo Escanear do Controle de Compras (CNPJ ${formatCnpj(cnpj)} · razão social: ${r.razao})`,
                created_by: actor,
                updated_by: actor,
              },
              select: { id: true, name: true },
            });
            supplier = { ...created, status: "novo" };
          }
        }
      } catch {
        // Receita fora do ar ou corrida no unique do CNPJ — relê e segue.
        try {
          const again = await prisma.supplier.findUnique({ where: { cnpj }, select: { id: true, name: true } });
          if (again) supplier = { ...again, status: "cadastro" };
        } catch { /* segue sem fornecedor */ }
      }
    }
  }
  if (!supplier && result.supplier_name) {
    const name = result.supplier_name;
    const all = await prisma.supplier.findMany({ select: { id: true, name: true } });
    const hits = all.filter((s) => companyNamesMatch(s.name, name));
    if (hits.length === 1) supplier = { ...hits[0], status: "cadastro" };
  }

  // "Esta compra já foi colocada no sistema?" — mesma chave/boleto/NF (exata)
  // ou mesmo fornecedor + valor + data próxima (provável). Só aviso: o modal
  // mostra quem lançou e pede confirmação; quem decide é o usuário. Falha na
  // consulta não derruba a leitura.
  const nfNumber = result.nf_number?.trim() || null;
  const issueDate = isoOrNull(result.issue_date);
  let duplicates: DuplicateMatch[] = [];
  try {
    duplicates = await findDuplicatePurchases({
      supplier: supplier?.name || result.supplier_name?.trim() || null,
      description: items.length === 1 ? items[0].description : null,
      nf_number: nfNumber,
      access_key: accessKey.length === 44 ? accessKey : null,
      digitable_line: digitableLine || null,
      total: totalAmount,
      purchase_date: issueDate,
    });
  } catch (err) {
    console.error("[compras/escanear] verificação de duplicata falhou:", err);
  }

  return NextResponse.json({
    document_type: result.document_type,
    supplier_name: supplier?.name || result.supplier_name?.trim() || null,
    supplier_status: supplier?.status ?? null,
    supplier_cnpj: cnpj || null,
    issue_date: issueDate,
    total_amount: totalAmount,
    payment_method: result.payment_method && PAYMENT_METHODS.includes(result.payment_method) ? result.payment_method : null,
    due_dates: (Array.isArray(result.due_dates) ? result.due_dates : []).map(isoOrNull).filter((d): d is string => !!d),
    digitable_line: digitableLine || null,
    nf_number: nfNumber,
    access_key: accessKey.length === 44 ? accessKey : null,
    items,
    nf_totals: nfTotals,
    notes: result.notes?.trim() || null,
    warnings: result.warnings?.trim() || null,
    duplicates,
  });
}
