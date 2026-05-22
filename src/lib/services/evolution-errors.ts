/**
 * Translate raw Evolution/Baileys error messages into something a non-engineer
 * can act on. Evolution wraps errors at several layers (HTTP, NestJS, Baileys
 * itself) so the strings we see in `err.message` vary a lot — match on
 * substrings rather than exact text.
 */
export function friendlyEvolutionError(raw: string): string {
  const lower = raw.toLowerCase();

  // Session/connection problems — fix is always to reconnect the instance.
  if (lower.includes("connection closed") || lower.includes("connection lost") || lower.includes("not connected")) {
    return "WhatsApp desconectado no servidor. Abra a aba WhatsApp API, confira o status e escaneie o QR Code novamente.";
  }

  // Recipient doesn't have WhatsApp. Evolution returns a few variations of this
  // ("exists":false, "number does not exist", "not exists on whatsapp", …).
  if (
    lower.includes("not exists") ||
    lower.includes("does not exist") ||
    lower.includes('"exists":false') ||
    lower.includes("not on whatsapp") ||
    lower.includes("invalid jid")
  ) {
    return "Esse número não tem WhatsApp ou foi cadastrado errado. Confira o telefone do colaborador em Colaboradores.";
  }

  if (lower.includes("timeout")) {
    return "Tempo esgotado falando com o WhatsApp. Tenta de novo em alguns segundos.";
  }

  if (lower.includes("rate") && lower.includes("limit")) {
    return "WhatsApp pediu pra desacelerar. Espera um minuto e tenta de novo.";
  }

  // Unknown — return the raw message but stripped of the noisy HTTP prefix
  // so the user at least sees the actual cause.
  return raw.replace(/^Evolution API \d+ \/[^:]+:\s*/, "").trim() || raw;
}
