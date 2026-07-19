/**
 * Reclassifica os itens do kit de embarque nas "caixinhas" ATUAIS do
 * Almoxarifado. As categorias antigas do import ("Embarque", "Hidrojato",
 * "Pistola e Caneta", "EPI e Químicos"...) não existem mais no menu — hoje o
 * Estoque é dividido em Utensílios, Fluídos, Maquinário, Ferramenta e Elétrica
 * (aba = stock_items.team) e a tela Embarque/Retorno mostra stock_items.location
 * como "Categoria".
 *
 * Este script move cada item pra aba certa (team) e grava a etiqueta certa
 * (location). EPI não tem inventário em stock_items (o módulo EPI é outra
 * tabela, por colaborador/tamanho), então os consumíveis de EPI do kit ficam
 * no Utensílios (team GALPAO) com a etiqueta "EPI".
 *
 * Uso: npx tsx scripts/reclassify-embark-categories.ts [--commit]
 * (sem --commit é dry-run: só mostra o que faria)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface Group { team: string; location: string; names: string[] }

const GROUPS: Group[] = [
  {
    // Máquina de hidrojato e tudo que acopla nela: bicos, lanças/varões,
    // mangueiras, emendas, conexões de água e a bomba química.
    team: "MAQUINARIO", location: "Maquinário",
    names: [
      "MAQUINA HIDROJATO", "COTOVELO BOMBA", "COTOVELO BYPASS", "PNEU DE ROLAMENTO",
      "BYPASS", "BICO QUIMICA", "REGISTRO AGUA", "ENGATE PISTOLA", "CANETA",
      "BICO AGRESSIVO", "EMEN/VARÃO", "EMEN/MEIO", "CONC/MAN/JÁ", "MANG/QUÍMI.",
      "BOMBA/QUÍMI.", "VARÃO GROSSO", "VARAO FINO", "FILTRO", "NIPLE",
      "MANGUEIRA BOMBA", "MANGUEIRA JARDIM", "MANGUEIRA GROSSA", "MANGUEIRA MEDIA",
      "MANGUEIRA FINA",
    ],
  },
  {
    team: "ELETRICA", location: "Elétrica",
    names: [
      "QUADRO ENERG.", "CONEC/ FÊMEA DUPLA", "CONEC/ MACHO CAIXA",
      "CONEC/ FEMEA BOBINA", "CONEC/ MACHO MÁQUINA", "CARGO LIGHT",
      "RADIO TANSMISSOR", "BOBINA DE CABO", "BOTOEIRA", "MULTIMETRO",
    ],
  },
  {
    // Óleos, graxas, colas e químicos.
    team: "FLUIDOS", location: "Fluídos",
    names: [
      "OLEO MOTOR", "VASELINA PASTA", "GRAXA", "COLA CASCOLAC", "DESINGRIPANTE",
      "LIMPA CONTATO", "COLA AZUL",
    ],
  },
  {
    team: "FERRAMENTA", location: "Ferramenta",
    names: ["PA BORRACHA", "ARCO SERRA", "ESPATOLA MAO", "ERASPADEIRA CUMPRIDA", "MARRETA"],
  },
  {
    // Proteção individual consumível do kit — fica no Utensílios (ver acima).
    team: "GALPAO", location: "EPI",
    names: [
      "LUVA PVC", "LUVA PIGMENTADA BRANCA", "CAPA QUIMICA", "MASCARA DE PROTEÇÃO",
      "MASCARA DE PROT SIMPLES", "CINTO DE SEGURANÇA",
    ],
  },
  {
    team: "GALPAO", location: "Utensílios",
    names: [
      "BRAÇADEIRA PRETA 4,8", "SILVER TAPE", "FITA VERMELHA", "ESPUMA",
      "CORDA BOMBEIRO", "LONA 6X6", "TAMBOR", "ESCADA", "FOGAO",
      "FITA HELLERMAN/LACRE", "REDE", "BEG", "GÁS", "COLLER", "CAXOT/FERRAM.",
      "CAXOT/COMID.", "CAXETA", "VARAO FINO ESFREGÃO", "CINTA DE IÇAMENTO",
    ],
  },
];

const norm = (s: string) => s.trim().toUpperCase();

async function main() {
  const commit = process.argv.includes("--commit");
  const items = await prisma.stockItem.findMany({
    select: { id: true, name: true, team: true, location: true },
  });
  const byNorm = new Map(items.map((i) => [norm(i.name), i]));

  let changed = 0, same = 0;
  const missing: string[] = [];
  for (const g of GROUPS) {
    console.log(`\n== ${g.location} (team ${g.team}) ==`);
    for (const name of g.names) {
      const item = byNorm.get(norm(name));
      if (!item) { missing.push(name); console.log(`  ?? NÃO ACHEI: ${name}`); continue; }
      if (item.team === g.team && item.location === g.location) {
        same++;
        continue;
      }
      console.log(`  ${item.name}  [${item.team} | ${item.location || "—"}] -> [${g.team} | ${g.location}]`);
      if (commit) {
        await prisma.stockItem.update({
          where: { id: item.id },
          data: { team: g.team, location: g.location, updated_by: "Reclassificação categorias" },
        });
      }
      changed++;
    }
  }

  console.log(`\n${commit ? "✅ Atualizados" : "Mudariam"}: ${changed} | já certos: ${same} | não achados: ${missing.length}`);
  if (missing.length) console.log("Não achados: " + missing.join(", "));
  if (!commit) console.log("\n— DRY RUN — rode com --commit pra aplicar.\n");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
