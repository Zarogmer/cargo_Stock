/**
 * Importa a "Demonstração Financeira <ano> - CARGOSHIPS.xlsx" (fonte oficial da
 * diretoria) pra tabela financial_statement_entries, que alimenta a aba
 * Financeiro › Demonstração Financeira.
 *
 *   npx tsx scripts/import-demonstracao-financeira.ts                 # dry-run 2026
 *   npx tsx scripts/import-demonstracao-financeira.ts --commit        # grava (PROD)
 *   npx tsx scripts/import-demonstracao-financeira.ts --year=2025 --commit
 *   npx tsx scripts/import-demonstracao-financeira.ts --file=C:/outro.xlsx --commit
 *
 * A planilha continua sendo a fonte: a aba é só leitura e reimportar é a forma
 * de atualizar. Idempotente — apaga e regrava o ANO INTEIRO a cada --commit.
 *
 * Escreve em PRODUÇÃO (DATABASE_URL aponta pro Postgres do Railway). O dry-run
 * imprime o resumo e a conferência de totais; rode ele antes.
 *
 * Conferência: cada bloco da planilha tem uma linha "TOTAIS" (linha 7) que o
 * script compara com a soma do que leu. Divergência não impede o import, mas
 * aparece no resumo — é o sinal de que a planilha mudou de formato.
 */
import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import * as fs from "node:fs";
import {
  STATEMENT_SECTIONS, SHEET_MONTHS, FIRST_DATA_ROW, TOTALS_ROW, SECTION_TITLE_ROW,
} from "../src/lib/demonstracao-financeira";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");

const yearArg = process.argv.find((a) => a.startsWith("--year="));
const YEAR = yearArg ? Number(yearArg.split("=")[1]) : 2026;

const fileArg = process.argv.find((a) => a.startsWith("--file="));
const FILE = fileArg
  ? fileArg.slice("--file=".length)
  : `C:/Users/Guilherme/CARGO SHIPS CLEANING LTDA/SERVIDOR - Documentos/2 -DIRETORIA/05 - DEMONSTRATIVO FINANCEIRO/Demonstração Financeira ${YEAR} - CARGOSHIPS.xlsx`;

interface Entry {
  year: number;
  month: number;
  section: string;
  entry_date: Date | null;
  description: string;
  value: number;
  source_row: number;
}

/** Compara títulos ignorando acento, caixa e espaço sobrando. */
function norm(s: unknown) {
  return String(s ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/\s+/g, " ").trim();
}

/**
 * Célula pelo endereço A1. A planilha tem buracos, então célula ausente é
 * normal — devolve undefined em vez de estourar.
 */
function cell(ws: XLSX.WorkSheet, row: number, col: number): XLSX.CellObject | undefined {
  return ws[XLSX.utils.encode_cell({ r: row - 1, c: col - 1 })];
}

function cellValue(ws: XLSX.WorkSheet, row: number, col: number): unknown {
  return cell(ws, row, col)?.v;
}

/**
 * Valor numérico da célula. Só aceita número: a planilha nunca traz valor como
 * texto (conferido nas 12 abas), então texto aqui é sinal de mudança de formato
 * e é melhor ignorar do que importar lixo.
 */
function numberAt(ws: XLSX.WorkSheet, row: number, col: number): number | null {
  const v = cellValue(ws, row, col);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/**
 * Data da célula. Com cellDates:true o xlsx devolve Date; a planilha também tem
 * muita linha sem data (conta recorrente), e isso é esperado.
 */
function dateAt(ws: XLSX.WorkSheet, row: number, col: number): Date | null {
  const v = cellValue(ws, row, col);
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // A célula vem como data local; grava só o dia (coluna DATE), sem fuso.
    return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  }
  return null;
}

function textAt(ws: XLSX.WorkSheet, row: number, col: number): string {
  const v = cellValue(ws, row, col);
  if (v == null) return "";
  return String(v).replace(/\s+/g, " ").trim();
}

function fmt(n: number) {
  return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  if (!fs.existsSync(FILE)) {
    console.error(`❌ Planilha não encontrada:\n   ${FILE}`);
    process.exit(1);
  }
  console.log(`📄 ${FILE}`);
  console.log(`📅 Ano: ${YEAR}${COMMIT ? "" : "   (dry-run — nada é gravado)"}\n`);

  const wb = XLSX.readFile(FILE, { cellDates: true });

  const entries: Entry[] = [];
  const warnings: string[] = [];

  for (const [idx, sheetName] of SHEET_MONTHS.entries()) {
    const month = idx + 1;
    const ws = wb.Sheets[sheetName];
    if (!ws) {
      warnings.push(`aba "${sheetName}" não existe na planilha`);
      continue;
    }
    // Até onde varrer. A planilha tem linhas em branco no meio dos blocos, então
    // não dá pra parar na primeira vazia — vai até o fim da aba.
    const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
    const lastRow = range.e.r + 1;

    for (const sec of STATEMENT_SECTIONS) {
      // Confere que o bloco ainda está onde esperamos. Se o título mudou de
      // lugar, importar seria pior que falhar calado.
      const title = norm(cellValue(ws, SECTION_TITLE_ROW, sec.titleCol));
      if (title !== norm(sec.label)) {
        warnings.push(
          `${sheetName} · seção ${sec.key}: título esperado "${sec.label}", encontrado "${title || "(vazio)"}" — bloco ignorado`,
        );
        continue;
      }

      let sum = 0;
      for (let row = FIRST_DATA_ROW; row <= lastRow; row++) {
        const value = numberAt(ws, row, sec.valueCol);
        // Sem valor não é lançamento: ou é linha vazia, ou (nos blocos da Folha)
        // é uma linha que só preenche outra coluna de valor.
        if (value == null) continue;
        const description = textAt(ws, row, sec.descCol);
        if (!description) {
          warnings.push(`${sheetName} · seção ${sec.key} · linha ${row}: valor ${fmt(value)} sem descrição — importado assim mesmo`);
        }
        entries.push({
          year: YEAR,
          month,
          section: sec.key,
          entry_date: dateAt(ws, row, sec.dateCol),
          description: description || "(sem descrição)",
          value,
          source_row: row,
        });
        sum += value;
      }

      // Conferência contra o TOTAIS da própria planilha (tolerância de 1 centavo
      // pra absorver arredondamento de float).
      const declared = numberAt(ws, TOTALS_ROW, sec.valueCol);
      if (declared != null && Math.abs(declared - sum) > 0.01) {
        warnings.push(
          `${sheetName} · seção ${sec.key}: TOTAIS da planilha = ${fmt(declared)}, soma do que li = ${fmt(sum)} (dif ${fmt(declared - sum)})`,
        );
      }
    }
  }

  // Resumo por seção.
  console.log("Lançamentos lidos por seção:");
  for (const sec of STATEMENT_SECTIONS) {
    const rows = entries.filter((e) => e.section === sec.key);
    const total = rows.reduce((s, e) => s + e.value, 0);
    console.log(`  ${sec.key.padEnd(4)} ${sec.shortLabel.padEnd(28)} ${String(rows.length).padStart(4)} linhas   R$ ${fmt(total).padStart(14)}`);
  }
  const grand = entries.reduce((s, e) => s + e.value, 0);
  console.log(`  ${"".padEnd(33)} ${String(entries.length).padStart(4)} linhas   R$ ${fmt(grand).padStart(14)}\n`);

  if (warnings.length) {
    console.log(`⚠️  ${warnings.length} aviso(s):`);
    for (const w of warnings) console.log(`   - ${w}`);
    console.log("");
  } else {
    console.log("✅ Totais conferem com a linha TOTAIS de todos os blocos.\n");
  }

  if (!COMMIT) {
    console.log("Dry-run: nada gravado. Rode com --commit pra importar.");
    return;
  }

  // Regrava o ano inteiro: é o que torna a reimportação idempotente e faz
  // sumir o que foi apagado da planilha.
  const deleted = await prisma.financialStatementEntry.deleteMany({ where: { year: YEAR } });
  await prisma.financialStatementEntry.createMany({
    data: entries.map((e) => ({ ...e, imported_by: "import-demonstracao-financeira" })),
  });
  console.log(`✅ ${YEAR}: ${deleted.count} linha(s) antiga(s) removida(s), ${entries.length} importada(s).`);
}

main()
  .catch((err) => {
    console.error("❌ Erro:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
