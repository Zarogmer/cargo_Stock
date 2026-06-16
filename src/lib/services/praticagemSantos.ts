/**
 * Praticagem de Santos (ZP-21) — leitor do line-up.
 *
 * O sistema da Praticagem de São Paulo publica em /servicos (atrás de login) o
 * quadro "SERVIÇOS DE PRATICAGEM", com 4 tabelas server-rendered:
 *   #movimentos  — movimentos do dia (IMO, NAVIO, MV, LOC#1/2, POB, PASSAG, CALADO, AGENTE, BORDO, TUG)
 *   #manobras    — manobras previstas (IMO, NAVIO, MV, LOC#1/2, AGENTE, BORDO, TUG)
 *   #fundeados   — navios fundeados na barra (IMO, NAVIO, FUNDEIO)
 *   #atracados   — navios atracados (IMO, NAVIO, LOCAL)
 *
 * A AGÊNCIA (quem contatar) só existe em #movimentos e #manobras. Cruzamos por
 * IMO pra enriquecer os fundeados/atracados com a agência quando ela aparece em
 * outra tabela.
 *
 * Acesso AUTORIZADO: logamos com as credenciais do operador (PRATICAGEM_USUARIO/
 * PRATICAGEM_SENHA) — é a porta da frente. Sem credenciais, o serviço lança um
 * erro tipado pra degradar com elegância (igual ao aisStream).
 *
 * Parser é dependency-free (regex) porque o HTML é gerado por máquina e estável.
 */

const BASE = "https://login.sppilots.com.br";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface PraticagemShip {
  imo: string;
  name: string;
  agencia: string | null;
  /** Rótulo amigável: "Fundeado (na barra)" | "Em movimento" | "Previsto" | "Atracado". */
  situacao: string;
  /** Movimento: "E" (entrando) | "S" (saindo) quando conhecido. */
  mv: string | null;
  /** Berço/posição (LOC) ou local de atracação. */
  local: string | null;
  /** Horário relevante: POB (movimento) ou hora do fundeio. */
  horario: string | null;
  /** Em quais tabelas o navio apareceu (movimento/previsto/fundeado/atracado). */
  presence: string[];
}

export class PraticagemConfigError extends Error {
  constructor() {
    super("PRATICAGEM_USUARIO/PRATICAGEM_SENHA não configuradas");
    this.name = "PraticagemConfigError";
  }
}

export class PraticagemFetchError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "PraticagemFetchError";
  }
}

function getCreds(): { usuario: string; senha: string } {
  const usuario = process.env.PRATICAGEM_USUARIO?.trim();
  const senha = process.env.PRATICAGEM_SENHA?.trim();
  if (!usuario || !senha) throw new PraticagemConfigError();
  return { usuario, senha };
}

// ─── Parser (puro, testável) ────────────────────────────────────────────────

// Cor de fundo da linha (#movimentos) → status legível da manobra.
const COLOR_STATUS: Record<string, string> = {
  "#ff4a4a": "Encerrada",
  "#00bfff": "Em andamento",
  "#b7b7ff": "Confirmada",
  "#ffffff": "Em previsão",
};

// Devolve o HTML da primeira <table> que aparece depois do elemento id="X".
function sectionTable(html: string, id: string): string {
  const idx = html.indexOf(`id="${id}"`);
  if (idx === -1) return "";
  const m = html.slice(idx).match(/<table[\s\S]*?<\/table>/i);
  return m ? m[0] : "";
}

function decode(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

interface Row {
  color: string | null;
  cells: string[];
}

// Lê as linhas de dados de uma <table>. Pula o cabeçalho (<th>). Quebra as
// células pela tag de ABERTURA <td> — assim aguenta o HTML levemente quebrado
// do #fundeados (que esquece alguns </td>).
function parseRows(tableHtml: string): Row[] {
  const rows: Row[] = [];
  const trRe = /<tr([^>]*)>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(tableHtml)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    if (/<th[\s>]/i.test(inner)) continue; // cabeçalho
    const colorMatch = attrs.match(/background:\s*(#[0-9a-f]+)/i);
    const color = colorMatch ? colorMatch[1].toLowerCase() : null;
    const cells = inner
      .split(/<td[^>]*>/i)
      .slice(1)
      .map((c) => decode(c));
    if (cells.length > 0) rows.push({ color, cells });
  }
  return rows;
}

/** Faz o parse das 4 tabelas e devolve a lista unificada por IMO. */
export function parseServicos(html: string): PraticagemShip[] {
  const mov = parseRows(sectionTable(html, "movimentos"));
  const man = parseRows(sectionTable(html, "manobras"));
  const fun = parseRows(sectionTable(html, "fundeados"));
  const atr = parseRows(sectionTable(html, "atracados"));

  const byImo = new Map<string, PraticagemShip>();
  const ensure = (imo: string, name: string): PraticagemShip => {
    let s = byImo.get(imo);
    if (!s) {
      s = {
        imo,
        name: name || "",
        agencia: null,
        situacao: "—",
        mv: null,
        local: null,
        horario: null,
        presence: [],
      };
      byImo.set(imo, s);
    }
    if (!s.name && name) s.name = name;
    return s;
  };

  // #movimentos: [0]IMO [1]NAVIO [2]MV [3]LOC#1 [4]LOC#2 [5]POB [6]PASSAG [7]CALADO [8]AGENTE [9]BORDO [10]TUG
  for (const r of mov) {
    const c = r.cells;
    if (!c[0]) continue;
    const s = ensure(c[0], c[1]);
    if (!s.presence.includes("movimento")) s.presence.push("movimento");
    if (c[8]) s.agencia = c[8];
    s.mv = c[2] || s.mv;
    s.local = c[4] || c[3] || s.local;
    s.horario = c[5] || s.horario;
    if (r.color && COLOR_STATUS[r.color]) s.situacao = COLOR_STATUS[r.color];
  }

  // #manobras: [0]IMO [1]NAVIO [2]MV [3]LOC#1 [4]LOC#2 [5]AGENTE [6]BORDO [7]TUG
  for (const r of man) {
    const c = r.cells;
    if (!c[0]) continue;
    const s = ensure(c[0], c[1]);
    if (!s.presence.includes("previsto")) s.presence.push("previsto");
    if (!s.agencia && c[5] && c[5].toUpperCase() !== "XXXXX") s.agencia = c[5];
    s.mv = s.mv || c[2];
    s.local = s.local || c[4] || c[3];
  }

  // #fundeados: [0]IMO [1]NAVIO [2]FUNDEIO
  for (const r of fun) {
    const c = r.cells;
    if (!c[0]) continue;
    const s = ensure(c[0], c[1]);
    if (!s.presence.includes("fundeado")) s.presence.push("fundeado");
    s.horario = s.horario || c[2];
  }

  // #atracados: [0]IMO [1]NAVIO [2]LOCAL
  for (const r of atr) {
    const c = r.cells;
    if (!c[0]) continue;
    const s = ensure(c[0], c[1]);
    if (!s.presence.includes("atracado")) s.presence.push("atracado");
    s.local = s.local || c[2];
  }

  // Rótulo de situação — prioridade pensada na prospecção (fundeado = na barra,
  // esperando = melhor alvo; depois em movimento; depois previsto; depois atracado).
  for (const s of byImo.values()) {
    s.situacao = s.presence.includes("fundeado")
      ? "Fundeado (na barra)"
      : s.presence.includes("movimento")
        ? `Em movimento${s.situacao && s.situacao !== "—" ? ` · ${s.situacao}` : ""}`
        : s.presence.includes("previsto")
          ? "Previsto"
          : s.presence.includes("atracado")
            ? "Atracado"
            : "—";
  }

  // Ordena: com agência primeiro (são os que dá pra emailar), depois por nome.
  return [...byImo.values()].sort((a, b) => {
    const aw = a.agencia ? 0 : 1;
    const bw = b.agencia ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return a.name.localeCompare(b.name);
  });
}

// ─── Login + fetch ────────────────────────────────────────────────────────────

function extractPhpsessid(res: Response): string | null {
  // Node 20+: getSetCookie() devolve array; fallback pro header combinado.
  const raw =
    typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie().join("; ")
      : res.headers.get("set-cookie") || "";
  const m = raw.match(/PHPSESSID=([^;,\s]+)/i);
  return m ? m[1] : null;
}

/**
 * Loga na praticagem e baixa o HTML de /servicos com a sessão autenticada.
 * Lança PraticagemConfigError se faltar credencial e PraticagemFetchError se a
 * página não vier como esperado.
 */
export async function fetchServicosHtml(): Promise<string> {
  const { usuario, senha } = getCreds();

  // 1. Login: POST do formulário (action=login) — estabelece a sessão (PHPSESSID).
  let cookie = "";
  try {
    const loginRes = await fetch(`${BASE}/inc/ajaxRequest.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
      },
      body: new URLSearchParams({ usuario, senha, redirect: "santos", action: "login" }).toString(),
      redirect: "manual",
    });
    const sid = extractPhpsessid(loginRes);
    if (sid) cookie = `PHPSESSID=${sid}`;
    // O corpo do login é só diagnóstico — não derrubamos por aqui pra não dar
    // falso-negativo; a validação real é a tabela aparecer no /servicos.
    await loginRes.text().catch(() => "");
  } catch (err) {
    throw new PraticagemFetchError(`Falha no login da praticagem: ${(err as Error).message}`);
  }

  // 2. Busca /servicos com a sessão.
  let html: string;
  try {
    const res = await fetch(`${BASE}/servicos`, {
      headers: { Cookie: cookie, "User-Agent": UA },
      redirect: "manual",
    });
    html = await res.text();
  } catch (err) {
    throw new PraticagemFetchError(`Falha ao buscar /servicos: ${(err as Error).message}`);
  }

  if (!/id="movimentos"/i.test(html)) {
    throw new PraticagemFetchError(
      "A página /servicos não veio com a tabela esperada (o login pode ter falhado)."
    );
  }
  return html;
}

/** Login + fetch + parse. Devolve a lista de navios de Santos com a agência. */
export async function fetchPraticagemShips(): Promise<PraticagemShip[]> {
  const html = await fetchServicosHtml();
  return parseServicos(html);
}
