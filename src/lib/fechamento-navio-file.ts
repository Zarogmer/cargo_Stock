// Nome do arquivo gerado na aba Financeiro › Fechamento de Navio:
// "Fechamento 46 - MV JNS DRAGON.pdf" / ".xlsx". Compartilhado entre a tela
// (download do Excel) e a rota do PDF (Content-Disposition). Puro, sem
// dependência de servidor nem de React.

import type { ClosingDoc } from "@/lib/fechamento-navio";

export function closingFileName(doc: Pick<ClosingDoc, "number" | "ship_name">, ext: "pdf" | "xlsx"): string {
  const number = doc.number.trim();
  const ship = doc.ship_name.trim().toUpperCase().replace(/^M\/V\s+/, "MV ") || "NAVIO";
  const base = number ? `Fechamento ${number} - ${ship}` : `Fechamento - ${ship}`;
  // Caracteres que Windows/Android recusam em nome de arquivo.
  return `${base.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim()}.${ext}`;
}
