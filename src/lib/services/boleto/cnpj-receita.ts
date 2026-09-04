// Consulta pública de CNPJ (dados da Receita Federal) — BrasilAPI com
// fallback minhareceita.org, os dois gratuitos e sem chave. Usada pela leitura
// de NF pela câmera: o CNPJ do emitente vem embutido na chave de acesso, e é
// daqui que saem razão social/fantasia/endereço quando o fornecedor ainda não
// está no cadastro.
//
// Módulo de servidor (fetch externo). Falha de rede/timeout devolve null —
// quem chama segue sem os dados da Receita.

export interface ReceitaCnpj {
  cnpj: string; // 14 dígitos
  razao: string;
  fantasia: string | null;
  endereco: string | null; // "Rua X, 123 - Bairro, Cidade/UF"
  municipio: string | null;
  uf: string | null;
  email: string | null;
  telefone: string | null;
  fonte: "brasilapi" | "minhareceita";
}

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// As duas fontes espelham as colunas do dataset da RF (razao_social,
// nome_fantasia, logradouro, ddd_telefone_1...), então um leitor só serve.
function fromDataset(d: Record<string, unknown>, cnpj: string, fonte: ReceitaCnpj["fonte"]): ReceitaCnpj | null {
  const razao = str(d.razao_social);
  if (!razao) return null;
  const municipio = str(d.municipio);
  const uf = str(d.uf);
  const rua = [str(d.descricao_tipo_de_logradouro), str(d.logradouro)].filter(Boolean).join(" ");
  const partes = [
    [rua, str(d.numero)].filter(Boolean).join(", "),
    str(d.bairro),
    municipio && uf ? `${municipio}/${uf}` : municipio || uf,
  ].filter(Boolean);
  return {
    cnpj,
    razao,
    fantasia: str(d.nome_fantasia),
    endereco: partes.length ? partes.join(" - ") : null,
    municipio,
    uf,
    email: str(d.email),
    telefone: str(d.ddd_telefone_1),
    fonte,
  };
}

export async function lookupCnpjReceita(cnpj: string): Promise<ReceitaCnpj | null> {
  const clean = (cnpj || "").replace(/\D/g, "");
  if (clean.length !== 14 || /^0+$/.test(clean)) return null;
  const b = await fetchJson(`https://brasilapi.com.br/api/cnpj/v1/${clean}`, 5000);
  const fromB = b && fromDataset(b, clean, "brasilapi");
  if (fromB) return fromB;
  const m = await fetchJson(`https://minhareceita.org/${clean}`, 5000);
  return (m && fromDataset(m, clean, "minhareceita")) || null;
}

export function formatCnpj(cnpj: string): string {
  const c = (cnpj || "").replace(/\D/g, "");
  return c.length === 14 ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}` : cnpj;
}

// ── Casamento razão social/fantasia × nome do cadastro ──────────────────────
// O cadastro costuma ter o apelido ("HIGIENEPLASTIC", "CARIBE"); a Receita
// devolve a razão social completa ("HIGIENE PLASTIC COMERCIO ... LTDA").
// Normaliza (maiúsculas sem acento, sem sufixos societários) e aceita quando
// um lado contém o outro — também na forma sem espaços.

const STOPWORDS = new Set([
  "LTDA", "EPP", "EIRELI", "MEI", "ME", "SA", "COMERCIO", "COMERCIAL",
  "DISTRIBUIDORA", "DISTRIBUICAO", "INDUSTRIA", "IND", "SERVICOS", "SERVICO",
  "DE", "DA", "DO", "DOS", "DAS", "E",
]);

// NFD separa a letra do acento; o filtro descarta os diacríticos (U+0300–036F).
function stripDiacritics(s: string): string {
  return Array.from(s.normalize("NFD"))
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c < 0x300 || c > 0x36f;
    })
    .join("");
}

export function normalizeCompanyName(s: string): string {
  return stripDiacritics(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(" ")
    .trim();
}

// Forte o bastante pra vincular CNPJ ao cadastro sem confirmação humana:
// exige pelo menos 5 caracteres no lado mais curto (evita siglas genéricas).
export function companyNamesMatch(a: string, b: string): boolean {
  const ca = normalizeCompanyName(a).replace(/ /g, "");
  const cb = normalizeCompanyName(b).replace(/ /g, "");
  if (Math.min(ca.length, cb.length) < 5) return false;
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}
