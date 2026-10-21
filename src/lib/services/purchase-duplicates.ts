import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeCompanyName, companyNamesMatch } from "@/lib/services/boleto/cnpj-receita";

// Compra duplicada no Controle de Compras.
//
// Duas pessoas lançam compras ao mesmo tempo (uma pelo Escanear, outra à mão)
// e a mesma nota fiscal acaba entrando duas vezes. Antes de salvar, a tela
// pergunta aqui se "essa compra já foi colocada no sistema". A resposta é só
// um AVISO — quem decide salvar mesmo assim é o usuário (há compras legítimas
// parecidas: água toda semana, o mesmo rancho pro mesmo fornecedor).
//
// Níveis:
//   exata    — mesma chave de acesso da NF-e (44 dígitos), mesmo boleto (linha
//              digitável) ou mesmo nº de NF do mesmo fornecedor. É a mesma nota.
//   provavel — mesmo fornecedor, mesmo valor e data próxima (±7 dias); ou mesma
//              descrição + valor em data próxima; ou mesmo nº de NF sem dar pra
//              comparar o fornecedor.
//
// Um lote do Escanear (itens com o mesmo batch_id) é tratado como UMA compra:
// o valor comparado é a soma dos itens — assim pega o caso de um usuário ter
// escaneado a nota (5 itens) e o outro lançar a nota à mão numa linha só.

export interface DuplicateCheckInput {
  supplier?: string | null;
  // Descrição da compra (lançamento de 1 item). Em lote, mande null.
  description?: string | null;
  nf_number?: string | null;
  access_key?: string | null;
  digitable_line?: string | null;
  // Valor total da compra/do documento (soma dos itens).
  total?: number | null;
  purchase_date?: string | null; // YYYY-MM-DD
  // Editando uma compra existente: ignora ela mesma (e o lote dela).
  exclude_id?: string | null;
  exclude_batch_id?: string | null;
}

export type DuplicateLevel = "exata" | "provavel";

export interface DuplicateMatch {
  level: DuplicateLevel;
  reason: string; // em português, pra mostrar na tela
  id: string; // 1ª compra do lote (ou a própria compra)
  batch_id: string | null;
  description: string; // lote: "3 itens: a, b, c"
  items_count: number;
  supplier: string | null;
  purchase_date: string | null; // YYYY-MM-DD
  total_value: number; // lote: soma dos itens
  nf_number: string | null;
  created_by: string;
  created_at: string; // ISO
}

// Janela de busca dos candidatos em volta da data da compra (a outra pessoa
// pode ter digitado a data do pagamento em vez da data da nota).
const WINDOW_DAYS = 15;
// "Data próxima" pro nível provável.
const NEAR_DAYS = 7;
// Quantos lançamentos parecidos devolver, no máximo.
const MAX_MATCHES = 5;

type Row = Prisma.PurchaseOrderGetPayload<{
  select: {
    id: true;
    batch_id: true;
    description: true;
    supplier: true;
    purchase_date: true;
    total_value: true;
    nf_number: true;
    access_key: true;
    digitable_line: true;
    notes: true;
    created_by: true;
    created_at: true;
  };
}>;

function digits(s: string | null | undefined): string {
  return (s || "").replace(/\D/g, "");
}

// Nº da NF comparável: maiúsculas, só letras/números; zeros à esquerda fora
// quando é só número ("000.012.345" = "12345").
export function normalizeNfNumber(s: string | null | undefined): string {
  const t = (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, "") : t;
}

function parseISODate(s: string | null | undefined): Date | null {
  const m = (s || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayOf(d: Date): number {
  return Math.floor(d.getTime() / 86_400_000);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function cents(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

// Valores "iguais" com folga: itens escaneados somam com centavos de diferença
// do total impresso na nota (arredondamento unitário × quantidade).
function sameAmount(a: number | null, b: number): boolean {
  if (a == null) return false;
  const tol = Math.max(100, Math.round(a * 0.005)); // R$ 1,00 ou 0,5%
  return Math.abs(a - b) <= tol;
}

type SupplierCmp = "same" | "unknown" | "different";
function compareSuppliers(a: string | null | undefined, b: string | null | undefined): SupplierCmp {
  const na = normalizeCompanyName(a || "");
  const nb = normalizeCompanyName(b || "");
  if (!na || !nb) return "unknown";
  if (na === nb) return "same";
  return companyNamesMatch(na, nb) ? "same" : "different";
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeCompanyName(a || "");
  const nb = normalizeCompanyName(b || "");
  return !!na && na === nb;
}

export async function findDuplicatePurchases(input: DuplicateCheckInput): Promise<DuplicateMatch[]> {
  const accessKey = digits(input.access_key);
  const key = accessKey.length === 44 ? accessKey : null;
  const digitable = digits(input.digitable_line);
  const line = digitable.length >= 44 ? digitable : null;
  const nfRaw = (input.nf_number || "").trim() || null;
  const nf = normalizeNfNumber(nfRaw) || null;
  const totalCents = cents(input.total);
  const date = parseISODate(input.purchase_date);
  const hasAnything = key || line || nf || (totalCents != null && (input.supplier?.trim() || input.description?.trim()));
  if (!hasAnything) return [];

  // Candidatos: casam numa chave forte OU estão na janela de datas. O resto da
  // comparação (nome, valor, nº de NF normalizado) é feita aqui no código.
  const or: Prisma.PurchaseOrderWhereInput[] = [];
  if (key) or.push({ access_key: key }, { notes: { contains: key } });
  if (line) or.push({ digitable_line: line });
  if (nfRaw) or.push({ nf_number: nfRaw });
  if (nf && nf !== nfRaw) or.push({ nf_number: nf });
  if (date) {
    or.push({ purchase_date: { gte: addDays(date, -WINDOW_DAYS), lte: addDays(date, WINDOW_DAYS) } });
  } else {
    or.push({ created_at: { gte: addDays(new Date(), -30) } });
  }

  // Exclusão do lote: `NOT (batch_id = X)` em SQL descarta também quem tem
  // batch_id NULL (compra avulsa) — por isso o OR explícito com IS NULL.
  const and: Prisma.PurchaseOrderWhereInput[] = [{ OR: or }];
  if (input.exclude_id) and.push({ id: { not: input.exclude_id } });
  if (input.exclude_batch_id) {
    and.push({ OR: [{ batch_id: null }, { batch_id: { not: input.exclude_batch_id } }] });
  }

  const rows: Row[] = await prisma.purchaseOrder.findMany({
    where: { AND: and },
    select: {
      id: true,
      batch_id: true,
      description: true,
      supplier: true,
      purchase_date: true,
      total_value: true,
      nf_number: true,
      access_key: true,
      digitable_line: true,
      notes: true,
      created_by: true,
      created_at: true,
    },
    orderBy: { created_at: "asc" },
    take: 2000,
  });
  if (rows.length === 0) return [];

  // Lote = uma compra só (soma dos itens); compra avulsa = grupo de 1.
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.batch_id ? `b:${r.batch_id}` : `s:${r.id}`;
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }

  const inputDay = date ? dayOf(date) : null;
  const near = (rowDate: Date | null, createdAt: Date): boolean => {
    if (inputDay == null) return true;
    const d = rowDate ?? createdAt;
    return Math.abs(dayOf(d) - inputDay) <= NEAR_DAYS;
  };

  const matches: DuplicateMatch[] = [];
  for (const g of groups.values()) {
    const first = g[0];
    const sumCents = g.reduce((s, r) => s + Math.round((Number(r.total_value) || 0) * 100), 0);
    const supplierCmp = compareSuppliers(input.supplier, first.supplier);
    const groupNear = near(first.purchase_date, first.created_at);

    let level: DuplicateLevel | null = null;
    let reason = "";
    const hit = (lv: DuplicateLevel, why: string) => {
      if (level === "exata") return;
      if (lv === "exata" || level == null) {
        level = lv;
        reason = why;
      }
    };

    if (key && g.some((r) => r.access_key === key || (r.notes || "").includes(key))) {
      hit("exata", "mesma chave de acesso da nota fiscal");
    }
    if (line && g.some((r) => r.digitable_line === line)) {
      hit("exata", "mesmo boleto (linha digitável igual)");
    }
    if (nf) {
      const nfHit = g.find((r) => normalizeNfNumber(r.nf_number) === nf);
      if (nfHit) {
        if (supplierCmp === "same") hit("exata", `mesma nota fiscal nº ${nfHit.nf_number} do mesmo fornecedor`);
        else if (supplierCmp === "unknown") hit("provavel", `mesmo nº de nota fiscal (${nfHit.nf_number})`);
      }
    }
    if (totalCents != null) {
      if (supplierCmp === "same" && groupNear && sameAmount(totalCents, sumCents)) {
        hit("provavel", "mesmo fornecedor, mesmo valor e data próxima");
      }
      // Linha a linha: mesma descrição e valor (ex.: lançaram só um item da
      // nota à mão, ou compra avulsa sem fornecedor preenchido).
      if (supplierCmp !== "different" && input.description?.trim()) {
        const rowHit = g.find(
          (r) =>
            sameText(r.description, input.description) &&
            sameAmount(totalCents, Math.round((Number(r.total_value) || 0) * 100)) &&
            near(r.purchase_date, r.created_at),
        );
        if (rowHit) hit("provavel", "mesma descrição e mesmo valor em data próxima");
      }
    }

    if (!level) continue;
    const descs = g.map((r) => r.description);
    matches.push({
      level,
      reason,
      id: first.id,
      batch_id: first.batch_id,
      description: g.length === 1 ? first.description : `${g.length} itens: ${descs.slice(0, 3).join(", ")}${g.length > 3 ? "…" : ""}`,
      items_count: g.length,
      supplier: first.supplier,
      purchase_date: first.purchase_date ? first.purchase_date.toISOString().slice(0, 10) : null,
      total_value: sumCents / 100,
      nf_number: g.find((r) => r.nf_number)?.nf_number ?? null,
      created_by: first.created_by,
      created_at: first.created_at.toISOString(),
    });
  }

  matches.sort((a, b) => {
    if (a.level !== b.level) return a.level === "exata" ? -1 : 1;
    return b.created_at.localeCompare(a.created_at);
  });
  return matches.slice(0, MAX_MATCHES);
}
