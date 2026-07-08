// Contrato comum do módulo de conciliação. TODA fonte de movimentação bancária
// (arquivo OFX/CNAB agora; APIs Itaú/Santander na Fase 6) é normalizada para
// `NormalizedTransaction` — o motor de conciliação (Fase 4) e o serviço de
// importação só conhecem este formato, nunca o formato nativo do banco.

import type { BankKind, TransactionSource } from "@prisma/client";

// Uma movimentação já normalizada, pronta pra virar BankTransaction.
export interface NormalizedTransaction {
  // Data de lançamento (só a data importa; hora/fuso do OFX são descartados).
  postedAt: Date;
  // Valor COM SINAL: negativo = débito/pagamento, positivo = crédito.
  amount: number;
  description: string; // memo original do banco
  payeeName: string | null; // favorecido extraído do memo, quando dá
  payeeDocument: string | null; // CNPJ/CPF do favorecido (só dígitos)
  // Id externo da transação (FITID do OFX / id da API). Só deve ser preenchido
  // quando for CONFIÁVEL e único por conta — senão null (o dedupe_hash cuida).
  externalId: string | null;
  // false = transferência interna / aplicação-resgate automático: não entra na
  // conciliação (ver comentário em prisma schema BankTransaction.reconcilable).
  reconcilable: boolean;
  // Registro cru pra auditoria (linha do OFX/CNAB ou objeto da API).
  raw: Record<string, unknown>;
}

// Resultado de ler um extrato de uma fonte (arquivo ou API).
export interface ParsedStatement {
  bank: BankKind;
  bankId: string | null; // código do banco (ex.: "0341", "033")
  accountId: string | null; // ACCTID cru do OFX (agência+conta concatenadas)
  currency: string | null;
  source: TransactionSource;
  transactions: NormalizedTransaction[];
  // Diagnóstico da leitura — nada é descartado em silêncio.
  skipped: { balanceMarkers: number };
  openingBalance: number | null; // "SALDO ANTERIOR", quando presente
}

// Provider de API bancária (Fase 6). Arquivos não implementam isto — eles usam
// parseStatementFile() —, mas ambos entregam o mesmo NormalizedTransaction.
export interface BancoProvider {
  readonly bank: BankKind;
  listarMovimentacoes(
    account: { agency?: string | null; accountNumber?: string | null },
    dataInicio: Date,
    dataFim: Date
  ): Promise<ParsedStatement>;
}
