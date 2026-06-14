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

// RBAC matrix - same as your Python app
const PERMISSIONS: Record<Role, Partial<Record<Module, Permission[]>>> = {
  GESTOR: {
    DASHBOARD: ["view"],
    ALMOXARIFADO: ["view"],
    EMBARQUE: ["view", "embarcar"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "baixar"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    ELETRICA: ["view", "create", "edit", "delete", "baixar"],
    NAVIOS: ["view", "create", "edit", "delete"],
    MARKETING: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
    // Mensagens fica restrito a Tecnologia, Executivo e Financeiro (pedido do
    // usuário) — Gestor e RH não enxergam mais a aba.
    CONVERSAS: ["view", "create"],
  },
  EXECUTIVO: {
    DASHBOARD: ["view"],
    ALMOXARIFADO: ["view"],
    EMBARQUE: ["view"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "baixar"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    ELETRICA: ["view", "create", "edit", "delete", "baixar"],
    NAVIOS: ["view", "create", "edit", "delete"],
    MARKETING: ["view", "create", "edit", "delete"],
    // Financeiro é só leitura pra Executivo — quem edita valores é Financeiro
    // e Tecnologia. Pedido da Sandra: controle total dela, Executivo vê tudo
    // sem chance de mexer (sem exceção).
    FINANCEIRO_MOD: ["view"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
    MENSAGENS: ["view", "create"],
    CONVERSAS: ["view", "create"],
  },
  MANUTENCAO: {
    DASHBOARD: ["view"],
    ALMOXARIFADO: ["view"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "baixar"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    ELETRICA: ["view", "create", "edit", "delete", "baixar"],
    NAVIOS: ["view"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
  },
  FINANCEIRO: {
    DASHBOARD: ["view"],
    ALMOXARIFADO: ["view"],
    EMBARQUE: ["view"],
    ESTOQUE: ["view"],
    EPI: ["view"],
    FERRAMENTAS: ["view"],
    MAQUINARIO: ["view"],
    ELETRICA: ["view"],
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
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    // Almoxarifado unificado: RH passa a gerenciar também Estoque, Ferramentas
    // e Maquinário (antes só via EPI/Uniforme).
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "baixar"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    ELETRICA: ["view", "create", "edit", "delete", "baixar"],
    NAVIOS: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view"],
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
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    ELETRICA: ["view", "create", "edit", "delete", "baixar"],
    NAVIOS: ["view", "create", "edit", "delete"],
    MARKETING: ["view", "create", "edit", "delete"],
    FINANCEIRO_MOD: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
    WHATSAPP: ["view", "edit"],
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
// RH (acesso só-leitura em Solicitações) também não entra nessa lista.
// Fonte única: o menu (rbac) e a própria página de Solicitações filtram por isto.
export const COMPRAS_ROLES: Role[] = ["GESTOR", "EXECUTIVO", "TECNOLOGIA", "FINANCEIRO"];

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
      { label: "Embarque", href: "/escalacao/estoque" },
    ],
  },
  {
    label: "Almoxarifado",
    href: "/almoxarifado",
    icon: "estoque",
    module: "ALMOXARIFADO",
    children: [
      // Rancho, EPI, Uniforme, Maquinário, Ferramenta e Elétrica deixaram de ser
      // itens do menu: viraram abas internas da própria aba "Estoque" (barra de
      // abas no topo da página). Links antigos (?tab=rancho, ?tab=epi, …) seguem
      // válidos — a página os abre já na aba interna certa. Aqui ficam só os
      // níveis externos: Estoque (que agrupa o inventário), Compras e Histórico.
      { label: "Estoque", href: "/almoxarifado?tab=estoque" },
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
      {
        label: "Documentos",
        href: "/colaboradores?tab=documentos",
        children: [
          { label: "DDS", href: "/colaboradores?tab=documentos&doc=dds" },
          { label: "Ficha de EPI", href: "/colaboradores?tab=documentos&doc=ficha-epi" },
          { label: "Aviso Médico", href: "/colaboradores?tab=documentos&doc=aviso-medico" },
          { label: "Recibo de Pagamento", href: "/colaboradores?tab=documentos&doc=recibo-pagamento" },
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
      { label: "Lista de Produtos", href: "/solicitacoes?tab=produtos", roles: ["TECNOLOGIA"] },
      { label: "Fornecedores", href: "/solicitacoes?tab=fornecedores" },
    ],
  },
  {
    label: "Financeiro",
    href: "/financeiro",
    icon: "financeiro",
    module: "FINANCEIRO_MOD",
    children: [
      { label: "Valores", href: "/financeiro?tab=funcoes" },
      { label: "Pagamento de Embarque", href: "/financeiro?tab=embarque" },
      { label: "Pagamento de Costado", href: "/financeiro?tab=costado" },
      { label: "Controle", href: "/financeiro?tab=controle" },
      { label: "Resumo", href: "/financeiro?tab=resumo" },
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
