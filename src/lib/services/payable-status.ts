// Máquina de estados do Contas a Pagar (PayableInvoice.status).
//
//   RECEBIDO ──► AGUARDANDO_APROVACAO ──► APROVADO ──► PAGO
//       │                │                   │
//       └────────────────┴───────────────────┴──► CANCELADO
//
// PAGO e CANCELADO são terminais. Toda transição passa por canTransition()
// na rota de API — o front nunca decide sozinho. Os campos de auditoria
// (quem aprovou/pagou/cancelou e quando) saem de transitionPatch().
//
// Sem dependência de servidor de propósito: a UI importa os labels/cores e a
// lista de próximas transições daqui, pra ter uma fonte única.

import type { PayableStatus } from "@prisma/client";

export const PAYABLE_TRANSITIONS: Record<PayableStatus, PayableStatus[]> = {
  RECEBIDO: ["AGUARDANDO_APROVACAO", "CANCELADO"],
  AGUARDANDO_APROVACAO: ["APROVADO", "CANCELADO"],
  APROVADO: ["PAGO", "CANCELADO"],
  PAGO: [],
  CANCELADO: [],
};

export function canTransition(from: PayableStatus, to: PayableStatus): boolean {
  return PAYABLE_TRANSITIONS[from]?.includes(to) ?? false;
}

// Campos gravados junto com a mudança de status — trilha de quem fez o quê.
export function transitionPatch(
  to: PayableStatus,
  userName: string,
  reason?: string | null
): Record<string, unknown> {
  const now = new Date();
  switch (to) {
    case "AGUARDANDO_APROVACAO":
      return { status: to };
    case "APROVADO":
      return { status: to, approved_by: userName, approved_at: now };
    case "PAGO":
      return { status: to, paid_by: userName, paid_at: now };
    case "CANCELADO":
      return {
        status: to,
        cancelled_by: userName,
        cancelled_at: now,
        cancel_reason: reason || null,
      };
    default:
      return { status: to };
  }
}

// Título ainda editável (valor/vencimento/fornecedor)? Depois de aprovado, os
// dados que foram aprovados não mudam — só notes.
export function isEditable(status: PayableStatus): boolean {
  return status === "RECEBIDO" || status === "AGUARDANDO_APROVACAO";
}

export const PAYABLE_STATUS_LABELS: Record<PayableStatus, string> = {
  RECEBIDO: "Recebido",
  AGUARDANDO_APROVACAO: "Aguardando aprovação",
  APROVADO: "Aprovado",
  PAGO: "Pago",
  CANCELADO: "Cancelado",
};

// Rótulo do botão que LEVA até o status (ação, não estado).
export const PAYABLE_ACTION_LABELS: Record<PayableStatus, string> = {
  RECEBIDO: "Marcar recebido",
  AGUARDANDO_APROVACAO: "Enviar p/ aprovação",
  APROVADO: "Aprovar",
  PAGO: "Marcar como pago",
  CANCELADO: "Cancelar título",
};

// Regra de aprovação automática: AppSetting "financeiro_auto_aprovar_max"
// (valor em reais). Título criado com valor ≤ teto nasce APROVADO, com o
// motivo na trilha. Setting ausente/zerada = regra desligada.
export const AUTO_APPROVE_SETTING_KEY = "financeiro_auto_aprovar_max";

export function autoApproveReason(amount: number, maxSetting: string | null | undefined): string | null {
  const max = parseFloat(String(maxSetting ?? "").replace(",", "."));
  if (!Number.isFinite(max) || max <= 0) return null;
  if (amount > max) return null;
  return `AUTO (valor ≤ teto de aprovação R$ ${max.toFixed(2)})`;
}
