import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { calcFiscalNoteTotals } from "@/lib/fiscal-note";
import type { Role } from "@/types/database";

// Notas de Débito / Crédito emitidas pelo Pagamento de Navios.
//
//   GET  /api/financeiro/notas?job_id=…   → notas do navio + próximo número do ano
//   POST /api/financeiro/notas            → emite a nota
//
// Roda no servidor pra garantir a numeração corrida por ano sem corrida entre
// dois usuários: o próximo número sai de um MAX() dentro da transação, e o
// índice único (kind, number, year) barra a duplicata que escapar.

function currentYear(): number {
  return new Date().getFullYear();
}

async function nextNumber(kind: string, year: number): Promise<number> {
  const last = await prisma.fiscalNote.findFirst({
    where: { kind, year },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  return (last?.number || 0) + 1;
}

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = session.user.role as Role;
  if (!hasPermission(role, "FINANCEIRO_MOD", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const jobId = request.nextUrl.searchParams.get("job_id");
  const year = Number(request.nextUrl.searchParams.get("year")) || currentYear();

  const notes = jobId
    ? await prisma.fiscalNote.findMany({
        where: { job_id: jobId },
        include: { items: { orderBy: { position: "asc" } } },
        orderBy: [{ year: "desc" }, { number: "desc" }],
      })
    : [];

  return NextResponse.json({
    notes,
    year,
    nextDebito: await nextNumber("DEBITO", year),
    nextCredito: await nextNumber("CREDITO", year),
  });
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = session.user.role as Role;
  // Emitir nota é ato de faturamento: mesma régua de editar o Financeiro.
  if (!hasPermission(role, "FINANCEIRO_MOD", "edit") && !hasPermission(role, "FINANCEIRO_MOD", "create")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const actor = session.user.name || session.user.email || "Sistema";

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Payload inválido" }, { status: 400 });

  const kind = body.kind === "CREDITO" ? "CREDITO" : "DEBITO";
  const year = Number(body.year) || currentYear();
  const items = Array.isArray(body.items) ? body.items : [];
  const cleanItems = items
    .map((it: Record<string, unknown>, i: number) => ({
      position: Number(it.position) || i + 1,
      description: String(it.description || "").trim(),
      unit_value: it.unit_value != null && it.unit_value !== "" ? new Prisma.Decimal(Number(it.unit_value).toFixed(2)) : null,
      quantity: it.quantity != null && it.quantity !== "" ? new Prisma.Decimal(Number(it.quantity).toFixed(2)) : null,
      amount: new Prisma.Decimal(Number(it.amount || 0).toFixed(2)),
    }))
    .filter((it: { description: string }) => it.description);
  if (cleanItems.length === 0) {
    return NextResponse.json({ error: "A nota precisa de pelo menos um item com descrição." }, { status: 400 });
  }
  if (!String(body.ship_name || "").trim()) {
    return NextResponse.json({ error: "Navio é obrigatório." }, { status: 400 });
  }
  if (!String(body.issue_date || "").trim()) {
    return NextResponse.json({ error: "Data de emissão é obrigatória." }, { status: 400 });
  }

  const issPercent = body.iss_percent != null && body.iss_percent !== "" ? Number(body.iss_percent) : null;
  const totals = calcFiscalNoteTotals(
    cleanItems.map((it: { amount: Prisma.Decimal }) => ({ amount: Number(it.amount) })),
    issPercent,
  );

  const number = Number(body.number) > 0 ? Number(body.number) : await nextNumber(kind, year);
  const date = (v: unknown) => {
    const s = String(v || "").slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null;
  };

  try {
    const note = await prisma.fiscalNote.create({
      data: {
        kind,
        number,
        year,
        job_id: body.job_id || null,
        ship_name: String(body.ship_name).trim(),
        client_name: String(body.client_name || "").trim(),
        client_legal_name: body.client_legal_name || null,
        client_address: body.client_address || null,
        client_cnpj: body.client_cnpj || null,
        client_ie: body.client_ie || null,
        client_municipal: body.client_municipal || null,
        header_line: body.header_line || null,
        language: body.language === "EN" ? "EN" : "PT",
        oi: body.oi || null,
        port: body.port || null,
        arrival_date: date(body.arrival_date),
        departure_date: date(body.departure_date),
        issue_date: date(body.issue_date)!,
        due_date: date(body.due_date),
        currency: body.currency === "USD" ? "USD" : "BRL",
        exchange_rate: body.exchange_rate ? new Prisma.Decimal(Number(body.exchange_rate).toFixed(4)) : null,
        iss_percent: issPercent != null ? new Prisma.Decimal(issPercent.toFixed(4)) : null,
        iss_value: issPercent != null ? new Prisma.Decimal(totals.issValue.toFixed(2)) : null,
        subtotal: new Prisma.Decimal(totals.subtotal.toFixed(2)),
        total: new Prisma.Decimal(totals.total.toFixed(2)),
        notes: body.notes || null,
        created_by: actor,
        items: { create: cleanItems },
      },
      include: { items: { orderBy: { position: "asc" } } },
    });
    return NextResponse.json({ note });
  } catch (err) {
    // Índice único (kind, number, year): alguém já usou esse número no ano.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return NextResponse.json(
        { error: `Já existe uma nota ${kind === "DEBITO" ? "de débito" : "de crédito"} com o número ${number} em ${year}.` },
        { status: 409 },
      );
    }
    throw err;
  }
}
