import { prisma } from "@/lib/prisma";
import { SECTION_BY_KEY } from "@/lib/demonstracao-financeira";
import { customKeyId, isCustomKey } from "@/lib/statement-sections";

// Valida a chave de seção que o cliente mandou pra um título: aceita as fixas
// da planilha ("6.1".."12") e as personalizadas ("c<id>") que existem e estão
// ativas. Devolve a chave válida ou null (não grava chave-fantasma). Vazio → null.
export async function resolveStatementSectionKey(raw: unknown): Promise<string | null> {
  if (!raw) return null;
  const key = String(raw).trim();
  if (!key) return null;
  if (SECTION_BY_KEY.has(key)) return key;
  if (isCustomKey(key)) {
    const id = customKeyId(key);
    if (id == null) return null;
    const found = await prisma.customStatementSection.findFirst({
      where: { id, active: true },
      select: { id: true },
    });
    return found ? key : null;
  }
  return null;
}
