// One-shot: migra Ferramenta e Elétrica do modelo de EMPRÉSTIMO (tabela `tools`,
// asset_type) para o modelo de INVENTÁRIO (tabela `stock_items`, com o campo
// `team` como sentinela do setor: "FERRAMENTA" / "ELETRICA").
//
// Antes: cada ferramenta/item elétrico era 1 linha em `tools` com status
// (Disponível/Equipe 1/2). Agora viram itens de estoque com QUANTIDADE: linhas
// com o mesmo nome (+ categoria) são agregadas, e a quantidade = nº de unidades.
// Maquinário NÃO é tocado (segue como empréstimo).
//
// O que faz (com --apply):
//   1. Cria os itens agregados em `stock_items` (team = FERRAMENTA/ELETRICA,
//      quantity = contagem, min_quantity = 0, category = OUTROS, location = a
//      antiga `location` da ferramenta, e notes = a antiga `notes`, se houver).
//   2. Apaga as linhas migradas de `tools` (cascade remove tool_movements delas).
//
// Roda em DRY-RUN por padrão (só lê e mostra o que mudaria). O .env aponta pro
// Postgres de PRODUÇÃO no Railway.
//
// Uso:
//   npx tsx scripts/migrate-tools-to-stock.ts            (dry-run)
//   npx tsx scripts/migrate-tools-to-stock.ts --apply    (grava)
//   npx tsx scripts/migrate-tools-to-stock.ts --apply --force   (mesmo com itens já existentes)

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

const TYPES = ["FERRAMENTA", "ELETRICA"] as const;
type AssetT = (typeof TYPES)[number];

interface Agg {
  team: AssetT;
  name: string;          // nome exibido (1ª ocorrência)
  location: string | null;
  quantity: number;      // nº de unidades agregadas
  notes: string[];       // observações encontradas (preservadas em stock_items.notes)
}

async function run() {
  // Segurança anti-duplicação: se já existem itens de inventário nesses setores,
  // provavelmente a migração já rodou. Exige --force pra seguir.
  const already = await prisma.stockItem.count({ where: { team: { in: [...TYPES] } } });
  if (already > 0) {
    console.log(`⚠️  Já existem ${already} item(ns) em stock_items com team FERRAMENTA/ELETRICA.`);
    if (!FORCE) {
      console.log("→ Para evitar duplicar, abortado. Rode com --force se tiver certeza.\n");
      return;
    }
    console.log("→ --force: seguindo mesmo assim.\n");
  }

  const tools = await prisma.tool.findMany({
    where: { asset_type: { in: [...TYPES] } },
    select: { id: true, name: true, location: true, notes: true, asset_type: true, updated_by: true },
    orderBy: [{ asset_type: "asc" }, { name: "asc" }],
  });

  if (tools.length === 0) {
    console.log("Nenhuma ferramenta/elétrica em `tools` para migrar. Nada a fazer.");
    return;
  }

  // Agrega por team + nome (sem caixa) + categoria.
  const map = new Map<string, Agg>();
  for (const t of tools) {
    const team = t.asset_type as AssetT;
    const name = (t.name || "").trim();
    const location = (t.location || "").trim() || null;
    const key = `${team}||${name.toLowerCase()}||${(location || "").toLowerCase()}`;
    const cur = map.get(key);
    if (cur) {
      cur.quantity += 1;
      if (t.notes && t.notes.trim()) cur.notes.push(t.notes.trim());
    } else {
      map.set(key, { team, name, location, quantity: 1, notes: t.notes && t.notes.trim() ? [t.notes.trim()] : [] });
    }
  }

  const aggs = [...map.values()];
  const byType = (tp: AssetT) => aggs.filter((a) => a.team === tp);

  console.log(`Linhas em \`tools\` (Ferramenta/Elétrica): ${tools.length}`);
  console.log(`Itens de inventário após agregação: ${aggs.length}\n`);

  for (const tp of TYPES) {
    const list = byType(tp);
    if (list.length === 0) continue;
    console.log(`── ${tp} (${list.length} item(ns)) ─────────────────────────────`);
    for (const a of list) {
      const cat = a.location ? ` [${a.location}]` : "";
      const note = a.notes.length ? `  📝 obs: ${a.notes.join(" | ")}` : "";
      console.log(`  • ${a.name}${cat}  → qtd ${a.quantity}${note}`);
    }
    console.log("");
  }

  const withNotes = aggs.filter((a) => a.notes.length).length;
  if (withNotes > 0) {
    console.log(`📝 ${withNotes} item(ns) com observações — preservadas em stock_items.notes.\n`);
  }

  if (!APPLY) {
    console.log("[dry-run] Nada gravado. Rode novamente com --apply para aplicar em produção.");
    return;
  }

  // 1) Cria os itens de inventário.
  let created = 0;
  for (const a of aggs) {
    await prisma.stockItem.create({
      data: {
        name: a.name,
        location: a.location,
        quantity: a.quantity,
        default_quantity: 0,
        category: "OUTROS",
        unit: "UN",
        team: a.team,
        min_quantity: 0,
        notes: a.notes.length ? a.notes.join(" | ") : null,
        updated_by: "Migração tools→stock",
      },
    });
    created += 1;
  }
  console.log(`✅ ${created} item(ns) criado(s) em stock_items.`);

  // 2) Remove as linhas migradas de `tools` (cascade apaga tool_movements delas).
  const del = await prisma.tool.deleteMany({ where: { asset_type: { in: [...TYPES] } } });
  console.log(`🗑️  ${del.count} linha(s) removida(s) de \`tools\` (Ferramenta/Elétrica).`);
  console.log("\n✅ Migração concluída.");
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
