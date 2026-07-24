/**
 * Aplica a lista da Equipe Turbo (EQUIPE_4) conforme o formulário do maquinista
 * Josué no navio LEVANTE M.
 *
 * Regras (definidas com o usuário):
 *  - "O que FOI" no LEVANTE M = exatamente a coluna Ida do Josué (controle da
 *    viagem). Gravado como embark_list_overrides SÓ quando difere do padrão.
 *  - "PADRÃO da Turbo" (embark_kit_items EQUIPE_4) = a Ida ONDE Ida > 0. Onde a
 *    Ida = 0 (falta pontual: Espátula, Marreta), o padrão é MANTIDO — só o navio
 *    fica com 0 (override). Itens sem número na Ida (conectores/óleo/caxeta) não
 *    mudam nada.
 *  - Alocação da Turbo (material_team_allocations EQUIPE_4) = o que foi, pra
 *    destravar o embarque (bloqueio = alocação < Leva). Muda o Disponível no
 *    Almoxarifado — decisão do usuário.
 *  - Itens novos (não existiam no estoque) são criados e entram no kit das 3
 *    equipes (EQUIPE_1/2/4). Balsa não foi e fica só cadastrada, sem kit.
 *
 * SÓ GRAVA com --go. Sem --go faz dry-run (mostra o diff, não escreve).
 * Escreve em PRODUÇÃO (DATABASE_URL = Postgres do Railway).
 *
 * Run:  npx tsx scripts/aplicar-turbo-levante.ts        (dry-run)
 *       npx tsx scripts/aplicar-turbo-levante.ts --go    (grava)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const GO = process.argv.includes("--go");
const ACTOR = "Josué (lista LEVANTE M)";
const TURBO = "EQUIPE_4";

// Coluna Ida do formulário, por NOME EXATO do stock_items.
//   número  -> foi essa quantidade
//   0       -> não foi (falta): navio = 0, padrão mantido
//   null    -> em branco no papel: não mexe em nada
const IDA: Record<string, number | null> = {
  "MAQUINA HIDROJATO": 7, "ENGATE PISTOLA": 9, "CANETA": 6, "VARÃO GROSSO": 15,
  "VARAO FINO": 12, "EMEN/VARÃO": 3, "EMEN/MEIO": 7, "BICO QUIMICA": 1,
  "FILTRO": 6, "GRAXA": 1, "TAMBOR": 7, "QUADRO ENERG.": 4, "BOBINA DE CABO": 4,
  "BOTOEIRA": 1, "CINTA DE IÇAMENTO": 4, "MANGUEIRA BOMBA": 2,
  "MANGUEIRA JARDIM": 10, "MANGUEIRA GROSSA": 40, "MANGUEIRA MEDIA": 40,
  "MANGUEIRA FINA": 40, "MANG/QUÍMI.": 1, "BOMBA/QUÍMI.": 1,
  "VARAO FINO ESFREGÃO": 16, "ESPUMA": 4, "ESCADA": 2, "CORDA BOMBEIRO": 8,
  "REDE": 1, "BEG": 3, "LONA 6X6": 1, "FOGAO": 1, "GÁS": 1, "COLLER": 1,
  "CAXOT/FERRAM.": 3, "CAXOT/COMID.": 1, "ERASPADEIRA CUMPRIDA": 4,
  "VASELINA PASTA": 1, "PA BORRACHA": 1, "COLA AZUL": 1, "CARGO LIGHT": 2,
  "RADIO TANSMISSOR": 6, "ARCO SERRA": 1, "COTOVELO BOMBA": 1,
  "COTOVELO BYPASS": 2, "PNEU DE ROLAMENTO": 2, "BICO AGRESSIVO": 10, "NIPLE": 28,
  "BRAÇADEIRA PRETA 4,8": 9, "REGISTRO AGUA": 6, "CONC/MAN/JÁ": 6, "BYPASS": 2,
  "LUVA PVC": 12, "LUVA PIGMENTADA BRANCA": 72, "SILVER TAPE": 10,
  "FITA VERMELHA": 1, "FITA HELLERMAN/LACRE": 300, "COLA CASCOLAC": 3,
  "CAPA QUIMICA": 10, "DESINGRIPANTE": 2, "LIMPA CONTATO": 1, "MULTIMETRO": 1,
  "MASCARA DE PROTEÇÃO": 2, "MASCARA DE PROT SIMPLES": 16, "CINTO DE SEGURANÇA": 4,
  "ESPATOLA MAO": 0, "MARRETA": 0,
  // sem número no papel — não mexe
  "CONEC/ MACHO CAIXA": null, "CONEC/ FEMEA BOBINA": null,
  "CONEC/ FÊMEA DUPLA": null, "CONEC/ MACHO MÁQUINA": null,
  "OLEO MOTOR": null, "CAXETA": null,
};

// Itens novos (não existem no estoque). setor = sentinela stock_items.team.
// qty = Ida. Balsa não foi: cria sem kit (qty base 0, fora da lista).
const NOVOS: { name: string; setor: string; qty: number; noKit?: boolean }[] = [
  { name: "QUIMICA KIMIKLAP", setor: "FLUIDOS", qty: 10 },
  { name: "QUIMICA REMOCON", setor: "FLUIDOS", qty: 10 },
  { name: "CORREÇÃO RETA", setor: "MAQUINARIO", qty: 2 },
  { name: "CORREÇÃO GATILHO", setor: "MAQUINARIO", qty: 2 },
  { name: "FITA ISOLANTE", setor: "GALPAO", qty: 1 },
  { name: "FITA VEDA ROSCA", setor: "GALPAO", qty: 1 },
  { name: "BALSA", setor: "GALPAO", qty: 0, noKit: true },
];

const log: string[] = [];
const line = (s: string) => { log.push(s); console.log(s); };

async function main() {
  line(GO ? "== GRAVANDO EM PRODUÇÃO ==" : "== DRY-RUN (não grava) ==");

  const ship = await prisma.ship.findFirst({
    where: { name: { contains: "LEVANTE", mode: "insensitive" } },
    select: { id: true, name: true },
  });
  if (!ship) throw new Error("Navio LEVANTE não encontrado");
  line(`Navio: ${ship.name} (${ship.id})\n`);

  const KINDS = ["GALPAO", "FLUIDOS", "MAQUINARIO", "FERRAMENTA", "ELETRICA"];
  const mats = await prisma.stockItem.findMany({
    where: { team: { in: KINDS } },
    select: { id: true, name: true, team: true },
  });
  const byName = new Map(mats.map((m) => [m.name, m]));

  let kitChanges = 0, ovrChanges = 0, allocChanges = 0, novos = 0, notFound = 0;

  // ── Itens existentes ──────────────────────────────────────────────────────
  for (const [name, ida] of Object.entries(IDA)) {
    if (ida === null) continue; // em branco: não mexe
    const item = byName.get(name);
    if (!item) { line(`  ⚠ NÃO ENCONTRADO no estoque: ${name}`); notFound++; continue; }

    const kit = await prisma.embarkKitItem.findUnique({
      where: { team_stock_item_id: { team: TURBO, stock_item_id: item.id } },
      select: { id: true, quantity: true },
    });
    const kitAtual = kit?.quantity ?? 0;
    // Padrão: sobe/ajusta se Ida>0; se Ida=0 (falta) mantém o padrão atual.
    const padraoNovo = ida > 0 ? ida : kitAtual;
    // Leva do navio = o que foi (Ida).
    const need = ida;

    // 1) Padrão (kit EQUIPE_4)
    if (padraoNovo !== kitAtual) {
      line(`  KIT  ${name}: padrão ${kitAtual} → ${padraoNovo}`);
      kitChanges++;
      if (GO) {
        await prisma.embarkKitItem.upsert({
          where: { team_stock_item_id: { team: TURBO, stock_item_id: item.id } },
          create: { team: TURBO, stock_item_id: item.id, quantity: padraoNovo },
          update: { quantity: padraoNovo },
        });
      }
    }

    // 2) Override do navio (só quando o que foi difere do padrão)
    const ovr = await prisma.embarkListOverride.findUnique({
      where: { ship_id_stock_item_id: { ship_id: ship.id, stock_item_id: item.id } },
      select: { id: true, quantity: true },
    });
    if (need !== padraoNovo) {
      if (!ovr || ovr.quantity !== need) {
        line(`  FOI  ${name}: LEVANTE M leva ${need} (padrão ${padraoNovo})`);
        ovrChanges++;
        if (GO) {
          await prisma.embarkListOverride.upsert({
            where: { ship_id_stock_item_id: { ship_id: ship.id, stock_item_id: item.id } },
            create: { ship_id: ship.id, team: TURBO, kind: "MATERIAL", stock_item_id: item.id, quantity: need },
            update: { team: TURBO, kind: "MATERIAL", quantity: need },
          });
        }
      }
    } else if (ovr) {
      // padrão já cobre: remove override antigo (ex.: BICO AGRESSIVO=10)
      line(`  FOI  ${name}: remove ajuste do navio (padrão ${padraoNovo} já cobre)`);
      ovrChanges++;
      if (GO) await prisma.embarkListOverride.delete({ where: { id: ovr.id } });
    }

    // 3) Alocação da Turbo = o que foi (destrava)
    const alloc = await prisma.materialTeamAllocation.findUnique({
      where: { stock_item_id_team: { stock_item_id: item.id, team: TURBO } },
      select: { id: true, quantity: true },
    });
    const allocAtual = alloc?.quantity ?? 0;
    if (allocAtual !== need) {
      line(`  SEP  ${name}: separado p/ Turbo ${allocAtual} → ${need}`);
      allocChanges++;
      if (GO) {
        await prisma.materialTeamAllocation.upsert({
          where: { stock_item_id_team: { stock_item_id: item.id, team: TURBO } },
          create: { stock_item_id: item.id, team: TURBO, quantity: need, updated_by: ACTOR },
          update: { quantity: need, updated_by: ACTOR },
        });
      }
    }
  }

  // ── Itens novos (cria se não existe; garante o kit das equipes) ───────────
  line("");
  for (const n of NOVOS) {
    let item = await prisma.stockItem.findFirst({
      where: { name: n.name, team: { in: KINDS } }, select: { id: true },
    });
    if (!item) {
      line(`  NOVO ${n.name} [${n.setor}] qty ${n.qty}`);
      novos++;
      if (GO) {
        item = await prisma.stockItem.create({
          data: {
            name: n.name, team: n.setor, quantity: n.qty, default_quantity: 0,
            min_quantity: 0, category: "OUTROS", updated_by: ACTOR,
          },
          select: { id: true },
        });
      }
    } else {
      line(`  (já existe no estoque) ${n.name}`);
    }
    if (n.noKit) continue; // Balsa: não foi, fica só no estoque
    // Garante kit E1/E2/Turbo e alocação da Turbo (só cria o que faltar).
    line(`     + kit E1/E2/Turbo=${n.qty}, separado p/ Turbo=${n.qty}`);
    if (GO && item) {
      for (const t of ["EQUIPE_1", "EQUIPE_2", "EQUIPE_4"]) {
        await prisma.embarkKitItem.upsert({
          where: { team_stock_item_id: { team: t, stock_item_id: item.id } },
          create: { team: t, stock_item_id: item.id, quantity: n.qty },
          update: { quantity: n.qty },
        });
      }
      await prisma.materialTeamAllocation.upsert({
        where: { stock_item_id_team: { stock_item_id: item.id, team: TURBO } },
        create: { stock_item_id: item.id, team: TURBO, quantity: n.qty, updated_by: ACTOR },
        update: { quantity: n.qty, updated_by: ACTOR },
      });
    }
  }

  line(`\n── Resumo ${GO ? "(GRAVADO)" : "(dry-run)"} ──`);
  line(`Padrão (kit) alterados:     ${kitChanges}`);
  line(`Ajustes do navio (FOI):     ${ovrChanges}`);
  line(`Separado p/ Turbo (SEP):    ${allocChanges}`);
  line(`Itens novos criados:        ${novos}`);
  if (notFound) line(`⚠ Não encontrados:          ${notFound}`);
  if (!GO) line(`\nNada foi gravado. Rode com --go pra aplicar.`);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
