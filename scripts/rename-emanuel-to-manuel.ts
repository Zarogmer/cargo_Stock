// One-shot: renomeia o login do usuário "emanuel" para "manuel".
// Mantém senha, role, full_name — só troca o email (que é a chave de login).
//
// Estratégia: procura users cujo email começa com "emanuel@". Se achar 1, faz
// o swap. Se achar mais de 1 (ex.: "emanuel@x" e "emanuel2@x"), aborta pra
// não renomear o errado — operador resolve manualmente.
//
// Uso: `npx tsx scripts/rename-emanuel-to-manuel.ts`

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function run() {
  const candidates = await prisma.user.findMany({
    where: { email: { startsWith: "emanuel@" } },
    select: { id: true, email: true, full_name: true, role: true },
  });

  if (candidates.length === 0) {
    console.log("Nenhum usuário com email começando em 'emanuel@' encontrado.");
    return;
  }

  if (candidates.length > 1) {
    console.error(`Encontrei ${candidates.length} candidatos — ambíguo, não vou mexer:`);
    for (const c of candidates) console.error(`  - ${c.email}`);
    process.exit(1);
  }

  const u = candidates[0];
  // "emanuel@foo.local" → "manuel@foo.local". Troco só o prefixo, mantendo
  // o domínio (não dá pra cravar @cargostock.local porque outros ambientes
  // podem usar domínios diferentes).
  const newEmail = u.email.replace(/^emanuel/i, "manuel");

  // Conflito? Aborta antes de tentar o update.
  const exists = await prisma.user.findUnique({ where: { email: newEmail } });
  if (exists) {
    console.error(`Já existe um usuário com email ${newEmail} — abortando.`);
    process.exit(1);
  }

  await prisma.user.update({
    where: { id: u.id },
    data: { email: newEmail },
  });

  console.log(`✅ Login renomeado: ${u.email} → ${newEmail} (senha preservada).`);
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
