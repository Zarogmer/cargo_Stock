// Rótulo curto da unidade de medida do estoque (stock_items.unit) pra usar em
// mensagens e listas: "10 kg", "25 un". As chaves são as mesmas opções de
// unidade do Almoxarifado (STOCK_UNITS em estoque-panel.tsx). Unidade
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
};

export function unitShort(unit: string | null | undefined): string {
  if (!unit) return "";
  const key = unit.trim().toUpperCase();
  if (!key) return "";
  return SHORT[key] ?? key.toLowerCase();
}
