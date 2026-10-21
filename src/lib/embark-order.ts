// Ordem oficial da lista de embarque + setores de material do Almoxarifado.
// Compartilhado pelo Checklist (Embarque/Retorno) e por Controle › Lista de
// Equipamentos (kit padrão por equipe) — as duas telas listam na MESMA ordem.

import { normalize } from "@/lib/utils";

// Setores do inventário que contam como "material" (tudo que não é Rancho).
// Sentinelas de stock_items.team — ver materiais-panel.tsx.
export const MATERIAL_TEAMS = new Set(["GALPAO", "FERRAMENTA", "ELETRICA", "FLUIDOS", "MAQUINARIO"]);
export const MATERIAL_TEAM_LABEL: Record<string, string> = {
  GALPAO: "Estoque", FERRAMENTA: "Ferramenta", ELETRICA: "Elétrica", FLUIDOS: "Fluídos", MAQUINARIO: "Maquinário",
};

// Ordem oficial da lista de embarque (formulário de papel do Josué), pra criar
// familiaridade com o maquinista: a lista na tela (Embarque, Retorno e Lista de
// Equipamentos) segue ESTA sequência, não a ordem alfabética. Nome =
// stock_items.name (comparado sem acento/caixa, pra sobreviver a um renome
// pequeno). Item que não estiver aqui vai pro fim, em ordem alfabética.
export const EMBARK_ORDER = [
  // coluna esquerda do formulário
  "MAQUINA HIDROJATO", "ENGATE PISTOLA", "CANETA", "VARÃO GROSSO", "VARAO FINO",
  "EMEN/VARÃO", "EMEN/MEIO", "BICO QUIMICA", "FILTRO", "GRAXA", "TAMBOR",
  "QUADRO ENERG.", "BOBINA DE CABO", "BOTOEIRA", "CINTA DE IÇAMENTO",
  "MANGUEIRA BOMBA", "MANGUEIRA JARDIM", "MANGUEIRA GROSSA", "MANGUEIRA MEDIA",
  "MANGUEIRA FINA", "MANG/QUÍMI.", "BOMBA/QUÍMI.", "VARAO FINO ESFREGÃO",
  "ESPUMA", "ESCADA", "CORDA BOMBEIRO", "REDE", "BEG", "LONA 6X6", "FOGAO",
  "GÁS", "COLLER", "CAXOT/FERRAM.", "CAXOT/COMID.", "ERASPADEIRA CUMPRIDA",
  // coluna direita
  "VASELINA PASTA", "PA BORRACHA", "COLA AZUL", "CARGO LIGHT", "RADIO TANSMISSOR",
  "BALSA", "QUIMICA KIMIKLAP", "QUIMICA REMOCON", "ARCO SERRA", "COTOVELO BOMBA",
  "COTOVELO BYPASS", "PNEU DE ROLAMENTO", "BICO AGRESSIVO", "NIPLE",
  "BRAÇADEIRA PRETA 4,8", "REGISTRO AGUA", "CONC/MAN/JÁ", "BYPASS", "LUVA PVC",
  "LUVA PIGMENTADA BRANCA", "SILVER TAPE", "FITA VERMELHA", "FITA HELLERMAN/LACRE",
  "COLA CASCOLAC", "CAPA QUIMICA", "DESINGRIPANTE", "LIMPA CONTATO", "MULTIMETRO",
  "MASCARA DE PROTEÇÃO", "MASCARA DE PROT SIMPLES", "CINTO DE SEGURANÇA",
  "ESPATOLA MAO", "MARRETA",
  // página 2 (conectores e extras)
  "CONEC/ MACHO CAIXA", "CONEC/ FEMEA BOBINA", "CONEC/ FÊMEA DUPLA", "OLEO MOTOR",
  "CAXETA", "CONEC/ MACHO MÁQUINA", "CORREÇÃO RETA", "CORREÇÃO GATILHO",
  "FITA ISOLANTE", "FITA VEDA ROSCA",
];
const EMBARK_ORDER_INDEX = new Map(EMBARK_ORDER.map((n, i) => [normalize(n), i]));
export const embarkSeq = (name: string): number =>
  EMBARK_ORDER_INDEX.get(normalize(name)) ?? Number.MAX_SAFE_INTEGER;
