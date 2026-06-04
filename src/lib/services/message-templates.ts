// Builders de mensagem com DADOS AO VIVO pros boletins de WhatsApp enviados aos
// grupos (aba Mensagens — envio na hora e agendado). Fonte ÚNICA: tanto o
// preview na UI (/api/whatsapp/templates) quanto o scheduler
// (src/lib/services/scheduler.ts) chamam `buildTemplate` daqui, pra não haver
// duas redações/contas divergentes.
//
// A conta de prontidão é a MESMA do donut do dashboard (EmbarqueChart em
// src/app/(dashboard)/page.tsx): só itens com Qtd Padrão > 0, atual limitado
// ao padrão, % = atual/padrão.

import { prisma } from "@/lib/prisma";

export type TemplateKind = "EPI" | "UNIFORME" | "PRONTIDAO";
export type ProntidaoTeam = "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3" | "ALL";

// Equipes de rancho consideradas na prontidão (mesmo conjunto do dashboard).
const FOOD_TEAMS = ["EQUIPE_1", "EQUIPE_2", "EQUIPE_3"] as const;

const TEAM_LABELS: Record<string, string> = {
  EQUIPE_1: "Equipe 1",
  EQUIPE_2: "Equipe 2",
  EQUIPE_3: "Equipe 3",
};

// Formata quantidade tirando zeros à toa: 1,5 → "1,5"; 12 → "12"; 1,67 → "1,67".
// Float no rancho aceita quebrado (kg), então não dá pra assumir inteiro.
const qtyFmt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
function fmtQty(n: number): string {
  return qtyFmt.format(n);
}

// "DD/MM/YYYY HHhMM" no horário de São Paulo — o operador raciocina em local,
// não UTC. Mesmo padrão formatToParts usado em escalacao/notify e groups.
function nowBrLabel(): string {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}h${get("minute")}`;
}

// ── EPI ─────────────────────────────────────────────────────────────────────
export async function buildEpiStockMessage(): Promise<string> {
  const items = await prisma.epi.findMany({
    orderBy: { name: "asc" },
    select: { name: true, size: true, stock_qty: true },
  });
  if (items.length === 0) return "*📋 Estoque de EPIs*\n\nNenhum EPI cadastrado.";

  const totalQty = items.reduce((s, i) => s + (i.stock_qty || 0), 0);
  const lines = items.map((i) => {
    const size = i.size?.trim() ? ` (${i.size.trim()})` : "";
    return `• ${i.name}${size} — ${fmtQty(i.stock_qty)} un`;
  });
  return [
    "*📋 Estoque de EPIs*",
    `_Atualizado em ${nowBrLabel()}_`,
    "",
    ...lines,
    "",
    `_Total em estoque: ${fmtQty(totalQty)} un · ${items.length} ${items.length === 1 ? "tipo" : "tipos"}_`,
  ].join("\n");
}

// ── Uniformes ────────────────────────────────────────────────────────────────
export async function buildUniformStockMessage(): Promise<string> {
  const items = await prisma.uniform.findMany({
    orderBy: { name: "asc" },
    select: { name: true, size: true, stock_qty: true },
  });
  if (items.length === 0) return "*👕 Estoque de Uniformes*\n\nNenhum uniforme cadastrado.";

  const totalQty = items.reduce((s, i) => s + (i.stock_qty || 0), 0);
  const lines = items.map((i) => {
    const size = i.size?.trim() ? ` (${i.size.trim()})` : "";
    return `• ${i.name}${size} — ${fmtQty(i.stock_qty)} un`;
  });
  return [
    "*👕 Estoque de Uniformes*",
    `_Atualizado em ${nowBrLabel()}_`,
    "",
    ...lines,
    "",
    `_Total em estoque: ${fmtQty(totalQty)} un · ${items.length} ${items.length === 1 ? "tipo" : "tipos"}_`,
  ].join("\n");
}

// ── Prontidão ────────────────────────────────────────────────────────────────
interface StockRow { name: string; quantity: number; default_quantity: number; team: string | null }

// Bloco de prontidão de UMA equipe (sem cabeçalho "atualizado em" — fica no
// envelope `buildProntidaoMessage`). % e totais replicam o EmbarqueChart.
//   full=true  → lista COMPLETA: cada item com atual/padrão e quanto falta repor.
//   full=false → resumo (só "em falta"), usado em "todas as equipes" pra não
//                virar um textão de 3 equipes.
function prontidaoBlock(team: string, rows: StockRow[], full: boolean): string {
  const teamLabel = TEAM_LABELS[team] || team;
  const withDefault = rows.filter((i) => i.default_quantity > 0);
  if (withDefault.length === 0) {
    return `*⚓ Prontidão para embarque — ${teamLabel}*\n_Sem itens com Qtd Padrão definida._`;
  }

  const totalDefault = withDefault.reduce((s, i) => s + i.default_quantity, 0);
  const totalCurrent = withDefault.reduce((s, i) => s + Math.min(i.quantity, i.default_quantity), 0);
  const pct = totalDefault > 0 ? Math.round((totalCurrent / totalDefault) * 100) : 0;
  const emoji = pct >= 90 ? "🟢" : pct >= 60 ? "🟡" : "🔴";
  const totalFalta = withDefault.reduce((s, i) => s + Math.max(0, i.default_quantity - i.quantity), 0);

  const head = [
    `*⚓ Prontidão para embarque — ${teamLabel}*`,
    `${emoji} *${pct}% pronto*  (${fmtQty(totalCurrent)}/${fmtQty(totalDefault)} itens)`,
  ];

  if (full) {
    // Lista completa: faltando primeiro (mais crítico no topo, por falta desc),
    // depois os completos por nome. Cada linha mostra atual/padrão.
    const sorted = [...withDefault].sort((a, b) => {
      const fa = Math.max(0, a.default_quantity - a.quantity);
      const fb = Math.max(0, b.default_quantity - b.quantity);
      if (fa !== fb) return fb - fa;
      return a.name.localeCompare(b.name, "pt-BR");
    });
    if (totalFalta > 0) head.push(`_Faltam ${fmtQty(totalFalta)} itens para completar_`);
    head.push("");
    for (const i of sorted) {
      const falta = i.default_quantity - i.quantity;
      const base = `• ${i.name} — ${fmtQty(i.quantity)}/${fmtQty(i.default_quantity)}`;
      head.push(falta > 0 ? `${base} (faltam ${fmtQty(falta)})` : `${base} ✅`);
    }
    return head.join("\n");
  }

  // Resumo (todas as equipes): só os itens em falta.
  const missing = withDefault
    .filter((i) => i.quantity < i.default_quantity)
    .map((i) => ({ name: i.name, falta: i.default_quantity - i.quantity }))
    .sort((a, b) => b.falta - a.falta);
  if (missing.length === 0) {
    head.push("_Rancho completo ✅_");
    return head.join("\n");
  }
  head.push("", "Em falta:");
  for (const m of missing) head.push(`• ${m.name} — faltam ${fmtQty(m.falta)}`);
  return head.join("\n");
}

export async function buildProntidaoMessage(team: ProntidaoTeam = "ALL"): Promise<string> {
  const rows = (await prisma.stockItem.findMany({
    where: { team: { in: [...FOOD_TEAMS] } },
    select: { name: true, quantity: true, default_quantity: true, team: true },
  })) as StockRow[];

  // Equipe específica → lista completa; "Todas" → resumo por equipe.
  const full = team !== "ALL";
  const teams: string[] = team === "ALL" ? [...FOOD_TEAMS] : [team];
  const blocks = teams.map((t) => prontidaoBlock(t, rows.filter((r) => r.team === t), full));
  return [`_Atualizado em ${nowBrLabel()}_`, "", blocks.join("\n\n———\n\n")].join("\n");
}

// Dispatcher usado pelo preview e pelo scheduler.
export async function buildTemplate(kind: TemplateKind, team?: ProntidaoTeam): Promise<string> {
  switch (kind) {
    case "EPI": return buildEpiStockMessage();
    case "UNIFORME": return buildUniformStockMessage();
    case "PRONTIDAO": return buildProntidaoMessage(team || "ALL");
    default: throw new Error(`Template desconhecido: ${kind}`);
  }
}
