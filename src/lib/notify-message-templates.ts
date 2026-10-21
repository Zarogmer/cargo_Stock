// Texto editável dos avisos automáticos do WhatsApp (cards "Lista de embarque",
// "Retorno de material" e "Compras registradas" em Mensagens). O modelo fica em
// app_settings junto com o resto da config (NotifyConfig.<aviso>.template);
// null = usa o padrão daqui, que reproduz o texto que as rotas montavam fixo.
//
// Módulo puro (sem Prisma): as rotas renderizam com os dados reais e a aba
// Mensagens renderiza com os dados de exemplo pra mostrar a prévia.
//
// Regras do modelo:
//   • {variavel} é trocada pelo valor (lista abaixo de cada aviso).
//   • Linha com alguma variável VAZIA some inteira (ex.: sem fornecedor, some a
//     linha "🏪 Fornecedor: ...").
//   • [ trecho ] é opcional dentro da linha: some se alguma variável dentro
//     dele estiver vazia; senão sai sem os colchetes.
//   • Linhas em branco repetidas viram uma só.

export type NotifyTemplateKind = "embarqueLista" | "retornoMaterial" | "compraRegistrada";

export interface TemplateVar {
  key: string;
  desc: string;
}

// Um cenário de exemplo pra prévia (ex.: "Enviar lista" x "Embarcar").
export interface TemplateSample {
  label: string;
  vars: Record<string, string>;
}

export interface TemplateSpec {
  defaultTemplate: string;
  vars: TemplateVar[];
  samples: TemplateSample[];
}

export const MAX_TEMPLATE_LENGTH = 4000;

export const NOTIFY_TEMPLATES: Record<NotifyTemplateKind, TemplateSpec> = {
  embarqueLista: {
    defaultTemplate: [
      "{titulo}",
      "",
      "🚢 Navio: *{navio}*[ · {equipe}]",
      "",
      "🧰 *Materiais ({qtd_materiais})*",
      "{materiais}",
      "",
      "🛒 *Rancho ({qtd_rancho})*",
      "{rancho}",
      "",
      "👤 {acao} por: {enviado_por}",
    ].join("\n"),
    vars: [
      { key: "titulo", desc: "📦 *Lista de embarque* (botão Enviar lista) ou ⚓ *Embarque confirmado* (botão Embarcar)" },
      { key: "navio", desc: "nome do navio" },
      { key: "equipe", desc: "Equipe 1, Equipe 2, Equipe Turbo..." },
      { key: "qtd_materiais", desc: "quantos materiais" },
      { key: "materiais", desc: "lista dos materiais com quantidade (uma linha por item)" },
      { key: "qtd_rancho", desc: "quantos itens de rancho" },
      { key: "rancho", desc: "lista do rancho — vazia pros grupos de Manutenção" },
      { key: "acao", desc: "Enviado ou Embarcado" },
      { key: "enviado_por", desc: "quem apertou o botão" },
    ],
    samples: [
      {
        label: "Enviar lista",
        vars: {
          titulo: "📦 *Lista de embarque*",
          navio: "MV OCEAN STAR",
          equipe: "Equipe 1",
          qtd_materiais: "3",
          materiais: "• MANGUEIRA 1\" — 2 un\n• VASSOURA — 10 un\n• DETERGENTE — 20 L",
          qtd_rancho: "2",
          rancho: "• ARROZ — 10 kg\n• FEIJÃO — 5 kg",
          acao: "Enviado",
          enviado_por: "Guilherme",
        },
      },
      {
        label: "Embarcar",
        vars: {
          titulo: "⚓ *Embarque confirmado*",
          navio: "MV OCEAN STAR",
          equipe: "Equipe 1",
          qtd_materiais: "3",
          materiais: "• MANGUEIRA 1\" — 2 un\n• VASSOURA — 10 un\n• DETERGENTE — 20 L",
          qtd_rancho: "2",
          rancho: "• ARROZ — 10 kg\n• FEIJÃO — 5 kg",
          acao: "Embarcado",
          enviado_por: "Guilherme",
        },
      },
      {
        label: "Grupo Manutenção",
        vars: {
          titulo: "📦 *Lista de embarque*",
          navio: "MV OCEAN STAR",
          equipe: "Equipe 1",
          qtd_materiais: "3",
          materiais: "• MANGUEIRA 1\" — 2 un\n• VASSOURA — 10 un\n• DETERGENTE — 20 L",
          qtd_rancho: "",
          rancho: "",
          acao: "Enviado",
          enviado_por: "Guilherme",
        },
      },
    ],
  },
  retornoMaterial: {
    defaultTemplate: [
      "{titulo}",
      "",
      "🚢 Navio: *{navio}*[ · {equipe}]",
      "",
      "✔️ Voltou em bom estado: {voltou_bem}",
      "",
      "{ocorrencias}",
      "",
      "📝 {observacao}",
      "",
      "👤 Conferido por: {conferido_por}",
    ].join("\n"),
    vars: [
      { key: "titulo", desc: "🛠️ *Retorno de material* (botão Enviar quebrados) ou ✅ *Retorno confirmado* (Confirmar Retorno)" },
      { key: "navio", desc: "nome do navio" },
      { key: "equipe", desc: "Equipe 1, Equipe 2, Equipe Turbo..." },
      { key: "voltou_bem", desc: "quantos itens voltaram bons — só no Confirmar Retorno" },
      { key: "ocorrencias", desc: "seções ❌ Perdido / 🛢️ Insumo / 🔧 Avariado com os itens" },
      { key: "observacao", desc: "observação digitada na conferência" },
      { key: "conferido_por", desc: "quem conferiu" },
    ],
    samples: [
      {
        label: "Enviar quebrados",
        vars: {
          titulo: "🛠️ *Retorno de material*",
          navio: "MV OCEAN STAR",
          equipe: "Equipe 1",
          voltou_bem: "",
          ocorrencias: "❌ *Perdido (1)*\n• *VASSOURA* — 2 un\n\n🔧 *Avariado (1)*\n• *MANGUEIRA 1\"* — 1 un — furada",
          observacao: "",
          conferido_por: "Guilherme",
        },
      },
      {
        label: "Confirmar Retorno",
        vars: {
          titulo: "✅ *Retorno confirmado*",
          navio: "MV OCEAN STAR",
          equipe: "Equipe 1",
          voltou_bem: "18 itens",
          ocorrencias: "❌ *Perdido (1)*\n• *VASSOURA* — 2 un",
          observacao: "Faltou uma vassoura na conferência",
          conferido_por: "Guilherme",
        },
      },
    ],
  },
  compraRegistrada: {
    defaultTemplate: [
      "🛒 *{titulo}*",
      "",
      "🏪 Fornecedor: *{fornecedor}*",
      "📅 Data: {data}",
      "🚢 Navio: {navio}",
      "💳 Pagamento: {pagamento}",
      "",
      "{itens}",
      "",
      "💰 *Total: {total}*",
      "",
      "👤 Registrado por: {registrado_por}",
    ].join("\n"),
    vars: [
      { key: "titulo", desc: "Compra registrada, ou \"3 compras registradas\" quando é uma nota com vários itens" },
      { key: "fornecedor", desc: "fornecedor da compra" },
      { key: "data", desc: "data da compra (DD/MM/AAAA)" },
      { key: "navio", desc: "navio da compra, se tiver" },
      { key: "pagamento", desc: "PIX, CARTÃO, FATURADO com os vencimentos..." },
      { key: "itens", desc: "lista dos itens com valor (uma linha por item)" },
      { key: "qtd_itens", desc: "quantos itens" },
      { key: "total", desc: "valor total (R$)" },
      { key: "registrado_por", desc: "quem salvou a compra" },
    ],
    samples: [
      {
        label: "Nota com 3 itens",
        vars: {
          titulo: "3 compras registradas",
          fornecedor: "CASA DAS FERRAGENS LTDA",
          data: "20/10/2026",
          navio: "",
          pagamento: "FATURADO 19/11, 19/12",
          itens: "• LUVA NITRÍLICA — 10 × R$ 12,50 = R$ 125,00\n• FITA ISOLANTE — R$ 8,90\n• DISCO DE CORTE — 5 × R$ 7,00 = R$ 35,00",
          qtd_itens: "3",
          total: "R$ 168,90",
          registrado_por: "Guilherme",
        },
      },
    ],
  },
};

// Valor da variável (vazio quando não existe ou é só espaço).
function valueOf(vars: Record<string, string | null | undefined>, key: string): string {
  const v = vars[key];
  return v == null ? "" : String(v);
}

const VAR_RE = /\{([a-z_]+)\}/g;

function hasEmptyVar(text: string, vars: Record<string, string | null | undefined>): boolean {
  for (const m of text.matchAll(VAR_RE)) {
    if (!valueOf(vars, m[1]).trim()) return true;
  }
  return false;
}

// Monta o texto final a partir do modelo (ver regras no topo do arquivo).
export function renderNotifyTemplate(
  template: string,
  vars: Record<string, string | null | undefined>,
): string {
  const out: string[] = [];
  for (const rawLine of template.replace(/\r\n?/g, "\n").split("\n")) {
    // Trechos opcionais [ ... ] primeiro: somem se tiverem variável vazia.
    const line = rawLine.replace(/\[([^\[\]]*)\]/g, (_, inner: string) =>
      hasEmptyVar(inner, vars) ? "" : inner,
    );
    if (hasEmptyVar(line, vars)) continue;
    out.push(line.replace(VAR_RE, (_, key: string) => valueOf(vars, key)));
  }
  return out
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Modelo salvo (se houver) ou o padrão do aviso.
export function notifyTemplateFor(kind: NotifyTemplateKind, saved: string | null | undefined): string {
  return saved && saved.trim() ? saved : NOTIFY_TEMPLATES[kind].defaultTemplate;
}
