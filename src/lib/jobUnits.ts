// Unidades das funções (job_functions.unit) e como elas viram SEÇÕES nas abas
// Valores (Financeiro) e Funções (RH) — fonte única, pra as duas telas ficarem
// sempre iguais. A unidade é texto livre em MAIÚSCULO: além das conhecidas, o
// usuário pode criar as suas no modal — cada unidade nova vira a própria seção.

const KNOWN_UNIT_LABELS: Record<string, string> = {
  MENSALISTA: "MENSALISTA",
  PORAO: "PORÃO",
  POR_NAVIO: "POR NAVIO",
  POR_DIA: "POR DIA",
  POR_HORA: "POR HORA",
  POR_OPERACAO: "POR OPERAÇÃO",
  TURNO: "TURNO (COSTADO)",
  ADMIN_COSTADO: "ADMINISTRATIVO",
};

// Rótulo curto e legível da unidade — sempre em MAIÚSCULO. Unidades conhecidas
// têm um nome amigável; as personalizadas aparecem com o próprio texto.
export function unitLabel(unit: string | null | undefined): string {
  const u = (unit || "").trim().toUpperCase();
  return KNOWN_UNIT_LABELS[u] || u.replace(/_/g, " ");
}

// Normaliza o que o usuário digitou pra guardar no banco: MAIÚSCULO e sem
// espaços (espaço → _), pra bater com as unidades canônicas (POR_NAVIO etc.).
export function normalizeUnit(unit: string | null | undefined): string {
  return (unit || "").trim().toUpperCase().replace(/\s+/g, "_") || "PORAO";
}

// Unidades "de fábrica" oferecidas no combobox, além das já usadas em funções.
export const SUGGESTED_UNITS = ["PORAO", "TURNO", "MENSALISTA"];

// Seção (grupo) de uma unidade. As conhecidas caem em seções canônicas; qualquer
// outra vira a própria seção (identificada pela unidade em MAIÚSCULO).
export function sectionKeyOfUnit(unit: string | null | undefined): string {
  const u = (unit || "").trim().toUpperCase();
  if (u === "TURNO") return "SERVICOS";
  if (u === "MENSALISTA" || u === "POR_DIA" || u === "POR_HORA") return "MENSALISTA";
  if (u === "" || u === "PORAO" || u === "POR_NAVIO" || u === "POR_OPERACAO") return "EMBARQUE";
  return u; // unidade personalizada = seção própria
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
