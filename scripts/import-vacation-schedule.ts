/**
 * One-shot importer for the accounting "Programação de Férias" report
 * (ex.: 342-ProgramaçãodeFérias-052026.pdf, base 12/06/2026).
 *
 * Run with:  npx tsx scripts/import-vacation-schedule.ts
 *            npx tsx scripts/import-vacation-schedule.ts --dry   (não grava)
 *
 * O que faz (casando por NOME, normalizado sem acento/caixa):
 *   - admission_date      <- coluna "Data admissão" do relatório
 *   - vacation_limit_date <- coluna "Limite p/ gozo" do período aquisitivo
 *                            mais antigo em aberto (1ª linha de cada empregado)
 *
 * Idempotente: re-rodar com os mesmos dados é seguro. Escreve em PRODUÇÃO
 * (DATABASE_URL aponta pro Postgres do Railway) — confira o resumo antes.
 *
 * Os dados abaixo foram extraídos do PDF com pdfplumber (texto, não digitação),
 * então admission/limit são exatamente os do relatório.
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DRY = process.argv.includes("--dry");

interface Row {
  name: string;
  admission: string; // YYYY-MM-DD
  limit: string; // YYYY-MM-DD — "Limite p/ gozo" mais antigo
}

// Extraído de 342-ProgramaçãodeFérias-052026.pdf (50 empregados).
const ROWS: Row[] = [
  { name: "ADINAELSON FERREIRA DE SOUZA", admission: "2023-10-30", limit: "2025-09-30" },
  { name: "ANDRE LUIZ DE MORAES ESPINDOLA", admission: "2025-04-01", limit: "2027-03-02" },
  { name: "ARTUR DOS SANTOS SILVA", admission: "2026-05-13", limit: "2028-04-13" },
  { name: "CAICK DOS SANTOS PIMENTA", admission: "2026-04-13", limit: "2028-03-14" },
  { name: "CAMILA FERREIRA DA SILVA", admission: "2022-04-01", limit: "2027-03-02" },
  { name: "CARLISON LUIZ NASCIMENTO", admission: "2024-05-02", limit: "2026-04-02" },
  { name: "DANIEL DOMINGOS DOS SANTOS", admission: "2022-10-20", limit: "2025-09-20" },
  { name: "DAVID EMANUELO FERNANDES CORTEZ", admission: "2024-09-01", limit: "2026-08-02" },
  { name: "DEIVIDE FERREIRA DA SILVA", admission: "2025-05-23", limit: "2027-04-23" },
  { name: "ELIAS MEDRADO ABREU", admission: "2025-08-08", limit: "2027-07-09" },
  { name: "ELTON MEDRADO ABREU", admission: "2026-04-13", limit: "2028-03-14" },
  { name: "GABRIEL SALES FREITAS DOS SANTOS", admission: "2025-09-11", limit: "2027-08-12" },
  { name: "GUILHERME LIMA DAMIAO", admission: "2022-06-01", limit: "2027-05-02" },
  { name: "GUSTAVO VARJAO CONCEICAO", admission: "2025-09-06", limit: "2027-08-07" },
  { name: "ISAIAS FRANCISCO SANTOS", admission: "2022-10-20", limit: "2026-09-20" },
  { name: "IVAM RODRIGUES FERREIRA", admission: "2026-05-27", limit: "2028-04-27" },
  { name: "IVAN RODRIGUES DE FREITAS", admission: "2022-10-20", limit: "2025-09-20" },
  { name: "JEAN GOMES DOS SANTOS SILVA", admission: "2024-07-26", limit: "2026-06-26" },
  { name: "JEDSON DIEGO GOMES DE LIMA", admission: "2022-02-14", limit: "2027-01-15" },
  { name: "JOAO VICTOR DOS SANTOS", admission: "2025-07-12", limit: "2027-06-12" },
  { name: "JOSUE FERREIRA ARAUJO", admission: "2025-08-21", limit: "2027-07-22" },
  { name: "JULIANO MARCELO MATOS", admission: "2026-04-08", limit: "2028-03-09" },
  { name: "KAIC MOURA DE MELO", admission: "2026-05-06", limit: "2028-04-06" },
  { name: "KAUE FREITAS DOS SANTOS", admission: "2026-05-09", limit: "2028-04-09" },
  { name: "LUCAS ALMEIDA DANTAS", admission: "2026-04-13", limit: "2028-03-14" },
  { name: "LUCAS BRASIL ALEXANDRE", admission: "2025-10-11", limit: "2027-09-11" },
  { name: "LUCAS NUNES DE BARROS", admission: "2024-04-27", limit: "2026-03-28" },
  { name: "LUCAS OCHOA ROSSINI", admission: "2023-10-18", limit: "2025-09-18" },
  { name: "LUCAS SALES FREITAS DOS SANTOS", admission: "2026-04-07", limit: "2028-03-08" },
  { name: "LUIZ FELIPE BATISTA DE OLIVEIRA", admission: "2025-08-22", limit: "2027-07-23" },
  { name: "MADSON DA SILVA DE PINHO", admission: "2026-05-19", limit: "2028-04-19" },
  { name: "MANOEL VICTOR DE SOUZA SANTIAGO", admission: "2024-12-27", limit: "2026-11-27" },
  { name: "MARCOS NUNES DA SILVA JUNIOR", admission: "2024-09-01", limit: "2026-08-02" },
  { name: "MATHEUS OLIVEIRA SUPPA DOS SANTOS", admission: "2023-03-21", limit: "2026-02-19" },
  { name: "NAYDHION HENDRYCKSON SANTOS DA SILVA", admission: "2025-11-04", limit: "2027-10-05" },
  { name: "PAULO EDSON ALVES FERREIRA", admission: "2024-11-08", limit: "2026-10-09" },
  { name: "PEDRO HENRIQUE ARAUJO DA CUNHA", admission: "2022-04-01", limit: "2027-03-02" },
  { name: "RAFAEL CHRISTOFOLETTI MERENDI", admission: "2026-01-28", limit: "2027-12-29" },
  { name: "ROBSON DA SILVA LARANJEIRA JUNIOR", admission: "2026-04-13", limit: "2028-03-14" },
  { name: "ROGER ROGERIO DOS SANTOS", admission: "2026-04-13", limit: "2028-03-14" },
  { name: "RONALDO ANDRADE DE SOUZA", admission: "2023-10-21", limit: "2025-09-21" },
  { name: "RYAN PETTERSON DE MENDONCA SILVA", admission: "2025-10-11", limit: "2027-09-11" },
  { name: "SERGIO LUIZ DA SILVA SOARES BORGES", admission: "2026-04-23", limit: "2028-03-24" },
  { name: "VANDERSON ARAUJO BORGES", admission: "2026-05-20", limit: "2028-04-20" },
  { name: "VANDRE TADEU GINO FERNANDES", admission: "2026-04-01", limit: "2028-03-02" },
  { name: "VICTOR DIOGO SOUZA CONCEICAO", admission: "2024-10-01", limit: "2026-09-01" },
  { name: "VICTOR HUGO DOS PASSOS CORREA PEREIRA", admission: "2023-12-12", limit: "2026-11-12" },
  { name: "WALBER GOIS DE ABREU", admission: "2026-01-28", limit: "2027-12-29" },
  { name: "WILHAMS GALVAO SOUZA", admission: "2024-05-28", limit: "2026-04-28" },
  { name: "YURI ANDRADE DE BRITO", admission: "2024-08-08", limit: "2026-07-09" },
];

// Casos em que o nome no relatório da contabilidade difere do cadastro
// (acento, nome do meio a mais/menos, "DE" extra). Mapeia o nome do PDF para
// o id do colaborador no sistema — assim o match é determinístico.
const ALIAS_BY_ID: Record<string, number> = {
  "ANDRE LUIZ DE MORAES ESPINDOLA": 3, // ANDRÉ LUIZ ESPINDOLA
  "GUILHERME LIMA DAMIAO": 15, // GUILHERME LIMA DAMIAO RIBEIRO
  "JEDSON DIEGO GOMES DE LIMA": 21, // JEDSON DIEGO GOMES LIMA
  "MADSON DA SILVA DE PINHO": 64, // MADSON DA SILVA ALVES DE PINHO
  "NAYDHION HENDRYCKSON SANTOS DA SILVA": 38, // NAYDHION HENDRYCSON SANTOS DA SILVA
  "RYAN PETTERSON DE MENDONCA SILVA": 46, // RYAN PETERSSON DE MENDONÇA SILVA
};

function norm(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fmt(iso: string | null | Date): string {
  if (!iso) return "—";
  const s = typeof iso === "string" ? iso.slice(0, 10) : iso.toISOString().slice(0, 10);
  return s.split("-").reverse().join("/");
}

async function main() {
  const employees = await prisma.employee.findMany({
    select: { id: true, name: true, admission_date: true, vacation_limit_date: true },
  });
  const byName = new Map<string, typeof employees>();
  const byId = new Map<number, (typeof employees)[number]>();
  for (const e of employees) {
    const k = norm(e.name);
    byName.set(k, [...(byName.get(k) || []), e]);
    byId.set(e.id, e);
  }

  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  let updated = 0;
  let unchanged = 0;

  console.log(`\n=== Programação de Férias → Colaboradores ${DRY ? "(DRY RUN)" : ""} ===\n`);

  for (const row of ROWS) {
    const aliasId = ALIAS_BY_ID[row.name];
    let emp: (typeof employees)[number] | undefined;
    if (aliasId !== undefined) {
      emp = byId.get(aliasId);
      if (!emp) {
        unmatched.push(`${row.name} (alias id ${aliasId} não existe)`);
        continue;
      }
    } else {
      const matches = byName.get(norm(row.name));
      if (!matches || matches.length === 0) {
        unmatched.push(row.name);
        continue;
      }
      if (matches.length > 1) {
        ambiguous.push(`${row.name} → ${matches.length} colaboradores com o mesmo nome`);
        continue;
      }
      emp = matches[0];
    }
    const curAdm = emp.admission_date ? emp.admission_date.toISOString().slice(0, 10) : null;
    const curLim = emp.vacation_limit_date ? emp.vacation_limit_date.toISOString().slice(0, 10) : null;
    const admChanged = curAdm !== row.admission;
    const limChanged = curLim !== row.limit;

    if (!admChanged && !limChanged) {
      unchanged++;
      continue;
    }

    const tags: string[] = [];
    if (admChanged) tags.push(`adm ${fmt(curAdm)} → ${fmt(row.admission)}`);
    if (limChanged) tags.push(`limite ${fmt(curLim)} → ${fmt(row.limit)}`);
    console.log(`  ✓ ${emp.name}: ${tags.join("; ")}`);

    if (!DRY) {
      await prisma.employee.update({
        where: { id: emp.id },
        data: {
          admission_date: new Date(row.admission),
          vacation_limit_date: new Date(row.limit),
          updated_by: "Programação de Férias (import)",
        },
      });
    }
    updated++;
  }

  console.log(`\n--- Resumo ---`);
  console.log(`  Atualizados : ${updated}`);
  console.log(`  Sem mudança : ${unchanged}`);
  console.log(`  Não casados : ${unmatched.length}`);
  if (unmatched.length) unmatched.forEach((n) => console.log(`      • ${n}`));
  if (ambiguous.length) {
    console.log(`  Ambíguos    : ${ambiguous.length}`);
    ambiguous.forEach((a) => console.log(`      • ${a}`));
  }
  console.log(DRY ? `\n(DRY RUN — nada gravado)\n` : `\nConcluído.\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
