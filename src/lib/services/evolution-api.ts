/**
 * Thin wrapper around Evolution API (https://github.com/EvolutionAPI/evolution-api).
 *
 * Configured via environment variables on the Next.js service:
 *   EVOLUTION_API_URL       e.g. http://evolution-api.railway.internal:8080
 *   EVOLUTION_API_KEY       matches AUTHENTICATION_API_KEY on the Evolution service
 *   EVOLUTION_INSTANCE      instance name (created beforehand via Evolution's own API/UI)
 *
 * Usage:
 *   import { sendWhatsappText, getInstanceStatus } from "@/lib/services/evolution-api";
 *   await sendWhatsappText("5513999999999", "Olá!");
 *
 * If any of the env vars are missing the helpers throw a clear error so the
 * caller can decide whether to surface it to the user or silently skip.
 */

interface EvolutionConfig {
  url: string;
  key: string;
  instance: string;
}

function readConfig(): EvolutionConfig {
  const url = process.env.EVOLUTION_API_URL?.replace(/\/$/, "");
  const key = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE;
  if (!url || !key || !instance) {
    throw new Error("Evolution API não configurada — defina EVOLUTION_API_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE.");
  }
  return { url, key, instance };
}

export function isEvolutionConfigured(): boolean {
  return !!(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY && process.env.EVOLUTION_INSTANCE);
}

// Brazilian numbers: strip everything except digits, prepend 55 when missing.
export function normalizeBRNumber(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("55")) return digits;
  return `55${digits}`;
}

// Recursively walks the parsed body looking for human-readable strings. Skips
// values that stringify to "[object Object]" (an Evolution v2 bug where they
// String()-ed a class instance) and only returns concrete error text.
function collectMessages(value: unknown, out: string[], depth = 0): void {
  if (out.length >= 3 || depth > 4) return;
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    const s = value.trim();
    if (s && s !== "[object Object]") out.push(s.slice(0, 300));
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const v of value) collectMessages(v, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Common error-bearing keys first.
    for (const key of ["message", "error", "details", "reason", "response"]) {
      if (key in obj) collectMessages(obj[key], out, depth + 1);
    }
  }
}

function formatEvolutionError(body: unknown, raw: string): string {
  if (typeof body === "string") return body.slice(0, 500);
  const collected: string[] = [];
  collectMessages(body, collected);
  if (collected.length > 0) return collected.join(" | ");
  // Fall back to the raw HTTP body so we at least show *something* useful.
  const trimmed = raw.trim();
  if (trimmed) return trimmed.slice(0, 500);
  return "";
}

async function evolutionFetch<T>(path: string, init: RequestInit = {}, apikey?: string): Promise<T> {
  const cfg = readConfig();
  const res = await fetch(`${cfg.url}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: apikey ?? cfg.key,
      ...(init.headers || {}),
    },
  });
  // Read the response as text first so we can surface it on errors even when
  // it's not JSON (HTML 500 page, plain string, NestJS exception filter, etc).
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  if (!res.ok) {
    // Evolution wraps errors in different shapes depending on the layer:
    //   NestJS validation: { statusCode, message: string[], error }
    //   Service errors:    { status, error, response: { message } }
    //   Baileys crashes:   plain text / HTML
    //   Evolution v2 bugs: { message: ["[object Object]"] } — useless, fall
    //                     back to the raw text body so we at least show what
    //                     Evolution actually returned.
    const detail = formatEvolutionError(body, raw);
    throw new Error(`Evolution API ${res.status} ${path}: ${detail || res.statusText}`);
  }
  return body as T;
}

// Evolution v2 (latest) requires the per-instance token for instance-scoped
// endpoints (/connect, /logout, /message/*). The token is returned by
// fetchInstances. Cached per process to avoid an extra hop on every call.
let cachedInstanceToken: string | null = null;
async function getInstanceToken(): Promise<string> {
  if (cachedInstanceToken) return cachedInstanceToken;
  const cfg = readConfig();
  const list = (await evolutionFetch<Array<{ name?: string; token?: string }>>(`/instance/fetchInstances`)) || [];
  const found = list.find((i) => i.name === cfg.instance);
  if (!found?.token) {
    throw new Error(`Instância "${cfg.instance}" não encontrada — crie-a primeiro.`);
  }
  cachedInstanceToken = found.token;
  return found.token;
}

// Useful when the instance is recreated and the cached token goes stale.
export function clearInstanceTokenCache() {
  cachedInstanceToken = null;
}

export async function sendWhatsappText(to: string, text: string): Promise<unknown> {
  const cfg = readConfig();
  const number = normalizeBRNumber(to);
  if (!number) throw new Error("Número inválido.");
  const token = await getInstanceToken();
  return evolutionFetch(
    `/message/sendText/${encodeURIComponent(cfg.instance)}`,
    { method: "POST", body: JSON.stringify({ number, text }) },
    token,
  );
}

// Sends a text message to a group identified by its full JID (e.g. "12036...@g.us").
// Same endpoint as sendWhatsappText but the "number" field carries the group JID.
export async function sendWhatsappTextToGroup(groupJid: string, text: string): Promise<unknown> {
  const cfg = readConfig();
  if (!groupJid.endsWith("@g.us")) throw new Error("JID de grupo inválido.");
  const token = await getInstanceToken();
  return evolutionFetch(
    `/message/sendText/${encodeURIComponent(cfg.instance)}`,
    { method: "POST", body: JSON.stringify({ number: groupJid, text }) },
    token,
  );
}

interface CreateGroupResult {
  // Evolution returns { id: "12036...@g.us", subject, ... }
  id?: string;
  groupJid?: string;
  subject?: string;
  [key: string]: unknown;
}

// Creates a WhatsApp group with the given subject and participant numbers.
// `participants` should be raw numbers (e.g. ["5513999999999"]); they're normalized
// to BR format and deduplicated.
export async function createWhatsappGroup(
  subject: string,
  participants: string[],
): Promise<CreateGroupResult> {
  const cfg = readConfig();
  const trimmed = subject.trim();
  if (!trimmed) throw new Error("Nome do grupo é obrigatório.");
  const normalized = Array.from(new Set(
    participants
      .map((p) => normalizeBRNumber(p))
      .filter((p) => p.length >= 12), // 55 + DDD(2) + number(8-9)
  ));
  if (normalized.length === 0) {
    throw new Error("Selecione ao menos um participante com número válido.");
  }
  const token = await getInstanceToken();
  return evolutionFetch<CreateGroupResult>(
    `/group/create/${encodeURIComponent(cfg.instance)}`,
    {
      method: "POST",
      body: JSON.stringify({ subject: trimmed, participants: normalized }),
    },
    token,
  );
}

export async function getInstanceStatus(): Promise<{ state?: string } & Record<string, unknown>> {
  const cfg = readConfig();
  return evolutionFetch(`/instance/connectionState/${encodeURIComponent(cfg.instance)}`);
}

// Creates the instance if missing. Idempotent-ish: Evolution returns an error
// when the instance already exists, which we swallow. After a successful create
// we also register the webhook so incoming messages start flowing to our DB.
export async function createInstanceIfMissing(): Promise<unknown> {
  const cfg = readConfig();
  try {
    const created = await evolutionFetch(`/instance/create`, {
      method: "POST",
      body: JSON.stringify({
        instanceName: cfg.instance,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
      }),
    });
    clearInstanceTokenCache();
    // Best-effort: webhook registration shouldn't block instance creation.
    try { await registerWebhook(); } catch (err) {
      console.warn("[evolution] webhook register failed (non-fatal):", (err as Error).message);
    }
    return created;
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg.toLowerCase().includes("already") || msg.includes("409")) {
      // Instance exists — still try to (re)register the webhook in case it was lost.
      try { await registerWebhook(); } catch { /* ignore */ }
      return { existed: true };
    }
    throw err;
  }
}

// Returns the QR code to scan with WhatsApp (as a data URL base64 PNG).
// When the instance is already connected this returns the current state instead.
export async function connectInstance(): Promise<{ base64?: string; code?: string; pairingCode?: string } & Record<string, unknown>> {
  const cfg = readConfig();
  const token = await getInstanceToken();
  return evolutionFetch(`/instance/connect/${encodeURIComponent(cfg.instance)}`, {}, token);
}

export async function logoutInstance(): Promise<unknown> {
  const cfg = readConfig();
  const token = await getInstanceToken();
  const result = await evolutionFetch(
    `/instance/logout/${encodeURIComponent(cfg.instance)}`,
    { method: "DELETE" },
    token,
  );
  clearInstanceTokenCache();
  return result;
}

// Hard-delete the instance entirely (different from logout — wipes the Evolution
// record so the next create starts fresh). 404 means it's already gone, which
// is fine for a reset flow.
export async function deleteInstance(): Promise<unknown> {
  const cfg = readConfig();
  try {
    const result = await evolutionFetch(
      `/instance/delete/${encodeURIComponent(cfg.instance)}`,
      { method: "DELETE" },
    );
    clearInstanceTokenCache();
    return result;
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg.includes("404") || msg.toLowerCase().includes("not found") || msg.toLowerCase().includes("does not exist")) {
      clearInstanceTokenCache();
      return { existed: false };
    }
    throw err;
  }
}

// Read whatever webhook is currently configured for the instance — handy when
// the UI wants to show admins "where is Evolution sending events?".
export async function getWebhookConfig(): Promise<unknown> {
  const cfg = readConfig();
  const token = await getInstanceToken();
  return evolutionFetch(`/webhook/find/${encodeURIComponent(cfg.instance)}`, {}, token);
}

// Tell Evolution to POST messages.upsert events to our /api/whatsapp/webhook.
// Idempotent — calling again just overwrites the previous config.
//
// Evolution v2 latest expects the payload wrapped in a `webhook` key with
// camelCase field names (webhookByEvents, webhookBase64). Older versions
// accepted flat snake_case — sending the v2 shape; if you hit a 4xx in older
// Evolution images, this is the place to flip.
export async function registerWebhook(): Promise<unknown> {
  const cfg = readConfig();
  const baseUrl = (process.env.AUTH_URL || process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error("AUTH_URL não definido — não dá pra registrar o webhook.");
  }
  const secret = process.env.EVOLUTION_WEBHOOK_SECRET || "";
  const url = `${baseUrl}/api/whatsapp/webhook${secret ? `?secret=${encodeURIComponent(secret)}` : ""}`;
  const token = await getInstanceToken();
  return evolutionFetch(
    `/webhook/set/${encodeURIComponent(cfg.instance)}`,
    {
      method: "POST",
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url,
          events: ["MESSAGES_UPSERT"],
          webhookByEvents: false,
          webhookBase64: false,
        },
      }),
    },
    token,
  );
}

// True when the response body has a QR base64 / pairing code somewhere in
// it — used to decide whether /instance/create actually gave us something
// usable or returned a "state-only" zombie response.
function hasQrCode(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.base64 === "string" && obj.base64.length > 0) return true;
  if (typeof obj.code === "string" && obj.code.length > 0) return true;
  if (typeof obj.pairingCode === "string" && obj.pairingCode.length > 0) return true;
  if (obj.qrcode && typeof obj.qrcode === "object") return hasQrCode(obj.qrcode);
  return false;
}

// Best-effort recovery from a stuck instance. Tries, in order:
//   1. logout — closes the Baileys session cleanly (often returns 500 with
//      "Connection Closed" when the session is already dead, which is fine)
//   2. delete — wipes the instance record
//   3. create — recreates it with qrcode:true
// Steps 1 and 2 are swallowed (the goal is "make create succeed", not "ensure
// every step worked"). Only failure of step 3 surfaces — that's the one the
// admin actually needs to know about.
export async function resetInstance(): Promise<unknown> {
  const cfg = readConfig();

  // Step 1: logout. Almost always fails with "Connection Closed" when called
  // on a stuck instance — that's the whole reason we're resetting. Swallow.
  try {
    await logoutInstance();
  } catch (err) {
    console.warn("[evolution] reset: logout step failed (continuing):", (err as Error).message);
  }
  clearInstanceTokenCache();

  // Step 2: delete. May 400 if Evolution doesn't accept delete in the current
  // state (e.g. session in "connecting"). Swallow and let create try anyway.
  try {
    await deleteInstance();
  } catch (err) {
    console.warn("[evolution] reset: delete step failed (continuing):", (err as Error).message);
  }
  clearInstanceTokenCache();

  // Step 3: create. This is the one we care about. Evolution returns the QR
  // base64 right here when qrcode:true.
  //
  // Edge case (the whole reason we're rewriting this): when delete fails
  // silently and the instance is still in Evolution's books, create returns
  // 200 OK with {"instance":{"state":"open"}} and NO QR. That's a zombie —
  // Evolution thinks it's connected, Baileys disagrees. We have to force a
  // restart to wake it up.
  let result: unknown;
  let createResponse: unknown = null;
  try {
    createResponse = await evolutionFetch(`/instance/create`, {
      method: "POST",
      body: JSON.stringify({
        instanceName: cfg.instance,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
      }),
    });
    result = createResponse;
  } catch (err) {
    const msg = (err as Error).message || "";
    // Some Evolution builds return 409/"already exists" instead of the 200
    // zombie response above. Same recovery path — kick Baileys.
    if (!(msg.toLowerCase().includes("already") || msg.includes("409"))) {
      throw new Error(`[create falhou] ${msg}`);
    }
  }

  // Detect the "zombie create" response and force a restart. The shape is
  // { instance: { instanceName, state } } with no qrcode/qrcode.base64 anywhere.
  if (!hasQrCode(createResponse)) {
    try {
      await evolutionFetch(`/instance/restart/${encodeURIComponent(cfg.instance)}`, {
        method: "POST",
      });
      // Brief pause so Baileys has time to drop the dead session.
      await new Promise((r) => setTimeout(r, 1500));
      // /instance/connect returns the new QR once Baileys re-opens the socket.
      result = await evolutionFetch(`/instance/connect/${encodeURIComponent(cfg.instance)}`);
    } catch (restartErr) {
      throw new Error(
        `Instância existe mas está travada (Evolution diz "open" sem QR). ` +
        `Restart falhou: ${(restartErr as Error).message}. ` +
        `Tente reiniciar o serviço Evolution na Railway.`,
      );
    }
  }
  clearInstanceTokenCache();

  try { await registerWebhook(); } catch (err) {
    console.warn("[evolution] webhook register after reset failed (non-fatal):", (err as Error).message);
  }
  return result;
}
