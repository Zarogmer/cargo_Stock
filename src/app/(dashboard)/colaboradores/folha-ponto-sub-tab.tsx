"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { printPdfBlob } from "@/lib/print";
import { db } from "@/lib/db";
import { AllocInput, WorkedMap, expandWorkedDates } from "@/lib/folha-ponto";
import { FolhaPontoPreview } from "./folha-ponto-preview";
import type { Employee } from "@/types/database";

const MESES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

// Mês anterior ao de hoje (competência típica de fechamento).
function defaultCompetencia(): { month: number; year: number } {
  const d = new Date();
  let month = d.getMonth(); // 0-based mês anterior já que getMonth()+1 seria o atual
  let year = d.getFullYear();
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return { month, year };
}

// Linhas cruas do Supabase. Buscamos alocações e jobs (com o navio embutido)
// separado e juntamos no cliente — o embed jobs→ships já é usado no Financeiro.
interface AllocRow {
  employee_id: number | null;
  kind: string | null;
  shift_date: string | null;
  shift_period: string | null;
  job_id: string | null;
}
interface JobRow {
  id: string;
  start_date: string | null;
  ships: { arrival_date: string | null; departure_date: string | null; services: string[] | null } | null;
}

export function FolhaPontoSubTab({ employees }: { employees: Employee[] }) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [empSearch, setEmpSearch] = useState("");
  const init = defaultCompetencia();
  const [month, setMonth] = useState(init.month);
  const [year, setYear] = useState(init.year);

  // Dias trabalhados por colaborador no mês (best-effort) — alimenta a contagem
  // e a visualização. Guardamos as datas (não só a contagem) pra renderizar a prévia.
  const [workedByEmp, setWorkedByEmp] = useState<Record<number, WorkedMap>>({});
  const [previewLoading, setPreviewLoading] = useState(false);
  // Qual colaborador está sendo visualizado.
  const [previewId, setPreviewId] = useState<number | null>(null);

  const [generating, setGenerating] = useState<"xlsx" | "pdf" | "print" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sortedEmployees = useMemo(() => {
    return [...employees]
      .filter((e) => e.status !== "INATIVO")
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [employees]);

  const filteredEmployees = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    if (!q) return sortedEmployees;
    const qDigits = q.replace(/\D/g, "");
    return sortedEmployees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        (qDigits ? (e.cpf || "").replace(/\D/g, "").includes(qDigits) : false)
    );
  }, [sortedEmployees, empSearch]);

  const selectedCount = selectedIds.size;
  const yearOptions = useMemo(() => {
    const cur = new Date().getFullYear();
    return [cur + 1, cur, cur - 1, cur - 2];
  }, []);

  // Carrega a prévia de dias trabalhados quando muda a seleção ou a competência.
  useEffect(() => {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      setWorkedByEmp({});
      return;
    }
    let active = true;
    setPreviewLoading(true);
    (async () => {
      try {
        const { data: allocs, error: aErr } = await db
          .from("job_allocations")
          .select("employee_id, kind, shift_date, shift_period, job_id")
          .in("employee_id", ids)
          .eq("status", "ATIVO");
        if (!active) return;
        if (aErr || !allocs) {
          setWorkedByEmp({});
          return;
        }
        const allocRows = allocs as unknown as AllocRow[];

        // Navio de cada job (services define o tipo; janela usada no Embarque).
        // Buscamos para TODAS as alocações com job — inclusive Costado.
        const jobIds = [...new Set(
          allocRows.filter((a) => a.job_id).map((a) => a.job_id as string)
        )];
        const jobById = new Map<string, JobRow>();
        if (jobIds.length > 0) {
          const { data: jobs } = await db
            .from("jobs")
            .select("id, start_date, ships(arrival_date, departure_date, services)")
            .in("id", jobIds);
          if (!active) return;
          for (const j of (jobs as unknown as JobRow[]) || []) jobById.set(j.id, j);
        }

        const byEmp = new Map<number, AllocInput[]>();
        for (const a of allocRows) {
          if (a.employee_id == null) continue;
          const job = a.job_id ? jobById.get(a.job_id) : null;
          const list = byEmp.get(a.employee_id) || [];
          list.push({
            kind: a.kind === "COSTADO" ? "COSTADO" : "EMBARQUE",
            shift_date: a.shift_date ? a.shift_date.slice(0, 10) : null,
            shift_period: a.shift_period ?? null,
            ship_services: job?.ships?.services ?? null,
            ship_arrival: job?.ships?.arrival_date ? job.ships.arrival_date.slice(0, 10) : null,
            ship_departure: job?.ships?.departure_date ? job.ships.departure_date.slice(0, 10) : null,
            job_start: job?.start_date ? job.start_date.slice(0, 10) : null,
          });
          byEmp.set(a.employee_id, list);
        }
        const next: Record<number, WorkedMap> = {};
        for (const id of ids) {
          next[id] = expandWorkedDates(byEmp.get(id) || [], year, month);
        }
        setWorkedByEmp(next);
      } catch {
        if (active) setWorkedByEmp({});
      } finally {
        if (active) setPreviewLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedIds, month, year]);

  function toggleEmployee(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  // Mantém o colaborador visualizado dentro da seleção (default = primeiro).
  useEffect(() => {
    setPreviewId((cur) => {
      if (cur != null && selectedIds.has(cur)) return cur;
      const first = [...selectedIds].sort((a, b) => {
        const na = employees.find((e) => e.id === a)?.name || "";
        const nb = employees.find((e) => e.id === b)?.name || "";
        return na.localeCompare(nb, "pt-BR");
      })[0];
      return first ?? null;
    });
  }, [selectedIds, employees]);

  const totalWorked = useMemo(
    () => [...selectedIds].reduce((acc, id) => acc + (workedByEmp[id]?.size ?? 0), 0),
    [selectedIds, workedByEmp]
  );

  const previewEmp = previewId != null ? employees.find((e) => e.id === previewId) ?? null : null;
  const previewWorked = useMemo<WorkedMap>(
    () => (previewId != null ? workedByEmp[previewId] : undefined) ?? new Map(),
    [previewId, workedByEmp]
  );
  const selectedEmpList = useMemo(
    () =>
      [...selectedIds]
        .map((id) => employees.find((e) => e.id === id))
        .filter((e): e is Employee => !!e)
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [selectedIds, employees]
  );

  async function handleGenerate(action: "xlsx" | "pdf" | "print") {
    setError(null);
    const ids = [...selectedIds];
    if (ids.length === 0) {
      setError("Selecione ao menos um colaborador.");
      return;
    }
    const format = action === "xlsx" ? "xlsx" : "pdf";
    setGenerating(action);
    try {
      const res = await fetch(`/api/documents/folha-ponto?format=${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeIds: ids, month, year }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        const main = b.error || `Erro ${res.status}`;
        throw new Error(b.detail ? `${main}\n\nDetalhe técnico: ${b.detail}` : main);
      }
      const blob = await res.blob();
      if (action === "print") {
        printPdfBlob(blob);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const periodo = `${MESES[month - 1]} ${year}`;
        a.download = ids.length === 1
          ? `Folha de Ponto - ${periodo}.${format}`
          : `Folhas de Ponto (${ids.length}) - ${periodo}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha ao gerar a folha de ponto.";
      setError(msg);
    } finally {
      setGenerating(null);
    }
  }

  const fieldCls =
    "mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30";
  const canGenerate = !generating && selectedCount > 0;

  return (
    <div className="space-y-5">
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div>
          <h3 className="font-semibold text-text">Gerar Folha de Ponto</h3>
          <p className="text-xs text-text-light mt-0.5">
            Os dias trabalhados saem dos <strong>navios cadastrados</strong>. Cada dia usa o horário do
            navio onde a pessoa esteve: <strong>Costado</strong> 6h (horário do turno escalado) ou{" "}
            <strong>Embarque</strong> 7h20 (09:00–17:20). Vários colaboradores geram um único arquivo com uma aba (ou página) para cada.
          </p>
        </div>

        {/* Competência */}
        <div className="grid grid-cols-2 gap-3 sm:max-w-xs">
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Mês</label>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={fieldCls}>
              {MESES.map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Ano</label>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={fieldCls}>
              {yearOptions.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Seleção de colaboradores */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">
              Colaboradores
            </label>
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={clearSelection}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                Limpar seleção ({selectedCount})
              </button>
            )}
          </div>
          <input
            type="text"
            value={empSearch}
            onChange={(e) => setEmpSearch(e.target.value)}
            placeholder="Buscar por nome ou CPF…"
            className={fieldCls}
          />
          <div className="mt-1 max-h-56 overflow-y-auto border border-border rounded-lg divide-y divide-border">
            {filteredEmployees.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-light">Nenhum colaborador encontrado.</p>
            ) : (
              filteredEmployees.map((e) => {
                const checked = selectedIds.has(e.id);
                const dias = workedByEmp[e.id]?.size;
                return (
                  <label
                    key={e.id}
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleEmployee(e.id)}
                      className="rounded border-border"
                    />
                    <span className="text-sm text-text flex-1">{e.name}</span>
                    {e.role && <span className="text-xs text-text-light">— {e.role}</span>}
                    {checked && (
                      <span
                        className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${
                          dias ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {previewLoading && dias === undefined ? "…" : `${dias ?? 0} dia${dias === 1 ? "" : "s"}`}
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </div>
          <p className="text-[11px] text-text-light mt-1">
            {selectedCount === 0
              ? "Marque um ou mais colaboradores."
              : `${selectedCount} selecionado${selectedCount === 1 ? "" : "s"} · ${totalWorked} dia${totalWorked === 1 ? "" : "s"} trabalhado${totalWorked === 1 ? "" : "s"} em ${MESES[month - 1]}/${year}.`}
            {selectedCount > 0 && totalWorked === 0 && !previewLoading && (
              <span className="text-amber-700"> Nenhum dia encontrado nessa competência — a folha sai em branco.</span>
            )}
          </p>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 whitespace-pre-line">
          ⚠️ {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="primary" onClick={() => handleGenerate("xlsx")} disabled={!canGenerate}>
          {generating === "xlsx" ? "Gerando..." : "Gerar Excel (.xlsx)"}
        </Button>
        <Button variant="danger" onClick={() => handleGenerate("pdf")} disabled={!canGenerate}>
          {generating === "pdf" ? "Gerando..." : "Gerar PDF (.pdf)"}
        </Button>
        <Button variant="secondary" onClick={() => handleGenerate("print")} disabled={!canGenerate}>
          {generating === "print" ? "Imprimindo..." : "🖨️ Imprimir"}
        </Button>
      </div>

      {/* Visualização */}
      {selectedCount > 0 && previewEmp && (
        <div className="space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h4 className="text-sm font-semibold text-text">
              Visualização
              {previewLoading && <span className="ml-2 text-xs font-normal text-text-light">atualizando…</span>}
            </h4>
            {selectedCount > 1 && (
              <div className="flex items-center gap-2">
                <label className="text-xs text-text-light">Colaborador:</label>
                <select
                  value={previewId ?? ""}
                  onChange={(e) => setPreviewId(Number(e.target.value))}
                  className="px-2 py-1 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  {selectedEmpList.map((e) => (
                    <option key={e.id} value={e.id}>{e.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <FolhaPontoPreview
            name={previewEmp.name}
            empId={previewEmp.id}
            worked={previewWorked}
            year={year}
            month={month}
          />
        </div>
      )}
    </div>
  );
}
