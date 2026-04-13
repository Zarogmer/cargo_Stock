"use client";

import { useEffect, useState } from "react";
import { db } from "@/lib/db";
import { useAuth } from "@/lib/auth-context";
import { useSession } from "next-auth/react";

interface TableCheck {
  name: string;
  count: number | null;
  error: string | null;
  data: unknown[] | null;
}

export default function DebugPage() {
  const { profile } = useAuth();
  const { data: session } = useSession();
  const [checks, setChecks] = useState<TableCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [sessionInfo, setSessionInfo] = useState<string>("checking...");

  useEffect(() => {
    async function run() {
      // Check session
      if (session?.user) {
        setSessionInfo(`OK — user: ${session.user.email} | role: ${(session.user as any).role || "?"}`);
      } else {
        setSessionInfo("NO SESSION — user not authenticated!");
      }

      const tables = [
        "stock_items",
        "employees",
        "tools",
        "tool_movements",
        "tool_requests",
        "epis",
        "uniforms",
        "ships",
        "stock_movements",
        "epi_movements",
        "uniform_movements",
        "users",
      ];

      const results: TableCheck[] = [];

      for (const table of tables) {
        const { data, error } = await db
          .from(table)
          .select("*")
          .limit(3);

        results.push({
          name: table,
          count: data ? data.length : null,
          error: error ? `${error.code}: ${error.message}` : null,
          data: data ? data.slice(0, 2) : null,
        });
      }

      setChecks(results);
      setLoading(false);
    }
    run();
  }, [session]);

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-2xl font-bold text-text">Diagnostico do Sistema</h1>

      <div className="bg-card rounded-xl border border-border p-4">
        <h2 className="font-bold mb-2">Sessao de Autenticacao</h2>
        <p className="text-sm font-mono break-all">{sessionInfo}</p>
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <h2 className="font-bold mb-2">Perfil do Usuario</h2>
        <pre className="text-xs font-mono break-all whitespace-pre-wrap">
          {JSON.stringify(profile, null, 2)}
        </pre>
      </div>

      <div className="bg-card rounded-xl border border-border p-4">
        <h2 className="font-bold mb-2">Plataforma</h2>
        <p className="text-sm font-mono break-all">
          Railway + PostgreSQL + NextAuth.js
        </p>
      </div>

      {loading ? (
        <div className="text-center py-8">
          <span className="text-4xl animate-bounce block">🔍</span>
          <p className="text-sm text-text-light mt-2">Testando tabelas...</p>
        </div>
      ) : (
        <div className="space-y-3">
          <h2 className="font-bold text-lg">Resultado das Tabelas</h2>
          {checks.map((c) => (
            <div
              key={c.name}
              className={`rounded-lg border p-3 ${
                c.error ? "border-red-300 bg-red-50" : c.count === 0 ? "border-yellow-300 bg-yellow-50" : "border-green-300 bg-green-50"
              }`}
            >
              <div className="flex justify-between items-center">
                <span className="font-mono font-bold text-sm">{c.name}</span>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                  c.error ? "bg-red-200 text-red-800" : c.count === 0 ? "bg-yellow-200 text-yellow-800" : "bg-green-200 text-green-800"
                }`}>
                  {c.error ? "ERRO" : `${c.count} registros`}
                </span>
              </div>
              {c.error && (
                <p className="text-xs text-red-700 mt-1 font-mono break-all">{c.error}</p>
              )}
              {c.data && c.data.length > 0 && (
                <details className="mt-1">
                  <summary className="text-xs text-gray-500 cursor-pointer">Ver amostra</summary>
                  <pre className="text-xs mt-1 overflow-x-auto font-mono whitespace-pre-wrap break-all">
                    {JSON.stringify(c.data[0], null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
