/**
 * Client-side database query builder.
 * Drop-in replacement for Supabase client's .from() API.
 *
 * Usage:
 *   import { db } from "@/lib/db";
 *   const { data, error } = await db.from("stock_items").select("*").order("name");
 *   const { error } = await db.from("stock_items").insert({ name: "Test" });
 *   const { error } = await db.from("stock_items").update({ name: "New" }).eq("id", 1);
 *   const { error } = await db.from("stock_items").delete().eq("id", 1);
 */

interface Filter {
  column: string;
  op: string;
  value?: unknown;
  values?: unknown[];
}

interface OrderSpec {
  column: string;
  ascending: boolean;
}

interface QuerySpec {
  table: string;
  action: "select" | "insert" | "update" | "delete";
  select?: string;
  filters: Filter[];
  order: OrderSpec[];
  limit?: number;
  data?: Record<string, unknown>;
  count?: string;
  head?: boolean;
}

interface DbResult<T = any> {
  data: T[] | null;
  error: { message: string; code: string; hint?: string } | null;
  count: number | null;
}

class QueryBuilder<T = any> {
  private spec: QuerySpec;

  constructor(table: string) {
    this.spec = {
      table,
      action: "select",
      filters: [],
      order: [],
    };
  }

  select(columns: string = "*", opts?: { count?: string; head?: boolean }): this {
    this.spec.select = columns;
    if (opts?.count) this.spec.count = opts.count;
    if (opts?.head) this.spec.head = opts.head;
    return this;
  }

  insert(data: Record<string, unknown> | Record<string, unknown>[]): this {
    this.spec.action = "insert";
    this.spec.data = Array.isArray(data) ? data[0] : data;
    return this;
  }

  update(data: Record<string, unknown>): this {
    this.spec.action = "update";
    this.spec.data = data;
    return this;
  }

  delete(): this {
    this.spec.action = "delete";
    return this;
  }

  eq(column: string, value: unknown): this {
    this.spec.filters.push({ column, op: "eq", value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.spec.filters.push({ column, op: "neq", value });
    return this;
  }

  gt(column: string, value: unknown): this {
    this.spec.filters.push({ column, op: "gt", value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.spec.filters.push({ column, op: "gte", value });
    return this;
  }

  lt(column: string, value: unknown): this {
    this.spec.filters.push({ column, op: "lt", value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.spec.filters.push({ column, op: "lte", value });
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.spec.filters.push({ column, op: "in", values });
    return this;
  }

  like(column: string, value: string): this {
    this.spec.filters.push({ column, op: "like", value });
    return this;
  }

  order(column: string, opts?: { ascending?: boolean }): this {
    this.spec.order.push({
      column,
      ascending: opts?.ascending ?? true,
    });
    return this;
  }

  limit(n: number): this {
    this.spec.limit = n;
    return this;
  }

  // Make the builder thenable so it auto-executes on await
  then<TResult1 = DbResult<T>, TResult2 = never>(
    onfulfilled?: ((value: DbResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<DbResult<T>> {
    try {
      const res = await fetch("/api/db", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.spec),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        return {
          data: null,
          error: body?.error || {
            message: `HTTP ${res.status}: ${res.statusText}`,
            code: String(res.status),
          },
          count: null,
        };
      }

      return await res.json();
    } catch (err: any) {
      return {
        data: null,
        error: {
          message: err.message || "Network error",
          code: "NETWORK_ERROR",
        },
        count: null,
      };
    }
  }
}

export const db = {
  from<T = any>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(table);
  },
};
