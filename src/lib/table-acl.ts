// Autorização por TABELA do gateway genérico /api/db.
//
// Todo o CRUD do front passa por /api/db (src/lib/db.ts), que até então só
// checava "existe sessão". Como os gates de tela são só de UI (hasPermission
// escondendo aba/botão), qualquer usuário logado podia ler/gravar qualquer
// tabela com um POST direto. Este mapa move a checagem pro servidor, no mesmo
// espírito do requireFinance (src/lib/financeiro-api.ts).
//
// Regra: tabela SEM política aqui continua liberada pra qualquer sessão — o
// mesmo comportamento de antes. A lista abaixo cobre as tabelas que só são
// lidas/escritas por telas de um módulo específico, onde negar não quebra nada.
// As tabelas de uso amplo (employees, job_functions, job_allocations...) são
// lidas legitimamente por telas de papel baixo (Dashboard, Almoxarifado,
// Escalação); nelas o sensível é a COLUNA (rate, default_rate, pluxee_value), e
// isso é tratado à parte no filtro de colunas do /api/db.
//
// Atenção ao escolher a `permission` de escrita: nem todo módulo tem
// create/edit/delete. EMBARQUE, por exemplo, só tem ["view", "embarcar"] — por
// isso cada entrada declara a permissão explicitamente em vez de derivar da
// ação.

import {
  hasPermission,
  canViewStockValue,
  COMPRAS_ROLES,
  FINANCEIRO_BANCO_ROLES,
  type Module,
  type Permission,
} from "@/lib/rbac";
import type { Role } from "@/types/database";

// Quem pode passar: ou uma permissão da matriz PERMISSIONS, ou uma lista de
// papéis já existente (COMPRAS_ROLES, FINANCEIRO_BANCO_ROLES...).
type Access = { module: Module; permission: Permission } | { roles: readonly Role[] };

interface TablePolicy {
  read: Access;
  write: Access;
}

const FINANCEIRO_VIEW: Access = { module: "FINANCEIRO_MOD", permission: "view" };
const FINANCEIRO_EDIT: Access = { module: "FINANCEIRO_MOD", permission: "edit" };
const BANCO: Access = { roles: FINANCEIRO_BANCO_ROLES };
const COMPRAS: Access = { roles: COMPRAS_ROLES };

export const TABLE_ACL: Record<string, TablePolicy> = {
  // --- Financeiro: lidas só por /financeiro ---------------------------------
  // Estágio tem FINANCEIRO_MOD: ["view"], então lê mas não grava — que é
  // exatamente a regra pedida (Estágio não mexe em salário/vale).
  employee_advances: { read: FINANCEIRO_VIEW, write: FINANCEIRO_EDIT },
  advance_discounts: { read: FINANCEIRO_VIEW, write: FINANCEIRO_EDIT },
  job_function_rates: { read: FINANCEIRO_VIEW, write: FINANCEIRO_EDIT },
  pluxee_config: { read: FINANCEIRO_VIEW, write: FINANCEIRO_EDIT },

  // Demonstração Financeira: folha e distribuição aos sócios da empresa
  // inteira. Restrita como o módulo bancário — Estágio fica de fora.
  financial_statement_entries: { read: BANCO, write: BANCO },

  // --- Bancos e compras ----------------------------------------------------
  // cards/bank_accounts são lidos em DOIS lugares: o módulo bancário e o
  // "Nova Compra" do Controle (seletor de cartão + cadastro de cartão no
  // próprio modal). Por isso a LEITURA segue COMPRAS_ROLES, e não
  // FINANCEIRO_BANCO_ROLES — senão Gestor/RH/Estágio perdiam o seletor de
  // cartão ao registrar uma compra. O que muda: Manutenção, que hoje carrega
  // as duas tabelas ao abrir /solicitacoes, deixa de ler.
  cards: { read: COMPRAS, write: COMPRAS },
  // Já a ESCRITA em contas bancárias é do módulo bancário: no Controle o
  // cadastro novo é de cartão, nunca de conta.
  bank_accounts: { read: COMPRAS, write: BANCO },
  purchase_orders: { read: COMPRAS, write: COMPRAS },

  // --- Módulos próprios ----------------------------------------------------
  marketing_clients: { read: { module: "MARKETING", permission: "view" }, write: { module: "MARKETING", permission: "edit" } },
  whatsapp_messages: { read: { module: "CONVERSAS", permission: "view" }, write: { module: "CONVERSAS", permission: "create" } },
  // EMBARQUE não tem create/edit/delete — a permissão de escrita é "embarcar".
  costado_period_status: { read: { module: "EMBARQUE", permission: "view" }, write: { module: "EMBARQUE", permission: "embarcar" } },
};

// ─── Camada 2: colunas de valor ────────────────────────────────────────────
//
// Tabelas de uso amplo não dão pra barrar inteiras: employees, job_functions e
// job_allocations são lidas legitimamente pelo Dashboard, Almoxarifado,
// Escalação e Navios — e todos os 8 papéis têm o módulo EPI. O que é sensível
// ali é a COLUNA de dinheiro. Quem lê: STOCK_VALUE_ROLES (canViewStockValue),
// a mesma lista que já vê o valor do item no Almoxarifado.
//
// `unit_value` do almoxarifado entra aqui como mais um caso do mesmo mecanismo
// (antes era a constante UNIT_VALUE_TABLES + stripUnitValue na rota).
const VALUE_COLUMNS: Record<string, readonly string[]> = {
  stock_items: ["unit_value"],
  epis: ["unit_value"],
  uniforms: ["unit_value"],
  job_functions: ["default_rate"],
  employee_function_rates: ["rate"],
  // extra_value = valor de rateio; também é dinheiro do colaborador.
  job_allocations: ["rate", "pluxee_value", "extra_value"],
};

export function isValueColumn(table: string, column: string): boolean {
  return (VALUE_COLUMNS[table] ?? []).includes(column);
}

function strip(table: string, node: unknown): unknown {
  if (Array.isArray(node)) return node.map((n) => strip(table, n));
  if (!node || typeof node !== "object") return node;
  const cols = VALUE_COLUMNS[table] ?? [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (cols.includes(key)) continue;
    // Relação aninhada (`job_allocations(*, job_functions(...))`): o parseSelect
    // usa o nome da tabela como nome do campo, então a chave que bate com uma
    // tabela de VALUE_COLUMNS é uma relação e precisa ser filtrada também.
    out[key] = key in VALUE_COLUMNS ? strip(key, value) : value;
  }
  return out;
}

/**
 * Remove as colunas de dinheiro da resposta quando o papel não pode vê-las.
 * Percorre relações aninhadas. Aceita 1 registro ou uma lista.
 */
export function filterValueColumns(table: string, data: unknown, role: Role): unknown {
  if (canViewStockValue(role)) return data;
  return strip(table, data);
}

function allows(access: Access, role: Role): boolean {
  if ("roles" in access) return access.roles.includes(role);
  return hasPermission(role, access.module, access.permission);
}

/**
 * Diz se `role` pode executar `action` em `table` pelo gateway /api/db.
 * Tabela sem política declarada continua liberada (ver comentário do topo).
 */
export function canAccessTable(
  role: Role,
  table: string,
  action: "select" | "insert" | "update" | "delete",
): boolean {
  const policy = TABLE_ACL[table];
  if (!policy) return true;
  return allows(action === "select" ? policy.read : policy.write, role);
}
