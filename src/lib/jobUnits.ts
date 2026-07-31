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

// Emoji do grupo — os canônicos mantêm o ícone de sempre; personalizados usam 📋.
const UNIT_EMOJI: Record<string, string> = { EMBARQUE: "🚢", COSTADO: "⚓", MENSALISTA: "🗓️" };
export function unitEmoji(name: string | null | undefined): string {
  return UNIT_EMOJI[(name || "").trim().toUpperCase()] || "📋";
}

// ── Forma de pagamento da unidade (job_units.pay_mode) ───────────────────────
// PORAO = por porão (Embarque), TURNO = por turno (Costado), MENSAL = salário
// fixo (Mensalista). PORAO/TURNO entram na escala do navio; MENSAL fica fora.
export type UnitPayMode = "PORAO" | "TURNO" | "MENSAL";

export const PAY_MODE_LABELS: Record<UnitPayMode, string> = {
  PORAO: "Por porão (como Embarque)",
  TURNO: "Por turno (como Costado)",
  MENSAL: "Mensalidade (salário fixo)",
};

// Normaliza o pay_mode vindo do banco; default PORAO (igual às personalizadas).
export function normalizePayMode(mode: string | null | undefined): UnitPayMode {
  const m = (mode || "").trim().toUpperCase();
  return m === "TURNO" || m === "MENSAL" ? m : "PORAO";
}

// Só PORAO e TURNO trabalham em navio (viram escala). MENSAL é valor fixo.
export function payModeIsEscalable(mode: string | null | undefined): boolean {
  const m = normalizePayMode(mode);
  return m === "PORAO" || m === "TURNO";
}

// Pay_mode-padrão derivado do nome quando a unidade não tem o campo (legado):
// COSTADO/TURNO → TURNO; MENSALISTA/POR_DIA/POR_HORA → MENSAL; resto → PORAO.
export function fallbackPayModeOfUnit(unit: string | null | undefined): UnitPayMode {
  const key = sectionKeyOfUnit(unit);
  if (key === "SERVICOS") return "TURNO";
  if (key === "MENSALISTA") return "MENSAL";
  return "PORAO";
}

// Decide o pay_mode de uma função pela unidade dela: procura a unidade cadastrada
// (mapa nome→pay_mode, chave em MAIÚSCULO) e cai no fallback pelo nome se faltar.
export function payModeOfFunctionUnit(
  unit: string | null | undefined,
  payModeByUnitName: Map<string, string>,
): UnitPayMode {
  const optName = unitToOption(unit).toUpperCase();
  const found = payModeByUnitName.get(optName);
  return found ? normalizePayMode(found) : fallbackPayModeOfUnit(unit);
}

// Descrição-padrão de fallback quando a unidade (ou legado) não tem texto próprio.
const DEFAULT_UNIT_HINT: Record<string, string> = {
  EMBARQUE: "Pago por porão — inclui os extras Raspagem e Pintura",
  COSTADO: "Pago por turno",
  MENSALISTA: "Salário fixo mensal",
};
export function unitHint(name: string | null | undefined, description?: string | null): string {
  if (description && description.trim()) return description.trim();
  return DEFAULT_UNIT_HINT[(name || "").trim().toUpperCase()] || "";
}

// Resolve uma função pelo NOME. Agora que o mesmo nome pode existir em unidades
// diferentes, isto desempata: prefere a função da SEÇÃO informada (ex.: "EMBARQUE"
// pra cargo pago por porão, "SERVICOS" pro Costado), depois a ativa. Quando o nome
// NÃO se repete, devolve a única — então o comportamento é idêntico ao de antes
// pra qualquer dado sem nome duplicado (pagamento não muda).
export function pickFunctionByName<
  F extends { name: string; unit?: string | null; active?: boolean | null },
>(functions: F[], name: string | null | undefined, preferSection?: string): F | undefined {
  const target = (name || "").trim().toUpperCase();
  if (!target) return undefined;
  const matches = functions.filter((f) => (f.name || "").trim().toUpperCase() === target);
  if (matches.length <= 1) return matches[0];
  if (preferSection) {
    const want = preferSection.trim().toUpperCase();
    const pref = matches.find((f) => sectionKeyOfUnit(f.unit) === want && f.active !== false);
    if (pref) return pref;
  }
  return matches.find((f) => f.active !== false) || matches[0];
}

// Função-carregador do ADMINISTRATIVO: o pessoal de escritório entra no custo
// do navio pelo SETOR (RH › Colaboradores), com valor por pessoa gravado no
// próprio colaborador (employees.admin_ship_rate). A função ADMINISTRATIVO
// existe só porque job_allocations.function_id é obrigatório — ela NÃO aparece
// nas listas de funções (Valores, RH › Funções, cargo do colaborador) nem pode
// ser a função principal do Costado. Vale também pra categoria legada
// ADMIN_COSTADO.
export function isAdminCarrierFn(f: { name?: string | null; unit?: string | null }): boolean {
  return (
    (f.name || "").trim().toUpperCase() === "ADMINISTRATIVO" ||
    (f.unit || "").trim().toUpperCase() === "ADMIN_COSTADO"
  );
}

// Função "principal" do Costado — todos os escalados de Costado entram nela.
// Depois de aposentar a antiga função COSTADO (valor fixo, sem rosto), passa a ser
// a função ATIVA da seção SERVICOS (ex.: AUXILIAR OPERACIONAL), que aceita valor
// por pessoa. Prefere uma que NÃO seja a própria "COSTADO"; cai nela só como
// fallback, pra não quebrar antes da migração. A ADMINISTRATIVO nunca entra —
// uma função de admin criada na seção Costado sombreava a real por ordem
// alfabética e zerava o valor/turno dos cards.
export function pickCostadoFunction<
  F extends { name: string; unit?: string | null; active?: boolean | null },
>(functions: F[]): F | undefined {
  const servicos = functions.filter(
    (f) => sectionKeyOfUnit(f.unit) === "SERVICOS" && !isAdminCarrierFn(f),
  );
  const active = servicos.filter((f) => f.active !== false);
  const isCostadoName = (f: F) => (f.name || "").trim().toUpperCase() === "COSTADO";
  return (
    active.find((f) => !isCostadoName(f)) ||
    active[0] ||
    servicos.find(isCostadoName) ||
    servicos[0]
  );
}

// Monta as seções a partir das UNIDADES cadastradas (job_units) + as funções.
// Cada unidade vira uma seção (na ordem sort_order → nome), mesmo vazia, pra o
// usuário poder adicionar funções nela. Funções apontando pra uma unidade sem
// cadastro (não deveria acontecer após o seed) viram seções extras no fim, pra
// nada sumir da tela.
export interface UnitSection<F> {
  name: string;
  description: string | null;
  functions: F[];
}
export function buildUnitSections<F extends { unit?: string | null }>(
  units: Array<{ name: string; description: string | null; sort_order: number }>,
  functions: F[],
): UnitSection<F>[] {
  const byUnit = new Map<string, F[]>();
  for (const f of functions) {
    const key = unitToOption(f.unit);
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key)!.push(f);
  }
  const rows = [...units].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "pt-BR"),
  );
  const seen = new Set(rows.map((u) => u.name.toUpperCase()));
  const sections: UnitSection<F>[] = rows.map((u) => ({
    name: u.name,
    description: u.description,
    functions: byUnit.get(u.name.toUpperCase()) || [],
  }));
  for (const [key, fns] of byUnit) {
    if (!seen.has(key.toUpperCase())) {
      sections.push({ name: key, description: null, functions: fns });
    }
  }
  return sections;
}
