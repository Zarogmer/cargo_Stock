import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireFinance } from "@/lib/financeiro-api";
import { SECTION_BY_KEY } from "@/lib/demonstracao-financeira";

// Renomeia (ou restaura) o rótulo de uma seção FIXA da Demonstração. O dado dos
// títulos não muda — a chave "6.1"/"9.2"/... continua a mesma; só o rótulo
// exibido no filtro e no cabeçalho passa a vir daqui. Ver src/lib/statement-sections.ts.

// POST — cria/atualiza o rótulo de uma seção fixa. Body: { section_key, label }
export async function POST(request: NextRequest) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;

  const body = await request.json().catch(() => null);
  const sectionKey = String(body?.section_key || "").trim();
  const label = String(body?.label || "").trim();
  if (!SECTION_BY_KEY.has(sectionKey)) {
    return NextResponse.json({ error: "Seção fixa inexistente" }, { status: 400 });
  }
  if (!label) return NextResponse.json({ error: "Nome não pode ficar vazio" }, { status: 400 });

  const override = await prisma.statementSectionOverride.upsert({
    where: { section_key: sectionKey },
    update: { label },
    create: { section_key: sectionKey, label, created_by: guard.userName },
    select: { section_key: true, label: true },
  });
  return NextResponse.json({ override });
}

// DELETE ?section_key=6.1 — remove o override (volta ao rótulo padrão da planilha).
export async function DELETE(request: NextRequest) {
  const guard = await requireFinance("edit");
  if (guard.error) return guard.error;

  const sectionKey = new URL(request.url).searchParams.get("section_key")?.trim() || "";
  if (!sectionKey) return NextResponse.json({ error: "section_key obrigatório" }, { status: 400 });

  await prisma.statementSectionOverride.deleteMany({ where: { section_key: sectionKey } });
  return NextResponse.json({ ok: true });
}
