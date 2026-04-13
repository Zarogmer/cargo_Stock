import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Map snake_case table names to Prisma model accessors
const TABLE_MAP: Record<string, string> = {
  users: "user",
  stock_items: "stockItem",
  stock_movements: "stockMovement",
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
  // Also support "profiles" alias -> reads from users table
  profiles: "user",
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

        return NextResponse.json({ data, error: null, count });
      }

      case "insert": {
        if (!spec.data) {
          return NextResponse.json(
            { data: null, error: { message: "No data provided for insert", code: "400" }, count: null },
            { status: 400 }
          );
        }

        // Handle updatedAt for tables that have it
        const insertData = { ...spec.data };

        const data = await model.create({ data: insertData });
        return NextResponse.json({ data, error: null, count: null });
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

        const updateData = { ...spec.data };
        // Set updated_at for tables that have it
        if ("updated_at" in (model.fields || {})) {
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
