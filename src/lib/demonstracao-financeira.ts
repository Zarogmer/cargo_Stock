/**
 * Mapa da planilha "Demonstração Financeira <ano> - CARGOSHIPS.xlsx" (fonte
 * oficial da diretoria, em SERVIDOR - Documentos/2 -DIRETORIA/05 - DEMONSTRATIVO
 * FINANCEIRO). Uma aba por mês; dentro da aba as seções ficam LADO A LADO, cada
 * uma num bloco de colunas Data/Descrição/Valor:
 *
 *   linha 4: título do grupo   ("6) DESPESAS DO ESCRITÓRIO")
 *   linha 5: título da seção   ("6.1 Infraestrutura (água, luz, net, aluguel...)")
 *   linha 6: cabeçalho         (Data | Descrição | Valor)
 *   linha 7: TOTAIS            (usada só pra conferir a soma na importação)
 *   linha 8+: os lançamentos   (com buracos: há linhas em branco no meio)
 *
 * Este arquivo é a fonte única desse mapa: o importador
 * (scripts/import-demonstracao-financeira.ts) usa as colunas, e a tela
 * (Financeiro › Demonstração Financeira) usa os rótulos e a ordem.
 */

export interface StatementSection {
  /** Chave gravada em financial_statement_entries.section. */
  key: string;
  /** Rótulo da seção, igual ao da planilha. */
  label: string;
  /** Rótulo curto, pro filtro não ficar quilométrico. */
  shortLabel: string;
  /** Grupo (o título em negrito da linha 4 da planilha). */
  group: string;
  /** Coluna (1-based) da Data no bloco. */
  dateCol: number;
  /** Coluna (1-based) da Descrição/Histórico/Nome/Navio/Sócio. */
  descCol: number;
  /** Coluna (1-based) do Valor. */
  valueCol: number;
  /**
   * Coluna (1-based) onde o título da seção aparece na linha 5. Na maioria dos
   * blocos é a própria coluna da Data; na Folha, que empilha três colunas de
   * valor sob uma Data só, o título de cada uma fica sobre o seu Valor.
   */
  titleCol: number;
}

export const STATEMENT_GROUPS = [
  "6) Despesas do Escritório",
  "7) Impostos/Encargos e Taxas",
  "8) Despesas Operacionais",
  "9) Folha de Pagamento",
  "10-12) Despesas Diversas",
] as const;

// Colunas conferidas célula a célula na planilha de 2026 (idênticas nos 12
// meses — a conferência de cabeçalho roda a cada import).
export const STATEMENT_SECTIONS: StatementSection[] = [
  // 6) DESPESAS DO ESCRITÓRIO — B..P
  { key: "6.1", label: "6.1 Infraestrutura (água, luz, net, aluguel...)", shortLabel: "Infraestrutura", group: STATEMENT_GROUPS[0], dateCol: 2, descCol: 3, valueCol: 4, titleCol: 2 },
  { key: "6.2", label: "6.2 Fornecedores e Prestadores de Serviço", shortLabel: "Fornecedores e Prestadores", group: STATEMENT_GROUPS[0], dateCol: 6, descCol: 7, valueCol: 8, titleCol: 6 },
  { key: "6.3", label: "6.3 Consultorias e Processos", shortLabel: "Consultorias e Processos", group: STATEMENT_GROUPS[0], dateCol: 10, descCol: 11, valueCol: 12, titleCol: 10 },
  { key: "6.4", label: "6.4 Diversos", shortLabel: "Diversos", group: STATEMENT_GROUPS[0], dateCol: 14, descCol: 15, valueCol: 16, titleCol: 14 },
  // 7) Impostos/Encargos e Taxas — R..T
  { key: "7.1", label: "7.1 Impostos/Encargos e Taxas", shortLabel: "Impostos e Taxas", group: STATEMENT_GROUPS[1], dateCol: 18, descCol: 19, valueCol: 20, titleCol: 18 },
  // 8) DESPESAS OPERACIONAIS — V..X
  { key: "8.1", label: "8.1 Navio", shortLabel: "Navio", group: STATEMENT_GROUPS[2], dateCol: 22, descCol: 23, valueCol: 24, titleCol: 22 },
  // 9) FOLHA DE PAGAMENTO — Z (data), AA (nome) e três colunas de valor. Cada
  // coluna de valor vira uma seção própria, com a numeração da própria planilha.
  { key: "9.1", label: "9.1 Salário Enc. e Ben.", shortLabel: "Salário Enc. e Ben.", group: STATEMENT_GROUPS[3], dateCol: 26, descCol: 27, valueCol: 28, titleCol: 28 },
  { key: "9.2", label: "9.2 Férias", shortLabel: "Férias", group: STATEMENT_GROUPS[3], dateCol: 26, descCol: 27, valueCol: 29, titleCol: 29 },
  { key: "9.3", label: "9.3 Prêmios e Gratificações", shortLabel: "Prêmios e Gratificações", group: STATEMENT_GROUPS[3], dateCol: 26, descCol: 27, valueCol: 30, titleCol: 30 },
  // DESPESAS DIVERSAS — AG..AO
  { key: "10", label: "10 Distribuição aos Sócios", shortLabel: "Distribuição aos Sócios", group: STATEMENT_GROUPS[4], dateCol: 33, descCol: 34, valueCol: 35, titleCol: 33 },
  { key: "11", label: "11 Despesas com Patrimônio", shortLabel: "Despesas com Patrimônio", group: STATEMENT_GROUPS[4], dateCol: 36, descCol: 37, valueCol: 38, titleCol: 36 },
  { key: "12", label: "12 Seguros e Sinistros", shortLabel: "Seguros e Sinistros", group: STATEMENT_GROUPS[4], dateCol: 39, descCol: 40, valueCol: 41, titleCol: 39 },
];

export const SECTION_BY_KEY = new Map(STATEMENT_SECTIONS.map((s) => [s.key, s]));

/** Nomes das abas na planilha, na ordem — o índice + 1 é o mês. */
export const SHEET_MONTHS = [
  "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
  "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
];

export const MONTH_LABELS = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

/** Linha do primeiro lançamento (abaixo do cabeçalho e da linha de TOTAIS). */
export const FIRST_DATA_ROW = 8;
/** Linha do TOTAIS de cada bloco — conferida contra a soma importada. */
export const TOTALS_ROW = 7;
/** Linha do título de cada seção — conferida pra planilha não mudar sem avisar. */
export const SECTION_TITLE_ROW = 5;
