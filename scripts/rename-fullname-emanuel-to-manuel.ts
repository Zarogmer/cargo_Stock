// One-shot (card #45): corrige o NOME EXIBIDO do usuário de "Emanuel" para
// "Manuel". Mexe só em users.full_name — o avatar/inicial na sidebar é derivado
// do nome (full_name.charAt(0)), então passa a mostrar "M". NÃO toca email,
// senha ou role. (O login emanuel@→manuel@ é outro card, com script próprio.)
//
// Segurança: só age se houver exatamente 1 usuário cujo full_name começa com
// "Emanuel" (case-insensitive, respeitando limite de palavra). 0 ou >1 → aborta
// e lista os candidatos. Roda em DRY-RUN por padrão; passe --apply para gravar.
//
// Uso:
//   npx tsx scripts/rename-fullname-emanuel-to-manuel.ts            (dry-run)
//   npx tsx scripts/rename-fullname-emanuel-to-manuel.ts --apply    (grava)

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function run() {
  const all = await prisma.user.findMany({
    select: { id: true, email: true, full_name: true, role: true },
  });
  const candidates = all.filter((u) => /^\s*emanuel\b/i.test(u.full_name || ""));

  if (candidates.length === 0) {
    console.log("Nenhum usuário com full_name começando em 'Emanuel'. Nada a fazer.");
    return;
  }
  if (candidates.length > 1) {
    console.error(`Encontrei ${candidates.length} candidatos — ambíguo, não vou mexer:`);
    for (const c of candidates) console.error(`  - "${c.full_name}" (${c.email})`);
    process.exit(1);
  }

  const u = candidates[0];
  const novo = u.full_name.replace(/^(\s*)emanuel/i, "$1Manuel");
  if (novo === u.full_name) {
    console.log(`full_name já está correto: "${u.full_name}". Nada a fazer.`);
    return;
  }

  if (!APPLY) {
    console.log(`[dry-run] Mudaria "${u.full_name}" → "${novo}" (${u.email}).`);
    console.log(`[dry-run] Avatar passaria a mostrar "${novo.charAt(0).toUpperCase()}".`);
    console.log(`Rode novamente com --apply para gravar em produção.`);
    return;
  }

  await prisma.user.update({ where: { id: u.id }, data: { full_name: novo } });
  console.log(`✅ Nome corrigido: "${u.full_name}" → "${novo}" (${u.email}).`);
  console.log(`   Avatar passará a mostrar "${novo.charAt(0).toUpperCase()}".`);
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
