// Lista de compras / reposição: itens dos três inventários (Estoque do galpão,
// EPI e Uniforme) que estão ABAIXO da quantidade mínima, com quanto comprar.
// Fonte ÚNICA — usada pela aba Compras, pela seção do Dashboard (via
// /api/almoxarifado/compras) e pelo template de WhatsApp (buildComprasMessage).
//
// Regra de reposição: todo item abaixo do mínimo entra na lista, com o quanto
// comprar pra voltar ao mínimo (mesma conta nos três inventários).
// min_quantity = 0 significa "sem mínimo" → o item nunca entra na lista.

import { prisma } from "@/lib/prisma";
import { unitSuffix } from "@/lib/utils";

export type PurchaseKind = "ESTOQUE" | "EPI" | "UNIFORME";

export interface PurchaseItem {
  kind: PurchaseKind;
  id: number;
  name: string;
  detail: string | null; // categoria (Estoque) ou tamanho (EPI/Uniforme)
  current: number;
  min: number;
  buy: number; // quanto comprar (> 0)
  unit: string; // "un", "kg", ... (Estoque); "un" nos demais
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export async function getPurchaseList(): Promise<PurchaseItem[]> {
  const [stock, epis, uniforms] = await Promise.all([
    prisma.stockItem.findMany({
      where: { team: "GALPAO", min_quantity: { gt: 0 } },
      select: { id: true, name: true, location: true, quantity: true, min_quantity: true, unit: true },
    }),
    prisma.epi.findMany({
      where: { min_quantity: { gt: 0 } },
      select: { id: true, name: true, size: true, stock_qty: true, min_quantity: true },
    }),
    prisma.uniform.findMany({
      where: { min_quantity: { gt: 0 } },
      select: { id: true, name: true, size: true, stock_qty: true, min_quantity: true },
    }),
  ]);

  const out: PurchaseItem[] = [];

  for (const s of stock) {
    if (s.quantity >= s.min_quantity) continue; // dentro do mínimo
    const buy = round3(s.min_quantity - s.quantity);
    if (buy <= 0) continue;
    out.push({
      kind: "ESTOQUE", id: s.id, name: s.name, detail: s.location || null,
      current: s.quantity, min: s.min_quantity, buy, unit: unitSuffix(s.unit),
    });
  }
  for (const e of epis) {
    if (e.stock_qty >= e.min_quantity) continue;
    out.push({
      kind: "EPI", id: e.id, name: e.name, detail: e.size?.trim() || null,
      current: e.stock_qty, min: e.min_quantity, buy: e.min_quantity - e.stock_qty, unit: "un",
    });
  }
  for (const u of uniforms) {
    if (u.stock_qty >= u.min_quantity) continue;
    out.push({
      kind: "UNIFORME", id: u.id, name: u.name, detail: u.size?.trim() || null,
      current: u.stock_qty, min: u.min_quantity, buy: u.min_quantity - u.stock_qty, unit: "un",
    });
  }

  // Mais crítico (maior quantidade a comprar) primeiro; desempata por nome.
  out.sort((a, b) => (b.buy - a.buy) || a.name.localeCompare(b.name, "pt-BR"));
  return out;
}
