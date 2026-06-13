/**
 * Diagnóstico SOMENTE-LEITURA: compara a planilha oficial do RH com a base do
 * sistema (tabela employees) pra descobrir quem está faltando de cada lado.
 * NÃO grava nada — só lê a planilha e consulta o banco.
 *
 * Uso:  npx tsx scripts/compare-employees.ts "<caminho-do-xlsx>"
 *
 * Casa por CPF (só dígitos), igual ao import-employees.ts. Também faz um
 * cruzamento por NOME nos que sobram, pra pegar caso de CPF digitado errado.
 */

import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import * as fs from "node:fs";

const prisma = new PrismaClient();

function s(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t.length > 0 ? t : null;
}
function cleanCpf(v: unknown): string | null {
  const raw = s(v);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}
function normName(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}
function fmtCpf(d: string | null): string {
  if (!d) return "(sem CPF)";
  if (d.length !== 11) return d;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}
function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

interface Person {
  name: string;
  cpf: string | null;
  status: "ATIVO" | "INATIVO";
  admission: Date | null;
}

function parseSheet(path: string): { people: Person[]; noCpf: Person[] } {
  const wb = XLSX.readFile(path, { cellDates: true });
  const sheet = wb.Sheets["FUNCIONARIOS"];
  if (!sheet) throw new Error("Aba 'FUNCIONARIOS' não encontrada na planilha.");
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { range: 1, defval: null });
  const rows = rawRows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[k.replace(/\s+/g, " ").trim()] = v;
    return out;
  });

  const people: Person[] = [];
  const noCpf: Person[] = [];
  for (const row of rows) {
    const name = s(row.FUNCIONARIOS as string);
    if (!name) continue;
    const cpf = cleanCpf(row.CPF);
    const bank = String(row.BANCO ?? "").toLowerCase();
    const aso = String(row.ASO ?? "").toLowerCase();
    const limpeza = String(row["REALIZA LIMPEZA"] ?? "").toLowerCase();
    const inactive =
      bank.includes("inativo") || aso === "inativo" || limpeza === "inativo" ||
      s(row.STAUTS as string)?.toUpperCase() === "INATIVO";
    const admRaw = row["Data de admissão"];
    const admission = admRaw instanceof Date ? admRaw : null;
    const p: Person = { name, cpf, status: inactive ? "INATIVO" : "ATIVO", admission };
    if (cpf) people.push(p);
    else noCpf.push(p);
  }
  return { people, noCpf };
}

async function main() {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error('Uso: npx tsx scripts/compare-employees.ts "<caminho-do-xlsx>"');
    process.exit(1);
  }
  if (!fs.existsSync(xlsxPath)) {
    console.error(`Arquivo não encontrado: ${xlsxPath}`);
    process.exit(1);
  }

  const { people: sheet, noCpf } = parseSheet(xlsxPath);
  const db = await prisma.employee.findMany({
    select: { name: true, cpf: true, status: true, admission_date: true },
    orderBy: { name: "asc" },
  });

  const sheetByCpf = new Map(sheet.map((p) => [p.cpf!, p]));
  const dbByCpf = new Map(db.filter((e) => e.cpf).map((e) => [e.cpf!.replace(/\D/g, ""), e]));
  const dbByName = new Map(db.map((e) => [normName(e.name), e]));
  const sheetByName = new Map(sheet.map((p) => [normName(p.name), p]));

  // Só na planilha (por CPF). Tenta achar por nome no sistema → possível CPF divergente.
  const onlyInSheet: { p: Person; nameMatch: boolean }[] = [];
  for (const p of sheet) {
    if (!dbByCpf.has(p.cpf!)) {
      onlyInSheet.push({ p, nameMatch: dbByName.has(normName(p.name)) });
    }
  }
  // Só no sistema (por CPF).
  const onlyInSystem: { e: (typeof db)[number]; nameMatch: boolean }[] = [];
  for (const e of db) {
    const cpfDigits = (e.cpf || "").replace(/\D/g, "");
    if (!cpfDigits || !sheetByCpf.has(cpfDigits)) {
      onlyInSystem.push({ e, nameMatch: sheetByName.has(normName(e.name)) });
    }
  }
  // Mesmo CPF, status diferente.
  const statusDiff: { name: string; cpf: string; sheet: string; system: string }[] = [];
  for (const [cpf, p] of sheetByCpf) {
    const e = dbByCpf.get(cpf);
    if (e && e.status !== p.status) {
      statusDiff.push({ name: p.name, cpf, sheet: p.status, system: e.status ?? "(sem status)" });
    }
  }

  const line = "─".repeat(70);
  console.log(`\n${line}`);
  console.log(`RESUMO`);
  console.log(line);
  console.log(`  Planilha (com CPF):      ${sheet.length}`);
  console.log(`  Planilha (SEM CPF):      ${noCpf.length}`);
  console.log(`  Sistema (total):         ${db.length}`);
  console.log(`  Só na planilha:          ${onlyInSheet.length}`);
  console.log(`  Só no sistema:           ${onlyInSystem.length}`);
  console.log(`  CPF igual, status difere:${statusDiff.length}`);

  console.log(`\n${line}`);
  console.log(`SÓ NA PLANILHA — não estão no sistema (${onlyInSheet.length})`);
  console.log(line);
  onlyInSheet
    .sort((a, b) => a.p.name.localeCompare(b.p.name, "pt-BR"))
    .forEach(({ p, nameMatch }) =>
      console.log(
        `  ${p.name}  [${fmtCpf(p.cpf)}]  ${p.status}  adm:${fmtDate(p.admission)}` +
          (nameMatch ? "  ⚠️ nome existe no sistema com OUTRO CPF" : ""),
      ),
    );

  console.log(`\n${line}`);
  console.log(`SÓ NO SISTEMA — não estão na planilha (${onlyInSystem.length})`);
  console.log(line);
  onlyInSystem
    .sort((a, b) => a.e.name.localeCompare(b.e.name, "pt-BR"))
    .forEach(({ e, nameMatch }) =>
      console.log(
        `  ${e.name}  [${fmtCpf((e.cpf || "").replace(/\D/g, "") || null)}]  ${e.status}  adm:${fmtDate(e.admission_date)}` +
          (nameMatch ? "  ⚠️ nome existe na planilha com OUTRO CPF" : ""),
      ),
    );

  if (statusDiff.length) {
    console.log(`\n${line}`);
    console.log(`STATUS DIVERGENTE — mesmo CPF, situação diferente (${statusDiff.length})`);
    console.log(line);
    statusDiff
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .forEach((d) => console.log(`  ${d.name}  [${fmtCpf(d.cpf)}]  planilha=${d.sheet}  sistema=${d.system}`));
  }

  if (noCpf.length) {
    console.log(`\n${line}`);
    console.log(`PLANILHA SEM CPF — não dá pra casar (${noCpf.length})`);
    console.log(line);
    noCpf
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .forEach((p) => console.log(`  ${p.name}  ${p.status}`));
  }

  console.log("");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
