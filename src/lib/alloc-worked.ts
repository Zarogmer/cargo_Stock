// Regra financeira: quais alocações contam como "trabalhadas".
//
// Quando o navio finaliza (data de saída passou), a rotina de liberação
// (release-finished-ships.ts) marca as alocações como REMOVIDO só pra soltar a
// pessoa da escala do RH — ela trabalhou a operação inteira e continua tendo
// que aparecer no Financeiro (Controle de Equipe, Faturar etc.). Já uma remoção
// manual (substituição, falta) é remoção de verdade e não conta.
//
// O discriminador é o prefixo do motivo — a liberação automática sempre grava
// "Navio finalizado (...)" (o texto entre parênteses variou entre versões,
// então NÃO case a string inteira).
const RELEASE_REASON_PREFIX = "Navio finalizado";

export function allocCountsAsWorked(a: {
  status?: string | null;
  removal_reason?: string | null;
}): boolean {
  if ((a.status ?? "ATIVO") === "ATIVO") return true;
  return a.status === "REMOVIDO" && (a.removal_reason || "").startsWith(RELEASE_REASON_PREFIX);
}

// Colapsa duplicatas do mesmo funcionário no mesmo job: o cabo-de-guerra entre
// o auto-add de ADMINISTRATIVO (Financeiro) e a liberação de navio finalizado
// (release-finished-ships.ts) acumulou várias linhas REMOVIDO "Navio
// finalizado" pra mesma pessoa — cada uma contaria de novo no custo.
//
// Regra: cada (job, funcionário, kind) vale UMA linha. Exceção: Costado, onde
// cada turno (data + período) é uma linha legítima — a mesma pessoa pode fazer
// dois turnos no mesmo dia. Linha sem funcionário (alocação só por função) não
// é colapsada. Preferência: ATIVO ganha de REMOVIDO; empate fica com a mais
// recente (id maior).
export function dedupeWorkedAllocations<T extends {
  id: number;
  job_id: string;
  employee_id?: number | null;
  kind?: string | null;
  status?: string | null;
  shift_date?: string | null;
  shift_period?: string | null;
}>(allocs: T[]): T[] {
  const best = new Map<string, T>();
  for (const a of allocs) {
    if (a.employee_id == null) continue;
    const kind = a.kind || "EMBARQUE";
    const key = kind === "COSTADO"
      ? `${a.job_id}|${a.employee_id}|${kind}|${a.shift_date || ""}|${a.shift_period || ""}`
      : `${a.job_id}|${a.employee_id}|${kind}`;
    const cur = best.get(key);
    if (!cur) { best.set(key, a); continue; }
    const curActive = (cur.status ?? "ATIVO") === "ATIVO";
    const aActive = (a.status ?? "ATIVO") === "ATIVO";
    if ((aActive && !curActive) || (aActive === curActive && a.id > cur.id)) best.set(key, a);
  }
  const kept = new Set<number>(Array.from(best.values(), (a) => a.id));
  return allocs.filter((a) => a.employee_id == null || kept.has(a.id));
}
