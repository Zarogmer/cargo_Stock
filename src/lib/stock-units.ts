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
