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
  | "FINANCEIRO_MOD";

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
  },
  EXECUTIVO: {
    DASHBOARD: ["view"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    NAVIOS: ["view", "create", "edit", "delete"],
    FINANCEIRO_MOD: ["view"],
  },
  MANUTENCAO: {
    DASHBOARD: ["view"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    NAVIOS: ["view"],
  },
  FINANCEIRO: {
    DASHBOARD: ["view"],
    ESTOQUE: ["view"],
    EPI: ["view"],
    NAVIOS: ["view"],
    FINANCEIRO_MOD: ["view"],
  },
  RH: {
    DASHBOARD: ["view"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    NAVIOS: ["view"],
  },
  TECNOLOGIA: {
    DASHBOARD: ["view"],
    EMBARQUE: ["view", "embarcar"],
    ESTOQUE: ["view", "create", "edit", "delete", "baixar"],
    EPI: ["view", "create", "edit", "delete", "entregar", "devolver"],
    FERRAMENTAS: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    MAQUINARIO: ["view", "create", "edit", "delete", "emprestar", "devolver", "manutencao"],
    NAVIOS: ["view", "create", "edit", "delete"],
    FINANCEIRO_MOD: ["view"],
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
}

export const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/", icon: "dashboard", module: "DASHBOARD" },
  { label: "Navios", href: "/navios", icon: "navios", module: "NAVIOS" },
  { label: "Embarque", href: "/embarque", icon: "embarque", module: "EMBARQUE" },
  { label: "Estoque", href: "/estoque", icon: "estoque", module: "ESTOQUE" },
  { label: "Colaboradores", href: "/colaboradores", icon: "epi", module: "EPI" },
  { label: "Equipamentos", href: "/equipamentos", icon: "equipamentos", module: "FERRAMENTAS" },
  { label: "Financeiro", href: "/financeiro", icon: "financeiro", module: "FINANCEIRO_MOD" },
];

export function getNavItemsForRole(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => hasModuleAccess(role, item.module));
}
