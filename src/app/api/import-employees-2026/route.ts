import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import employeesData from "@/data/employees-2026.json";

// One-shot import endpoint for the 2026 employee listing.
// Auth: must be logged in as TECNOLOGIA. Upserts by CPF (falls back to name).
// Safe to re-run.

interface EmployeeInput {
  subestipulante: number | null;
  modulo: number | null;
  e_social: string | null;
  status: string;
  name: string;
  cpf: string | null;
  rg: string | null;
  isps_code: string | null;
  birth_date: string | null;
  admission_date: string | null;
  bank_agency: string | null;
  bank_account: string | null;
  bank_name: string | null;
  bank_account_type: string | null;
  phone: string | null;
  meio_ambiente_training: string | null;
  nrs_training: string | null;
  team: string | null;
  lifeguard_training: boolean;
  rubber_boot: boolean;
  boot_size: string | null;
  shirt_size: string | null;
  bermuda_size: string | null;
  last_aso_date: string | null;
  aso_status: string | null;
  realiza_limpeza: boolean;
  role: string | null;
  sector: string | null;
}

function toDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s + (s.length === 10 ? "T00:00:00" : ""));
  return Number.isNaN(d.getTime()) ? null : d;
}

function payloadFor(e: EmployeeInput, actor: string) {
  return {
    name: e.name.toUpperCase(),
    subestipulante: e.subestipulante,
    modulo: e.modulo,
    e_social: e.e_social,
    status: e.status,
    cpf: e.cpf,
    rg: e.rg,
    isps_code: e.isps_code,
    birth_date: toDate(e.birth_date),
    admission_date: toDate(e.admission_date),
    bank_agency: e.bank_agency,
    bank_account: e.bank_account,
    bank_name: e.bank_name,
    bank_account_type: e.bank_account_type,
    phone: e.phone,
    meio_ambiente_training: e.meio_ambiente_training,
    nrs_training: e.nrs_training,
    team: e.team,
    lifeguard_training: e.lifeguard_training,
    rubber_boot: e.rubber_boot,
    boot_size: e.boot_size,
    shirt_size: e.shirt_size,
    bermuda_size: e.bermuda_size,
    last_aso_date: e.last_aso_date,
    aso_status: e.aso_status,
    realiza_limpeza: e.realiza_limpeza,
    role: e.role,
    sector: e.sector,
    updated_by: actor,
  };
}

export async function POST() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "TECNOLOGIA") {
    return NextResponse.json({ error: "Forbidden — TECNOLOGIA only" }, { status: 403 });
  }

  const actor = session.user.name || "import-2026";
  const data = employeesData as { employees: EmployeeInput[]; executives: EmployeeInput[] };
  const all: EmployeeInput[] = [...data.employees, ...data.executives];

  let created = 0;
  let updated = 0;
  const errors: Array<{ name: string; error: string }> = [];

  for (const e of all) {
    try {
      let existing = null;
      if (e.cpf) {
        existing = await prisma.employee.findFirst({ where: { cpf: e.cpf } });
      }
      if (!existing) {
        existing = await prisma.employee.findFirst({ where: { name: e.name.toUpperCase() } });
      }

      const payload = payloadFor(e, actor);

      if (existing) {
        await prisma.employee.update({ where: { id: existing.id }, data: payload as never });
        updated++;
      } else {
        await prisma.employee.create({ data: payload as never });
        created++;
      }
    } catch (err) {
      errors.push({ name: e.name, error: (err as Error).message });
    }
  }

  return NextResponse.json({
    success: true,
    created,
    updated,
    errors,
    total: all.length,
  });
}
