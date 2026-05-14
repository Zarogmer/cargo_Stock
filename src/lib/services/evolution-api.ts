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
    const b = body as { message?: unknown; error?: unknown; response?: { message?: unknown } } | string | null;
    const detail = typeof b === "string"
      ? b.slice(0, 500)
      : (() => {
          const msgs = [
            b?.response && typeof b.response === "object" && "message" in b.response ? JSON.stringify(b.response.message) : null,
            b?.message ? JSON.stringify(b.message) : null,
            b?.error ? JSON.stringify(b.error) : null,
          ].filter(Boolean);
          return msgs.length ? msgs.join(" | ") : JSON.stringify(b).slice(0, 500);
        })();
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

// Tell Evolution to POST messages.upsert events to our /api/whatsapp/webhook.
// Idempotent — calling again just overwrites the previous config.
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
        url,
        enabled: true,
        events: ["MESSAGES_UPSERT"],
        webhook_by_events: false,
        webhook_base64: false,
      }),
    },
    token,
  );
}

// Delete + create. The QR is reliably returned by /instance/create when qrcode:
// true — the connect endpoint sometimes doesn't regenerate it for an instance
// stuck in "close", so this is the reset hatch.
export async function resetInstance(): Promise<unknown> {
  try {
    await deleteInstance();
  } catch (err) {
    throw new Error(`[delete falhou] ${(err as Error).message}`);
  }
  const cfg = readConfig();
  let result: unknown;
  try {
    result = await evolutionFetch(`/instance/create`, {
      method: "POST",
      body: JSON.stringify({
        instanceName: cfg.instance,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
      }),
    });
  } catch (err) {
    throw new Error(`[create falhou] ${(err as Error).message}`);
  }
  clearInstanceTokenCache();
  try { await registerWebhook(); } catch (err) {
    console.warn("[evolution] webhook register after reset failed (non-fatal):", (err as Error).message);
  }
  return result;
}
