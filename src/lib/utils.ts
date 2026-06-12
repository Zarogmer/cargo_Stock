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

// Evolution às vezes manda, no lugar do nome do remetente (pushName), um
// identificador cru do WhatsApp — o "LID" de privacidade (ex.: "12658…@lid"),
// um JID ("…@s.whatsapp.net") ou só dígitos. Isso NÃO é um nome: o contato não
// está salvo e o número não foi exposto, então não dá pra descobrir quem é.
export function isJidLikeName(value: string | null | undefined): boolean {
  if (!value) return false;
  const t = value.trim();
  return /@(lid|s\.whatsapp\.net|g\.us)\s*$/i.test(t) || /^\+?\d{11,}$/.test(t);
}

// Nome de remetente pronto pra exibir: devolve o pushName quando é um nome de
// verdade; quando é um LID/JID cru, devolve um rótulo curto ("Participante
// 499056") em vez do identificador feio; vazio -> null (sem rótulo).
export function cleanSenderName(pushName: string | null | undefined): string | null {
  if (!pushName) return null;
  const name = pushName.trim();
  if (!name) return null;
  if (isJidLikeName(name)) {
    const digits = name.replace(/\D/g, "");
    return digits ? `Participante ${digits.slice(-6)}` : null;
  }
  return name;
}

// Converte um texto digitado em pt-BR (vírgula como separador decimal) para
// número. Ex.: "1,5" -> 1.5, "1,500" -> 1.5, "1.234,5" -> 1234.5, "2" -> 2.
// Se não houver vírgula, assume que o ponto (se houver) é o separador decimal
// ("1.5" -> 1.5). Vazio/ inválido -> 0.
export function parseDecimalBR(value: string | number | null | undefined): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  let s = String(value).trim();
  if (s === "") return 0;
  if (s.includes(",")) {
    // pt-BR: pontos são milhar, vírgula é decimal.
    s = s.replace(/\./g, "").replace(",", ".");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// Formata uma quantidade numérica para exibição em pt-BR, sem zeros à direita.
// Ex.: 1.5 -> "1,5", 3 -> "3", 1.67 -> "1,67", 1500 -> "1.500".
export function formatQty(value: number | string | null | undefined): string {
  const n = typeof value === "number" ? value : parseDecimalBR(value);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 3 });
}

// Sufixo curto da unidade de medida do rancho (ex.: "kg", "un", "fardo").
// Usado no Almoxarifado (tabela/modal) e nas mensagens de prontidão.
export function unitSuffix(unit: string | null | undefined): string {
  const u = (unit || "UN").toUpperCase();
  const map: Record<string, string> = {
    KG: "kg", FARDO: "fardo", L: "L", CX: "cx", PCT: "pct", DZ: "dz", SACO: "saco",
  };
  return map[u] || "un";
}

// ── Código automático de itens do Almoxarifado ──────────────────────────────
// Palavras "vazias" ignoradas ao montar o prefixo (conectores).
const CODE_STOPWORDS = new Set(["DE", "DA", "DO", "DAS", "DOS", "E", "COM", "PARA", "P", "A", "O", "NO", "NA", "EM"]);

// Prefixo do código a partir do nome: iniciais das palavras significativas
// (sem acento, maiúsculas). Ex.: "Mangueira Fina" -> "MF", "Calabresa" -> "CA".
export function codePrefix(name: string): string {
  const norm = normalize(name || "").toUpperCase();
  const words = norm.split(/[^A-Z0-9]+/).filter(Boolean);
  const significant = words.filter((w) => !CODE_STOPWORDS.has(w));
  const pool = significant.length > 0 ? significant : words;
  let prefix = pool.map((w) => w[0]).join("");
  if (prefix.length < 2 && pool[0]) prefix = pool[0].slice(0, 2); // palavra única → 2 letras
  if (!prefix) prefix = "XX";
  return prefix.slice(0, 4);
}

// Gera um código por item (prefixo do nome + sequência de 2 dígitos entre itens
// de mesmo prefixo, ordenados por id = ordem de cadastro). Ex.: dois itens com
// prefixo "MF" → "MF01", "MF02". Derivado (não persiste); recalcula na lista.
export function buildCodeMap<T>(
  items: T[],
  getId: (item: T) => number,
  getName: (item: T) => string,
): Map<number, string> {
  const sorted = [...items].sort((a, b) => getId(a) - getId(b));
  const counters = new Map<string, number>();
  const result = new Map<number, string>();
  for (const item of sorted) {
    const prefix = codePrefix(getName(item));
    const n = (counters.get(prefix) || 0) + 1;
    counters.set(prefix, n);
    result.set(getId(item), `${prefix}${String(n).padStart(2, "0")}`);
  }
  return result;
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

// NR training storage: JSON map of { "1": "2025-01-14", "6": "", ... }.
// "" means NR is checked but date not yet filled. Absence means not checked.
// Backwards compat: legacy CSV ("1,6,7,17,29,35") returns each NR with empty date.
export const VALID_NRS = ["1", "6", "7", "17", "29", "35"] as const;
export type NrCode = (typeof VALID_NRS)[number];
export type NrDates = Partial<Record<NrCode, string>>;

export function parseNrsWithDates(value: string | null | undefined): NrDates {
  if (!value) return {};
  const s = String(value).trim();
  if (s.startsWith("{")) {
    try {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      const out: NrDates = {};
      for (const nr of VALID_NRS) {
        if (nr in parsed) {
          const v = parsed[nr];
          out[nr] = typeof v === "string" ? v : "";
        }
      }
      return out;
    } catch {
      /* fall through to legacy parser */
    }
  }
  const out: NrDates = {};
  for (const nr of VALID_NRS) {
    const re = new RegExp(`(^|[^\\d])${nr}([^\\d]|$)`);
    if (re.test(s)) out[nr] = "";
  }
  return out;
}

export function formatNrsWithDates(map: NrDates): string {
  return JSON.stringify(map);
}

// Training tracked here renews annually. Returns true if the employee has
// any ASO/Meio Ambiente/NR whose 1-year renewal date is already in the past.
export interface TrainingFields {
  last_aso_date: string | null;
  nrs_training: string | null;
  meio_ambiente_training: string | null;
}

function isExpired(isoDate: string): boolean {
  const last = new Date(isoDate + "T00:00:00");
  if (Number.isNaN(last.getTime())) return false;
  const next = new Date(last);
  next.setFullYear(next.getFullYear() + 1);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return next.getTime() < today.getTime();
}

export function hasExpiredTraining(emp: TrainingFields): boolean {
  const aso = parseLegacyDate(emp.last_aso_date);
  if (aso && isExpired(aso)) return true;
  const ma = parseLegacyDate(emp.meio_ambiente_training);
  if (ma && isExpired(ma)) return true;
  const nrs = parseNrsWithDates(emp.nrs_training);
  for (const date of Object.values(nrs)) {
    if (date && isExpired(date)) return true;
  }
  return false;
}

// PENDENCIA is forced when training expired — INATIVO is never overridden.
export function effectiveEmployeeStatus(
  emp: TrainingFields & { status: string | null }
): "ATIVO" | "INATIVO" | "PENDENCIA" {
  const stored = (emp.status || "ATIVO") as "ATIVO" | "INATIVO" | "PENDENCIA";
  if (stored === "INATIVO") return "INATIVO";
  if (stored === "PENDENCIA") return "PENDENCIA";
  if (hasExpiredTraining(emp)) return "PENDENCIA";
  return "ATIVO";
}

// Visual label only — the internal DB value stays "INATIVO" so existing
// filters, RBAC and queries keep working. We just present it as "Demitido"
// to end users.
export const EMPLOYEE_STATUS_LABELS: Record<"ATIVO" | "INATIVO" | "PENDENCIA", string> = {
  ATIVO: "Ativo",
  INATIVO: "Demitido",
  PENDENCIA: "Pendência",
};

export function employeeStatusLabel(s: "ATIVO" | "INATIVO" | "PENDENCIA" | string | null | undefined): string {
  if (!s) return "—";
  return EMPLOYEE_STATUS_LABELS[s as "ATIVO" | "INATIVO" | "PENDENCIA"] ?? s;
}

export const TOOL_STATUS_LABELS: Record<string, string> = {
  DISPONIVEL: "Disponível",
  EQUIPE_1: "Equipe 1",
  EQUIPE_2: "Equipe 2",
  MANUTENCAO: "Manutenção",
};

// Tipos de ativo da tabela `tools` (asset_type). Cada um vira uma aba própria no
// Almoxarifado e um destino na compra. Rótulos com emoji compartilhados pelo
// seletor de Tipo e pelo destino da compra.
export const ASSET_TYPE_LABELS: Record<string, string> = {
  MAQUINARIO: "⚙️ Maquinário",
  FERRAMENTA: "🔧 Ferramenta",
  ELETRICA: "⚡ Elétrica",
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
