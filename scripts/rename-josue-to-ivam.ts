// One-shot: o funcionário mudou — substitui a conta do "Josué" pela do "Ivam".
// Troca de uma vez o LOGIN (email) e o NOME EXIBIDO (full_name) do mesmo usuário,
// preservando senha, role e histórico de login (mantém o mesmo id). O avatar/inicial
// na sidebar é derivado do nome (full_name.charAt(0)), então passa a mostrar "I".
//
// Não há campo "username" separado no schema: o login é o email (ver lib/auth.ts) e
// o nome exibido é o full_name. Então essas duas colunas são tudo que muda.
//
// Segurança (mesmo padrão do rename-emanuel-to-manuel): só age se houver
// EXATAMENTE 1 usuário cujo email começa com "josue@". 0 → nada; >1 → aborta e
// lista os candidatos pro operador resolver. Aborta também se o email de destino
// já existir. Roda em DRY-RUN por padrão; passe --apply para gravar em produção.
//
// Uso:
//   npx tsx scripts/rename-josue-to-ivam.ts            (dry-run)
//   npx tsx scripts/rename-josue-to-ivam.ts --apply    (grava)

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const NOVO_NOME = "Ivam";

async function run() {
  const candidates = await prisma.user.findMany({
    where: { email: { startsWith: "josue@" } },
    select: { id: true, email: true, full_name: true, role: true },
  });

  if (candidates.length === 0) {
    console.log("Nenhum usuário com email começando em 'josue@'. Nada a fazer.");
    return;
  }
  if (candidates.length > 1) {
    console.error(`Encontrei ${candidates.length} candidatos — ambíguo, não vou mexer:`);
    for (const c of candidates) console.error(`  - "${c.full_name}" (${c.email})`);
    process.exit(1);
  }

  const u = candidates[0];
  // "josue@foo.local" → "ivam@foo.local". Troco só o prefixo, mantendo o domínio
  // (outros ambientes podem usar domínios diferentes de @cargostock.local).
  const novoEmail = u.email.replace(/^josue/i, "ivam");

  // Conflito? Aborta antes de tentar o update.
  const exists = await prisma.user.findUnique({ where: { email: novoEmail } });
  if (exists && exists.id !== u.id) {
    console.error(`Já existe um usuário com email ${novoEmail} — abortando.`);
    process.exit(1);
  }

  if (!APPLY) {
    console.log(`[dry-run] Conta encontrada: "${u.full_name}" <${u.email}> (role ${u.role}).`);
    console.log(`[dry-run] Login:  ${u.email} → ${novoEmail}`);
    console.log(`[dry-run] Nome:   "${u.full_name}" → "${NOVO_NOME}"  (avatar mostraria "${NOVO_NOME.charAt(0).toUpperCase()}")`);
    console.log(`[dry-run] Senha e role preservados. Rode novamente com --apply para gravar em produção.`);
    return;
  }

  await prisma.user.update({
    where: { id: u.id },
    data: { email: novoEmail, full_name: NOVO_NOME },
  });

  console.log(`✅ Conta substituída (senha e role preservados):`);
  console.log(`   Login: ${u.email} → ${novoEmail}`);
  console.log(`   Nome:  "${u.full_name}" → "${NOVO_NOME}"  (avatar passa a mostrar "${NOVO_NOME.charAt(0).toUpperCase()}")`);
}

run()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
