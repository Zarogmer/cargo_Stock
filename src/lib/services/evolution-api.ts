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
//
// `mentions` é opcional — array de telefones (brutos, vamos normalizar) que
// devem ser marcados (@) na mensagem. O texto da mensagem precisa conter
// `@<numero>` correspondente; o `mentioned` na payload faz o WhatsApp tratar
// como menção de verdade (notifica o usuário e renderiza com o nome dele).
export async function sendWhatsappTextToGroup(
  groupJid: string,
  text: string,
  mentions?: string[],
): Promise<unknown> {
  const cfg = readConfig();
  if (!groupJid.endsWith("@g.us")) throw new Error("JID de grupo inválido.");
  const token = await getInstanceToken();
  const payload: Record<string, unknown> = { number: groupJid, text };
  if (mentions && mentions.length > 0) {
    const normalized = Array.from(new Set(
      mentions
        .map((p) => normalizeBRNumber(p))
        .filter((p) => p.length >= 12),
    ));
    if (normalized.length > 0) {
      payload.mentioned = normalized;
    }
  }
  return evolutionFetch(
    `/message/sendText/${encodeURIComponent(cfg.instance)}`,
    { method: "POST", body: JSON.stringify(payload) },
    token,
  );
}

// Núcleo do envio de IMAGEM (endpoint /message/sendMedia do Evolution v2).
// `target` é o destino que vai no campo `number`: número normalizado (DM) ou
// JID do grupo (…@g.us). Aceita data URL ("data:image/jpeg;base64,AAAA…"),
// base64 puro ou URL pública — é o formato guardado em image_url (foto
// comprimida inline, sem storage externo).
async function sendMediaRaw(
  target: string,
  media0: string,
  caption: string,
  fileName: string,
): Promise<unknown> {
  const cfg = readConfig();
  const token = await getInstanceToken();

  // Separa o mimetype e o base64 cru. O Evolution espera o base64 SEM o prefixo
  // "data:…;base64," (ele faz Buffer.from(media, "base64") internamente). Se for
  // uma URL pública (http…), passa direto — o Evolution baixa.
  let mimetype = "image/jpeg";
  let media = (media0 || "").trim();
  if (!media) throw new Error("Imagem vazia.");
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(media);
  if (m) {
    mimetype = m[1];
    media = m[2];
  }

  return evolutionFetch(
    `/message/sendMedia/${encodeURIComponent(cfg.instance)}`,
    {
      method: "POST",
      body: JSON.stringify({
        number: target,
        mediatype: "image",
        mimetype,
        caption,
        media,
        fileName,
      }),
    },
    token,
  );
}

// Envia uma IMAGEM (com legenda) a um grupo identificado pelo JID.
export async function sendWhatsappMediaToGroup(
  groupJid: string,
  dataUrlOrBase64: string,
  caption: string,
  fileName = "produto.jpg",
): Promise<unknown> {
  if (!groupJid.endsWith("@g.us")) throw new Error("JID de grupo inválido.");
  return sendMediaRaw(groupJid, dataUrlOrBase64, caption, fileName);
}

// Envia uma IMAGEM (com legenda) numa conversa individual (DM). O número é
// normalizado pro formato BR (55 + DDD + número), igual ao sendWhatsappText.
export async function sendWhatsappMediaToNumber(
  to: string,
  dataUrlOrBase64: string,
  caption: string,
  fileName = "produto.jpg",
): Promise<unknown> {
  const number = normalizeBRNumber(to);
  if (!number) throw new Error("Número inválido.");
  return sendMediaRaw(number, dataUrlOrBase64, caption, fileName);
}

// Extrai o id REAL da mensagem (key.id) da resposta de um envio do Evolution.
// sendText/sendMedia retornam `{ key: { id, remoteJid, fromMe }, ... }`. Esse id
// é o que o WhatsApp usa pra revogar ("apagar para todos") depois — por isso os
// senders guardam ele no message_id (em vez de um id sintético). Devolve null se
// a resposta não trouxer, e o caller cai no id sintético de fallback.
export function extractSentMessageId(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const key = (result as Record<string, unknown>).key;
  if (key && typeof key === "object") {
    const id = (key as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

// Apaga uma mensagem PARA TODOS (revoke) — some do WhatsApp de todo mundo na
// conversa/grupo, igual ao "Apagar para todos" do app oficial. Endpoint
// DELETE /chat/deleteMessageForEveryone do Evolution v2.
//
// Limitações do PRÓPRIO WhatsApp (não dá pra contornar):
//   - Só funciona em mensagens que VOCÊ enviou (fromMe), OU em mensagens de
//     outra pessoa num grupo quando o número conectado é ADMIN.
//   - Mensagem de outra pessoa numa conversa individual (DM) nunca dá.
//   - Precisa do id REAL da mensagem (key.id) — ids sintéticos não funcionam.
// `participant` é o JID de quem enviou (necessário pra revogar msg de terceiro
// num grupo). Lança se o Evolution/WhatsApp recusar — o caller decide a mensagem.
export async function deleteWhatsappMessageForEveryone(opts: {
  remoteJid: string;
  messageId: string;
  fromMe: boolean;
  participant?: string | null;
}): Promise<unknown> {
  const cfg = readConfig();
  const token = await getInstanceToken();
  const body: Record<string, unknown> = {
    id: opts.messageId,
    remoteJid: opts.remoteJid,
    fromMe: opts.fromMe,
  };
  if (opts.participant) body.participant = opts.participant;
  return evolutionFetch(
    `/chat/deleteMessageForEveryone/${encodeURIComponent(cfg.instance)}`,
    { method: "DELETE", body: JSON.stringify(body) },
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

// Updates a group's description (the long text shown under "Adicionar descrição"
// on WhatsApp). Used right after createWhatsappGroup so the operation info
// stays pinned at the top of the group info panel.
export async function setWhatsappGroupDescription(groupJid: string, description: string): Promise<unknown> {
  const cfg = readConfig();
  if (!groupJid.endsWith("@g.us")) throw new Error("JID de grupo inválido.");
  const token = await getInstanceToken();
  return evolutionFetch(
    `/group/updateGroupDescription/${encodeURIComponent(cfg.instance)}?groupJid=${encodeURIComponent(groupJid)}`,
    { method: "POST", body: JSON.stringify({ description }) },
    token,
  );
}

// Renomeia um grupo — muda o "subject" (o nome que aparece no WhatsApp). Requer
// que o número conectado seja admin/dono do grupo; senão o WhatsApp recusa.
export async function updateWhatsappGroupSubject(groupJid: string, subject: string): Promise<unknown> {
  const cfg = readConfig();
  if (!groupJid.endsWith("@g.us")) throw new Error("JID de grupo inválido.");
  const trimmed = subject.trim();
  if (!trimmed) throw new Error("Nome do grupo é obrigatório.");
  const token = await getInstanceToken();
  return evolutionFetch(
    `/group/updateGroupSubject/${encodeURIComponent(cfg.instance)}?groupJid=${encodeURIComponent(groupJid)}`,
    { method: "POST", body: JSON.stringify({ subject: trimmed }) },
    token,
  );
}

// Promote (or demote) participants in a group. `action` is "promote" to give
// admin rights, "demote" to remove them. Participants are normalized BR phone
// numbers — Evolution accepts the same format used when creating the group.
// Throws if Evolution rejects the call (caller decides whether to swallow).
export async function updateGroupParticipants(
  groupJid: string,
  action: "promote" | "demote" | "add" | "remove",
  participants: string[],
): Promise<unknown> {
  const cfg = readConfig();
  if (!groupJid.endsWith("@g.us")) throw new Error("JID de grupo inválido.");
  const normalized = Array.from(new Set(
    participants
      .map((p) => normalizeBRNumber(p))
      .filter((p) => p.length >= 12),
  ));
  if (normalized.length === 0) return { skipped: "nenhum participante válido" };
  const token = await getInstanceToken();
  return evolutionFetch(
    `/group/updateParticipant/${encodeURIComponent(cfg.instance)}?groupJid=${encodeURIComponent(groupJid)}`,
    { method: "POST", body: JSON.stringify({ action, participants: normalized }) },
    token,
  );
}

// Faz o número conectado (o "bot" do sistema) SAIR de um grupo. Diferente de
// `updateGroupParticipants("remove", ...)`, que tira OUTRO participante: aqui é
// a própria conta que deixa o grupo. Evolution expõe isso como
// DELETE /group/leaveGroup. Depois de sair, o app não consegue mais postar nem
// ler o grupo (ele some das próximas sincronizações) — pra voltar, alguém
// precisa readicionar o número manualmente no WhatsApp.
export async function leaveWhatsappGroup(groupJid: string): Promise<unknown> {
  const cfg = readConfig();
  if (!groupJid.endsWith("@g.us")) throw new Error("JID de grupo inválido.");
  const token = await getInstanceToken();
  return evolutionFetch(
    `/group/leaveGroup/${encodeURIComponent(cfg.instance)}?groupJid=${encodeURIComponent(groupJid)}`,
    { method: "DELETE" },
    token,
  );
}

export async function getInstanceStatus(): Promise<{ state?: string } & Record<string, unknown>> {
  const cfg = readConfig();
  return evolutionFetch(`/instance/connectionState/${encodeURIComponent(cfg.instance)}`);
}

interface EvolutionGroupInfo {
  id?: string;
  subject?: string;
  subjectOwner?: string;
  subjectTime?: number;
  size?: number;
  desc?: string;
  creation?: number;             // seconds-since-epoch
  owner?: string;
  // O Evolution recente devolve mais campos pra cada participante. Em grupos
  // com LIDs, o `id` vem como `xxxxx@lid` (opaco) mas alguns dos demais campos
  // podem trazer o telefone real (depende da versão). Capturamos todos pra
  // facilitar a resolução.
  participants?: Array<{
    id?: string;
    admin?: string | null;
    jid?: string;
    phoneNumber?: string;
    lid?: string;
    pn?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

// Detailed info for a single group — used by the conversation info panel.
// Evolution returns participants with their JIDs and admin flags so we can
// cross-reference with our Employees table for friendly names.
export async function findGroupInfo(groupJid: string): Promise<EvolutionGroupInfo> {
  const cfg = readConfig();
  const token = await getInstanceToken();
  return evolutionFetch<EvolutionGroupInfo>(
    `/group/findGroupInfos/${encodeURIComponent(cfg.instance)}?groupJid=${encodeURIComponent(groupJid)}`,
    {},
    token,
  );
}

// Lists every WhatsApp group the connected number is a member of. Used by the
// sync endpoint to backfill the conversation list with groups created outside
// the app or before this feature existed.
//
// Evolution requires `getParticipants` to ALWAYS be present in the query
// string (it errors with "The getParticipants needs to be informed in the
// query" otherwise) — we default to false to keep the response light.
export async function fetchAllGroups(includeParticipants = false): Promise<EvolutionGroupInfo[]> {
  const cfg = readConfig();
  const token = await getInstanceToken();
  const qs = `?getParticipants=${includeParticipants ? "true" : "false"}`;
  const result = await evolutionFetch<EvolutionGroupInfo[] | { groups?: EvolutionGroupInfo[] }>(
    `/group/fetchAllGroups/${encodeURIComponent(cfg.instance)}${qs}`,
    {},
    token,
  );
  if (Array.isArray(result)) return result;
  if (result && typeof result === "object" && Array.isArray(result.groups)) return result.groups;
  return [];
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
          // MESSAGES_UPSERT é o feed principal de conversas.
          // GROUP_PARTICIPANTS_UPDATE traz add/remove/promote/demote dos grupos —
          // virou systemNotice na aba Conversas (estilo WhatsApp).
          events: ["MESSAGES_UPSERT", "GROUP_PARTICIPANTS_UPDATE"],
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

async function tryCreate(cfg: EvolutionConfig): Promise<unknown> {
  return evolutionFetch(`/instance/create`, {
    method: "POST",
    body: JSON.stringify({
      instanceName: cfg.instance,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
    }),
  });
}

// Best-effort recovery from a stuck instance. Stuck = Evolution reports
// state:"open" but Baileys is dead, so sends fail with "Connection Closed".
//
// We try escalating layers of force, in order:
//   1. logout    — close the Baileys session cleanly
//   2. delete    — wipe the instance record (incl. saved credentials)
//   3. create    — recreate with qrcode:true
//   4. restart   — kick Baileys if create returned zombie {state:"open", no QR}
//   5. connect   — fetch fresh QR after the restart
//   6. delete+create again — if connect ALSO returns zombie (Evolution's
//      session lock didn't release), nuke it once more
//   7. give up with a clear error pointing to a Railway service restart
//
// We track failures along the way so the final error message can explain
// WHICH step couldn't recover — usually it's delete being rejected because
// Baileys still holds the row, and the only real fix is restarting Evolution.
export async function resetInstance(): Promise<unknown> {
  const cfg = readConfig();
  const stepErrors: string[] = [];

  // Step 1: logout. Almost always fails with "Connection Closed" when the
  // session is already dead — that's the whole reason we're resetting.
  try {
    await logoutInstance();
  } catch (err) {
    console.warn("[evolution] reset: logout failed (continuing):", (err as Error).message);
  }
  clearInstanceTokenCache();

  // Step 2: delete. If it fails we still try create — but track the error so
  // we can surface it if recovery ultimately fails.
  let deleteErrMsg: string | null = null;
  try {
    await deleteInstance();
  } catch (err) {
    deleteErrMsg = (err as Error).message;
    stepErrors.push(`delete: ${deleteErrMsg}`);
    console.warn("[evolution] reset: delete failed (continuing):", deleteErrMsg);
  }
  clearInstanceTokenCache();

  // Step 3: create. Evolution returns the QR base64 inline when qrcode:true.
  // If the instance still exists (delete failed) and is in the zombie state,
  // create returns 200 OK with {instance:{state:"open"}} and NO QR.
  let result: unknown;
  let createResponse: unknown = null;
  try {
    createResponse = await tryCreate(cfg);
    result = createResponse;
  } catch (err) {
    const msg = (err as Error).message || "";
    if (!(msg.toLowerCase().includes("already") || msg.includes("409"))) {
      throw new Error(`[create falhou] ${msg}`);
    }
    stepErrors.push(`create: ${msg}`);
  }

  // Steps 4-6: zombie recovery. Only enter this branch if create didn't give
  // us a QR — meaning the instance is alive in Evolution but unusable.
  if (!hasQrCode(createResponse)) {
    try {
      // Step 4: kick Baileys.
      await evolutionFetch(`/instance/restart/${encodeURIComponent(cfg.instance)}`, {
        method: "POST",
      });
      // Give Baileys time to drop the dead websocket and release its session lock.
      await new Promise((r) => setTimeout(r, 2000));

      // Step 5: ask for a fresh QR.
      const connectResponse = await evolutionFetch(
        `/instance/connect/${encodeURIComponent(cfg.instance)}`,
      );
      result = connectResponse;

      // Step 6: connect ALSO returned zombie → delete + create one more time.
      // By now Baileys should be in a state where delete actually works.
      if (!hasQrCode(connectResponse)) {
        clearInstanceTokenCache();
        try {
          await deleteInstance();
        } catch (delErr) {
          stepErrors.push(`delete pós-restart: ${(delErr as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 1000));
        try {
          result = await tryCreate(cfg);
        } catch (createErr) {
          stepErrors.push(`create pós-restart: ${(createErr as Error).message}`);
        }
      }
    } catch (restartErr) {
      stepErrors.push(`restart/connect: ${(restartErr as Error).message}`);
    }

    // Still no QR after all that? Evolution is genuinely stuck — only a
    // service-level restart on Railway will fix it.
    if (!hasQrCode(result)) {
      const detail = stepErrors.length > 0 ? ` Detalhes: ${stepErrors.join(" | ")}.` : "";
      throw new Error(
        `Evolution está travado — devolve "open" sem QR mesmo após logout, delete, create, restart e connect. ` +
        `Reinicie o serviço Evolution na Railway (painel Railway → serviço Evolution → Restart) e tente de novo.${detail}`,
      );
    }
  }
  clearInstanceTokenCache();

  try { await registerWebhook(); } catch (err) {
    console.warn("[evolution] webhook register after reset failed (non-fatal):", (err as Error).message);
  }
  return result;
}
