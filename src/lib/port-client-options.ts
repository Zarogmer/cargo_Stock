// Portos e clientes do sistema.
//
// PORTO = nome padronizado. O mesmo porto aparecia de várias formas no banco
// ("Paranagua"/"Paranaguá", "PORTO AÇU"/"Porto Acu", "São Francisco"/
// "São Francisco do Sul", "Mangaratiba RJ") e cada grafia virava uma opção a
// mais no filtro do Financeiro. Regra desde 2026-09-20:
//   • todo porto gravado (navio, pagamento) passa por canonicalPort();
//   • comparações/dedupe usam portKey() (sem acento, caixa ou espaços extras);
//   • valor com mais de um porto ("Porto do Açu / Rio Grande") é normalizado
//     parte a parte e reunido com " / ".
// Porto novo digitado pelo usuário é aceito (vira Título de Capitalização) e
// pode ganhar entrada no catálogo abaixo quando tiver apelidos conhecidos.
// scripts/normalize-ports.ts aplica a regra nos dados já gravados.

type PortEntry = { name: string; aliases: string[] };

// Apelidos em forma de chave (ver portKey): sem acento, caixa alta, sem
// "PORTO DE/DO" na frente nem sigla de estado no fim — a chave já tira isso,
// então "Porto de Aratu - BA" e "ARATU" caem na mesma entrada.
export const PORT_CATALOG: PortEntry[] = [
  { name: "Santos",               aliases: ["SANTOS SP"] },
  { name: "Paranaguá",            aliases: ["PARANAGUA", "PARANAGUA PR"] },
  { name: "São Francisco do Sul", aliases: ["SAO FRANCISCO", "SAO FRANCISCO SC", "SFS"] },
  { name: "Porto do Açu",         aliases: ["ACU", "AÇU", "PORTO ACU", "ACU RJ"] },
  { name: "Rio Grande",           aliases: ["RIO GRANDE RS"] },
  { name: "Aratu",                aliases: ["ARATU BA", "ARATU - BA"] },
  { name: "Mangaratiba",          aliases: ["MANGARATIBA RJ"] },
  { name: "Sepetiba",             aliases: ["SEPETIBA RJ", "ITAGUAI", "ITAGUAÍ"] },
  { name: "Vitória",              aliases: ["VITORIA", "VITORIA ES"] },
  { name: "Rio de Janeiro",       aliases: ["RIO", "RJ"] },
  { name: "Itaqui",               aliases: ["ITAQUI MA", "SAO LUIS"] },
  { name: "Suape",                aliases: ["SUAPE PE"] },
  { name: "Imbituba",             aliases: ["IMBITUBA SC"] },
  { name: "São Sebastião",        aliases: ["SAO SEBASTIAO"] },
];

// Sementes das listas (ComboBox do navio e filtro do Financeiro): só os
// portos frequentes — os demais entram quando algum navio usar.
export const DEFAULT_PORTS = ["Santos", "Paranaguá", "São Francisco do Sul", "Porto do Açu"];
export const DEFAULT_CLIENTS = ["Deep", "Transatlântica", "Continental", "Wilson Sons"];

const UF = "(?:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)";
// Só com espaço antes: "MANGARATIBA" e "RIO DE JANEIRO" terminam em BA/RO e
// não podem perder o fim. Traço/vírgula já viraram espaço na chave.
const UF_SUFFIX = new RegExp(`\s+${UF}$`);

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Chave de UM porto (sem "/"): sem acento, caixa alta, espaços únicos, sem
// pontuação, sem "PORTO DE/DO/DA" na frente e sem UF no fim.
function singlePortKey(part: string): string {
  let k = stripAccents(part).toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  k = k.replace(/^PORTO (?:DE |DO |DA )?/, "");
  const noUf = k.replace(UF_SUFFIX, "").trim();
  // "RJ" sozinho é apelido do Rio: só tira a UF se sobrar alguma coisa.
  if (noUf) k = noUf;
  return k;
}

const ALIAS_INDEX = new Map<string, string>();
for (const e of PORT_CATALOG) {
  ALIAS_INDEX.set(singlePortKey(e.name), e.name);
  for (const a of e.aliases) ALIAS_INDEX.set(singlePortKey(a), e.name);
}

// "PORTO ACU" → "Porto Acu"; "de/do/da/e" ficam em minúsculo.
function titleCasePt(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w, i) => (i > 0 && ["de", "do", "da", "dos", "das", "e"].includes(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// Separa valores com mais de um porto: "A / B", "A e B", "A, B", "A/B".
function splitPorts(raw: string): string[] {
  return raw
    .split(/\s*(?:\/|,|;|\s+e\s+|\s+&\s+)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

function canonicalSinglePort(part: string): string {
  const key = singlePortKey(part);
  if (!key) return "";
  const known = ALIAS_INDEX.get(key);
  if (known) return known;
  // Porto fora do catálogo: mantém o que o usuário digitou, só padroniza
  // espaços e capitalização (acento preservado).
  const cleaned = part.replace(/\s+/g, " ").trim();
  return cleaned === cleaned.toUpperCase() || cleaned === cleaned.toLowerCase() ? titleCasePt(cleaned) : cleaned;
}

// Nome padronizado do porto (ou "" se vazio). Multi-porto vira "A / B".
export function canonicalPort(raw: string | null | undefined): string {
  const v = (raw || "").trim();
  if (!v) return "";
  const parts = splitPorts(v).map(canonicalSinglePort).filter(Boolean);
  // Dedupe dentro do próprio valor ("Açu / Porto do Açu").
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const k = singlePortKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.join(" / ");
}

// Chave de comparação: dois valores com a mesma chave são o mesmo porto.
export function portKey(raw: string | null | undefined): string {
  return canonicalPort(raw).split(" / ").map(singlePortKey).join("/");
}

// Lista de opções (ComboBox/filtro) sem repetição: entrada vazia ignorada,
// grafias diferentes do mesmo porto viram uma só, ordenada em pt-BR.
export function uniquePortOptions(values: Iterable<string | null | undefined>): string[] {
  const map = new Map<string, string>();
  for (const v of values) {
    const name = canonicalPort(v);
    if (!name) continue;
    const k = portKey(name);
    if (!map.has(k)) map.set(k, name);
  }
  return [...map.values()].sort((a, b) => a.localeCompare(b, "pt-BR"));
}
