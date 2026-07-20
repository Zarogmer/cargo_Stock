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
