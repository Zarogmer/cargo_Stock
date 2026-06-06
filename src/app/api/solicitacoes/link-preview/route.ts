import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isMercadoLivreLink, fetchMlItem } from "@/lib/services/mercado-livre";

// Precisa de Buffer (base64 da imagem) e fetch sem edge limits → Node runtime.
export const runtime = "nodejs";

interface PreviewResult {
  name: string | null;
  value: number | null;
  image: string | null; // data URL (base64 inline) ou, em último caso, a URL remota
  supplier: string | null;
  url: string; // URL final após redirecionamentos
  keywords?: string | null; // palavras-chave oficiais (só Mercado Livre conectado)
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Alguns marketplaces (ex.: Mercado Livre) servem uma página "isca" minúscula
// pra fetch de servidor com UA de navegador, mas entregam o HTML completo (com
// JSON-LD de preço) pro Googlebot — que eles tratam como SEO. Pra esses hosts
// usamos o UA do Googlebot, e aí o valor passa a vir.
const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

// Detecta domínios do Mercado Livre (.com.br e variações do Mercado Libre).
function isMercadoLivre(host: string): boolean {
  const h = host.toLowerCase();
  return /(^|\.)mercadolivre\.com(\.br)?$/.test(h) || /(^|\.)mercadolibre\.com(\.[a-z]{2})?$/.test(h);
}

// Hosts que rendem mais com o UA do Googlebot (hoje só o ML precisa).
function prefersGooglebot(host: string): boolean {
  return isMercadoLivre(host);
}

// Nome "bonito" do fornecedor a partir do host — mostra "Mercado Livre" em vez
// de "mercadolivre.com.br". Cobre os marketplaces mais usados; o resto cai no
// og:site_name ou no próprio host.
const SUPPLIER_NAMES: { test: (h: string) => boolean; name: string }[] = [
  { test: isMercadoLivre, name: "Mercado Livre" },
  { test: (h) => /(^|\.)amazon\.com(\.br)?$/.test(h), name: "Amazon" },
  { test: (h) => /(^|\.)magazineluiza\.com\.br$/.test(h) || /(^|\.)magalu\.com$/.test(h), name: "Magazine Luiza" },
  { test: (h) => /(^|\.)americanas\.com\.br$/.test(h), name: "Americanas" },
  { test: (h) => /(^|\.)casasbahia\.com\.br$/.test(h), name: "Casas Bahia" },
  { test: (h) => /(^|\.)shopee\.com\.br$/.test(h), name: "Shopee" },
  { test: (h) => /(^|\.)aliexpress\.com$/.test(h), name: "AliExpress" },
  { test: (h) => /(^|\.)kabum\.com\.br$/.test(h), name: "KaBuM!" },
  { test: (h) => /(^|\.)leroymerlin\.com\.br$/.test(h), name: "Leroy Merlin" },
];
function friendlySupplier(host: string): string | null {
  const h = host.toLowerCase();
  for (const s of SUPPLIER_NAMES) if (s.test(h)) return s.name;
  return null;
}

// ── Anti-SSRF ────────────────────────────────────────────────────────────────
// O app roda na Railway com serviços internos (Evolution em *.railway.internal,
// Postgres, etc.). Buscar URLs arbitrárias no servidor é um risco de SSRF, então
// bloqueamos hosts internos/privados e protocolos não-HTTP — inclusive a cada
// redirecionamento.
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  // IPv6 loopback / link-local / unique-local
  if (h === "::1" || h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true;
  // IPv4 literais: loopback / privados / link-local (metadata 169.254.169.254)
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

function safeUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (isBlockedHost(u.hostname)) return null;
  return u;
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: "manual" });
  } finally {
    clearTimeout(t);
  }
}

// Segue redirecionamentos manualmente, revalidando cada hop contra o anti-SSRF.
async function safeFetch(
  initial: URL,
  accept: string,
  ms: number,
  ua: string = UA,
  maxHops = 5,
): Promise<{ res: Response; finalUrl: string }> {
  let current = initial;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetchWithTimeout(
      current.toString(),
      {
        headers: { "User-Agent": ua, Accept: accept, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" },
      },
      ms,
    );
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { res, finalUrl: current.toString() };
      const next = safeUrl(new URL(loc, current).toString());
      if (!next) throw new Error("redirecionamento bloqueado");
      current = next;
      continue;
    }
    return { res, finalUrl: current.toString() };
  }
  throw new Error("muitos redirecionamentos");
}

// ── Parsing de HTML (regex leve — sem dependências de DOM) ───────────────────
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function metaContent(html: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${k}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1]).trim();
  }
  return null;
}

// Busca recursiva pelo primeiro "price" plausível dentro de um JSON-LD.
function findPrice(node: unknown, depth = 0): number | null {
  if (node == null || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const p = findPrice(v, depth + 1);
      if (p != null) return p;
    }
    return null;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    for (const key of ["price", "lowPrice", "highPrice"]) {
      if (key in obj) {
        const n = Number(String(obj[key]).replace(",", "."));
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    for (const k of Object.keys(obj)) {
      const p = findPrice(obj[k], depth + 1);
      if (p != null) return p;
    }
  }
  return null;
}

function priceFromJsonLd(html: string): number | null {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const p = findPrice(JSON.parse(raw));
      if (p != null) return p;
    } catch {
      // bloco inválido — ignora e tenta o próximo
    }
  }
  return null;
}

// Primeiro valor string plausível — `image` no JSON-LD pode vir como string,
// array ou objeto { url }.
function firstString(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) {
    for (const x of v) { const s = firstString(x); if (s) return s; }
    return null;
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.url === "string" && o.url.trim()) return o.url.trim();
  }
  return null;
}

// Lê name/image/price do JSON-LD de produto. Um "nó de produto" é qualquer
// objeto com @type Product OU com `name` + `offers` — o ML não marca
// @type:"Product", então não dá pra exigir isso. Achata arrays e @graph.
// Pegar o nome daqui evita o og:title do ML, que vem sujo
// ("... - R$ 6.999,00 | Parcelamento sem juros").
interface JsonLdInfo { name: string | null; image: string | null; price: number | null; }
function parseJsonLd(html: string): JsonLdInfo {
  const out: JsonLdInfo = { name: null, image: null, price: null };
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1].trim();
    if (!raw) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const stack: unknown[] = [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node); continue; }
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (Array.isArray(o["@graph"])) stack.push(...(o["@graph"] as unknown[]));
      const type = o["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
      const productLike = isProduct || (typeof o.name === "string" && "offers" in o);
      if (!productLike) continue;
      if (out.name == null && typeof o.name === "string" && o.name.trim()) {
        out.name = decodeEntities(o.name).trim();
      }
      if (out.image == null) {
        const img = firstString(o.image);
        if (img) out.image = img;
      }
      if (out.price == null) {
        const p = findPrice(o);
        if (p != null) out.price = p;
      }
    }
    if (out.name && out.image && out.price != null) break;
  }
  return out;
}

// <meta itemprop="price" content="6999"> — comum em PDPs (inclusive ML).
function priceFromItemprop(html: string): number | null {
  const m =
    html.match(/itemprop=["']price["'][^>]*\bcontent=["']([^"']+)["']/i) ||
    html.match(/\bcontent=["']([^"']+)["'][^>]*itemprop=["']price["']/i);
  if (!m?.[1]) return null;
  const cleaned = m[1]
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function priceFromMeta(html: string): number | null {
  const raw =
    metaContent(html, "product:price:amount") ||
    metaContent(html, "og:price:amount") ||
    metaContent(html, "twitter:data1");
  if (!raw) return null;
  // Tira símbolos, normaliza separadores: ponto de milhar (seguido de 3 dígitos)
  // some; vírgula vira ponto decimal. "1.234,56" → 1234.56 ; "199.90" → 199.90.
  const cleaned = raw
    .replace(/[^\d.,]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractTitle(html: string, siteName: string | null): string | null {
  let title = metaContent(html, "og:title") || metaContent(html, "twitter:title");
  if (!title) {
    const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (tm?.[1]) title = decodeEntities(tm[1]).trim();
  }
  if (!title) return null;
  // Remove sufixos comuns de marketplace e marketing: "... | Mercado Livre",
  // "... - R$ 6.999,00", "... | Parcelamento sem juros".
  const known = "Mercado Livre|MercadoLivre|Mercado Libre|Amazon[^|\\-–—]*|Shopee|Magazine Luiza|Magalu|Americanas|AliExpress|Parcelamento sem juros|Frete gr[aá]tis";
  const knownRe = new RegExp(`\\s*[|\\-–—]\\s*(?:${known})\\s*$`, "i");
  const priceRe = /\s*[|\-–—]\s*R\$\s*[\d.,]+\s*$/i;
  // Loop porque o ML empilha vários sufixos ("... - R$ X | Parcelamento...").
  for (let i = 0; i < 4; i++) {
    const before: string = title;
    title = title.replace(knownRe, "").replace(priceRe, "");
    if (siteName) {
      const sn = siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      title = title.replace(new RegExp(`\\s*[|\\-–—]\\s*${sn}\\s*$`, "i"), "");
    }
    if (title === before) break;
  }
  return title.trim() || null;
}

// Baixa a imagem e devolve um data URL base64 (inline, no espírito do resto do
// app). Falhou / grande demais / não-imagem → null (o caller cai na URL remota).
async function imageToDataUrl(imgUrl: string): Promise<string | null> {
  const u = safeUrl(imgUrl);
  if (!u) return null;
  try {
    const { res } = await safeFetch(u, "image/*,*/*;q=0.8", 7000);
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!ct.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > 1_500_000) return null;
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

// POST /api/solicitacoes/link-preview  { url }
// Best-effort: sempre responde 200 (com `error` textual quando não dá pra ler a
// página) pra UI seguir deixando o usuário preencher na mão.
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let url: string;
  try {
    ({ url } = (await request.json()) as { url: string });
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const u = safeUrl(url || "");
  if (!u) return NextResponse.json({ error: "Link inválido ou não permitido." }, { status: 200 });

  // Mercado Livre conectado: tenta a API OFICIAL primeiro (nome/preço/foto limpos
  // + palavras-chave). Qualquer falha (não configurado, sem token, item removido,
  // timeout) cai na raspagem abaixo — que segue funcionando sem a conta conectada.
  if (isMercadoLivreLink(u.toString())) {
    try {
      const item = await fetchMlItem(u.toString());
      if (item && (item.title || item.price != null || item.picture)) {
        const image = item.picture ? (await imageToDataUrl(item.picture)) || item.picture : null;
        const result: PreviewResult = {
          name: item.title || null,
          value: item.price,
          image,
          supplier: "Mercado Livre",
          url: item.permalink || u.toString(),
          keywords: item.keywords || null,
        };
        return NextResponse.json(result);
      }
    } catch (err) {
      console.warn("[link-preview] API oficial do ML indisponível, usando raspagem:", (err as Error).message);
    }
  }

  // ML (e afins) só entregam a página completa — com o preço — pro Googlebot.
  const htmlUa = prefersGooglebot(u.hostname) ? GOOGLEBOT_UA : UA;
  let html: string;
  let finalUrl = u.toString();
  try {
    const { res, finalUrl: fu } = await safeFetch(
      u,
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      9000,
      htmlUa,
    );
    finalUrl = fu;
    if (!res.ok) {
      return NextResponse.json({ error: `Não consegui abrir o link (HTTP ${res.status}).`, url: finalUrl }, { status: 200 });
    }
    if (!(res.headers.get("content-type") || "").includes("html")) {
      return NextResponse.json({ error: "O link não aponta para uma página de produto.", url: finalUrl }, { status: 200 });
    }
    const raw = await res.text();
    html = raw.length > 2_000_000 ? raw.slice(0, 2_000_000) : raw;
  } catch {
    return NextResponse.json({ error: "Falha ao buscar o link (tempo esgotado ou bloqueado pelo site).", url: finalUrl }, { status: 200 });
  }

  const ld = parseJsonLd(html);
  const siteName = metaContent(html, "og:site_name");
  // Nome: prioriza o JSON-LD (limpo); cai no og:title/title só se faltar.
  const name = ld.name || extractTitle(html, siteName);

  const ogImage =
    metaContent(html, "og:image:secure_url") ||
    metaContent(html, "og:image") ||
    metaContent(html, "twitter:image") ||
    metaContent(html, "twitter:image:src");
  const imageSrc = ogImage || ld.image;
  const image = imageSrc ? (await imageToDataUrl(imageSrc)) || imageSrc : null;

  // Valor: JSON-LD de produto → meta de preço → itemprop → varredura global de
  // JSON-LD. Fica `null` quando o item está sem preço (ex.: anúncio esgotado),
  // e aí a UI deixa o campo em branco pro preenchimento manual.
  const value =
    ld.price ?? priceFromMeta(html) ?? priceFromItemprop(html) ?? priceFromJsonLd(html);

  // Fornecedor: nome amigável do marketplace ("Mercado Livre") quando o host é
  // conhecido; senão og:site_name; por último o host sem "www.".
  const supplier =
    friendlySupplier(u.hostname) || siteName || u.hostname.replace(/^www\./, "");

  const result: PreviewResult = { name, value, image, supplier, url: finalUrl, keywords: null };
  return NextResponse.json(result);
}
