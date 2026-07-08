// Orquestra a captura de boletos por e-mail:
//   syncMailbox: delta do Graph → enfileira 1 job por mensagem com anexo.
//   processEmailJobs: consome a fila → baixa PDFs → ingestBoletoPdf (RECEBIDO).
// Separado de propósito: o delta é rápido; o download/parse (pesado) roda na
// fila, com retry e idempotência.

import { prisma } from "@/lib/prisma";
import { enqueueFinanceJob, processFinanceJobs, type ProcessResult } from "@/lib/services/finance-queue";
import { ingestBoletoPdf } from "@/lib/services/boleto/ingest";
import { isGraphConfigured, fetchDeltaMessages, fetchPdfAttachments } from "./graph";

export interface SyncSummary {
  configured: boolean;
  mailboxes: number;
  enqueued: number;
  errors: string[];
}

// Sincroniza todas as caixas habilitadas: descobre mensagens novas e enfileira.
export async function syncAllMailboxes(): Promise<SyncSummary> {
  if (!isGraphConfigured()) {
    return { configured: false, mailboxes: 0, enqueued: 0, errors: [] };
  }
  const accounts = await prisma.emailIntegrationAccount.findMany({ where: { enabled: true } });
  let enqueued = 0;
  const errors: string[] = [];

  for (const account of accounts) {
    try {
      const { messages, deltaLink } = await fetchDeltaMessages(account);
      for (const m of messages) {
        const ok = await enqueueFinanceJob(
          "EMAIL_MESSAGE",
          { accountId: account.id, mailbox: account.mailbox, messageId: m.id, subject: m.subject ?? null },
          `${account.mailbox}:${m.id}`
        );
        if (ok) enqueued++;
      }
      await prisma.emailIntegrationAccount.update({
        where: { id: account.id },
        data: {
          delta_token: deltaLink ?? account.delta_token,
          last_sync_at: new Date(),
          last_status: `ok: ${messages.length} msg com anexo`,
        },
      });
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(`${account.mailbox}: ${msg}`);
      await prisma.emailIntegrationAccount.update({
        where: { id: account.id },
        data: { last_sync_at: new Date(), last_status: `error: ${msg.slice(0, 200)}` },
      });
      await prisma.integrationLog.create({
        data: { provider: "GRAPH", operation: "delta_sync", ok: false, message: msg },
      });
    }
  }
  return { configured: true, mailboxes: accounts.length, enqueued, errors };
}

interface EmailMessagePayload {
  accountId: number;
  mailbox: string;
  messageId: string;
  subject: string | null;
}

// Handler do job EMAIL_MESSAGE: baixa os PDFs da mensagem e cria os títulos.
async function handleEmailMessage(payloadRaw: unknown): Promise<void> {
  const p = payloadRaw as EmailMessagePayload;
  const account = await prisma.emailIntegrationAccount.findUnique({ where: { id: p.accountId } });
  if (!account) throw new Error(`Conta de e-mail ${p.accountId} sumiu`);

  const attachments = await fetchPdfAttachments(account, p.messageId);
  let created = 0;
  for (const att of attachments) {
    const result = await ingestBoletoPdf(att.contentBytes, {
      origin: "EMAIL",
      createdBy: `E-mail: ${p.mailbox}`,
      filename: att.name,
      sourceMessageId: p.messageId,
      description: p.subject ?? undefined,
    });
    if (result.status === "created") created++;
  }
  await prisma.integrationLog.create({
    data: {
      provider: "GRAPH",
      operation: "ingest_email",
      ok: true,
      message: `${p.mailbox} msg ${p.messageId}: ${attachments.length} PDF(s), ${created} título(s) novo(s)`,
    },
  });
}

// Processa a fila de e-mail.
export async function processEmailJobs(): Promise<ProcessResult> {
  return processFinanceJobs({ EMAIL_MESSAGE: handleEmailMessage });
}
