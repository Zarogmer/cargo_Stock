/**
 * Monta o "kit de embarque" por equipe (tabela embark_kit_items) a partir do
 * Check List.xlsx. Cada item do Check List é garantido no Estoque (stock_items,
 * team=GALPAO): ou casa com um material existente, ou é CRIADO como item novo
 * (categoria/location "Embarque"). A Equipe 2 é cópia da Equipe 1.
 *
 *   npx tsx scripts/import-embark-kit.ts            # dry-run
 *   npx tsx scripts/import-embark-kit.ts --commit   # cria itens + kit (PROD)
 *   npx tsx scripts/import-embark-kit.ts --commit --force  # regrava o kit
 *
 * Idempotente: itens criados são reusados pelo nome em re-runs; o kit é
 * recriado do zero quando --force.
 */
import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import * as fs from "node:fs";

const prisma = new PrismaClient();
const FILE = "C:/Users/Guilherme/CARGO SHIPS CLEANING LTDA/SERVIDOR - Documentos/CARGO - PLANILHAS/Check List.xlsx";
const TEAMS = ["EQUIPE_1", "EQUIPE_2"];

// Check List (nome) -> Estoque (nome exato) p/ os nomes tortos que o matcher
// não pega sozinho (confirmados pelo usuário).
const OVERRIDES: Record<string, string> = {
  "Rádio Transm.": "RADIO TANSMISSOR",
  "Raspadeira": "ERASPADEIRA CUMPRIDA",
  "Espátula": "ESPATOLA MAO",
  "Cola Casco Lac": "COLA CASCOLAC",
  "Pneu Rolam.": "PNEU DE ROLAMENTO",
  "MangBomba": "MANGUEIRA BOMBA",
  "Óleo Máquina": "OLEO MOTOR",
  "Másc. Branca": "MASCARA DE PROT SIMPLES",
};

function norm(s: unknown) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function expand(n: string) {
  let s = ` ${n} `;
  const map: [string, string][] = [
    [" MANG ", " MANGUEIRA "], [" MASC ", " MASCARA "], [" CINT ", " CINTO "],
    [" REGISTR ", " REGISTRO "], [" SILVERTAPE ", " SILVER TAPE "],
    [" PIGUIMENTADA ", " PIGMENTADA "], [" PIGUIM ", " PIGMENTADA "],
    [" EXTEN ", " EXTENSAO "], [" QUIMI ", " QUIMICA "], [" QUIM ", " QUIMICA "],
    [" COTOV ", " COTOVELO "], [" TRANSM ", " TRANSMISSOR "],
    [" DESENGRIPANTE ", " DESINGRIPANTE "], [" EMEN ", " EMENDA "], [" CONC ", " CONEXAO "],
  ];
  for (const [a, b] of map) s = s.split(a).join(b);
  return s.trim().replace(/\s+/g, " ");
}
function stem(t: string) { t = t.replace(/S$/, ""); if (t.length > 4) t = t.replace(/[AOE]$/, ""); return t; }
function tokset(n: string) { return new Set(n.split(" ").filter((w) => w.length > 1).map(stem)); }
function score(a: string, b: string) {
  if (a === b) return 1;
  const ta = tokset(a), tb = tokset(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0; for (const t of ta) if (tb.has(t)) inter++;
  const jac = inter / new Set([...ta, ...tb]).size;
  const smaller = ta.size <= tb.size ? ta : tb;
  let cont = 0; for (const t of smaller) if ((ta.size <= tb.size ? tb : ta).has(t)) cont++;
  return Math.max(jac, (cont / smaller.size) * 0.9);
}

function parseEq1(): { name: string; qty: number }[] {
  const wb = XLSX.read(fs.readFileSync(FILE), { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets["Equipe 1"], { header: 1, blankrows: false, defval: "" });
  const out: { name: string; qty: number }[] = [];
  const skip = new Set(["LISTA", "QUANT", "MAQUINISTA", "SUPERVISOR", "SURPERVISOR", "ENCARREGADO", "JOSUE", "DATA", "NAVIO", "PORTO", "EQUIPE", "PRODUTO"]);
  for (let i = 4; i < rows.length; i++) {
    const r = rows[i];
    for (const [qi, ni] of [[0, 1], [4, 5]]) {
      const name = String(r[ni] ?? "").trim();
      const qty = Number(r[qi]);
      if (!name || name.startsWith("_") || skip.has(norm(name))) continue;
      out.push({ name, qty: Number.isFinite(qty) ? qty : 0 });
    }
  }
  return out;
}

// Nome do item novo no Estoque (MAIÚSCULO, espaços normalizados).
function estoqueName(clName: string) { return clName.toUpperCase().replace(/\s+/g, " ").trim(); }

async function main() {
  const commit = process.argv.includes("--commit");
  const force = process.argv.includes("--force");

  const cl = parseEq1();
  let est = (await prisma.stockItem.findMany({ where: { team: "GALPAO" }, select: { id: true, name: true } }))
    .map((e) => ({ ...e, n: expand(norm(e.name)) }));
  const byNorm = new Map(est.map((e) => [norm(e.name), e]));

  type R = { clName: string; qty: number; estId: number | null; estName: string | null; create: boolean };
  const resolved: R[] = [];
  for (const item of cl) {
    const ovr = OVERRIDES[item.name];
    if (ovr) {
      const e = byNorm.get(norm(ovr));
      resolved.push({ clName: item.name, qty: item.qty, estId: e?.id ?? null, estName: e?.name ?? null, create: !e });
      continue;
    }
    const cn = expand(norm(item.name));
    let best: typeof est[number] | null = null, bs = 0;
    for (const e of est) { const sc = score(cn, e.n); if (sc > bs) { bs = sc; best = e; } }
    if (best && bs >= 0.85) resolved.push({ clName: item.name, qty: item.qty, estId: best.id, estName: best.name, create: false });
    else resolved.push({ clName: item.name, qty: item.qty, estId: null, estName: estoqueName(item.name), create: true });
  }

  const matched = resolved.filter((r) => !r.create);
  const toCreate = resolved.filter((r) => r.create);
  console.log(`\nCheck List: ${cl.length} itens | já no Estoque ${matched.length} | criar ${toCreate.length}`);
  console.log("\n== JÁ NO ESTOQUE (casados) ==");
  matched.forEach((r) => console.log(`  [${String(r.qty).padStart(3)}] ${r.clName.padEnd(22)} -> ${r.estName}`));
  console.log("\n== CRIAR NO ESTOQUE (novos, categoria Embarque) ==");
  toCreate.forEach((r) => console.log(`  [${String(r.qty).padStart(3)}] ${r.clName.padEnd(22)} -> ${r.estName}`));

  if (!commit) { console.log("\n— DRY RUN — use --commit pra criar os itens e o kit.\n"); return; }

  // Tabela do kit (aditivo).
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "embark_kit_items" (
      "id" SERIAL PRIMARY KEY,
      "team" TEXT NOT NULL,
      "stock_item_id" INTEGER NOT NULL REFERENCES "stock_items"("id") ON DELETE CASCADE,
      "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE ("team","stock_item_id")
    );`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "embark_kit_items_team_idx" ON "embark_kit_items"("team");`);

  // Cria (ou reusa) cada item novo no Estoque.
  let created = 0;
  for (const r of toCreate) {
    const existing = byNorm.get(norm(r.estName!));
    if (existing) { r.estId = existing.id; continue; }
    const row = await prisma.stockItem.create({
      data: {
        name: r.estName!, category: "OUTROS", location: "Embarque",
        quantity: r.qty, default_quantity: r.qty, min_quantity: 0,
        team: "GALPAO", updated_by: "Importação Check List",
      },
      select: { id: true, name: true },
    });
    byNorm.set(norm(row.name), { ...row, n: expand(norm(row.name)) });
    r.estId = row.id; created++;
  }
  console.log(`\n✅ Itens criados no Estoque: ${created} (reusados ${toCreate.length - created}).`);

  // Monta o kit (qtd > 0), deduplicado por (equipe, item).
  const kitItems = resolved.filter((r) => r.estId && r.qty > 0);
  const existingKit = await prisma.embarkKitItem.count();
  if (existingKit > 0 && !force) {
    console.log(`\n⚠️  Já existem ${existingKit} itens de kit. Use --force pra regravar. (Itens do Estoque acima já foram criados.)`);
    return;
  }
  if (existingKit > 0) {
    const del = await prisma.embarkKitItem.deleteMany({});
    console.log(`🗑️  Removidos ${del.count} itens de kit antigos.`);
  }
  const seen = new Set<string>();
  const rows: { team: string; stock_item_id: number; quantity: number }[] = [];
  for (const team of TEAMS) {
    for (const r of kitItems) {
      const key = `${team}:${r.estId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ team, stock_item_id: r.estId!, quantity: r.qty });
    }
  }
  const res = await prisma.embarkKitItem.createMany({ data: rows, skipDuplicates: true });
  console.log(`✅ Kit gravado: ${res.count} linhas (${kitItems.length} itens × ${TEAMS.length} equipes).\n`);
}

// O Postgres da Railway anda instável (cai e volta). Como tudo aqui é
// idempotente (--force regrava o kit; itens novos são reusados pelo nome),
// repetimos main() inteiro até conectar, reaproveitando a mesma conexão.
async function runWithRetry() {
  const maxAttempts = 40;
  for (let i = 1; i <= maxAttempts; i++) {
    try { await main(); return; }
    catch (e: any) {
      const msg = String(e?.message || e);
      const transient = /can't reach|reach database|ECONNREFUSED|ETIMEDOUT|Closed|connection|pool/i.test(msg);
      if (!transient || i === maxAttempts) throw e;
      console.log(`tentativa ${i}/${maxAttempts} — DB indisponível, aguardando 10s...`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}
runWithRetry().catch((e) => { console.error("ERRO:", e); process.exit(1); }).finally(() => prisma.$disconnect());
