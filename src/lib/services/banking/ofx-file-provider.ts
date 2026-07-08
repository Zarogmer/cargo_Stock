// Leitura de extrato a partir de um ARQUIVO enviado (Fase 3). Hoje só OFX; o
// retorno CNAB 240/400 entra aqui quando tivermos um arquivo real de exemplo
// pra calibrar as posições (ver docs/financeiro/01-plano.md, Fase 3).
//
// O OFX vem em CHARSET 1252 (Windows-1252) nos dois bancos — decodificamos
// como latin1 pra não corromper acentos (São/Damião) antes do regex.

import type { ParsedStatement } from "./types";
import { parseOfx } from "./ofx";

export function looksLikeOfx(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 200).toString("latin1").toUpperCase();
  return head.includes("OFXHEADER") || head.includes("<OFX>");
}

export function parseStatementFile(buffer: Buffer, filename: string): ParsedStatement {
  if (looksLikeOfx(buffer)) {
    return parseOfx(buffer.toString("latin1"));
  }
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "ret" || ext === "cnab" || ext === "txt") {
    throw new Error(
      "Retorno CNAB ainda não é suportado — envie o extrato em OFX. (O parser CNAB entra numa próxima etapa, quando houver um arquivo de retorno real pra calibrar.)"
    );
  }
  throw new Error("Arquivo não reconhecido como OFX. Envie o extrato exportado do banco em formato .ofx");
}
