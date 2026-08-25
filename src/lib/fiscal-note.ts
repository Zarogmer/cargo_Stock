// Notas de Débito (ND) e Crédito (NC) do faturamento dos navios.
//
// A empresa cobra o cliente por NOTA DE DÉBITO e devolve comissão/repasse por
// NOTA DE CRÉDITO. Até 2026-08 isso era planilha solta por cliente (WILSON
// SONS/NOTAS DE DÉBITOS 2026.xlsx, CONTINENTAL/ND 055-26 …pdf), com numeração
// corrida por ano. Aqui mora o formato ÚNICO: um modelo genérico que cobre os
// dois jeitos que a empresa usa hoje —
//   • itens separados por serviço (Limpeza / Raspagem / Pintura / Boat support),
//     que é como a Wilson Sons emite ND separada pra lavagem e pra lancha;
//   • moeda R$ ou USD, com a taxa negociada impressa;
//   • ISS opcional abatendo do total (vem da contabilidade, é sempre digitado);
//   • bloco fiscal do cliente vindo do cadastro (invoice_clients).
//
// Puro/sem Prisma — roda no cliente e no servidor.

export type FiscalNoteKind = "DEBITO" | "CREDITO";
export type FiscalNoteCurrency = "BRL" | "USD";
export type FiscalNoteLanguage = "PT" | "EN";

export interface FiscalNoteItemInput {
  position: number;
  description: string;
  // Memória de cálculo opcional (ex.: 2.240,00 USD/porão × 5 porões). Quando
  // vazia, a nota mostra só a descrição e o valor.
  unit_value?: number | null;
  quantity?: number | null;
  amount: number;
}

export interface FiscalNoteInput {
  kind: FiscalNoteKind;
  number: number;
  year: number;
  job_id?: string | null;
  ship_name: string;
  client_name: string;
  client_legal_name?: string | null;
  client_address?: string | null;
  client_cnpj?: string | null;
  client_ie?: string | null;
  client_municipal?: string | null;
  header_line?: string | null;
  language: FiscalNoteLanguage;
  oi?: string | null;
  port?: string | null;
  arrival_date?: string | null;
  departure_date?: string | null;
  issue_date: string;
  due_date?: string | null;
  currency: FiscalNoteCurrency;
  exchange_rate?: number | null;
  iss_percent?: number | null;
  notes?: string | null;
  items: FiscalNoteItemInput[];
}

// Dados da própria Cargo Ships que saem no topo de toda nota. Vêm do papel
// timbrado das planilhas atuais — se mudar CNPJ/endereço, muda aqui.
export const CARGO_ISSUER = {
  name: "Cargo Ships Cleaning Ltda.",
  address: "Praça Iguatemy Martins, 8 - Vila Nova",
  city: "Santos /SP - CEP: 11013-310",
  phone: "(13) 98816-2379 · (13) 3385-8481",
  email: "cargoships@cargoships.com.br",
  cnpjMatriz: "41.560.212/0001-00",
  inscMatriz: "296149-3",
  cnpjFilial: "41.560.212/0002-91",
  inscFilial: "300885-0",
  ie: "135.961.090.113",
  bank: "Banco Itaú (341)",
  agency: "0447",
  account: "99830-3",
  pix: "41.560.212/0001-00",
} as const;

export const CURRENCY_SYMBOL: Record<FiscalNoteCurrency, string> = {
  BRL: "R$",
  USD: "USD",
};

// Rótulos nos dois idiomas — a Wilson Sons recebe a nota em inglês
// (DEBIT NOTE / BARTHED / SAILED / DEADLINE), os demais em português.
export const NOTE_LABELS = {
  PT: {
    debito: "NOTA DE DÉBITO",
    credito: "NOTA DE CRÉDITO",
    ref: "Ref.:",
    oi: "OI:",
    arrival: "Entrada:",
    departure: "Saída:",
    port: "Porto:",
    description: "Histórico",
    debit: "Débito",
    credit: "Crédito",
    total: "Total",
    subtotal: "SUB-TOTAL",
    grandTotal: "TOTAL",
    due: "VENCIMENTO:",
    invoiceTotal: "Valor total a Fatura:",
    exchange: "TAXA DO DÓLAR: R$",
    inFavorDebit: "Crédito a Favor da Cargo Ships",
    inFavorCredit: "Crédito a Favor do Cliente",
    deposit: "Dados para depósito:",
    obsBRL: "OBS: VALORES EXPRESSOS EM REAL",
    obsUSD: "OBS: VALORES EXPRESSOS EM DÓLAR",
    iss: "ISS do mês",
    issValue: "Valor do ISS",
    noteTotal: "Valor total da NF/ND",
  },
  EN: {
    debito: "DEBIT NOTE",
    credito: "CREDIT NOTE",
    ref: "Ref.:",
    oi: "OI:",
    arrival: "BARTHED:",
    departure: "SAILED:",
    port: "Port:",
    description: "DESCRIPTION",
    debit: "DEBIT",
    credit: "CREDIT",
    total: "Total",
    subtotal: "SUB-TOTAL",
    grandTotal: "TOTAL",
    due: "DEADLINE:",
    invoiceTotal: "Amount:",
    exchange: "DOLLAR EXCHANGE RATE: R$",
    inFavorDebit: "DEBIT TO CLIENT",
    inFavorCredit: "CREDIT TO CLIENT",
    deposit: "Bank details:",
    obsBRL: "OBS: AMOUNTS IN BRAZILIAN REAL",
    obsUSD: "OBS: AMOUNTS IN US DOLLAR",
    iss: "ISS of the month",
    issValue: "ISS amount",
    noteTotal: "Invoice total",
  },
} as const;

export interface FiscalNoteTotals {
  subtotal: number;
  issValue: number;
  total: number;
}

// Subtotal = soma dos itens. O ISS (quando informado) abate do total, como na
// planilha da Wilson Sons: "Total da fatura − Valor do ISS = Valor total da
// NF/ND". Sem ISS, total = subtotal.
export function calcFiscalNoteTotals(
  items: { amount: number }[],
  issPercent?: number | null,
): FiscalNoteTotals {
  const subtotal = +items.reduce((s, it) => s + (Number(it.amount) || 0), 0).toFixed(2);
  const pct = Number(issPercent || 0);
  const issValue = pct > 0 ? +((subtotal * pct) / 100).toFixed(2) : 0;
  return { subtotal, issValue, total: +(subtotal - issValue).toFixed(2) };
}

// "59" + 2026 → "059/26" (formato usado nas planilhas e no nome dos PDFs).
export function formatNoteNumber(number: number, year: number): string {
  return `${String(number).padStart(3, "0")}/${String(year).slice(-2)}`;
}

// Linha de destinatário: `{NAVIO}` no cadastro do cliente vira o nome do navio.
// A Wilson Sons usa "AO COMANDANTE E/OU ARMADOR DO {NAVIO} A/C WILSON SONS…".
export function resolveHeaderLine(
  headerLine: string | null | undefined,
  shipName: string,
  fallback: string,
): string {
  const tpl = (headerLine || "").trim();
  if (!tpl) return fallback;
  return tpl.replace(/\{NAVIO\}/gi, shipName);
}

export function formatMoney(value: number, currency: FiscalNoteCurrency): string {
  return `${CURRENCY_SYMBOL[currency]} ${value.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// dd/mm/aaaa a partir de "aaaa-mm-dd" (as datas do banco chegam como ISO).
export function formatNoteDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return "";
  return `${d}/${m}/${y}`;
}

const MONTHS_PT = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

// "Santos, 25 de Agosto de 2026" — abertura das notas.
export function formatIssueCity(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return "Santos";
  return `Santos, ${Number(d)} de ${MONTHS_PT[Number(m) - 1]} de ${y}`;
}

// Nome do arquivo: "ND 059-26 MV BSM QINZHOU".
export function fiscalNoteFileName(
  kind: FiscalNoteKind,
  number: number,
  year: number,
  shipName: string,
): string {
  const prefix = kind === "DEBITO" ? "ND" : "NC";
  const safeShip = (shipName || "NAVIO").replace(/[\\/:*?"<>|]+/g, "-").trim();
  return `${prefix} ${String(number).padStart(3, "0")}-${String(year).slice(-2)} ${safeShip}`;
}
