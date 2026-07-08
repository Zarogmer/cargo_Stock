// Tipos do módulo Contas a Pagar/Conciliação usados no client. Espelham os
// enums do prisma/schema.prisma — string unions pra não arrastar o
// @prisma/client pro bundle do browser.

export type PayableStatus =
  | "RECEBIDO"
  | "AGUARDANDO_APROVACAO"
  | "APROVADO"
  | "PAGO"
  | "CANCELADO";

export type PayableOrigin = "EMAIL" | "MANUAL";

export type BankKind = "ITAU" | "SANTANDER" | "OUTRO";

export type TransactionSource = "OFX_FILE" | "CNAB_FILE" | "API_ITAU" | "API_SANTANDER";

export type ReconciliationStatus = "SUGERIDA" | "CONFIRMADA" | "REJEITADA";

export type FinanceJobStatus = "PENDENTE" | "PROCESSANDO" | "CONCLUIDO" | "ERRO";
