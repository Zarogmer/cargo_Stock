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

async function evolutionFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cfg = readConfig();
  const res = await fetch(`${cfg.url}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: cfg.key,
      ...(init.headers || {}),
    },
  });
  const body = (await res.json().catch(() => null)) as T | { message?: string; response?: unknown };
  if (!res.ok) {
    const err = body as { message?: string };
    throw new Error(`Evolution API ${res.status}: ${err?.message || res.statusText}`);
  }
  return body as T;
}

export async function sendWhatsappText(to: string, text: string): Promise<unknown> {
  const cfg = readConfig();
  const number = normalizeBRNumber(to);
  if (!number) throw new Error("Número inválido.");
  return evolutionFetch(`/message/sendText/${encodeURIComponent(cfg.instance)}`, {
    method: "POST",
    body: JSON.stringify({ number, text }),
  });
}

export async function getInstanceStatus(): Promise<{ state?: string } & Record<string, unknown>> {
  const cfg = readConfig();
  return evolutionFetch(`/instance/connectionState/${encodeURIComponent(cfg.instance)}`);
}
