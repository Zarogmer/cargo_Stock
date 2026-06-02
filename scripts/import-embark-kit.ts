/**
 * Monta o "kit de embarque" por equipe (tabela embark_kit_items) a partir do
 * Check List.xlsx, ligando cada item ao material do Estoque (stock_items,
 * team=GALPAO). A Equipe 2 é cópia da Equipe 1 (a planilha veio sem qtd na 2).
 *
 * Casamento: matcher por nome normalizado (>= 0.85) + OVERRIDES p/ os itens
 * com nome torto/grudado que o usuário confirmou. Itens sem par são ignorados
 * (não deduzem nada). Cria a tabela via SQL aditivo (não roda db push).
 *
 *   npx tsx scripts/import-embark-kit.ts            # dry-run
 *   npx tsx scripts/import-embark-kit.ts --commit   # cria tabela + grava (PROD)
 *   npx tsx scripts/import-embark-kit.ts --commit --force  # apaga kit e regrava
 */
import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import * as fs from "node:fs";

const prisma = new PrismaClient();
const FILE = "C:/Users/Guilherme/CARGO SHIPS CLEANING LTDA/SERVIDOR - Documentos/CARGO - PLANILHAS/Check List.xlsx";
const TEAMS = ["EQUIPE_1", "EQUIPE_2"];

// Check List (nome) -> Estoque (nome exato). Itens que o matcher não pega
// sozinho (nome torto/grudado), confirmados pelo usuário.
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
    [" DESENGRIPANTE ", " DESINGRIPANTE "], [" EMEN ", " EMENDA "],
    [" CONC ", " CONEXAO "],
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

async function main() {
  const commit = process.argv.includes("--commit");
  const force = process.argv.includes("--force");

  const cl = parseEq1();
  const est = (await prisma.stockItem.findMany({ where: { team: "GALPAO" }, select: { id: true, name: true } }))
    .map((e) => ({ ...e, n: expand(norm(e.name)) }));
  const byNorm = new Map(est.map((e) => [norm(e.name), e]));

  const kit: { name: string; estName: string; estId: number; qty: number }[] = [];
  const skipped: { name: string; qty: number }[] = [];

  for (const item of cl) {
    const ovr = OVERRIDES[item.name];
    if (ovr) {
      const e = byNorm.get(norm(ovr));
      if (e) { kit.push({ name: item.name, estName: e.name, estId: e.id, qty: item.qty }); continue; }
      skipped.push({ name: `${item.name} (override "${ovr}" não achado!)`, qty: item.qty }); continue;
    }
    const cn = expand(norm(item.name));
    let best: typeof est[number] | null = null, bs = 0;
    for (const e of est) { const sc = score(cn, e.n); if (sc > bs) { bs = sc; best = e; } }
    if (best && bs >= 0.85) kit.push({ name: item.name, estName: best.name, estId: best.id, qty: item.qty });
    else skipped.push(item);
  }

  console.log(`\nKit Equipe 1: ${kit.length} casados | ${skipped.length} ignorados (sem par)`);
  console.log("\n== KIT (vai deduzir do Estoque) ==");
  kit.forEach((k) => console.log(`  [${String(k.qty).padStart(3)}] ${k.name.padEnd(22)} -> ${k.estName} (#${k.estId})`));
  console.log("\n== IGNORADOS (não deduz) ==");
  skipped.forEach((s) => console.log(`  [${String(s.qty).padStart(3)}] ${s.name}`));

  if (!commit) { console.log("\n— DRY RUN — use --commit pra criar a tabela e gravar.\n"); return; }

  // Cria a tabela só se não existir (aditivo, não destrutivo).
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

  const existing = await prisma.embarkKitItem.count();
  if (existing > 0 && !force) {
    console.log(`\n⚠️  Já existem ${existing} itens no kit. Use --force pra apagar e regravar. Abortado.`);
    return;
  }
  if (existing > 0 && force) {
    const del = await prisma.embarkKitItem.deleteMany({});
    console.log(`\n🗑️  Removidos ${del.count} itens de kit antigos.`);
  }

  const rows = TEAMS.flatMap((team) => kit.map((k) => ({ team, stock_item_id: k.estId, quantity: k.qty })));
  const res = await prisma.embarkKitItem.createMany({ data: rows });
  console.log(`\n✅ Kit gravado: ${res.count} linhas (${kit.length} itens × ${TEAMS.length} equipes).\n`);
}

main().catch((e) => { console.error("ERRO:", e); process.exit(1); }).finally(() => prisma.$disconnect());
