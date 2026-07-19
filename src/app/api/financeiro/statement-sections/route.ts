import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";

// Seções/subseções personalizadas da Demonstração Financeira (além das fixas
// da planilha). GET lista as ativas; POST cria uma nova subseção num grupo
// (oficial ou novo). Ver src/lib/statement-sections.ts pra como se mesclam.

// GET /api/financeiro/statement-sections — lista as seções personalizadas ativas
// e os rótulos renomeados das seções fixas (overrides).
export async function GET() {
  const guard = await requireFinance("view");
  if (guard.error) return guard.error;

  const [sections, overrides] = await Promise.all([
    prisma.customStatementSection.findMany({
      where: { active: true },
      orderBy: [{ sort_order: "asc" }, { label: "asc" }],
      select: { id: true, label: true, group_label: true, sort_order: true, active: true },
    }),
    prisma.statementSectionOverride.findMany({
      select: { section_key: true, label: true },
    }),
  ]);
  return NextResponse.json({ sections, overrides });
}

// POST /api/financeiro/statement-sections — cria uma subseção.
// Body: { label, group_label, sort_order? }
export async function POST(request: NextRequest) {
  const guard = await requireFinance("create");
  if (guard.error) return guard.error;

  const body = await request.json().catch(() => null);
  const label = String(body?.label || "").trim();
  const groupLabel = String(body?.group_label || "").trim();
  if (!label) return NextResponse.json({ error: "Informe o nome da subseção" }, { status: 400 });
  if (!groupLabel) return NextResponse.json({ error: "Informe o grupo" }, { status: 400 });

  const section = await prisma.customStatementSection.create({
    data: {
      label,
      group_label: groupLabel,
      sort_order: Number.isFinite(Number(body?.sort_order)) ? Number(body.sort_order) : 0,
      created_by: guard.userName,
    },
    select: { id: true, label: true, group_label: true, sort_order: true, active: true },
  });
  return NextResponse.json({ section }, { status: 201 });
}
