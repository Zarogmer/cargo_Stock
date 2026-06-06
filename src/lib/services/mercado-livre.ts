/**
 * Integração com a API OFICIAL do Mercado Livre.
 *
 * Fluxo OAuth 2.0 Authorization Code (cliente confidencial — usa client_secret).
 * A empresa autoriza UMA vez (Mensagens → Conectar Mercado Livre); guardamos
 * access_token + refresh_token em app_settings e renovamos sozinhos. O access
 * token dura 6h; o refresh token é de uso único e ROTACIONA a cada renovação —
 * por isso salvamos o novo refresh a cada refresh.
 *
 * Uso principal: a partir de um LINK de produto do ML, ler o item oficial
 * (título = palavras-chave, atributos como marca/modelo, preço, foto) via
 *   GET /items/{id}        (anúncio)
 *   GET /products/{id}     (catálogo, links .../p/MLB...)
 *
 * Sem MERCADO_LIVRE_CLIENT_ID/SECRET o serviço lança MercadoLivreConfigError;
 * sem conta conectada, MercadoLivreAuthError. Os callers degradam graciosamente
 * (ex.: a raspagem do link-preview continua funcionando).
 *
 * PKCE: o app é confidencial (tem client_secret), então NÃO usamos PKCE. Deixe a
 * opção "PKCE" desativada na configuração do app no painel do Mercado Livre.
 */

import { prisma } from "@/lib/prisma";

// ── Endpoints (Brasil) ───────────────────────────────────────────────────────
const AUTH_BASE = "https://auth.mercadolivre.com.br/authorization";
const TOKEN_URL = "https://api.mercadolibre.com/oauth/token";
const API_BASE = "https://api.mercadolibre.com";

// Chave única em app_settings com o JSON dos tokens.
const TOKENS_KEY = "mercado_livre_oauth";

// Cookie curto com o `state` do OAuth — setado no /connect e validado no
// /callback contra CSRF. Mora aqui pra ser fonte única das duas rotas.
export const ML_STATE_COOKIE = "ml_oauth_state";

// Renova um pouco antes de expirar pra nunca usar token vencido numa chamada.
const EXPIRY_SKEW_MS = 5 * 60_000; // 5 min
const DEFAULT_EXPIRES_S = 21_600; // 6h, caso a resposta não traga expires_in

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Erros tipados (mesmo espírito do aisStream.ts) ───────────────────────────
export class MercadoLivreConfigError extends Error {
  constructor() {
    super("Mercado Livre não configurado (defina MERCADO_LIVRE_CLIENT_ID e MERCADO_LIVRE_CLIENT_SECRET).");
    this.name = "MercadoLivreConfigError";
  }
}

export class MercadoLivreAuthError extends Error {
  constructor(message = "Conta do Mercado Livre não conectada ou autorização expirada. Reconecte em Mensagens.") {
    super(message);
    this.name = "MercadoLivreAuthError";
  }
}

export class MercadoLivreApiError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "MercadoLivreApiError";
  }
}

// ── Config por env ───────────────────────────────────────────────────────────
export function isMercadoLivreConfigured(): boolean {
  return Boolean(
    process.env.MERCADO_LIVRE_CLIENT_ID?.trim() &&
      process.env.MERCADO_LIVRE_CLIENT_SECRET?.trim(),
  );
}

function clientId(): string {
  const v = process.env.MERCADO_LIVRE_CLIENT_ID?.trim();
  if (!v) throw new MercadoLivreConfigError();
  return v;
}

function clientSecret(): string {
  const v = process.env.MERCADO_LIVRE_CLIENT_SECRET?.trim();
  if (!v) throw new MercadoLivreConfigError();
  return v;
}

// Redirect URI: usa o explícito (MERCADO_LIVRE_REDIRECT_URI) ou deriva do AUTH_URL
// (mesma base do app). DEVE bater EXATAMENTE com o cadastrado no painel do ML.
export function mlRedirectUri(): string {
  const explicit = process.env.MERCADO_LIVRE_REDIRECT_URI?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const base = (process.env.AUTH_URL || "").trim().replace(/\/$/, "");
  return `${base}/api/integrations/mercado-livre/callback`;
}

// ── Helpers HTTP ─────────────────────────────────────────────────────────────
async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Tokens em app_settings ───────────────────────────────────────────────────
export interface MlTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  user_id: number | null;
  scope: string | null;
  updated_at: number; // epoch ms
}

export async function readMlTokens(): Promise<MlTokens | null> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: TOKENS_KEY } });
    if (!row?.value) return null;
    const t = JSON.parse(row.value) as Partial<MlTokens>;
    if (!t.access_token || !t.refresh_token) return null;
    return {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Number(t.expires_at) || 0,
      user_id: typeof t.user_id === "number" ? t.user_id : null,
      scope: t.scope ?? null,
      updated_at: Number(t.updated_at) || 0,
    };
  } catch {
    return null;
  }
}

async function saveMlTokens(t: MlTokens, actor?: string | null): Promise<void> {
  const value = JSON.stringify(t);
  await prisma.appSetting.upsert({
    where: { key: TOKENS_KEY },
    update: { value, updated_by: actor ?? null },
    create: { key: TOKENS_KEY, value, updated_by: actor ?? null },
  });
}

export async function clearMlTokens(): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: TOKENS_KEY } });
}

// ── OAuth ────────────────────────────────────────────────────────────────────
export function buildMlAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId(),
    redirect_uri: mlRedirectUri(),
    state,
  });
  return `${AUTH_BASE}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  user_id?: number;
  refresh_token: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetchWithTimeout(
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams(body).toString(),
    },
    10_000,
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* resposta não-JSON */
  }
  if (!res.ok) {
    const msg =
      json && typeof json === "object" && "message" in json
        ? String((json as { message: unknown }).message)
        : `HTTP ${res.status}`;
    // 400 invalid_grant / 401 = código ou refresh token inválido → reconectar.
    if (res.status === 400 || res.status === 401) {
      throw new MercadoLivreAuthError(`Mercado Livre recusou a autorização: ${msg}`);
    }
    throw new MercadoLivreApiError(`Falha no token do Mercado Livre: ${msg}`, res.status);
  }
  return json as TokenResponse;
}

function toTokens(r: TokenResponse): MlTokens {
  const now = Date.now();
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token,
    expires_at: now + (Number(r.expires_in) || DEFAULT_EXPIRES_S) * 1000,
    user_id: typeof r.user_id === "number" ? r.user_id : null,
    scope: r.scope ?? null,
    updated_at: now,
  };
}

// Troca o `code` do callback por tokens e salva. Quem chama: a rota /callback.
export async function exchangeMlCode(code: string, actor?: string | null): Promise<MlTokens> {
  const r = await postToken({
    grant_type: "authorization_code",
    client_id: clientId(),
    client_secret: clientSecret(),
    code,
    redirect_uri: mlRedirectUri(),
  });
  const tokens = toTokens(r);
  await saveMlTokens(tokens, actor);
  return tokens;
}

async function refreshMlTokens(current: MlTokens): Promise<MlTokens> {
  const r = await postToken({
    grant_type: "refresh_token",
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: current.refresh_token,
  });
  const tokens = toTokens(r);
  await saveMlTokens(tokens);
  return tokens;
}

// Serializa o refresh no processo: o refresh token é de uso único, então duas
// renovações simultâneas fariam a segunda falhar. Suficiente pro porte do app
// (1 instância na Railway).
let refreshInFlight: Promise<MlTokens> | null = null;
function refreshOnce(current: MlTokens): Promise<MlTokens> {
  if (!refreshInFlight) {
    refreshInFlight = refreshMlTokens(current).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// Token de acesso válido (renova se preciso). Lança MercadoLivreConfigError se
// faltam credenciais e MercadoLivreAuthError se a conta nunca foi conectada.
export async function getMlAccessToken(): Promise<string> {
  if (!isMercadoLivreConfigured()) throw new MercadoLivreConfigError();
  const current = await readMlTokens();
  if (!current) throw new MercadoLivreAuthError();
  if (Date.now() < current.expires_at - EXPIRY_SKEW_MS) return current.access_token;
  const refreshed = await refreshOnce(current);
  return refreshed.access_token;
}

// Status pra UI (Mensagens). Nunca lança.
export interface MlStatus {
  configured: boolean;
  connected: boolean;
  userId: number | null;
  expiresAt: number | null;
}

export async function getMlStatus(): Promise<MlStatus> {
  const configured = isMercadoLivreConfigured();
  const tokens = configured ? await readMlTokens() : null;
  return {
    configured,
    connected: Boolean(tokens),
    userId: tokens?.user_id ?? null,
    expiresAt: tokens?.expires_at ?? null,
  };
}

// ── Itens / palavras-chave ───────────────────────────────────────────────────
export interface MlAttribute {
  id: string;
  name: string;
  value: string;
}

export interface MlItem {
  id: string;
  title: string;
  price: number | null;
  picture: string | null; // URL da imagem (https)
  permalink: string | null;
  attributes: MlAttribute[];
  keywords: string; // título oficial + marca/modelo (string pronta pra exibir)
  categoryId: string | null;
}

// Reconhece links do Mercado Livre / Mercado Libre / encurtadores (meli.la).
function isMlHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    /(^|\.)mercadolivre\.com(\.br)?$/.test(h) ||
    /(^|\.)mercadolibre\.com(\.[a-z]{2})?$/.test(h) ||
    /(^|\.)meli\.la$/.test(h)
  );
}

export function isMercadoLivreLink(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return isMlHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

// MLB-1234567890 (anúncio) — aceita com ou sem hífen, qualquer site (MLB/MLA/...).
const MLB_RE = /\b(ML[A-Z])-?(\d{6,})\b/i;

interface ItemRef {
  kind: "item" | "product";
  id: string;
}

function parseItemRef(rawUrl: string): ItemRef | null {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  // Catálogo: .../p/MLB123 → produto (id contíguo, sem hífen).
  const prod = u.pathname.match(/\/p\/(ML[A-Z])(\d{6,})/i);
  if (prod) return { kind: "product", id: `${prod[1].toUpperCase()}${prod[2]}` };
  // Anúncio: MLB-123 no path ou no host (produto.mercadolivre.com.br/MLB-123-...).
  const item = `${u.pathname} ${u.hostname}`.match(MLB_RE);
  if (item) return { kind: "item", id: `${item[1].toUpperCase()}${item[2]}` };
  return null;
}

// Segue redirecionamentos de links curtos do ML (mercadolivre.com/sec/..., meli.la)
// até achar a URL final com o id. Só segue hosts http(s).
async function resolveShortLink(start: URL): Promise<URL | null> {
  let current = start;
  for (let i = 0; i < 5; i++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        current.toString(),
        { method: "GET", redirect: "manual", headers: { "User-Agent": UA } },
        8000,
      );
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return current;
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        return null;
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") return null;
      current = next;
      continue;
    }
    return current;
  }
  return current;
}

function mapAttributes(raw: unknown): MlAttribute[] {
  if (!Array.isArray(raw)) return [];
  const out: MlAttribute[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    const values = Array.isArray(o.values) ? (o.values as Record<string, unknown>[]) : [];
    const value = String(o.value_name ?? values[0]?.name ?? "").trim();
    if (!value) continue;
    out.push({ id: String(o.id ?? ""), name: String(o.name ?? ""), value });
  }
  return out;
}

function firstPicture(pics: unknown): string | null {
  if (!Array.isArray(pics)) return null;
  const p = pics[0] as Record<string, unknown> | undefined;
  if (!p) return null;
  const url = p.secure_url || p.url;
  return typeof url === "string" && url ? url : null;
}

// Marca/modelo/linha são o que mais ajuda a reencontrar o produto na busca do ML.
const KEYWORD_ATTR_IDS = ["BRAND", "MODEL", "LINE"];

// Monta a string de palavras-chave: título oficial (limpo) + marca/modelo que
// ainda não apareçam no título, separados por " · ".
export function buildMlKeywords(item: Pick<MlItem, "title" | "attributes">): string {
  const title = (item.title || "").trim();
  const parts: string[] = title ? [title] : [];
  const titleLc = title.toLowerCase();
  for (const id of KEYWORD_ATTR_IDS) {
    const a = item.attributes.find((x) => x.id === id);
    const v = a?.value?.trim();
    if (v && !titleLc.includes(v.toLowerCase())) parts.push(v);
  }
  return parts.join(" · ");
}

function normalizeItem(d: Record<string, unknown>, fallbackId: string): MlItem {
  const attributes = mapAttributes(d.attributes);
  const title = String(d.title ?? "").trim();
  const price = typeof d.price === "number" && d.price > 0 ? d.price : null;
  const picture =
    firstPicture(d.pictures) ||
    (typeof d.secure_thumbnail === "string" ? d.secure_thumbnail : null) ||
    (typeof d.thumbnail === "string" ? d.thumbnail : null);
  const item: MlItem = {
    id: String(d.id ?? fallbackId),
    title,
    price,
    picture,
    permalink: typeof d.permalink === "string" ? d.permalink : null,
    attributes,
    categoryId: typeof d.category_id === "string" ? d.category_id : null,
    keywords: "",
  };
  item.keywords = buildMlKeywords(item);
  return item;
}

function normalizeProduct(d: Record<string, unknown>, fallbackId: string): MlItem {
  const attributes = mapAttributes(d.attributes);
  const title = String(d.name ?? "").trim();
  const buyBox = (d.buy_box_winner as Record<string, unknown> | undefined) ?? undefined;
  const price = buyBox && typeof buyBox.price === "number" && buyBox.price > 0 ? buyBox.price : null;
  const item: MlItem = {
    id: String(d.id ?? fallbackId),
    title,
    price,
    picture: firstPicture(d.pictures),
    permalink: typeof d.permalink === "string" ? d.permalink : null,
    attributes,
    categoryId: typeof d.category_id === "string" ? d.category_id : null,
    keywords: "",
  };
  item.keywords = buildMlKeywords(item);
  return item;
}

// Lê o produto oficial a partir de um link do ML. Devolve null quando o link não
// é do ML, não dá pra extrair o id, ou o item foi removido (404). Lança
// MercadoLivreConfigError/MercadoLivreAuthError quando não dá pra autenticar
// (caller decide se ignora — é best-effort no nosso uso).
export async function fetchMlItem(url: string): Promise<MlItem | null> {
  let ref = parseItemRef(url);
  if (!ref) {
    let u: URL | null = null;
    try {
      u = new URL(url.trim());
    } catch {
      return null;
    }
    if (!isMlHost(u.hostname)) return null;
    const resolved = await resolveShortLink(u);
    if (resolved) ref = parseItemRef(resolved.toString());
  }
  if (!ref) return null;

  const token = await getMlAccessToken();
  const path = ref.kind === "product" ? `/products/${ref.id}` : `/items/${ref.id}`;
  const res = await fetchWithTimeout(
    `${API_BASE}${path}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    9000,
  );
  if (res.status === 401 || res.status === 403) {
    throw new MercadoLivreAuthError("Mercado Livre recusou o acesso (token inválido). Reconecte em Mensagens.");
  }
  if (res.status === 404) return null; // item inexistente / removido
  if (!res.ok) {
    throw new MercadoLivreApiError(`Erro ${res.status} ao ler o item no Mercado Livre.`, res.status);
  }
  const data = (await res.json()) as Record<string, unknown>;
  return ref.kind === "product" ? normalizeProduct(data, ref.id) : normalizeItem(data, ref.id);
}
