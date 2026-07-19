// Formas de pagamento do Contas a Pagar — superset das do Controle de Compras
// (FATURADO, CARTÃO DE CRÉDITO/DÉBITO, PIX, DINHEIRO) + BOLETO e TRANSFERÊNCIA,
// comuns nos títulos a pagar. Fonte única pro seletor, o filtro e a validação.
export const PAYMENT_METHODS = [
  "PIX",
  "DINHEIRO",
  "BOLETO",
  "CARTÃO DE CRÉDITO",
  "CARTÃO DE DÉBITO",
  "FATURADO",
  "TRANSFERÊNCIA",
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// Normaliza/valida uma forma de pagamento vinda do cliente (ou de uma compra):
// devolve o rótulo canônico se conhecido, senão null (não grava lixo).
export function normalizePaymentMethod(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const up = raw.trim().toUpperCase();
  return (PAYMENT_METHODS as readonly string[]).includes(up) ? up : null;
}
