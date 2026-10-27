// Unidades de medida do estoque (stock_items.unit) — fonte única pro seletor
// dos modais (Rancho e materiais) e pra coluna "Un." das tabelas. As oito
// primeiras são as do Rancho de sempre; as demais entraram pros materiais
// (rolo de fio, par de luva, galão, metro de cabo...).
export const STOCK_UNITS: { value: string; label: string }[] = [
  { value: "UN", label: "Unidade (un)" },
  { value: "KG", label: "Quilograma (kg)" },
  { value: "FARDO", label: "Fardo" },
  { value: "L", label: "Litro (L)" },
  { value: "CX", label: "Caixa (cx)" },
  { value: "PCT", label: "Pacote (pct)" },
  { value: "DZ", label: "Dúzia (dz)" },
  { value: "SACO", label: "Saco" },
  { value: "ROLO", label: "Rolo" },
  { value: "PAR", label: "Par" },
  { value: "KIT", label: "Kit/Jogo" },
  { value: "GALAO", label: "Galão" },
  { value: "M", label: "Metro (m)" },
];

// Rótulo curto da unidade pra mensagens e listas: "10 kg", "25 un". Unidade
// desconhecida sai em minúsculas; vazia fica sem sufixo.
const SHORT: Record<string, string> = {
  UN: "un",
  KG: "kg",
  FARDO: "fardo",
  L: "L",
  CX: "cx",
  PCT: "pct",
  DZ: "dz",
  SACO: "saco",
  ROLO: "rolo",
  PAR: "par",
  KIT: "kit",
  GALAO: "galão",
  M: "m",
};

export function unitShort(unit: string | null | undefined): string {
  if (!unit) return "";
  const key = unit.trim().toUpperCase();
  if (!key) return "";
  return SHORT[key] ?? key.toLowerCase();
}

// Unidades que são EMBALAGEM — têm um conteúdo ("CX com 30 DZ", "ROLO de
// 100 m", "GALÃO de 5 L"). Na compra, o valor unitário é da embalagem, não do
// que vem dentro: o Controle de Compras pergunta o conteúdo pra não confundir
// "1 caixa de ovos a R$ 250" com "1 ovo a R$ 250".
export const PACK_UNITS = new Set(["CX", "PCT", "FARDO", "SACO", "KIT", "ROLO", "GALAO"]);

export function isPackUnit(unit: string | null | undefined): boolean {
  return !!unit && PACK_UNITS.has(unit.trim().toUpperCase());
}

// Abreviações que aparecem nas notas fiscais (coluna UN/UNID.) → código do
// STOCK_UNITS. "PC"/"PÇ" é peça (= unidade); "PT"/"PCT"/"PAC" é pacote.
const NF_UNIT_ALIASES: Record<string, string> = {
  UN: "UN", UND: "UN", UNID: "UN", UNIDADE: "UN", U: "UN", PC: "UN", "PÇ": "UN", PECA: "UN", "PEÇA": "UN", PCS: "UN",
  KG: "KG", KILO: "KG", QUILO: "KG",
  FD: "FARDO", FARDO: "FARDO",
  L: "L", LT: "L", LTS: "L", LITRO: "L",
  CX: "CX", CXA: "CX", CAIXA: "CX",
  PT: "PCT", PCT: "PCT", PAC: "PCT", PACOTE: "PCT",
  DZ: "DZ", DUZIA: "DZ", "DÚZIA": "DZ",
  SC: "SACO", SACO: "SACO",
  RL: "ROLO", ROLO: "ROLO", BOB: "ROLO", BOBINA: "ROLO",
  PR: "PAR", PAR: "PAR",
  KIT: "KIT", JG: "KIT", JOGO: "KIT", CJ: "KIT", CONJ: "KIT",
  GL: "GALAO", GAL: "GALAO", GALAO: "GALAO", "GALÃO": "GALAO",
  M: "M", MT: "M", MTS: "M", METRO: "M", MTR: "M",
};

// Unidade lida da nota → código do STOCK_UNITS (ou null se não reconhece).
export function normalizeStockUnit(raw: string | null | undefined): string | null {
  const key = (raw || "").trim().toUpperCase().replace(/\.$/, "");
  if (!key) return null;
  return NF_UNIT_ALIASES[key] ?? null;
}
