// Regras de conteúdo dos Relatórios de Bordo compartilhadas entre a tela (aba
// Fotos, ordem dos blocos) e o gerador de PDF do servidor (src/lib/report-pdf).
// Só funções puras aqui — nada de DOM nem de pdf-lib, senão um lado arrasta a
// dependência do outro pro bundle.

// Serviço do navio que vira um relatório próprio. EMBARQUE = lavagem de porão
// e COSTADO = lavagem do costado (os dois originais); RASPAGEM e PINTURA são os
// outros serviços do Embarque (ships.services), cada um com o seu relatório pro
// cliente. Raspagem/Pintura andam junto da escala de EMBARQUE — não existe
// alocação própria delas (ver baseKind em report-scope.ts).
export type ReportKindName = "EMBARQUE" | "COSTADO" | "RASPAGEM" | "PINTURA";

export interface ReportKindInfo {
  // Nome do serviço na tela (PT).
  label: string;
  emoji: string;
  // Título da aba de preenchimento ("Lavagem dos Porões", "Raspagem dos Porões"…).
  workTab: string;
  // Nome do relatório em inglês, sem "Report" — o PDF vai pro agente/armador.
  titleEn: string;
  // Como o serviço aparece na fase da foto: "BEFORE <stageEn>".
  stageEn: string;
  // Lavagem tem as duas fases de água (salgada/doce); raspagem e pintura têm só
  // início e término.
  waterPhases: boolean;
  // Costado trabalha por "área"; os demais, por porão.
  areaWord: "porão" | "área";
  // Serviço do cadastro do navio (ships.services) que liga este relatório.
  service: string;
}

export const REPORT_KINDS: Record<ReportKindName, ReportKindInfo> = {
  EMBARQUE: {
    label: "Embarque",
    emoji: "⚓",
    workTab: "Lavagem dos Porões",
    titleEn: "Cargo Hold Cleaning",
    stageEn: "CLEANING",
    waterPhases: true,
    areaWord: "porão",
    service: "LAVAGEM_PORAO",
  },
  COSTADO: {
    label: "Costado",
    emoji: "🌊",
    workTab: "Lavagem do Costado",
    titleEn: "Hull Side Cleaning",
    stageEn: "CLEANING",
    waterPhases: true,
    areaWord: "área",
    service: "COSTADO",
  },
  RASPAGEM: {
    label: "Raspagem",
    emoji: "🪚",
    workTab: "Raspagem dos Porões",
    titleEn: "Cargo Hold Scraping",
    stageEn: "SCRAPING",
    waterPhases: false,
    areaWord: "porão",
    service: "RASPAGEM",
  },
  PINTURA: {
    label: "Pintura",
    emoji: "🎨",
    workTab: "Pintura dos Porões",
    titleEn: "Cargo Hold Painting",
    stageEn: "PAINTING",
    waterPhases: false,
    areaWord: "porão",
    service: "PINTURA",
  },
};

export interface HoldRow {
  label: string;
  status: string; // PENDENTE | EM_ANDAMENTO | COMPLETO
  // Legado: horário geral (relatórios de antes das fases de água).
  start_time: string | null;
  end_time: string | null;
  // Fases da lavagem: água salgada (lavagem) e água doce (enxágue).
  salt_start: string | null;
  salt_end: string | null;
  fresh_start: string | null;
  fresh_end: string | null;
  completion_pct: number;
}

export interface ActivityRow {
  time_range: string | null;
  activity: string;
  hold_label: string | null;
}

export interface PhotoMeta {
  id: number;
  hold_label: string | null;
  stage: string; // ANTES | DURANTE | DEPOIS | GERAL
  caption: string | null;
}

export interface SectionMeta {
  label: string;
  caption: string | null;
  sort_order: number;
}

export interface EvaluationPrintRow {
  name: string;
  function_name: string | null;
  productivity: number;
  quality: number;
  teamwork: number;
  safety: number;
  initiative: number;
  punctuality: number;
  technical: number;
  comments: string | null;
}

export const EVAL_CRITERIA: { key: keyof EvaluationPrintRow; label: string }[] = [
  { key: "productivity", label: "Produtividade" },
  { key: "quality", label: "Qualidade no trabalho" },
  { key: "teamwork", label: "Trabalho em equipe" },
  { key: "safety", label: "Segurança e uso de EPI" },
  { key: "initiative", label: "Iniciativa" },
  { key: "punctuality", label: "Pontualidade" },
  { key: "technical", label: "Habilidade técnica" },
];

// Rótulo do bloco "sem local": foto antiga (hold_label null) e o bloco geral do
// costado caem no mesmo lugar.
export const GENERAL_BLOCK = "Geral";

export function photoBlockKey(label: string | null | undefined): string {
  return (label || "").trim() || GENERAL_BLOCK;
}

// Locais de foto fora dos porões (blocos fixos da aba Fotos) → inglês do PDF.
// Chave em minúsculas pra casar sem depender de caixa.
const PHOTO_PLACE_EN: Record<string, string> = {
  "carregamento do caminhão": "TRUCK LOADING",
  "embarque de material": "MATERIAL BOARDING",
  "navio": "VESSEL",
  "desembarque do navio": "VESSEL DISEMBARKATION",
  "descarregamento do caminhão": "TRUCK UNLOADING",
};

// Ordem em que os blocos aparecem — a sequência real da operação, pro PDF já
// sair na ordem que o cliente lê: caminhão → material → navio → porões 1..N →
// desembarque → descarregamento. Bloco criado à mão entra depois dos porões,
// ainda a bordo, antes da volta.
const PHOTO_PLACE_ORDER: Record<string, number> = {
  "carregamento do caminhão": 10,
  "embarque de material": 20,
  "navio": 30,
  "desembarque do navio": 900,
  "desembarque de material": 900,
  "descarregamento do caminhão": 910,
};

export function photoPlaceRank(label: string | null, customOrder = 0): number {
  const l = (label || "").trim().toLowerCase();
  if (!l || l === "geral") return 0;
  const m = l.match(/por[aã]o\s*#?\s*(\d+)/);
  if (m) return 100 + Number(m[1]);
  return PHOTO_PLACE_ORDER[l] ?? 500 + customOrder;
}

// "Porão 3" → "CARGO HOLD #3" (os relatórios de lavagem/fotos saem em inglês —
// vão pro agente/armador). Outros rótulos: caixa alta.
export function holdLabelEn(label: string | null, kind: ReportKindName): string {
  if (!label || label.trim().toLowerCase() === "geral") {
    return kind === "COSTADO" ? "HULL SIDE" : "GENERAL";
  }
  const m = label.match(/por[aã]o\s*#?\s*(\d+)/i);
  if (m) return `CARGO HOLD #${m[1]}`;
  return PHOTO_PLACE_EN[label.trim().toLowerCase()] || label.toUpperCase();
}

// "BEFORE CLEANING" / "BEFORE SCRAPING" / "BEFORE PAINTING" — a fase da foto
// nomeia o serviço do relatório.
export function stageEn(stage: string, kind: ReportKindName): string | null {
  const prefix: Record<string, string> = { ANTES: "BEFORE", DURANTE: "DURING", DEPOIS: "AFTER" };
  const p = prefix[stage];
  return p ? `${p} ${REPORT_KINDS[kind].stageEn}` : null;
}

export const HOLD_STATUS_EN: Record<string, string> = {
  PENDENTE: "Pending",
  EM_ANDAMENTO: "In progress",
  COMPLETO: "Complete",
};

export function formatDayMonthYear(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(String(iso).length === 10 ? `${iso}T12:00:00` : String(iso));
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR");
}

// A data do ETC vem do seletor de data (ISO yyyy-mm-dd) — na tela e no PDF ela
// sai em dd/mm/aaaa, igual à data do relatório. Relatório antigo tinha texto
// livre nesse campo: esse a gente mostra exatamente como foi digitado.
export function formatEtcDate(v: string | null | undefined): string {
  const s = String(v || "").trim();
  if (!s) return "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? formatDayMonthYear(s) : s;
}

// Nome do arquivo baixado. Sem barra (data) nem caractere que o Windows recusa.
export function reportFileName(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join(" - ")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

// Muitos navios já vêm cadastrados como "MV FULANO" — tira o prefixo antes de
// estampar "M/V", senão sai "M/V MV FULANO".
export function bareVesselName(name: string): string {
  return String(name || "").replace(/^m\/?v\.?\s+/i, "");
}
