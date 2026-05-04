/**
 * One-shot importer for the official employee spreadsheet
 * (Func_Listagem_Oficial_2026.xlsx).
 *
 * Run with:  npx tsx scripts/import-employees.ts <path-to-xlsx>
 *
 * Idempotent: upserts by CPF. Re-running with the same file is safe.
 *
 * Data cleanups applied:
 *   - CPF: strips trailing ";"
 *   - Bank: "SANTADER" -> "SANTANDER"; case-normalized
 *   - Status: detected from "BANCO=inativo" sentinel rows
 *   - Account type: "corrente" -> "CORRENTE", "poupança" -> "POUPANCA"
 *   - Realiza limpeza: SIM/sim -> true, NÃO -> false, others -> null
 */

import { PrismaClient } from "@prisma/client";
import * as XLSX from "xlsx";
import * as fs from "node:fs";

const prisma = new PrismaClient();

// Keys here match the spreadsheet header text after whitespace normalization.
interface SheetRow {
  Subestipulante?: string | number;
  "Módulo"?: string | number;
  "E SOCIAL"?: string | number;
  STAUTS?: string;
  FUNCIONARIOS?: string;
  CPF?: string;
  RG?: string;
  "ISPS CODE"?: string | number;
  "Data de nascimento"?: string | Date | number;
  "Data de admissão"?: string | Date | number;
  AGENCIA?: string | number;
  CONTA?: string;
  BANCO?: string;
  "PP/CC/CS"?: string;
  TELEFONE?: string;
  "MEIO AMBIENTE"?: string;
  "NRS 1,6,7,17,29,35"?: string;
  "SALVA VIDAS"?: string;
  "BOTA BORRACHA"?: string;
  "N º BOTA"?: string | number;
  "N º BLUSA"?: string;
  BERMUDA?: string | number;
  "ULTIMO ASO"?: string;
  ASO?: string;
  "REALIZA LIMPEZA"?: string;
  __EMPTY?: string; // unnamed column (function/role)
  SETOR?: string;
}

function s(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t.length > 0 ? t : null;
}

function n(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const x = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(x) ? x : null;
}

function cleanCpf(v: unknown): string | null {
  const raw = s(v);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

function cleanBank(v: unknown): string | null {
  const raw = s(v);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper.includes("INATIVO") || upper === "PENDENCIA" || upper === "BANCO") {
    return null;
  }
  if (upper === "SANTADER") return "SANTANDER";
  return upper;
}

function mapAccountType(
  v: unknown
): "CORRENTE" | "POUPANCA" | "CONTA_SAL" | "DIGITAL" | null {
  const raw = s(v);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("poupan")) return "POUPANCA";
  if (lower.includes("corrente")) return "CORRENTE";
  if (lower.includes("salár") || lower.includes("salar")) return "CONTA_SAL";
  if (lower.includes("digital")) return "DIGITAL";
  return null;
}

function detectInactive(row: SheetRow): boolean {
  const bank = String(row.BANCO ?? "").toLowerCase();
  const aso = String(row.ASO ?? "").toLowerCase();
  const limpeza = String(row["REALIZA LIMPEZA"] ?? "").toLowerCase();
  return (
    bank.includes("inativo") ||
    aso === "inativo" ||
    limpeza === "inativo"
  );
}

function asBool(v: unknown): boolean {
  const raw = s(v);
  if (!raw) return false;
  const upper = raw.toUpperCase();
  return upper === "OK" || upper === "SIM" || upper === "X";
}

function asLimpezaBool(v: unknown): boolean | null {
  const raw = s(v);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === "SIM") return true;
  if (upper === "NÃO" || upper === "NAO") return false;
  return null;
}

function parseExcelDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return v;
  if (typeof v === "number") {
    // xlsx already handles cellDates; this is a fallback (Excel epoch).
    const epoch = Date.UTC(1899, 11, 30);
    return new Date(epoch + v * 86400000);
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

async function main() {
  const xlsxPath = process.argv[2];
  if (!xlsxPath) {
    console.error("Usage: npx tsx scripts/import-employees.ts <path-to-xlsx>");
    process.exit(1);
  }
  if (!fs.existsSync(xlsxPath)) {
    console.error(`File not found: ${xlsxPath}`);
    process.exit(1);
  }

  const wb = XLSX.readFile(xlsxPath, { cellDates: true });
  const sheet = wb.Sheets["FUNCIONARIOS"];
  if (!sheet) {
    console.error("Sheet 'FUNCIONARIOS' not found");
    process.exit(1);
  }

  // header row is the second row in the file
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    range: 1,
    defval: null,
  });

  // Normalize keys: collapse whitespace runs to single spaces, trim ends.
  const rows = rawRows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      out[k.replace(/\s+/g, " ").trim()] = v;
    }
    return out as unknown as SheetRow;
  });

  console.log(`Read ${rows.length} rows from spreadsheet.`);

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const name = s(row.FUNCIONARIOS);
    if (!name) {
      skipped++;
      continue;
    }

    const cpf = cleanCpf(row.CPF);
    if (!cpf) {
      // Without CPF we can't dedupe — skip with warning.
      console.warn(`SKIP (no CPF): ${name}`);
      skipped++;
      continue;
    }

    const inactive = detectInactive(row);
    const status: "ATIVO" | "INATIVO" =
      inactive || s(row.STAUTS)?.toUpperCase() === "INATIVO" ? "INATIVO" : "ATIVO";

    const role = s(row.__EMPTY) || s(row["REALIZA LIMPEZA"] as string)?.match(/^(WAP|AJUDANTE|ESFREG.O|ANALISTA.*|OPERACIONAL)$/i)?.[0] || null;

    const data = {
      name,
      cpf,
      rg: s(row.RG)?.replace(/[;]/g, "") ?? null,
      isps_code: s(row["ISPS CODE"]),
      e_social: s(row["E SOCIAL"]),
      subestipulante: n(row.Subestipulante),
      modulo: n(row["Módulo"]),
      status,
      sector: s(row.SETOR)?.toUpperCase() ?? null,
      role: role ? role.toUpperCase().replace(/Ã/g, "A").replace(/[^A-Z0-9_ ]/g, "").trim() : null,
      birth_date: parseExcelDate(row["Data de nascimento"]),
      admission_date: parseExcelDate(row["Data de admissão"]),
      phone: s(row.TELEFONE),
      bank_name: cleanBank(row.BANCO),
      bank_agency: inactive ? null : s(row.AGENCIA)?.replace(/^inativo$/i, "") || null,
      bank_account: inactive ? null : s(row.CONTA)?.replace(/^inativo$/i, "") || null,
      bank_account_type: mapAccountType(row["PP/CC/CS"]),
      nrs_training: s(row["NRS 1,6,7,17,29,35"]),
      meio_ambiente_training: s(row["MEIO AMBIENTE"]),
      lifeguard_training: asBool(row["SALVA VIDAS"]),
      rubber_boot: asBool(row["BOTA BORRACHA"]),
      boot_size: s(row["N º BOTA"]),
      shirt_size: s(row["N º BLUSA"]),
      bermuda_size: s(row.BERMUDA),
      last_aso_date: s(row["ULTIMO ASO"]),
      aso_status: s(row.ASO)?.toUpperCase() === "0K" ? "OK" : s(row.ASO)?.toUpperCase() ?? null,
      realiza_limpeza: asLimpezaBool(row["REALIZA LIMPEZA"]),
      updated_by: "import-script",
    };

    try {
      const existing = await prisma.employee.findUnique({ where: { cpf } });
      if (existing) {
        await prisma.employee.update({ where: { cpf }, data });
        updated++;
      } else {
        await prisma.employee.create({ data });
        created++;
      }
    } catch (err) {
      errors.push(`${name} (CPF ${cpf}): ${(err as Error).message}`);
    }
  }

  console.log(`\n— Import summary —`);
  console.log(`  Created: ${created}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors:  ${errors.length}`);
  if (errors.length > 0) {
    console.log(`\nErrors:`);
    for (const e of errors) console.log(`  - ${e}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
