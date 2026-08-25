import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { hasPermission } from "@/lib/rbac";
import { buildFiscalNotePdf } from "@/lib/fiscal-note-pdf";
import { buildFiscalNoteXlsx } from "@/lib/fiscal-note-xlsx";
import { fiscalNoteFileName, type FiscalNoteInput } from "@/lib/fiscal-note";
import type { Role } from "@/types/database";

// GET /api/financeiro/notas/[id]/arquivo?formato=pdf|xlsx
// Baixa a nota já emitida. O documento é montado na hora a partir do que está
// gravado — o arquivo nunca fica no banco, então corrigir o gerador corrige
// todas as notas antigas de uma vez.

function toInput(note: Record<string, any>): FiscalNoteInput {
  const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  return {
    kind: note.kind,
    number: note.number,
    year: note.year,
    job_id: note.job_id,
    ship_name: note.ship_name,
    client_name: note.client_name,
    client_legal_name: note.client_legal_name,
    client_address: note.client_address,
    client_cnpj: note.client_cnpj,
    client_ie: note.client_ie,
    client_municipal: note.client_municipal,
    header_line: note.header_line,
    language: note.language,
    oi: note.oi,
    port: note.port,
    arrival_date: iso(note.arrival_date),
    departure_date: iso(note.departure_date),
    issue_date: iso(note.issue_date)!,
    due_date: iso(note.due_date),
    currency: note.currency,
    exchange_rate: note.exchange_rate != null ? Number(note.exchange_rate) : null,
    iss_percent: note.iss_percent != null ? Number(note.iss_percent) : null,
    notes: note.notes,
    items: (note.items || []).map((it: Record<string, any>) => ({
      position: it.position,
      description: it.description,
      unit_value: it.unit_value != null ? Number(it.unit_value) : null,
      quantity: it.quantity != null ? Number(it.quantity) : null,
      amount: Number(it.amount),
    })),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const role = session.user.role as Role;
  if (!hasPermission(role, "FINANCEIRO_MOD", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const note = await prisma.fiscalNote.findUnique({
    where: { id },
    include: { items: { orderBy: { position: "asc" } } },
  });
  if (!note) return NextResponse.json({ error: "Nota não encontrada" }, { status: 404 });

  const input = toInput(note as unknown as Record<string, any>);
  const base = fiscalNoteFileName(input.kind, input.number, input.year, input.ship_name);
  const formato = (request.nextUrl.searchParams.get("formato") || "pdf").toLowerCase();

  if (formato === "xlsx") {
    const buf = buildFiscalNoteXlsx(input);
    return new NextResponse(Buffer.from(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(base)}.xlsx"`,
      },
    });
  }

  const pdf = await buildFiscalNotePdf(input);
  return new NextResponse(Buffer.from(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(base)}.pdf"`,
    },
  });
}
