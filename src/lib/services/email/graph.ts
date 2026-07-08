// Cliente Microsoft Graph — captura de boletos por e-mail (app-only / client
// credentials). O segredo do app fica em env (GRAPH_CLIENT_ID/SECRET); o tenant
// e a caixa vêm por EmailIntegrationAccount (múltiplas caixas). Enquanto as
// credenciais não são configuradas, isGraphConfigured() é false e o módulo fica
// inerte (nada quebra) — dev/prod rodam sem Graph até a homologação sair.
//
// Token de app cacheado (criptografado) na própria conta pra não pedir a cada tick.

import type { EmailIntegrationAccount } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "@/lib/crypto";

const GRAPH = "https://graph.microsoft.com/v1.0";

export function isGraphConfigured(): boolean {
  return !!(process.env.GRAPH_CLIENT_ID && process.env.GRAPH_CLIENT_SECRET);
}

function defaultTenant(): string | undefined {
  return process.env.GRAPH_TENANT_ID || undefined;
}

// Obtém (e cacheia) o token de aplicativo pro tenant da conta.
async function getAppToken(account: EmailIntegrationAccount): Promise<string> {
  // Cache válido?
  if (account.access_token_enc && account.token_expires_at && account.token_expires_at.getTime() > Date.now() + 60_000) {
    try {
      return decryptSecret(account.access_token_enc);
    } catch {
      /* cache corrompido — refaz abaixo */
    }
  }

  const tenant = account.tenant_id || defaultTenant();
  if (!tenant) throw new Error("tenant_id não definido para a caixa");
  const clientId = process.env.GRAPH_CLIENT_ID;
  const clientSecret = process.env.GRAPH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GRAPH_CLIENT_ID/SECRET não configurados");

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Falha no token Graph (${res.status}): ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + (json.expires_in - 120) * 1000);
  await prisma.emailIntegrationAccount.update({
    where: { id: account.id },
    data: { access_token_enc: encryptSecret(json.access_token), token_expires_at: expiresAt },
  });
  return json.access_token;
}

async function graphGet<T>(account: EmailIntegrationAccount, urlOrPath: string): Promise<T> {
  const token = await getAppToken(account);
  const url = urlOrPath.startsWith("http") ? urlOrPath : `${GRAPH}${urlOrPath}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Graph GET ${res.status}: ${t.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface DeltaMessage {
  id: string;
  subject?: string;
  hasAttachments?: boolean;
  isDraft?: boolean;
}
interface DeltaPage {
  value: DeltaMessage[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

// Percorre o delta da Inbox e devolve as mensagens NOVAS com anexo, além do
// próximo deltaLink (pra guardar e só trazer o que mudar na próxima).
export async function fetchDeltaMessages(
  account: EmailIntegrationAccount
): Promise<{ messages: DeltaMessage[]; deltaLink: string | null }> {
  const mailbox = encodeURIComponent(account.mailbox);
  let url =
    account.delta_token ||
    `${GRAPH}/users/${mailbox}/mailFolders/Inbox/messages/delta?$select=id,subject,hasAttachments,isDraft`;

  const messages: DeltaMessage[] = [];
  let deltaLink: string | null = null;
  // Limite de páginas por sync pra não travar o tick; o resto vem no próximo.
  for (let page = 0; page < 50; page++) {
    const data = await graphGet<DeltaPage>(account, url);
    for (const m of data.value || []) {
      if (m.hasAttachments && !m.isDraft) messages.push(m);
    }
    if (data["@odata.nextLink"]) {
      url = data["@odata.nextLink"];
      continue;
    }
    deltaLink = data["@odata.deltaLink"] || null;
    break;
  }
  return { messages, deltaLink };
}

export interface GraphAttachment {
  name: string;
  contentBytes: Buffer;
}

// Baixa os anexos PDF de uma mensagem.
export async function fetchPdfAttachments(
  account: EmailIntegrationAccount,
  messageId: string
): Promise<GraphAttachment[]> {
  const mailbox = encodeURIComponent(account.mailbox);
  const list = await graphGet<{
    value: Array<{ id: string; name: string; contentType?: string; contentBytes?: string }>;
  }>(account, `/users/${mailbox}/messages/${messageId}/attachments`);

  const out: GraphAttachment[] = [];
  for (const att of list.value || []) {
    const isPdf =
      att.contentType === "application/pdf" || /\.pdf$/i.test(att.name || "");
    if (!isPdf || !att.contentBytes) continue;
    out.push({ name: att.name || "boleto.pdf", contentBytes: Buffer.from(att.contentBytes, "base64") });
  }
  return out;
}
