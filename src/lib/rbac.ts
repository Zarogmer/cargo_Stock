import type { Role } from "@/types/database";

// Module identifiers
export type Module =
  | "DASHBOARD"
  | "EMBARQUE"
  | "ESTOQUE"
  | "EPI"
  | "FERRAMENTAS"
  | "MAQUINARIO"
  | "NAVIOS"
  | "FINANCEIRO_MOD"
  | "SOLICITACOES"
  | "WHATSAPP"
  | "MENSAGENS";

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
    EMBARQUE: ["view", "embarcar"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    NAVIOS: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
    WHATSAPP: ["view", "edit"],
    MENSAGENS: ["view", "create"],
  },
  EXECUTIVO: {
    DASHBOARD: ["view"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    NAVIOS: ["view", "create", "edit", "delete"],
    FINANCEIRO_MOD: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
    WHATSAPP: ["view", "edit"],
    MENSAGENS: ["view", "create"],
  },
  MANUTENCAO: {
    DASHBOARD: ["view"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    NAVIOS: ["view"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
  },
  FINANCEIRO: {
    DASHBOARD: ["view"],
    EMBARQUE: ["view"],
    ESTOQUE: ["view"],
    EPI: ["view"],
    FERRAMENTAS: ["view"],
    MAQUINARIO: ["view"],
    NAVIOS: ["view"],
    FINANCEIRO_MOD: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
  },
  RH: {
    DASHBOARD: ["view"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    NAVIOS: ["view"],
    SOLICITACOES: ["view"],
    WHATSAPP: ["view"],
    MENSAGENS: ["view", "create"],
  },
  TECNOLOGIA: {
    DASHBOARD: ["view"],
    EMBARQUE: ["view", "embarcar"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    NAVIOS: ["view", "create", "edit", "delete"],
    FINANCEIRO_MOD: ["view", "create", "edit", "delete"],
    SOLICITACOES: ["view", "create", "edit", "delete"],
    WHATSAPP: ["view", "edit"],
    MENSAGENS: ["view", "create"],
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
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/", icon: "dashboard", module: "DASHBOARD" },
  { label: "Navios", href: "/navios", icon: "navios", module: "NAVIOS" },
  {
    label: "Escalação",
    href: "/escalacao",
    icon: "embarque",
    module: "EMBARQUE",
    children: [
      { label: "Escalação de Costado", href: "/escalacao/costado" },
      { label: "Escalação de Embarque", href: "/escalacao/embarque" },
      { label: "Estoque para embarque", href: "/escalacao/estoque" },
    ],
  },
  { label: "Estoque", href: "/estoque", icon: "estoque", module: "ESTOQUE" },
  {
    label: "Rh",
    href: "/colaboradores",
    icon: "epi",
    module: "EPI",
    children: [
      { label: "Colaboradores", href: "/colaboradores?tab=colaboradores" },
      { label: "EPI", href: "/colaboradores?tab=epi" },
      { label: "Uniforme", href: "/colaboradores?tab=uniforme" },
      { label: "Histórico", href: "/colaboradores?tab=historico" },
    ],
  },
  {
    label: "Equipamentos",
    href: "/equipamentos",
    icon: "equipamentos",
    module: "FERRAMENTAS",
    children: [
      { label: "Ferramentas", href: "/equipamentos?tab=ferramentas" },
      { label: "Maquinário", href: "/equipamentos?tab=maquinario" },
      { label: "Histórico", href: "/equipamentos?tab=historico" },
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
      { label: "Funções e Valores", href: "/financeiro?tab=funcoes" },
      { label: "Trabalhos", href: "/financeiro?tab=trabalhos" },
      { label: "Faturar", href: "/financeiro?tab=faturar" },
      { label: "Resumo", href: "/financeiro?tab=resumo" },
    ],
  },
  { label: "Mensagens", href: "/mensagens", icon: "mensagens", module: "MENSAGENS" },
  { label: "WhatsApp", href: "/whatsapp", icon: "whatsapp", module: "WHATSAPP" },
];

export function getNavItemsForRole(role: Role): NavItem[] {
  return NAV_ITEMS
    .filter((item) => hasModuleAccess(role, item.module))
    .map((item) => ({
      ...item,
      children: item.children?.filter((c) => !c.roles || c.roles.includes(role)),
    }));
}
