import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

// Precisa de Buffer (base64 da imagem) e fetch sem edge limits → Node runtime.
export const runtime = "nodejs";

interface PreviewResult {
  name: string | null;
  value: number | null;
  image: string | null; // data URL (base64 inline) ou, em último caso, a URL remota
  supplier: string | null;
  url: string; // URL final após redirecionamentos
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
  maxHops = 5,
): Promise<{ res: Response; finalUrl: string }> {
  let current = initial;
  for (let i = 0; i < maxHops; i++) {
    const res = await fetchWithTimeout(
      current.toString(),
      {
        headers: { "User-Agent": UA, Accept: accept, "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8" },
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
  // Remove sufixos comuns de marketplace ("... | Mercado Livre").
  const known = "Mercado Livre|MercadoLivre|Mercado Libre|Amazon[^|\\-–—]*|Shopee|Magazine Luiza|Magalu|Americanas|AliExpress";
  title = title.replace(new RegExp(`\\s*[|\\-–—]\\s*(?:${known})\\s*$`, "i"), "");
  if (siteName) {
    const sn = siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title.replace(new RegExp(`\\s*[|\\-–—]\\s*${sn}\\s*$`, "i"), "");
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

  let html: string;
  let finalUrl = u.toString();
  try {
    const { res, finalUrl: fu } = await safeFetch(
      u,
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      9000,
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

  const siteName = metaContent(html, "og:site_name");
  const name = extractTitle(html, siteName);

  const ogImage =
    metaContent(html, "og:image:secure_url") ||
    metaContent(html, "og:image") ||
    metaContent(html, "twitter:image") ||
    metaContent(html, "twitter:image:src");
  const image = ogImage ? (await imageToDataUrl(ogImage)) || ogImage : null;

  const value = priceFromJsonLd(html) ?? priceFromMeta(html);

  const supplier = siteName || u.hostname.replace(/^www\./, "");

  const result: PreviewResult = { name, value, image, supplier, url: finalUrl };
  return NextResponse.json(result);
}
