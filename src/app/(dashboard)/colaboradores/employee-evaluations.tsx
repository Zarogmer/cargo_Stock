"use client";

import { useEffect, useState } from "react";

// Histórico de avaliações de desempenho do colaborador (detalhe em Rh ›
// Colaboradores). As avaliações são preenchidas pelos supervisores nos
// Relatórios de Bordo, navio a navio — aqui a gestão vê tudo acumulado:
// média por navio, critérios e observações do supervisor.

interface EvaluationRow {
  id: number;
  job_id: string;
  kind: string;
  ship_name: string;
  job_date: string | null;
  productivity: number;
  quality: number;
  teamwork: number;
  safety: number;
  initiative: number;
  punctuality: number;
  technical: number;
  comments: string | null;
  evaluated_by: string;
  updated_at: string;
}

const CRITERIA: { key: keyof EvaluationRow; label: string }[] = [
  { key: "productivity", label: "Produtividade" },
  { key: "quality", label: "Qualidade no trabalho" },
  { key: "teamwork", label: "Trabalho em equipe" },
  { key: "safety", label: "Segurança e uso de EPI" },
  { key: "initiative", label: "Iniciativa" },
  { key: "punctuality", label: "Pontualidade" },
  { key: "technical", label: "Habilidade técnica" },
];

function avgOf(e: EvaluationRow): number | null {
  const rated = CRITERIA.map((c) => Number(e[c.key]) || 0).filter((v) => v > 0);
  if (rated.length === 0) return null;
  return rated.reduce((s, v) => s + v, 0) / rated.length;
}

function stars(n: number): string {
  return "★".repeat(n) + "☆".repeat(5 - n);
}

export function EmployeeEvaluations({ employeeId }: { employeeId: number }) {
  const [rows, setRows] = useState<EvaluationRow[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setExpanded(null);
    fetch(`/api/rh/avaliacoes?employee_id=${employeeId}`)
      .then((r) => r.json())
      .then((json) => {
        if (alive) setRows(json.data || []);
      })
      .catch(() => {
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, [employeeId]);

  // Só avaliações com pelo menos um critério dado (upsert em massa grava
  // linhas zeradas pros não avaliados — essas não contam).
  const rated = (rows || []).filter((e) => avgOf(e) !== null);
  // Média geral POR NAVIO: Embarque e Costado do mesmo navio são duas
  // avaliações, mas contam como UM navio (média das duas primeiro).
  const byJob = new Map<string, { sum: number; n: number }>();
  for (const e of rated) {
    const j = byJob.get(e.job_id) || { sum: 0, n: 0 };
    byJob.set(e.job_id, { sum: j.sum + (avgOf(e) || 0), n: j.n + 1 });
  }
  const shipAvgs = [...byJob.values()].map((j) => j.sum / j.n);
  const shipCount = shipAvgs.length;
  const overall = shipCount ? shipAvgs.reduce((s, v) => s + v, 0) / shipCount : null;

  return (
    <div className="border-t border-border pt-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-text-light uppercase tracking-wider">
          ⭐ Avaliações de desempenho
        </h3>
        {overall !== null && (
          <span className="text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-800 font-bold">
            Média geral: {overall.toFixed(1)} · {shipCount} navio{shipCount > 1 ? "s" : ""}
          </span>
        )}
      </div>

      {rows === null ? (
        <p className="text-sm text-text-light py-2">Carregando avaliações...</p>
      ) : rated.length === 0 ? (
        <p className="text-sm text-text-light py-2">
          Nenhuma avaliação registrada ainda (os supervisores avaliam pelo Relatório de Bordo do navio).
        </p>
      ) : (
        <div className="space-y-1.5">
          {rated.map((e) => {
            const avg = avgOf(e)!;
            const open = expanded === e.id;
            const weak = CRITERIA.filter((c) => {
              const v = Number(e[c.key]) || 0;
              return v > 0 && v <= 3;
            });
            return (
              <div key={e.id} className="border border-border rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : e.id)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-gray-50 transition"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text truncate">
                      {e.kind === "COSTADO" ? "🌊" : "⚓"} {e.ship_name}
                    </p>
                    <p className="text-xs text-text-light">
                      {e.job_date ? e.job_date.slice(0, 10).split("-").reverse().join("/") : "—"} · por{" "}
                      {e.evaluated_by}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 text-sm font-bold ${avg >= 4 ? "text-emerald-600" : avg >= 3 ? "text-amber-600" : "text-red-600"}`}
                  >
                    {avg.toFixed(1)} {open ? "▴" : "▾"}
                  </span>
                </button>
                {open && (
                  <div className="px-3 pb-3 pt-1 border-t border-border bg-gray-50/60 space-y-2">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
                      {CRITERIA.map((c) => {
                        const v = Number(e[c.key]) || 0;
                        return (
                          <div key={c.key} className="flex items-center justify-between text-xs">
                            <span className="text-text">{c.label}</span>
                            <span className="text-amber-600 tracking-wider">
                              {v > 0 ? `${stars(v)} (${v})` : <span className="text-text-light">—</span>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    {weak.length > 0 && (
                      <p className="text-xs text-red-700">
                        Pontos a melhorar: {weak.map((c) => c.label).join(", ")}
                      </p>
                    )}
                    {e.comments && (
                      <p className="text-xs text-text bg-white border border-border rounded-md px-2 py-1.5">
                        💬 {e.comments}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
