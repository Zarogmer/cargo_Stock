export function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("pt-BR");
}

export function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatCurrency(value: number): string {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

export function normalize(str: string): string {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function matchSearch(text: string, query: string): boolean {
  if (!query) return true;
  return normalize(text).includes(normalize(query));
}

export const TOOL_STATUS_LABELS: Record<string, string> = {
  DISPONIVEL: "Disponível",
  EQUIPE_1: "Equipe 1",
  EQUIPE_2: "Equipe 2",
  MANUTENCAO: "Manutenção",
};

export const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  ENTRADA: "Entrada",
  BAIXA: "Baixa",
  AJUSTE: "Ajuste",
  ENTREGA: "Entrega",
  DEVOLUCAO: "Devolução",
  EQUIPE_1: "Equipe 1",
  EQUIPE_2: "Equipe 2",
  MANUTENCAO: "Manutenção",
  CADASTRO: "Cadastro",
  PENDENTE: "Pendente",
  APROVADO: "Aprovada",
  REJEITADO: "Rejeitada",
  AGENDADO: "Agendado",
  EM_OPERACAO: "Em Operação",
  CONCLUIDO: "Concluído",
  CANCELADO: "Cancelado",
};

export const CATEGORY_LABELS: Record<string, string> = {
  COMPRAS: "Compras",
  CARNES: "Carnes",
  FEIRA: "Feira",
  OUTROS: "Outros",
  CARNE: "Carne",
  SUPRIMENTOS: "Suprimentos",
};
