// Parser de OFX (Open Financial Exchange) tolerante — os bancos BR exportam
// OFX 1.x, que é SGML (tags não fechadas), não XML. Calibrado com extratos
// reais de Itaú (VERSION 102, decimal com ponto, FITID sequencial confiável) e
// Santander (VERSION 102, decimal com vírgula, FITID que se repete no arquivo).
//
// O parser é GENÉRICO: não sabe de banco. Quem decide banco/idempotência é o
// chamador (ofx-file-provider + import).

import type { BankKind } from "@prisma/client";
import type { NormalizedTransaction, ParsedStatement } from "./types";
import { isBalanceMarker, isReconcilable, extractPayee } from "./classify";

// Valor de uma tag SGML: tudo entre `<TAG>` e o próximo `<` (ou fim de linha).
function tagValue(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

// "20260430100000[-03:EST]" → Date no dia certo (UTC meio-dia evita que o fuso
// jogue a data pro dia anterior). Só a parte da data importa (coluna DATE).
function parseOfxDate(value: string | null): Date | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 8) return null;
  const y = Number(digits.slice(0, 4));
  const mo = Number(digits.slice(4, 6));
  const d = Number(digits.slice(6, 8));
  if (!y || !mo || !d) return null;
  return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
}

// "-339,00" | "46975.70" | "-1.912,59" → number. Itaú usa ponto decimal,
// Santander vírgula; alguns valores podem trazer milhar.
export function parseOfxAmount(value: string | null): number {
  if (!value) return 0;
  let s = value.replace(/\s|R\$/gi, "").trim();
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // ponto = milhar, vírgula = decimal
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function detectBank(bankId: string | null, org: string | null): BankKind {
  const id = (bankId || "").replace(/^0+/, "");
  if (id === "33" || /santander/i.test(org || "")) return "SANTANDER";
  if (id === "341" || /ita[uú]/i.test(org || "")) return "ITAU";
  return "OUTRO";
}

// Lê um OFX inteiro. `sourceTag` marca a origem no ParsedStatement.
export function parseOfx(text: string): ParsedStatement {
  const org = tagValue(text, "ORG");
  const bankId = tagValue(text, "BANKID");
  const accountId = tagValue(text, "ACCTID");
  const currency = tagValue(text, "CURDEF");
  const bank = detectBank(bankId, org);

  const transactions: NormalizedTransaction[] = [];
  let balanceMarkers = 0;
  let openingBalance: number | null = null;

  const blockRe = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(text)) !== null) {
    const block = match[1];
    const memo = (tagValue(block, "MEMO") || tagValue(block, "NAME") || "").trim();
    const amount = parseOfxAmount(tagValue(block, "TRNAMT"));
    const postedAt = parseOfxDate(tagValue(block, "DTPOSTED"));
    if (!postedAt) continue;

    // Marcador de saldo do Itaú: guarda o SALDO ANTERIOR como saldo inicial e
    // descarta a linha (não é movimentação).
    if (isBalanceMarker(memo)) {
      balanceMarkers++;
      if (/ANTERIOR/i.test(memo) && openingBalance === null) openingBalance = amount;
      continue;
    }

    const { payeeName, payeeDocument } = extractPayee(memo);
    transactions.push({
      postedAt,
      amount,
      description: memo,
      payeeName,
      payeeDocument,
      externalId: tagValue(block, "FITID"),
      reconcilable: isReconcilable(memo),
      raw: {
        trntype: tagValue(block, "TRNTYPE"),
        fitid: tagValue(block, "FITID"),
        checknum: tagValue(block, "CHECKNUM"),
        memo,
      },
    });
  }

  return {
    bank,
    bankId,
    accountId,
    currency,
    source: "OFX_FILE",
    transactions,
    skipped: { balanceMarkers },
    openingBalance,
  };
}
