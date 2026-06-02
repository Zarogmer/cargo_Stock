/**
 * One-shot importer for the warehouse material spreadsheets into the "Estoque"
 * (materiais) tab — stored in `stock_items` with the sentinel team "GALPAO" so
 * they stay isolated from the team-based Rancho (food) and Embarque views.
 *
 *   - Galpão:  LISTA DE MATERIAL (ESTOQUE).xlsx  → sheet "ESTOQUE GALPÃO"
 *   - Cozinha: LISTA DE UTENSÍLIOS PARA COZINHA.xlsx
 *
 * The spreadsheet group (code prefix 40015/50016/... ) becomes the item's
 * `location` (= "Categoria" no painel). `category` fica OUTROS (enum fixo).
 * `quantity` e `default_quantity` recebem o TOTAL da planilha.
 *
 * Run:
 *   npx tsx scripts/import-materials.ts            # dry-run (só imprime)
 *   npx tsx scripts/import-materials.ts --commit   # grava no banco (PRODUÇÃO)
 *   npx tsx scripts/import-materials.ts --commit --force  # apaga GALPAO e re-importa
 *
 * Idempotente: sem --force, aborta se já houver itens GALPAO (evita duplicar).
 */

import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import * as fs from "node:fs";

const prisma = new PrismaClient();

const BASE = "C:/Users/Guilherme/CARGO SHIPS CLEANING LTDA/SERVIDOR - Documentos/CARGO - PLANILHAS";
const GALPAO_FILE = `${BASE}/LISTA DE MATERIAL (ESTOQUE).xlsx`;
const COZINHA_FILE = `${BASE}/LISTA DE UTENSÍLIOS PARA COZINHA.xlsx`;

const TEAM = "GALPAO"; // sentinela: separa materiais do rancho (EQUIPE_1/2/3)

// Código de grupo da planilha (coluna 0) -> rótulo de categoria no painel.
const GROUP_LABELS: Record<string, string> = {
  "40015": "Elétrica",
  "50016": "EPI e Químicos",
  "10012": "Hidrojato",
  "20013": "Pistola e Caneta",
  "30014": "Rodas",
  "60017": "Líquidos",
  "70018": "Ferramentas",
  "70019": "Mangueiras e Conexões",
  "90020": "Varões",
};

interface Material {
  name: string;
  location: string; // grupo/categoria
  quantity: number;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function cleanName(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

function readSheet(file: string, sheetName?: string): unknown[][] {
  const wb = XLSX.read(fs.readFileSync(file), { type: "buffer" });
  const sn = sheetName || wb.SheetNames[0];
  const ws = wb.Sheets[sn];
  if (!ws) throw new Error(`Sheet "${sn}" não encontrada em ${file}`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
}

// ── Galpão ────────────────────────────────────────────────────────────────────
// col0 = código do grupo (carrega pra baixo quando vazio), col1 = subcódigo,
// col2 = nome, col4 = INÍCIO, col6 = TOTAL=, col8 = TOTAL.
function parseGalpao(): Material[] {
  const rows = readSheet(GALPAO_FILE, "ESTOQUE GALPÃO");
  const out: Material[] = [];
  let currentCode = "";
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i];
    const codeCell = num(r[0]);
    if (codeCell !== null) currentCode = String(codeCell);
    const name = cleanName(r[2]);
    if (!name) continue; // linhas separadoras / sub-cabeçalhos (ex.: "LITROS")
    const qty = num(r[8]) ?? num(r[6]) ?? num(r[4]) ?? 0;
    out.push({
      name,
      location: GROUP_LABELS[currentCode] || "Outros",
      quantity: qty,
    });
  }
  return out;
}

// ── Cozinha ───────────────────────────────────────────────────────────────────
// col0 = quantidade, col2 = item. (cabeçalho na linha 0)
function parseCozinha(): Material[] {
  const rows = readSheet(COZINHA_FILE);
  const out: Material[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = cleanName(r[2]);
    if (!name) continue;
    out.push({ name, location: "Cozinha", quantity: num(r[0]) ?? 0 });
  }
  return out;
}

async function main() {
  const commit = process.argv.includes("--commit");
  const force = process.argv.includes("--force");

  const galpao = parseGalpao();
  const cozinha = parseCozinha();
  const all = [...galpao, ...cozinha];

  // Resumo por grupo
  const byGroup = new Map<string, number>();
  for (const m of all) byGroup.set(m.location, (byGroup.get(m.location) || 0) + 1);

  console.log(`\n📦 Materiais lidos: ${all.length} (galpão ${galpao.length} + cozinha ${cozinha.length})`);
  console.log("Por categoria:");
  for (const [g, c] of [...byGroup.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${g.padEnd(22)} ${c}`);
  }

  const existing = await prisma.stockItem.count({ where: { team: TEAM } });
  console.log(`\nItens GALPAO já no banco: ${existing}`);

  if (!commit) {
    console.log("\n— DRY RUN — nada gravado. Use --commit para gravar.\n");
    const sample = process.argv.includes("--all") ? all : all.slice(0, 8);
    sample.forEach((m) => console.log(`  [${m.location}] ${m.name} = ${m.quantity}`));
    return;
  }

  if (existing > 0 && !force) {
    console.log("\n⚠️  Já existem itens GALPAO. Use --force pra apagar e re-importar. Abortado.");
    return;
  }

  if (existing > 0 && force) {
    const del = await prisma.stockItem.deleteMany({ where: { team: TEAM } });
    console.log(`\n🗑️  Removidos ${del.count} itens GALPAO antigos.`);
  }

  const res = await prisma.stockItem.createMany({
    data: all.map((m) => ({
      name: m.name,
      category: "OUTROS" as const,
      location: m.location,
      quantity: m.quantity,
      default_quantity: m.quantity,
      min_quantity: 0,
      team: TEAM,
      updated_by: "Importação (planilha)",
    })),
  });
  console.log(`\n✅ Inseridos ${res.count} materiais no Estoque (team=${TEAM}).\n`);
}

main()
  .catch((e) => {
    console.error("ERRO:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
