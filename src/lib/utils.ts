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

export function formatPhone(value: string | null | undefined): string {
  if (!value) return "—";
  const digits = String(value).replace(/\D/g, "");
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  if (digits.length === 8) return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  return String(value);
}

// Best-effort parse of legacy ASO/training date text — handles ISO ("2026-01-06"),
// Portuguese long form ("06 de janeiro de 2026"), and shorthand ("30 OUTUBRO 2025").
// Returns YYYY-MM-DD or empty string.
const PT_MONTHS: Record<string, string> = {
  janeiro: "01", fevereiro: "02", marco: "03", "março": "03", abril: "04",
  maio: "05", junho: "06", julho: "07", agosto: "08", setembro: "09",
  outubro: "10", novembro: "11", dezembro: "12",
};
export function parseLegacyDate(value: string | null | undefined): string {
  if (!value) return "";
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const norm = s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const m = norm.match(/(\d{1,2})\s*(?:de\s+)?([a-z]+)(?:\s+de)?\s+(\d{4})/);
  if (m) {
    const day = m[1].padStart(2, "0");
    const month = PT_MONTHS[m[2]];
    if (month) return `${m[3]}-${month}-${day}`;
  }
  return "";
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
  LOGIN: "Login",
  LOGOUT: "Logout",
};

export const CATEGORY_LABELS: Record<string, string> = {
  COMPRAS: "Compras",
  CARNES: "Carnes",
  FEIRA: "Feira",
  OUTROS: "Outros",
  CARNE: "Carne",
  SUPRIMENTOS: "Suprimentos",
};
