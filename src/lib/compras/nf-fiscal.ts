import { formatCurrency } from "@/lib/utils";

// Colunas fiscais da DANFE que o Escanear (IA) lê e a compra guarda. Antes a
// IA só tinha quantidade/unitário/total pra preencher e a BASE CÁLC. ICMS ou o
// VALOR ICMS (colunas vizinhas na nota) acabavam caindo em quantidade ou valor.
// Com um campo pra cada coluna, cada número tem onde ficar.

// Colunas da linha do produto: NCM/SH | CST | CFOP | ... | BASE CÁLC. ICMS |
// VALOR ICMS | VALOR IPI | ALÍQ. ICMS | ALÍQ. IPI (nomes = purchase_orders).
export interface ItemFiscal {
  ncm: string | null;
  cst: string | null;
  cfop: string | null;
  icms_base: number | null;
  icms_value: number | null;
  icms_rate: number | null;
  ipi_value: number | null;
  ipi_rate: number | null;
}

// Rodapé "CÁLCULO DO IMPOSTO" da nota (purchase_orders.nf_totals, igual em
// todos os itens do lote). total = VALOR TOTAL DA NOTA.
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

export const EMPTY_FISCAL: ItemFiscal = {
  ncm: null, cst: null, cfop: null,
  icms_base: null, icms_value: null, icms_rate: null, ipi_value: null, ipi_rate: null,
};

export function pickFiscal(src: Partial<ItemFiscal> | null | undefined): ItemFiscal | null {
  if (!src) return null;
  const f: ItemFiscal = {
    ncm: src.ncm ?? null,
    cst: src.cst ?? null,
    cfop: src.cfop ?? null,
    icms_base: src.icms_base ?? null,
    icms_value: src.icms_value ?? null,
    icms_rate: src.icms_rate ?? null,
    ipi_value: src.ipi_value ?? null,
    ipi_rate: src.ipi_rate ?? null,
  };
  return Object.values(f).some((v) => v != null) ? f : null;
}

function pct(n: number | null): string {
  if (n == null) return "";
  return ` (${String(Math.round(n * 100) / 100).replace(".", ",")}%)`;
}

// "NCM 02071300 · CST 020 · CFOP 5102 · Base ICMS R$ 125,18 · ICMS R$ 15,02 (12%) · IPI R$ 0,00"
export function fiscalSummary(f: ItemFiscal | null | undefined): string {
  if (!f) return "";
  const parts: string[] = [];
  if (f.ncm) parts.push(`NCM ${f.ncm}`);
  if (f.cst) parts.push(`CST ${f.cst}`);
  if (f.cfop) parts.push(`CFOP ${f.cfop}`);
  if (f.icms_base != null) parts.push(`Base ICMS ${formatCurrency(f.icms_base)}`);
  if (f.icms_value != null) parts.push(`ICMS ${formatCurrency(f.icms_value)}${pct(f.icms_rate)}`);
  else if (f.icms_rate != null) parts.push(`ICMS${pct(f.icms_rate)}`);
  if (f.ipi_value != null) parts.push(`IPI ${formatCurrency(f.ipi_value)}${pct(f.ipi_rate)}`);
  return parts.join(" · ");
}

// Acréscimos/descontos do rodapé que entram como item na compra, pra soma dos
// itens fechar com o VALOR TOTAL DA NOTA (o título do Contas a Pagar é a soma).
export function nfExtraItems(t: NfTotals | null | undefined): { description: string; value: number }[] {
  if (!t) return [];
  const out: { description: string; value: number }[] = [];
  const add = (label: string, v: number | null, sign: 1 | -1) => {
    if (v != null && v > 0.004) out.push({ description: label, value: Math.round(v * 100) / 100 * sign });
  };
  add("Frete", t.freight, 1);
  add("Seguro", t.insurance, 1);
  add("Outras despesas acessórias", t.other_expenses, 1);
  add("IPI", t.ipi_total, 1);
  add("Desconto", t.discount, -1);
  return out;
}

// "Produtos R$ 1.467,99 · Frete R$ 0,00 … → Total da nota R$ 1.467,99"
export function nfTotalsSummary(t: NfTotals | null | undefined): string {
  if (!t) return "";
  const parts: string[] = [];
  if (t.products_total != null) parts.push(`Produtos ${formatCurrency(t.products_total)}`);
  if (t.freight) parts.push(`Frete ${formatCurrency(t.freight)}`);
  if (t.insurance) parts.push(`Seguro ${formatCurrency(t.insurance)}`);
  if (t.other_expenses) parts.push(`Outras ${formatCurrency(t.other_expenses)}`);
  if (t.ipi_total) parts.push(`IPI ${formatCurrency(t.ipi_total)}`);
  if (t.discount) parts.push(`Desconto −${formatCurrency(t.discount)}`);
  if (t.icms_total != null) parts.push(`ICMS ${formatCurrency(t.icms_total)}${t.icms_base_total != null ? ` (base ${formatCurrency(t.icms_base_total)})` : ""}`);
  if (t.total != null) parts.push(`Total da nota ${formatCurrency(t.total)}`);
  return parts.join(" · ");
}
