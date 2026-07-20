import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canViewStockValue } from "@/lib/rbac";
import { canAccessTable, filterValueColumns, isValueColumn } from "@/lib/table-acl";
import type { Role } from "@/types/database";

// Map snake_case table names to Prisma model accessors
const TABLE_MAP: Record<string, string> = {
  users: "user",
  stock_items: "stockItem",
  stock_movements: "stockMovement",
  embark_kit_items: "embarkKitItem",
  employees: "employee",
  epis: "epi",
  epi_movements: "epiMovement",
  uniforms: "uniform",
  uniform_movements: "uniformMovement",
  tools: "tool",
  tool_movements: "toolMovement",
  mission_standard_items: "missionStandardItem",
  ships: "ship",
  login_logs: "loginLog",
  tool_requests: "toolRequest",
  product_links: "productLink",
  suppliers: "supplier",
  purchase_orders: "purchaseOrder",
  cards: "card",
  bank_accounts: "bankAccount",
  // Sistema financeiro
  job_functions: "jobFunction",
  job_function_rates: "jobFunctionRate",
  employee_function_rates: "employeeFunctionRate",
  jobs: "job",
  job_allocations: "jobAllocation",
  job_adjustments: "jobAdjustment",
  costado_period_status: "costadoPeriodStatus",
  boarding_situation_templates: "boardingSituationTemplate",
  pluxee_config: "pluxeeConfig",
  financial_statement_entries: "financialStatementEntry",
  employee_advances: "employeeAdvance",
  advance_discounts: "advanceDiscount",
  material_returns: "materialReturn",
  material_return_items: "materialReturnItem",
  // Also support "profiles" alias -> reads from users table
  profiles: "user",
  // WhatsApp
  whatsapp_messages: "whatsappMessage",
  // Marketing
  marketing_clients: "marketingClient",
};

interface QuerySpec {
  table: string;
  action: "select" | "insert" | "update" | "delete";
  select?: string;
  filters?: Array<{ column: string; op: string; value?: unknown; values?: unknown[] }>;
  order?: Array<{ column: string; ascending: boolean }>;
  limit?: number;
  data?: Record<string, unknown>;
  count?: string;
  head?: boolean;
}

// Parse select string to extract columns and relations
// e.g., "id, movement_type, stock_items(name)" -> { select: {...}, include: {...} }
function parseSelect(selectStr: string) {
  if (!selectStr || selectStr === "*") {
    return { prismaSelect: undefined, prismaInclude: undefined };
  }

  // Check if there are relations (parentheses)
  const hasRelations = selectStr.includes("(");
  if (!hasRelations) {
    // Simple column selection
    if (selectStr === "*") return { prismaSelect: undefined, prismaInclude: undefined };
    const cols = selectStr.split(",").map((c) => c.trim()).filter(Boolean);
    const select: Record<string, boolean> = {};
    cols.forEach((c) => { select[c] = true; });
    return { prismaSelect: select, prismaInclude: undefined };
  }

  // Has relations - parse them
  // e.g., "*, tools(name, asset_type)" or "id, movement_type, stock_items(name)"
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selectStr) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());

  const columns: string[] = [];
  const includes: Record<string, { select: Record<string, boolean> }> = {};

  for (const part of parts) {
    const relMatch = part.match(/^(\w+)\((.+)\)$/);
    if (relMatch) {
      const relationTable = relMatch[1]; // e.g., "stock_items", "tools", "epis"
      const relCols = relMatch[2].split(",").map((c) => c.trim());
      const relSelect: Record<string, boolean> = {};
      relCols.forEach((c) => { relSelect[c] = true; });
      // Use table name as Prisma relation field name (matching our schema)
      includes[relationTable] = { select: relSelect };
    } else if (part !== "*") {
      columns.push(part);
    }
  }

  // If we have "*" plus relations, use include (select all + include relations)
  const hasWildcard = selectStr.includes("*");
  if (hasWildcard) {
    return {
      prismaSelect: undefined,
      prismaInclude: Object.keys(includes).length > 0 ? includes : undefined,
    };
  }

  // Specific columns + relations
  const select: Record<string, unknown> = {};
  columns.forEach((c) => { select[c] = true; });
  Object.entries(includes).forEach(([rel, val]) => { select[rel] = val; });

  return { prismaSelect: select, prismaInclude: undefined };
}

// Build Prisma where clause from filters
function buildWhere(filters: QuerySpec["filters"]) {
  if (!filters || filters.length === 0) return undefined;

  const where: Record<string, unknown> = {};
  for (const f of filters) {
    switch (f.op) {
      case "eq":
        where[f.column] = f.value;
        break;
      case "neq":
        where[f.column] = { not: f.value };
        break;
      case "gt":
        where[f.column] = { gt: f.value };
        break;
      case "gte":
        where[f.column] = { gte: f.value };
        break;
      case "lt":
        where[f.column] = { lt: f.value };
        break;
      case "lte":
        where[f.column] = { lte: f.value };
        break;
      case "in":
        where[f.column] = { in: f.values };
        break;
      case "notIn":
        where[f.column] = { notIn: f.values };
        break;
      case "like":
        where[f.column] = { contains: f.value, mode: "insensitive" };
        break;
    }
  }
  return where;
}

// Build Prisma orderBy from order spec
function buildOrderBy(order: QuerySpec["order"]) {
  if (!order || order.length === 0) return undefined;
  return order.map((o) => ({ [o.column]: o.ascending ? "asc" : "desc" }));
}

// Get Prisma model by table name
function getModel(tableName: string): any {
  const modelName = TABLE_MAP[tableName];
  if (!modelName) return null;
  return (prisma as any)[modelName];
}

// Quais campos de cada model são realmente DateTime no schema. Cacheado por
// tabela. Retorna null quando não dá pra resolver o model (fallback abaixo).
const dateTimeFieldsCache = new Map<string, Set<string> | null>();
function getDateTimeFields(tableName: string): Set<string> | null {
  if (dateTimeFieldsCache.has(tableName)) return dateTimeFieldsCache.get(tableName)!;
  const accessor = TABLE_MAP[tableName]; // ex.: "employee"
  let result: Set<string> | null = null;
  if (accessor) {
    // O accessor do Prisma é o nome do model com a 1ª letra minúscula —
    // reverter é só capitalizar (employee → Employee, jobAllocation → JobAllocation).
    const modelName = accessor.charAt(0).toUpperCase() + accessor.slice(1);
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
    if (model) {
      result = new Set(
        model.fields.filter((f) => f.type === "DateTime").map((f) => f.name),
      );
    }
  }
  dateTimeFieldsCache.set(tableName, result);
  return result;
}

// Converte strings "YYYY-MM-DD" em Date — MAS só para colunas que são DateTime
// no schema. Sem isso, colunas String que guardam data como texto (ex.:
// employees.last_aso_date, meio_ambiente_training) virariam Date e o Prisma
// rejeitaria o write inteiro. Quando o model não é resolvível, cai no
// comportamento antigo (converte tudo que parece data) pra não regredir.
function convertDates(tableName: string, data: Record<string, unknown>): Record<string, unknown> {
  const dtFields = getDateTimeFields(tableName);
  const result = { ...data };
  for (const key of Object.keys(result)) {
    const val = result[key];
    if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(val)) {
      if (!dtFields || dtFields.has(key)) {
        result[key] = new Date(val);
      }
    }
  }
  return result;
}

// Resolve o valor da alocação no servidor, com a MESMA regra que a Escalação e
// a aba Navios aplicam no cliente: override por pessoa (employee_function_rates)
// > default_rate da função.
//
// Por que isto existe: o cliente monta o `rate` lendo job_functions.default_rate
// e employee_function_rates.rate e grava o número em job_allocations. Ao esconder
// essas colunas de quem não é gestão (Gestor e RH, que são justamente quem
// escala), a conta do cliente cairia no `?? 0` e as alocações seriam criadas com
// rate 0 — zerando o Pagamento de Navios em silêncio. Então, para esses papéis,
// o rate enviado é ignorado e recalculado aqui.
async function resolveAllocationRate(data: Record<string, unknown>): Promise<number | null> {
  const functionId = Number(data.function_id);
  if (!Number.isFinite(functionId)) return null;

  const employeeId = Number(data.employee_id);
  if (Number.isFinite(employeeId)) {
    const override = await prisma.employeeFunctionRate.findUnique({
      where: { employee_id_function_id: { employee_id: employeeId, function_id: functionId } },
    });
    if (override) return Number(override.rate);
  }

  const fn = await prisma.jobFunction.findUnique({ where: { id: functionId } });
  return fn ? Number(fn.default_rate) : null;
}

// Tira as colunas de dinheiro do payload de escrita de quem não pode vê-las —
// silenciosamente, como o unit_value já fazia: no update a coluna fica com o
// valor que já tinha, em vez de quebrar o save inteiro. A exceção é
// job_allocations.rate, que é NOT NULL e portanto precisa de um valor no insert:
// aí o servidor resolve (ver resolveAllocationRate).
async function sanitizeWriteData(table: string, data: Record<string, unknown>): Promise<void> {
  if (table === "job_allocations") {
    // Só dá pra recalcular quando a função vem no payload. Ela vem em todos os
    // caminhos que gravam rate hoje (escalação de embarque/costado e navios);
    // um update que não mexe na função também não mexe no rate.
    const resolved = data.function_id !== undefined ? await resolveAllocationRate(data) : null;
    if (resolved !== null) data.rate = resolved;
    else delete data.rate;
    delete data.pluxee_value;
    delete data.extra_value;
    return;
  }

  for (const column of Object.keys(data)) {
    if (isValueColumn(table, column)) delete data[column];
  }
}

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json(
        { data: null, error: { message: "Unauthorized", code: "401" }, count: null },
        { status: 401 }
      );
    }

    const spec: QuerySpec = await request.json();
    const model = getModel(spec.table);
    const role = (session.user as { role?: Role }).role as Role;

    // Autorização por tabela (src/lib/table-acl.ts). Sem isto o gateway aceita
    // qualquer tabela do TABLE_MAP de qualquer papel — os gates de tela são só
    // de UI e não protegem um POST direto.
    if (!canAccessTable(role, spec.table, spec.action)) {
      return NextResponse.json(
        { data: null, error: { message: "Forbidden", code: "403" }, count: null },
        { status: 403 }
      );
    }

    // Colunas de dinheiro (unit_value, default_rate, rate, pluxee_value...):
    // quem não está em STOCK_VALUE_ROLES não lê nem grava. Vale na resposta e no
    // payload — assim um POST adulterado também não passa.
    const hideValues = !canViewStockValue(role);
    if (hideValues && spec.data) await sanitizeWriteData(spec.table, spec.data);

    if (!model) {
      return NextResponse.json(
        { data: null, error: { message: `Unknown table: ${spec.table}`, code: "404" }, count: null },
        { status: 404 }
      );
    }

    const where = buildWhere(spec.filters);
    const orderBy = buildOrderBy(spec.order);
    const { prismaSelect, prismaInclude } = parseSelect(spec.select || "*");

    switch (spec.action) {
      case "select": {
        if (spec.head && spec.count === "exact") {
          // Count-only query
          const count = await model.count({ where });
          return NextResponse.json({ data: null, error: null, count });
        }

        const queryArgs: any = { where, orderBy };
        if (prismaSelect) queryArgs.select = prismaSelect;
        if (prismaInclude) queryArgs.include = prismaInclude;
        if (spec.limit) queryArgs.take = spec.limit;

        let data;
        let count = null;

        if (spec.count === "exact") {
          [data, count] = await Promise.all([
            model.findMany(queryArgs),
            model.count({ where }),
          ]);
        } else {
          data = await model.findMany(queryArgs);
        }

        return NextResponse.json({ data: filterValueColumns(spec.table, data, role), error: null, count });
      }

      case "insert": {
        if (!spec.data) {
          return NextResponse.json(
            { data: null, error: { message: "No data provided for insert", code: "400" }, count: null },
            { status: 400 }
          );
        }

        const insertData = convertDates(spec.table, spec.data);

        const data = await model.create({ data: insertData });
        return NextResponse.json({ data: filterValueColumns(spec.table, data, role), error: null, count: null });
      }

      case "update": {
        if (!spec.data) {
          return NextResponse.json(
            { data: null, error: { message: "No data provided for update", code: "400" }, count: null },
            { status: 400 }
          );
        }

        if (!where || Object.keys(where).length === 0) {
          return NextResponse.json(
            { data: null, error: { message: "No filter provided for update", code: "400" }, count: null },
            { status: 400 }
          );
        }

        const updateData = convertDates(spec.table, spec.data);
        // Auto-set updated_at for tables that have it
        const TABLES_WITH_UPDATED_AT = [
          "stock_items", "users", "employees", "epis", "uniforms",
          "tools", "tool_requests", "product_links", "purchase_orders",
        ];
        if (TABLES_WITH_UPDATED_AT.includes(spec.table)) {
          updateData.updated_at = new Date();
        }

        const data = await model.updateMany({ where, data: updateData });
        return NextResponse.json({ data, error: null, count: null });
      }

      case "delete": {
        if (!where || Object.keys(where).length === 0) {
          return NextResponse.json(
            { data: null, error: { message: "No filter provided for delete", code: "400" }, count: null },
            { status: 400 }
          );
        }

        await model.deleteMany({ where });
        return NextResponse.json({ data: null, error: null, count: null });
      }

      default:
        return NextResponse.json(
          { data: null, error: { message: `Unknown action: ${spec.action}`, code: "400" }, count: null },
          { status: 400 }
        );
    }
  } catch (error: any) {
    console.error("DB API error:", error);
    return NextResponse.json(
      {
        data: null,
        error: {
          message: error.message || "Internal server error",
          code: error.code || "500",
          hint: error.meta?.cause || "",
        },
        count: null,
      },
      { status: 500 }
    );
  }
}
