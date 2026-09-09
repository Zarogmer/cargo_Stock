// Ordem dos seletores de navio (Escalação, Embarque/Retorno, Costado): o mais
// novo sempre em cima. Quem abre a aba quer o navio da vez — não rolar até o
// fim da lista pra achá-lo. Chegada mais recente primeiro; empate (mesmo dia)
// pelo cadastro mais recente; navio sem data de chegada vai pro fim.
// Ordena aqui e não no banco: no Postgres, DESC joga os NULL pro começo.
export function sortShipsNewestFirst<T extends { arrival_date: string | null; created_at?: string | null }>(
  ships: T[],
): T[] {
  // Datas vêm como ISO ("2026-08-26T00:00:00.000Z"): comparação de string basta.
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...ships].sort(
    (a, b) => cmp(b.arrival_date ?? "", a.arrival_date ?? "") || cmp(b.created_at ?? "", a.created_at ?? ""),
  );
}
