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
