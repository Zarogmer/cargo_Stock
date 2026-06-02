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
    FERRAMENTAS: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    NAVIOS: ["view", "create", "edit", "delete"],
    MARKETING: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
    MENSAGENS: ["view", "create"],
    CONVERSAS: ["view", "create"],
  },
  EXECUTIVO: {
    DASHBOARD: ["view"],
    ALMOXARIFADO: ["view"],
    EMBARQUE: ["view"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
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
    FERRAMENTAS: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
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
    NAVIOS: ["view", "create", "edit", "delete"],
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
    FERRAMENTAS: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    NAVIOS: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view"],
    MENSAGENS: ["view", "create"],
    CONVERSAS: ["view", "create"],
  },
  TECNOLOGIA: {
    DASHBOARD: ["view"],
    ALMOXARIFADO: ["view"],
    EMBARQUE: ["view", "embarcar"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
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
      // "Estoque" = materiais do galpão (inventário com quantidade). "Rancho" =
      // comida por equipe (antiga aba "Estoque"). A antiga aba "Ferramentas"
      // (empréstimo) foi substituída pelo Estoque; o empréstimo segue em Maquinário.
      { label: "Estoque", href: "/almoxarifado?tab=estoque" },
      { label: "Rancho", href: "/almoxarifado?tab=rancho" },
      { label: "EPI", href: "/almoxarifado?tab=epi" },
      { label: "Uniforme", href: "/almoxarifado?tab=uniforme" },
      { label: "Maquinário", href: "/almoxarifado?tab=maquinario" },
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
