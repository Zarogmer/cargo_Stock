// Importa um ParsedStatement pra dentro do banco (tabela bank_transactions),
// de forma IDEMPOTENTE: reimportar o mesmo arquivo (ou um extrato que se
// sobrepõe) não duplica nada.
//
// Idempotência em duas camadas (as duas @@unique de BankTransaction):
//   1. external_id (FITID) — usado só quando é CONFIÁVEL: todos os FITIDs do
//      lote são únicos e não vazios. No Santander o FITID se repete no mesmo
//      arquivo, então caímos fora e external_id fica null.
//   2. dedupe_hash = sha256(conta|data|centavos|memo|ocorrência) — sempre
//      calculado; é o que garante idempotência quando não há id confiável.
//      A "ocorrência" distingue lançamentos idênticos no mesmo arquivo e se
//      mantém estável na reimportação do mesmo arquivo.

import { createHash } from "crypto";
import { Prisma, type TransactionSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ParsedStatement } from "./types";

export interface ImportResult {
  inserted: number;
  duplicates: number;
  skippedBalanceMarkers: number;
  total: number;
}

function dateISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function normMemo(s: string): string {
  return s.replace(/\s+/g, " ").trim().toUpperCase();
}

export async function importStatement(
  bankAccountId: number,
  statement: ParsedStatement,
  userName: string
): Promise<ImportResult> {
  const txs = statement.transactions;

  // FITID é confiável só se todos os não-vazios forem únicos no lote.
  const fitids = txs.map((t) => t.externalId).filter((x): x is string => !!x);
  const fitidReliable =
    fitids.length === txs.length && new Set(fitids).size === fitids.length;

  // Contador de ocorrências pra lançamentos idênticos (conta implícita).
  const seen = new Map<string, number>();

  const rows = txs.map((t) => {
    const iso = dateISO(t.postedAt);
    const cents = Math.round(t.amount * 100);
    const base = `${bankAccountId}|${iso}|${cents}|${normMemo(t.description)}`;
    const occ = seen.get(base) ?? 0;
    seen.set(base, occ + 1);
    const dedupe_hash = createHash("sha256").update(`${base}|${occ}`).digest("hex");

    return {
      bank_account_id: bankAccountId,
      posted_at: t.postedAt,
      amount: new Prisma.Decimal(t.amount.toFixed(2)),
      description: t.description || null,
      payee_name: t.payeeName,
      payee_document: t.payeeDocument,
      external_id: fitidReliable ? t.externalId : null,
      dedupe_hash,
      reconcilable: t.reconcilable,
      source: statement.source as TransactionSource,
      raw: t.raw as Prisma.InputJsonValue,
      imported_by: userName,
    };
  });

  // ON CONFLICT DO NOTHING em qualquer uma das @@unique — idempotente.
  const { count } = await prisma.bankTransaction.createMany({
    data: rows,
    skipDuplicates: true,
  });

  const result: ImportResult = {
    inserted: count,
    duplicates: rows.length - count,
    skippedBalanceMarkers: statement.skipped.balanceMarkers,
    total: rows.length,
  };

  await prisma.integrationLog.create({
    data: {
      provider: "OFX",
      operation: "import_extrato",
      ok: true,
      message: `Conta ${bankAccountId}: +${result.inserted} novas, ${result.duplicates} já existiam, ${result.skippedBalanceMarkers} marcadores de saldo ignorados`,
      details: {
        bank: statement.bank,
        accountId: statement.accountId,
        openingBalance: statement.openingBalance,
        fitidReliable,
        ...result,
      } as Prisma.InputJsonValue,
    },
  });

  return result;
}
