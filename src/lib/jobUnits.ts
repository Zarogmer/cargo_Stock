// Unidades das funções (job_functions.unit) e como elas viram SEÇÕES nas abas
// Valores (Financeiro) e Funções (RH) — fonte única, pra as duas telas ficarem
// sempre iguais. A "unidade" é o GRUPO da função e o usuário a enxerga com o
// mesmo nome da seção: EMBARQUE, COSTADO ou MENSALISTA. Além dessas três, ele
// pode criar unidades próprias no modal — cada uma vira a sua própria seção.
//
// Funções antigas ainda podem ter no banco os valores legados (PORAO, POR_NAVIO,
// TURNO...); eles continuam funcionando e aparecem com o nome do grupo.

const KNOWN_UNIT_LABELS: Record<string, string> = {
  // Canônicas (o que o usuário escolhe hoje) = nome do grupo:
  EMBARQUE: "EMBARQUE",
  COSTADO: "COSTADO",
  MENSALISTA: "MENSALISTA",
  // Legados → mostram o nome do grupo correspondente:
  PORAO: "EMBARQUE",
  POR_NAVIO: "EMBARQUE",
  POR_OPERACAO: "EMBARQUE",
  TURNO: "COSTADO",
  POR_DIA: "MENSALISTA",
  POR_HORA: "MENSALISTA",
  ADMIN_COSTADO: "ADMINISTRATIVO",
};

// Rótulo curto e legível da unidade — sempre em MAIÚSCULO. Unidades conhecidas
// têm um nome amigável; as personalizadas aparecem com o próprio texto.
export function unitLabel(unit: string | null | undefined): string {
  const u = (unit || "").trim().toUpperCase();
  return KNOWN_UNIT_LABELS[u] || u.replace(/_/g, " ");
}

// Normaliza o que o usuário digitou pra guardar no banco: MAIÚSCULO e sem
// espaços (espaço → _). As três canônicas ficam EMBARQUE/COSTADO/MENSALISTA.
export function normalizeUnit(unit: string | null | undefined): string {
  return (unit || "").trim().toUpperCase().replace(/\s+/g, "_") || "EMBARQUE";
}

// Unidades "de fábrica" oferecidas no dropdown — os três grupos do sistema.
export const SUGGESTED_UNITS = ["EMBARQUE", "COSTADO", "MENSALISTA"];

// Seção (grupo) de uma unidade. As conhecidas (canônicas + legados) caem nas três
// seções do sistema; qualquer outra vira a própria seção (a unidade em MAIÚSCULO).
export function sectionKeyOfUnit(unit: string | null | undefined): string {
  const u = (unit || "").trim().toUpperCase();
  if (u === "COSTADO" || u === "TURNO") return "SERVICOS";
  if (u === "MENSALISTA" || u === "POR_DIA" || u === "POR_HORA") return "MENSALISTA";
  if (u === "" || u === "EMBARQUE" || u === "PORAO" || u === "POR_NAVIO" || u === "POR_OPERACAO") return "EMBARQUE";
  return u; // unidade personalizada = seção própria
}

// Valor canônico da unidade que representa a seção da função — usado pra casar o
// <select> do modal. Legados (POR_NAVIO, TURNO...) resolvem pra EMBARQUE/COSTADO/
// MENSALISTA; unidades personalizadas resolvem pra elas mesmas.
export function unitToOption(unit: string | null | undefined): string {
  const key = sectionKeyOfUnit(unit);
  if (key === "EMBARQUE") return "EMBARQUE";
  if (key === "SERVICOS") return "COSTADO";
  if (key === "MENSALISTA") return "MENSALISTA";
  return (unit || "").trim().toUpperCase(); // personalizada
}

// Opções do dropdown de unidade, sem duplicatas: as três canônicas + as
// unidades personalizadas já em uso (uma por seção customizada).
export function unitOptions(existingUnits: Array<string | null | undefined>): string[] {
  const opts = [...SUGGESTED_UNITS];
  for (const u of existingUnits) {
    const opt = unitToOption(u);
    if (opt && !opts.includes(opt)) opts.push(opt);
  }
  return opts;
}

const SECTION_META: Record<string, { title: string; hint: string }> = {
  EMBARQUE: { title: "🚢 EMBARQUE", hint: "Pago por porão — inclui os extras Raspagem e Pintura" },
  SERVICOS: { title: "⚓ COSTADO", hint: "Pago por turno" },
  MENSALISTA: { title: "🗓️ MENSALISTA", hint: "Salário fixo mensal" },
};

export function sectionMeta(key: string): { title: string; hint: string } {
  return SECTION_META[key] || { title: `📋 ${unitLabel(key)}`, hint: "Unidade personalizada" };
}

// Ordena as seções presentes: Embarque e Costado primeiro, as personalizadas no
// meio (alfabético) e a Mensalista sempre por último.
export function orderedSectionKeys(units: Array<string | null | undefined>): string[] {
  const present = Array.from(new Set(units.map(sectionKeyOfUnit)));
  const head = ["EMBARQUE", "SERVICOS"].filter((k) => present.includes(k));
  const custom = present
    .filter((k) => !["EMBARQUE", "SERVICOS", "MENSALISTA"].includes(k))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const tail = present.includes("MENSALISTA") ? ["MENSALISTA"] : [];
  return [...head, ...custom, ...tail];
}
