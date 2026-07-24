import type { Role } from "@/types/database";

// Module identifiers
export type Module =
  | "DASHBOARD"
  | "EMBARQUE"
  | "ALMOXARIFADO"
  | "ESTOQUE"
  | "EPI"
  | "FERRAMENTAS"
  | "MAQUINARIO"
  | "ELETRICA"
  | "NAVIOS"
  | "MARKETING"
  | "FINANCEIRO_MOD"
  | "SOLICITACOES"
  | "WHATSAPP"
  | "MENSAGENS"
  | "CONVERSAS";

// Permission actions
export type Permission =
  | "view"
  | "create"
  | "edit"
  | "delete"
  | "baixar"
  | "entregar"
  | "devolver"
  | "embarcar"
  | "emprestar"
  | "manutencao";

// EXECUTIVO e COMERCIAL têm exatamente as MESMAS permissões — "Comercial" é só
// uma categoria à parte no cadastro (mesmo padrão de ESTAGIO≈TECNOLOGIA, mas
// aqui sem nenhuma diferença). Definimos o bloco uma vez e reaproveitamos nos
// dois papéis, e toda lista de papéis abaixo que tem EXECUTIVO também traz
// COMERCIAL. Se as permissões do Executivo mudarem, o Comercial acompanha só.
const EXECUTIVO_PERMS: Partial<Record<Module, Permission[]>> = {
  DASHBOARD: ["view"],
  ALMOXARIFADO: ["view"],
  EMBARQUE: ["view", "embarcar"],
  ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
  EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
  FERRAMENTAS: ["view", "create", "edit", "delete", "baixar"],
  MAQUINARIO: ["view", "create", "edit", "delete", "baixar"],
  ELETRICA: ["view", "create", "edit", "delete", "baixar"],
  NAVIOS: ["view", "create", "edit", "delete"],
  MARKETING: ["view", "create", "edit", "delete"],
  // 2026-06: a pedido do Guilherme, Executivo e Financeiro passam a poder
  // editar tudo, menos a aba WhatsApp API. Antes o Financeiro era só-leitura
  // pro Executivo (pedido da Sandra) — essa restrição foi removida.
  FINANCEIRO_MOD: ["view", "create", "edit", "delete"],
  SOLICITACOES: ["view", "create", "edit", "delete"],
  MENSAGENS: ["view", "create"],
  CONVERSAS: ["view", "create"],
};

// RBAC matrix - same as your Python app
const PERMISSIONS: Record<Role, Partial<Record<Module, Permission[]>>> = {
  GESTOR: {
    DASHBOARD: ["view"],
    ALMOXARIFADO: ["view"],
    EMBARQUE: ["view", "embarcar"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "baixar"],
    MAQUINARIO: ["view", "create", "edit", "delete", "baixar"],
    ELETRICA: ["view", "create", "edit", "delete", "baixar"],
    NAVIOS: ["view", "create", "edit", "delete"],
    MARKETING: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
    // Mensagens fica restrito a Tecnologia, Executivo e Financeiro (pedido do
    // usuário) — Gestor e RH não enxergam mais a aba.
    CONVERSAS: ["view", "create"],
  },
  EXECUTIVO: EXECUTIVO_PERMS,
  // COMERCIAL = mesma permissão de EXECUTIVO (ver EXECUTIVO_PERMS acima).
  COMERCIAL: EXECUTIVO_PERMS,
  MANUTENCAO: {
    DASHBOARD: ["view"],
    ALMOXARIFADO: ["view"],
    // 2026-07: Manutenção opera o Embarque/Retorno (Controle). Só "embarcar",
    // SEM "view" — com "view" o menu Escalação (Costado/Embarque) apareceria.
    EMBARQUE: ["embarcar"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "baixar"],
    MAQUINARIO: ["view", "create", "edit", "delete", "baixar"],
    ELETRICA: ["view", "create", "edit", "delete", "baixar"],
    NAVIOS: ["view"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
  },
  FINANCEIRO: {
    DASHBOARD: ["view"],
    ALMOXARIFADO: ["view"],
    EMBARQUE: ["view", "embarcar"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "baixar"],
    MAQUINARIO: ["view", "create", "edit", "delete", "baixar"],
    ELETRICA: ["view", "create", "edit", "delete", "baixar"],
    NAVIOS: ["view", "create", "edit", "delete"],
    MARKETING: ["view", "create", "edit", "delete"],
    FINANCEIRO_MOD: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
    MENSAGENS: ["view", "create"],
    CONVERSAS: ["view", "create"],
  },
  RH: {
    DASHBOARD: ["view"],
    ALMOXARIFADO: ["view"],
    // 2026-06: a pedido do Guilherme, o RH passa a operar também Escalação
    // (EMBARQUE), Marketing e Controle (SOLICITACOES completo) — Navios já tinha.
    // A única restrição extra é a "Paga" do colaborador (valor por função), que
    // segue só pra Executivo/Tecnologia (ver canEditPaga em colaboradores/page).
    EMBARQUE: ["view", "embarcar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    // Almoxarifado unificado: RH passa a gerenciar também Estoque, Ferramentas
    // e Maquinário (antes só via EPI/Uniforme).
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "baixar"],
    MAQUINARIO: ["view", "create", "edit", "delete", "baixar"],
    ELETRICA: ["view", "create", "edit", "delete", "baixar"],
    NAVIOS: ["view", "create", "edit", "delete"],
    MARKETING: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
    // RH NÃO enxerga o Financeiro (pedido do Guilherme — revertido o acesso de
    // leitura que tinha sido dado em 2026-06).
    // Mensagens restrito a Tecnologia, Executivo e Financeiro — RH fica de fora.
    CONVERSAS: ["view", "create"],
  },
  TECNOLOGIA: {
    DASHBOARD: ["view"],
    ALMOXARIFADO: ["view"],
    EMBARQUE: ["view", "embarcar"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "baixar"],
    MAQUINARIO: ["view", "create", "edit", "delete", "baixar"],
    ELETRICA: ["view", "create", "edit", "delete", "baixar"],
    NAVIOS: ["view", "create", "edit", "delete"],
    MARKETING: ["view", "create", "edit", "delete"],
    FINANCEIRO_MOD: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
    WHATSAPP: ["view", "edit"],
    MENSAGENS: ["view", "create"],
    CONVERSAS: ["view", "create"],
  },
  // "Estágio" — mesmas permissões de TECNOLOGIA (pedido do Guilherme). Manter os
  // dois blocos em sincronia se as permissões da Tecnologia mudarem.
  ESTAGIO: {
    DASHBOARD: ["view"],
    ALMOXARIFADO: ["view"],
    EMBARQUE: ["view", "embarcar"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "baixar"],
    MAQUINARIO: ["view", "create", "edit", "delete", "baixar"],
    ELETRICA: ["view", "create", "edit", "delete", "baixar"],
    NAVIOS: ["view", "create", "edit", "delete"],
    MARKETING: ["view", "create", "edit", "delete"],
    // Estágio NÃO edita Financeiro nem a WhatsApp API — só visualiza (pedido do
    // Guilherme). Salários (Paga em Colaboradores + troca de função por navio no
    // Financeiro) também ficam fora — ver canEditPaga/canEditFunction.
    FINANCEIRO_MOD: ["view"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
    WHATSAPP: ["view"],
    MENSAGENS: ["view", "create"],
    CONVERSAS: ["view", "create"],
  },
};

export function hasPermission(
  role: Role,
  module: Module,
  permission: Permission
): boolean {
  const rolePerms = PERMISSIONS[role];
  if (!rolePerms) return false;
  const modulePerms = rolePerms[module];
  if (!modulePerms) return false;
  return modulePerms.includes(permission);
}

export function hasModuleAccess(role: Role, module: Module): boolean {
  return hasPermission(role, module, "view");
}

export function getAccessibleModules(role: Role): Module[] {
  const rolePerms = PERMISSIONS[role];
  if (!rolePerms) return [];
  return Object.keys(rolePerms) as Module[];
}

// Sidebar navigation items
export interface NavItem {
  label: string;
  href: string;
  icon: string;
  module: Module;
  children?: NavSubItem[];
}

export interface NavSubItem {
  label: string;
  href: string;
  // When set, only these roles see this sub-item. Omit to inherit the parent's
  // module visibility (default behaviour).
  roles?: Role[];
  // Optional nested entries. When present, the sub-item itself does not
  // navigate — clicking the label toggles the nested list open/closed.
  children?: NavSubItem[];
}

// Papéis que enxergam "Controle de Compras" (o registro/ledger de compras).
// Manutenção fica de fora de propósito: o pessoal de manutenção usa a aba
// Solicitações só pra PEDIR material — quem controla as compras é a gestão.
// 2026-06: RH foi liberado no Controle (ganhou SOLICITACOES completo), então
// passa a entrar também aqui.
// Fonte única: o menu (rbac) e a própria página de Solicitações filtram por isto.
export const COMPRAS_ROLES: Role[] = ["GESTOR", "EXECUTIVO", "COMERCIAL", "TECNOLOGIA", "ESTAGIO", "FINANCEIRO", "RH"];

// Papéis que enxergam "Lista de Produtos" (catálogo de produtos do Controle).
// Era exclusivo da Tecnologia; depois Executivo e Financeiro; em 2026-06 o RH
// também (acesso completo ao Controle).
export const PRODUTOS_ROLES: Role[] = ["TECNOLOGIA", "ESTAGIO", "EXECUTIVO", "COMERCIAL", "FINANCEIRO", "RH"];

// Papéis que enxergam "Fornecedores" (cadastro de fornecedores do Controle).
// Manutenção fica de fora (pedido de 2026-07): solicita material e opera o
// Embarque/Retorno, mas não gerencia o cadastro de fornecedores/produtos.
// Fonte única: o menu (rbac) e a página de Solicitações filtram por isto.
export const FORNECEDORES_ROLES: Role[] = ["GESTOR", "EXECUTIVO", "COMERCIAL", "TECNOLOGIA", "ESTAGIO", "FINANCEIRO", "RH"];

// Papéis que acessam o módulo bancário do Financeiro (Contas a Pagar,
// Conciliação Bancária, Boletos por e-mail e o Painel financeiro). Dados de
// banco/saldo/extrato são sensíveis — só Executivo, Financeiro e Tecnologia.
// Estágio, apesar de ver o resto do Financeiro (Valores/Pagamento de Navios),
// NÃO entra aqui. Fonte única: sidebar (roles nos sub-itens), páginas e as
// rotas de API (requireFinance) checam por esta lista.
export const FINANCEIRO_BANCO_ROLES: Role[] = ["EXECUTIVO", "COMERCIAL", "FINANCEIRO", "TECNOLOGIA"];

export function canAccessFinanceiroBanco(role: Role): boolean {
  return FINANCEIRO_BANCO_ROLES.includes(role);
}

// Papéis que enxergam o VALOR dos itens do Almoxarifado (Estoque, Ferramenta,
// Elétrica, Fluídos, Maquinário, EPI e Uniforme). Quanto custa cada item é
// informação de gestão — o operacional (Manutenção) e o RH/Estágio movimentam o
// estoque sem precisar ver preço. Fonte única: os painéis escondem a coluna e o
// /api/db remove a coluna `unit_value` da resposta pra quem não está aqui.
export const STOCK_VALUE_ROLES: Role[] = ["GESTOR", "EXECUTIVO", "COMERCIAL", "FINANCEIRO", "TECNOLOGIA"];

export function canViewStockValue(role: Role): boolean {
  return STOCK_VALUE_ROLES.includes(role);
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/", icon: "dashboard", module: "DASHBOARD" },
  { label: "Navios", href: "/navios", icon: "navios", module: "NAVIOS" },
  {
    label: "Marketing",
    href: "/marketing",
    icon: "marketing",
    module: "MARKETING",
    children: [
      { label: "Enviar email", href: "/marketing?tab=email" },
      { label: "Clientes", href: "/marketing?tab=clientes" },
    ],
  },
  {
    label: "Escalação",
    href: "/escalacao",
    icon: "embarque",
    module: "EMBARQUE",
    children: [
      { label: "Escalação de Costado", href: "/escalacao/costado" },
      { label: "Escalação de Embarque", href: "/escalacao/embarque" },
    ],
  },
  {
    label: "Almoxarifado",
    href: "/almoxarifado",
    icon: "estoque",
    module: "ALMOXARIFADO",
    children: [
      // "Estoque" agrupa, como submenu, todos os setores do inventário. Cada item
      // deep-linka pra aba interna certa via ?tab=<setor> — a página resolve isso
      // por ESTOQUE_KEYS (almoxarifado/page.tsx). O item-pai não navega: clicar
      // só abre/fecha a lista. Compras e Histórico seguem como níveis externos.
      {
        label: "Estoque",
        href: "/almoxarifado?tab=geral",
        children: [
          { label: "Geral", href: "/almoxarifado?tab=geral" },
          { label: "Utensílios", href: "/almoxarifado?tab=estoque" },
          { label: "Rancho", href: "/almoxarifado?tab=rancho" },
          { label: "Fluídos", href: "/almoxarifado?tab=fluidos" },
          { label: "Maquinário", href: "/almoxarifado?tab=maquinario" },
          { label: "Ferramenta", href: "/almoxarifado?tab=ferramenta" },
          { label: "Elétrica", href: "/almoxarifado?tab=eletrica" },
        ],
      },
      // "Funcionário" agrupa os itens entregues ao colaborador (EPI e Uniforme).
      {
        label: "Funcionário",
        href: "/almoxarifado?tab=epi",
        children: [
          { label: "EPI", href: "/almoxarifado?tab=epi" },
          { label: "Uniforme", href: "/almoxarifado?tab=uniforme" },
        ],
      },
      { label: "Compras", href: "/almoxarifado?tab=compras" },
      { label: "Histórico", href: "/almoxarifado?tab=historico" },
    ],
  },
  {
    label: "Rh",
    href: "/colaboradores",
    icon: "epi",
    module: "EPI",
    children: [
      { label: "Colaboradores", href: "/colaboradores?tab=colaboradores" },
      { label: "Funções", href: "/colaboradores?tab=funcoes" },
      {
        label: "Documentos",
        href: "/colaboradores?tab=documentos",
        children: [
          { label: "DDS", href: "/colaboradores?tab=documentos&doc=dds" },
          { label: "Ficha de EPI", href: "/colaboradores?tab=documentos&doc=ficha-epi" },
          { label: "Aviso Médico", href: "/colaboradores?tab=documentos&doc=aviso-medico" },
          { label: "Recibo de Pagamento", href: "/colaboradores?tab=documentos&doc=recibo-pagamento" },
          { label: "Folha de Ponto", href: "/colaboradores?tab=documentos&doc=folha-ponto" },
          { label: "Listagem", href: "/colaboradores?tab=documentos&doc=listagem" },
        ],
      },
    ],
  },
  {
    label: "Controle",
    href: "/solicitacoes",
    icon: "solicitacoes",
    module: "SOLICITACOES",
    children: [
      { label: "Solicitações", href: "/solicitacoes?tab=solicitacoes" },
      { label: "Controle de Compras", href: "/solicitacoes?tab=compras", roles: COMPRAS_ROLES },
      { label: "Lista de Produtos", href: "/solicitacoes?tab=produtos", roles: PRODUTOS_ROLES },
      { label: "Fornecedores", href: "/solicitacoes?tab=fornecedores", roles: FORNECEDORES_ROLES },
      // "Embarque" (loadout: kit de embarque + rancho) veio da Escalação. Mantém
      // a visibilidade de quem tinha EMBARQUE (Gestor não enxergava) — sem isso,
      // ao herdar SOLICITACOES ele passaria a ver a aba que baixa estoque. A
      // rota segue /escalacao/estoque. Manutenção entrou em 2026-07 (ganhou
      // "embarcar" no módulo EMBARQUE, sem "view").
      { label: "Embarque/Retorno", href: "/escalacao/estoque", roles: ["EXECUTIVO", "COMERCIAL", "FINANCEIRO", "RH", "TECNOLOGIA", "ESTAGIO", "MANUTENCAO"] },
    ],
  },
  {
    label: "Financeiro",
    href: "/financeiro",
    icon: "financeiro",
    module: "FINANCEIRO_MOD",
    children: [
      { label: "Valores", href: "/financeiro?tab=funcoes" },
      { label: "Pagamento de Navios", href: "/financeiro?tab=navios" },
      { label: "Controle de Funcionários", href: "/financeiro?tab=controle" },
      { label: "Relatório de Vales", href: "/financeiro?tab=vales" },
      // Módulo bancário (fornecedores/bancos) — sub-rotas reais, restritas a
      // FINANCEIRO_BANCO_ROLES (Estágio fica de fora). Ver docs/financeiro/.
      { label: "Contas a Pagar", href: "/financeiro/contas", roles: FINANCEIRO_BANCO_ROLES },
      { label: "Conciliação Bancária", href: "/financeiro/conciliacao", roles: FINANCEIRO_BANCO_ROLES },
      { label: "Boletos por e-mail", href: "/financeiro/email", roles: FINANCEIRO_BANCO_ROLES },
      // Espelho da planilha da diretoria. Restrita como o módulo bancário: traz
      // folha de pagamento e distribuição aos sócios da empresa inteira.
      { label: "Demonstração Financeira", href: "/financeiro?tab=demonstracao", roles: FINANCEIRO_BANCO_ROLES },
    ],
  },
  { label: "Conversas", href: "/conversas", icon: "conversas", module: "CONVERSAS" },
  { label: "Mensagens", href: "/mensagens", icon: "mensagens", module: "MENSAGENS" },
  { label: "WhatsApp API", href: "/whatsapp", icon: "whatsapp", module: "WHATSAPP" },
];

function filterSubItems(items: NavSubItem[] | undefined, role: Role): NavSubItem[] | undefined {
  if (!items) return undefined;
  return items
    .filter((c) => !c.roles || c.roles.includes(role))
    .map((c) => ({
      ...c,
      children: filterSubItems(c.children, role),
    }));
}

export function getNavItemsForRole(role: Role): NavItem[] {
  return NAV_ITEMS
    .filter((item) => hasModuleAccess(role, item.module))
    .map((item) => ({
      ...item,
      children: filterSubItems(item.children, role),
    }));
}
