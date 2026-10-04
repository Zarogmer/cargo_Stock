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

// Linha da tabela invoice_clients (Financeiro › Dados dos Clientes).
export interface InvoiceClientRow {
  id: number;
  name: string;
  legal_name: string | null;
  address: string | null;
  cnpj: string | null;
  ie: string | null;
  municipal_reg: string | null;
  header_line: string | null;
  language: string;
  default_currency: string;
  // Só a Wilson Sons trabalha com OI — o campo aparece no modal só pra ela.
  requires_oi: boolean;
  // Dados para depósito da nota deste cliente (uma linha por informação).
  // NULL = Itaú padrão da CARGO_ISSUER. A Deep recebe a conta Santander.
  deposit_bank: string | null;
  // Forma de cálculo da nota deste cliente (ver CALC_METHODS).
  calc_method?: string | null;
  // Rótulo da caixa amarela do valor ("Valor total a Fatura:" na Continental,
  // "Valor" na Wilson Sons e na Deep). Vazio = padrão do idioma.
  value_label?: string | null;
  notes: string | null;
}

// Cada cliente fatura de um jeito. As duas formas vêm das planilhas da
// diretoria (2- INVOICE/<cliente>):
//   • DIRETO — Continental e demais (ND CONTINENTAL 2026.xlsx): o valor fechado
//     de cada serviço é digitado direto na moeda da nota (R$ ou USD), sem
//     conversão; total = soma dos itens.
//   • USD_CONVERTIDO — Wilson Sons (NOTAS DE DÉBITOS 2026.xlsx): o serviço é
//     negociado em USD por porão/lancha; USD × qtd × taxa negociada = R$, que é
//     o que sai no débito. O ISS do mês × total da fatura sai no crédito e abate
//     do total. Lancha vai em nota separada, mesma taxa, sem ISS.
export type FiscalNoteCalcMethod = "DIRETO" | "USD_CONVERTIDO";

export function normalizeCalcMethod(v: string | null | undefined): FiscalNoteCalcMethod {
  return v === "USD_CONVERTIDO" ? "USD_CONVERTIDO" : "DIRETO";
}

export const CALC_METHODS: Record<FiscalNoteCalcMethod, { label: string; steps: string[] }> = {
  DIRETO: {
    label: "Valor fechado na moeda da nota",
    steps: [
      "O valor fechado de cada serviço é digitado direto na moeda da nota (R$ ou USD) — não há conversão pelo dólar.",
      "Total da nota = soma dos itens (SUB-TOTAL = TOTAL).",
      "Nota em dólar sai com a observação \"VALORES EXPRESSOS EM DÓLAR\"; em real, \"VALORES EXPRESSOS EM REAL\".",
    ],
  },
  USD_CONVERTIDO: {
    label: "USD × quantidade × taxa do dólar = R$",
    steps: [
      "Valor do serviço em USD (por porão / por lancha) × quantidade = total em USD.",
      "Total em USD × taxa do dólar negociada = valor em R$ — é o que sai no DÉBITO da nota.",
      "Total da fatura × ISS do mês (contabilidade) = valor do ISS, que sai no CRÉDITO e abate do total.",
      "Lancha (Boat support) vai em nota separada, com a mesma taxa e sem ISS.",
    ],
  },
};

// Títulos PADRÃO dos itens da nota, levantados das notas emitidas em 2026
// (2- INVOICE/WILSON SONS, CONTINENTAL e DEEP). Cada um tem a versão em
// português (Continental, Deep) e em inglês (Wilson Sons) — trocar o idioma
// da nota troca o título que ainda estiver no padrão. O usuário continua
// livre pra escrever o que quiser.
export interface ItemTitlePreset {
  key: string;
  // Rótulo curto do botão no modal.
  label: string;
  PT: string;
  EN: string;
  // Serviço do navio (ships.services) que sugere este título sozinho.
  service?: string;
  // Só faz sentido em Nota de Crédito (repasse).
  creditOnly?: boolean;
}

export function itemTitlePresets(shipName: string, holds: number, clientName: string): ItemTitlePreset[] {
  const n = Math.max(1, Number(holds) || 1);
  const hh = String(n).padStart(2, "0");
  const ship = (shipName || "").trim();
  const bare = ship.replace(/^M\/?V\s+/i, "").toUpperCase();
  const client = (clientName || "").trim();
  return [
    { key: "LIMPEZA", label: "Limpeza de porões", service: "LAVAGEM_PORAO",
      PT: `Prestação de Serviço de Limpeza em ${n} Porões do ${ship}`,
      EN: `HOLD CLEANING OF ${hh} HOLDS OF THE SHIP: ${bare}` },
    { key: "RASPAGEM", label: "Raspagem", service: "RASPAGEM",
      PT: `Prestação de Serviço de Raspagem em ${n} Porões do ${ship}`,
      EN: `HOLD SCRAPING OF ${hh} HOLDS OF THE SHIP: ${bare}` },
    { key: "PINTURA", label: "Pintura", service: "PINTURA",
      PT: `Prestação de Serviço de Pintura em ${n} Porões do ${ship}`,
      EN: `HOLD PAINTING OF ${hh} HOLDS OF THE SHIP: ${bare}` },
    { key: "RASPAGEM_PINTURA", label: "Raspagem e Pintura",
      PT: `Prestação de Serviço de Raspagem e Pintura em ${n} Porões do ${ship}`,
      EN: `HOLD SCRAPING AND PAINTING OF ${hh} HOLDS OF THE SHIP: ${bare}` },
    { key: "COSTADO", label: "Limpeza de costado",
      PT: `Prestação de Serviço de Limpeza de Costado do ${ship}`,
      EN: `HULL CLEANING OF THE SHIP: ${bare}` },
    { key: "LANCHA", label: "Barco / Lancha",
      PT: "BARCO/LANCHA (EMBARQUE/DESEMBARQUE)",
      EN: "Boat support - 2 trips" },
    { key: "PISO", label: "Raspagem de piso",
      PT: "Raspagem de piso",
      EN: "FLOOR SANDING" },
    { key: "FERRUGEM", label: "Ferrugem (rust scales)",
      PT: "Remoção de ferrugem",
      EN: "RUST SCALES" },
    { key: "QUIMICA", label: "Química nos pisos",
      PT: "Aplicação de química nos pisos",
      EN: "CHEMICAL APPLICATION ON THE FLOORS" },
    { key: "DIARIAS", label: "Diárias",
      PT: "Diárias",
      EN: "DAILY RATES" },
    { key: "CANCELADO", label: "Serviço cancelado",
      PT: "Custos operacionais (Prestação de serviço cancelada)",
      EN: "OPERATIONAL COSTS (SERVICE CANCELLED)" },
    { key: "CREDITO", label: "Crédito (repasse)", creditOnly: true,
      PT: `Crédito ${client}`.trim(),
      EN: `Credit ${client}`.trim() },
  ];
}

// USD unitário × quantidade × taxa → R$ (2 casas), como H22*H23*H25 da planilha
// da Wilson Sons. Devolve também o total em USD pra memória de cálculo.
export function convertUsdItem(unitUsd: number, qty: number, rate: number): { totalUsd: number; amountBrl: number } {
  const totalUsd = (Number(unitUsd) || 0) * (Number(qty) || 0);
  return { totalUsd: +totalUsd.toFixed(2), amountBrl: +(totalUsd * (Number(rate) || 0)).toFixed(2) };
}

// Linha do ISS na nota. Em inglês segue o modelo da Wilson Sons:
// "TAXES CALCULATED BY THE SERVICE COST (ISS: 2,71%)".
export function issLineLabel(language: FiscalNoteLanguage, pct: number): string {
  const p = pct.toLocaleString("pt-BR", { maximumFractionDigits: 4 });
  if (language === "EN") return `TAXES CALCULATED BY THE SERVICE COST (ISS: ${p}%)`;
  const L = NOTE_LABELS.PT;
  return `${L.iss} (${p}%) - ${L.issValue}`;
}

// Chave pra casar o cliente do navio com o cadastro fiscal: sem acento, caixa
// ou espaços extras ("Transatlântica" = "TRANSATLANTICA ").
export function clientKey(name: string | null | undefined): string {
  return (name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toUpperCase();
}

export function findInvoiceClient<T extends { name: string }>(list: T[], name: string | null | undefined): T | undefined {
  const k = clientKey(name);
  if (!k) return undefined;
  return list.find((c) => clientKey(c.name) === k);
}

// Linhas do bloco "Dados para depósito": as do cadastro do cliente quando
// preenchidas, senão o Itaú padrão.
export function depositLines(depositBank: string | null | undefined): string[] {
  const custom = (depositBank || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (custom.length) return custom;
  return [
    CARGO_ISSUER.bank,
    `AG: ${CARGO_ISSUER.agency}`,
    `C/C: ${CARGO_ISSUER.account}`,
    `PIX: ${CARGO_ISSUER.pix}`,
  ];
}
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
  // Forma de cálculo usada na emissão. Em USD_CONVERTIDO o unit_value dos itens
  // está em USD e o amount em R$ — a memória "unit x qtd" não é impressa.
  calc_method?: string | null;
  value_label?: string | null;
  notes?: string | null;
  // Dados para depósito do cliente (cadastro). Vazio = Itaú padrão.
  deposit_bank?: string | null;
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
    description: "Descrição",
    debit: "Débito",
    credit: "Crédito",
    total: "Total",
    subtotal: "SUB-TOTAL",
    grandTotal: "TOTAL",
    due: "VENCIMENTO:",
    invoiceTotal: "Valor total a Fatura:",
    exchange: "TAXA DO DÓLAR: R$",
    inFavorDebit: "Débito para {CLIENTE}",
    inFavorCredit: "Crédito para {CLIENTE}",
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
    // Na nota em inglês da Wilson Sons a caixa amarela é a única coisa em
    // português: fica "Valor", como no modelo original.
    invoiceTotal: "Valor",
    exchange: "DOLLAR EXCHANGE RATE: R$",
    inFavorDebit: "DEBIT TO {CLIENTE}",
    inFavorCredit: "CREDIT TO {CLIENTE}",
    deposit: "Bank details:",
    obsBRL: "OBS: AMOUNTS IN BRAZILIAN REAL",
    obsUSD: "OBS: AMOUNTS IN US DOLLAR",
    iss: "ISS of the month",
    issValue: "ISS amount",
    noteTotal: "Invoice total",
  },
} as const;

// Linha de fechamento da nota: "DEBIT TO WILSON SONS" / "Débito para WILSON
// SONS". Débito = o cliente nos deve; crédito = devolvemos ao cliente. Sempre
// em nome do CLIENTE da nota (nunca "a favor da Cargo Ships"), como no modelo
// que a Wilson Sons recebe.
export function inFavorLine(language: FiscalNoteLanguage, isDebit: boolean, clientName: string): string {
  const L = NOTE_LABELS[language] ?? NOTE_LABELS.PT;
  const tpl = isDebit ? L.inFavorDebit : L.inFavorCredit;
  return tpl.replace("{CLIENTE}", (clientName || "").trim().toUpperCase() || (language === "EN" ? "CLIENT" : "CLIENTE"));
}

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
