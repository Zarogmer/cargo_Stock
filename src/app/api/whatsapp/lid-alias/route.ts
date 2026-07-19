import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { formatPhone } from "@/lib/utils";

const ALLOWED_ROLES = ["RH", "TECNOLOGIA", "ESTAGIO", "GESTOR", "EXECUTIVO", "COMERCIAL", "FINANCEIRO"];

function onlyDigits(s: string | null | undefined): string {
  return (s || "").replace(/\D/g, "");
}

// "(13) 99674-4755" a partir de dígitos, tirando o 55 do país quando presente.
function prettyPhone(digits: string): string {
  const local = digits.length >= 12 && digits.startsWith("55") ? digits.slice(2) : digits;
  return formatPhone(local);
}

// Mapa telefone(dígitos) -> nome do colaborador, com variantes com/sem 55 (BR).
async function buildEmpByPhone(): Promise<Map<string, string>> {
  const emps = await prisma.employee.findMany({
    where: { phone: { not: null } },
    select: { name: true, phone: true },
  });
  const map = new Map<string, string>();
  for (const e of emps) {
    const d = onlyDigits(e.phone);
    if (!d) continue;
    if (!map.has(d)) map.set(d, e.name);
    const alt = d.startsWith("55") ? d.slice(2) : `55${d}`;
    if (!map.has(alt)) map.set(alt, e.name);
  }
  return map;
}

// Nome de exibição de um alias: nome do colaborador (casando pelo telefone) ou,
// não havendo cadastro, o telefone formatado. Sem telefone -> null.
function resolveName(phone: string | null, empByPhone: Map<string, string>): string | null {
  const d = onlyDigits(phone);
  if (!d) return null;
  const alt = d.startsWith("55") ? d.slice(2) : `55${d}`;
  return empByPhone.get(d) || empByPhone.get(alt) || prettyPhone(d);
}

// GET /api/whatsapp/lid-alias
// Devolve { aliases: { [lidDigits]: { phone, name } } } pra UI resolver os LIDs.
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const [aliases, empByPhone] = await Promise.all([
      prisma.whatsappLidAlias.findMany(),
      buildEmpByPhone(),
    ]);
    const map: Record<string, { phone: string | null; name: string | null }> = {};
    for (const a of aliases) {
      map[a.lid] = { phone: a.phone, name: resolveName(a.phone, empByPhone) };
    }
    return NextResponse.json({ aliases: map });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// POST /api/whatsapp/lid-alias  body: { lid, phone }
// Vincula um LID a um telefone. phone vazio remove o vínculo (volta a "Participante #…").
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!ALLOWED_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { lid?: string; phone?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const lid = onlyDigits(body.lid);
  if (!lid) return NextResponse.json({ error: "Participante inválido" }, { status: 400 });

  let phone = onlyDigits(body.phone);
  if (phone) {
    if (phone.length < 10) return NextResponse.json({ error: "Telefone inválido (faltam dígitos)" }, { status: 400 });
    // Completa o 55 (BR) quando vier só com DDD + número.
    if (!phone.startsWith("55") && phone.length <= 11) phone = `55${phone}`;
  }

  const actor = session.user.name || session.user.email || "Sistema";
  try {
    await prisma.whatsappLidAlias.upsert({
      where: { lid },
      update: { phone: phone || null },
      create: { lid, phone: phone || null, created_by: actor },
    });
    const empByPhone = await buildEmpByPhone();
    return NextResponse.json({ ok: true, lid, phone: phone || null, name: resolveName(phone || null, empByPhone) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
