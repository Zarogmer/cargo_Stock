"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { printPdfBlob } from "@/lib/print";
import { db } from "@/lib/db";
import { AllocInput, JornadaFilter, WorkedMap, countWorkedKind, expandWorkedDates, periodoFileLabel, rangeDayCount } from "@/lib/folha-ponto";
import { FolhaPontoPreview } from "./folha-ponto-preview";
import type { Employee } from "@/types/database";

// Período máximo da folha — igual ao limite da API (~4 meses).
const MAX_RANGE_DAYS = 124;

// Como o período é escolhido: por intervalo de datas livre ou por navio (o
// período e as alocações vêm do navio selecionado).
type FiltroPeriodo = "DATA" | "NAVIO";

// Período default: o do cartão de ponto oficial da contabilidade — dia 26 do
// mês anterior a dia 25 do mês atual (ex.: 26/10 a 25/11).
function defaultRange(): { start: string; end: string } {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return {
    start: `${py}-${String(pm).padStart(2, "0")}-26`,
    end: `${y}-${String(m).padStart(2, "0")}-25`,
  };
}

function ddmmyy(iso: string | null): string {
  if (!iso) return "?";
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}`;
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
interface ShipOption {
  id: string;
  name: string;
  arrival_date: string | null;
  departure_date: string | null;
  services: string[] | null;
}

// Um navio é de Costado quando os serviços incluem "COSTADO"; senão é Embarque.
// É a mesma regra que decide o tipo de jornada de cada dia (ship_services).
function isCostadoShip(s: ShipOption): boolean {
  return (s.services || []).includes("COSTADO");
}

export function FolhaPontoSubTab({ employees }: { employees: Employee[] }) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [empSearch, setEmpSearch] = useState("");
  const init = defaultRange();
  const [startIso, setStartIso] = useState(init.start);
  const [endIso, setEndIso] = useState(init.end);
  // Tipo de jornada que filtra a folha. "AMBAS" mostra Embarque e Costado juntos
  // na mesma folha (é o que vai pra contabilidade) — default.
  const [jornada, setJornada] = useState<JornadaFilter>("AMBAS");
  // Filtro do período: por data (De/Até livres) ou por navio (datas derivadas).
  const [filtro, setFiltro] = useState<FiltroPeriodo>("DATA");

  // Navios pro filtro "Por navio" (carregados quando o modo é aberto).
  const [ships, setShips] = useState<ShipOption[] | null>(null);
  const [shipId, setShipId] = useState("");
  // Jobs do navio selecionado — restringem as alocações da prévia.
  const [shipJobIds, setShipJobIds] = useState<string[] | null>(null);
  // Quem está escalado no navio (pro atalho "selecionar escalados").
  const [shipEmpIds, setShipEmpIds] = useState<number[]>([]);
  const [shipLoading, setShipLoading] = useState(false);

  // Dias trabalhados por colaborador no período (best-effort) — alimenta a
  // contagem e a visualização. Guardamos as datas pra renderizar a prévia.
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

  // No modo "Por navio", a lista já vem restrita a quem esteve escalado no
  // navio — é assim que o pessoal pensa a folha ("quem foi no navio tal").
  const filteredEmployees = useMemo(() => {
    let base = sortedEmployees;
    if (filtro === "NAVIO" && shipId) {
      const crew = new Set(shipEmpIds);
      base = base.filter((e) => crew.has(e.id));
    }
    const q = empSearch.trim().toLowerCase();
    if (!q) return base;
    const qDigits = q.replace(/\D/g, "");
    return base.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        (qDigits ? (e.cpf || "").replace(/\D/g, "").includes(qDigits) : false)
    );
  }, [sortedEmployees, empSearch, filtro, shipId, shipEmpIds]);

  const selectedCount = selectedIds.size;

  // Validação do período (compartilhada entre a prévia e o botão de gerar).
  const rangeError = useMemo(() => {
    if (filtro === "NAVIO" && !shipId) return "Selecione um navio.";
    if (!startIso || !endIso) return "Informe as datas de início e fim do período.";
    if (endIso < startIso) return "A data final é anterior à inicial.";
    if (rangeDayCount(startIso, endIso) > MAX_RANGE_DAYS) {
      return `Período muito longo: o máximo é ${MAX_RANGE_DAYS} dias.`;
    }
    return null;
  }, [filtro, shipId, startIso, endIso]);
  const rangeOk = rangeError === null;

  // Carrega a lista de navios quando o filtro "Por navio" é aberto.
  useEffect(() => {
    if (filtro !== "NAVIO" || ships !== null) return;
    let active = true;
    (async () => {
      const { data } = await db
        .from("ships")
        .select("id, name, arrival_date, departure_date, services")
        .order("arrival_date", { ascending: false })
        .limit(300);
      if (active) setShips(((data as unknown as ShipOption[]) || []));
    })();
    return () => {
      active = false;
    };
  }, [filtro, ships]);

  // Navio selecionado → deriva o período (chegada/saída + turnos de Costado),
  // guarda os jobs (pra filtrar as alocações) e quem está escalado nele.
  useEffect(() => {
    if (filtro !== "NAVIO" || !shipId) {
      setShipJobIds(null);
      setShipEmpIds([]);
      return;
    }
    let active = true;
    setShipLoading(true);
    (async () => {
      try {
        const [{ data: shipRows }, { data: jobs }] = await Promise.all([
          db.from("ships").select("arrival_date, departure_date").eq("id", shipId).limit(1),
          db.from("jobs").select("id, start_date").eq("ship_id", shipId),
        ]);
        if (!active) return;
        const jobIds = ((jobs as { id: string; start_date: string | null }[]) || []).map((j) => j.id);
        let allocRows: { employee_id: number | null; shift_date: string | null }[] = [];
        if (jobIds.length > 0) {
          const { data: allocs } = await db
            .from("job_allocations")
            .select("employee_id, shift_date")
            .in("job_id", jobIds)
            .eq("status", "ATIVO");
          if (!active) return;
          allocRows = (allocs as { employee_id: number | null; shift_date: string | null }[]) || [];
        }
        setShipJobIds(jobIds);
        setShipEmpIds([...new Set(allocRows.map((a) => a.employee_id).filter((n): n is number => n != null))]);

        // Período do navio: da menor à maior data conhecida (chegada, saída,
        // início dos jobs e turnos de Costado). O usuário pode ajustar depois.
        const s = ((shipRows as { arrival_date: string | null; departure_date: string | null }[] | null) || [])[0] ?? null;
        const dates = [
          s?.arrival_date,
          s?.departure_date,
          ...((jobs as { start_date: string | null }[]) || []).map((j) => j.start_date),
          ...allocRows.map((a) => a.shift_date),
        ]
          .filter((d): d is string => !!d)
          .map((d) => d.slice(0, 10));
        if (dates.length > 0) {
          dates.sort();
          setStartIso(dates[0]);
          setEndIso(dates[dates.length - 1]);
        }
      } finally {
        if (active) setShipLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [filtro, shipId]);

  // Carrega a prévia de dias trabalhados quando muda a seleção ou o período.
  useEffect(() => {
    const ids = [...selectedIds];
    if (ids.length === 0 || !rangeOk) {
      setWorkedByEmp({});
      return;
    }
    // No filtro por navio, espera os jobs do navio chegarem antes de buscar.
    const shipFilter = filtro === "NAVIO" ? shipJobIds : null;
    if (filtro === "NAVIO" && shipFilter === null) return;
    let active = true;
    setPreviewLoading(true);
    (async () => {
      try {
        if (shipFilter !== null && shipFilter.length === 0) {
          setWorkedByEmp({});
          return;
        }
        let query = db
          .from("job_allocations")
          .select("employee_id, kind, shift_date, shift_period, job_id")
          .in("employee_id", ids)
          .eq("status", "ATIVO");
        if (shipFilter !== null) query = query.in("job_id", shipFilter);
        const { data: allocs, error: aErr } = await query;
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
          next[id] = expandWorkedDates(byEmp.get(id) || [], startIso, endIso);
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
  }, [selectedIds, startIso, endIso, rangeOk, filtro, shipJobIds]);

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

  // Atalho do filtro por navio: seleciona todo mundo escalado no navio.
  function selectShipCrew() {
    const active = new Set(sortedEmployees.map((e) => e.id));
    setSelectedIds(new Set(shipEmpIds.filter((id) => active.has(id))));
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
    () => [...selectedIds].reduce((acc, id) => {
      const w = workedByEmp[id];
      return acc + (w ? countWorkedKind(w, jornada) : 0);
    }, 0),
    [selectedIds, workedByEmp, jornada]
  );

  const selectedShip = useMemo(
    () => (ships || []).find((s) => s.id === shipId) ?? null,
    [ships, shipId]
  );

  // Dropdown de navios filtrado pela jornada escolhida: Costado → só navios de
  // Costado; Embarque → só de Embarque; Ambas → todos. Assim o RH escolhe pelo
  // par jornada+navio sem misturar tipos.
  const shipsForJornada = useMemo(() => {
    const list = ships || [];
    if (jornada === "COSTADO") return list.filter(isCostadoShip);
    if (jornada === "EMBARQUE") return list.filter((s) => !isCostadoShip(s));
    return list;
  }, [ships, jornada]);

  // Se o navio selecionado deixa de bater com a jornada (ex.: troquei p/ Costado
  // com um navio de Embarque escolhido), limpa a seleção do navio.
  useEffect(() => {
    if (!shipId || ships === null) return;
    if (!shipsForJornada.some((s) => s.id === shipId)) setShipId("");
  }, [shipId, ships, shipsForJornada]);

  // Ao carregar a tripulação do navio, já marca todo mundo escalado (é o caso
  // comum da folha por navio). Trocar de navio reinicia a seleção.
  useEffect(() => {
    if (filtro !== "NAVIO" || !shipId) return;
    const activeIds = new Set(sortedEmployees.map((e) => e.id));
    setSelectedIds(new Set(shipEmpIds.filter((id) => activeIds.has(id))));
  }, [shipEmpIds, filtro, shipId, sortedEmployees]);

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
    if (!rangeOk) {
      setError(rangeError);
      return;
    }
    const format = action === "xlsx" ? "xlsx" : "pdf";
    setGenerating(action);
    try {
      const res = await fetch(`/api/documents/folha-ponto?format=${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employeeIds: ids,
          startDate: startIso,
          endDate: endIso,
          jornada,
          shipId: filtro === "NAVIO" ? shipId : undefined,
        }),
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
        const periodo = periodoFileLabel(startIso, endIso);
        const tipoLabel = jornada === "COSTADO" ? "Costado" : jornada === "EMBARQUE" ? "Embarque" : "Ambas";
        const shipPart = filtro === "NAVIO" && selectedShip ? ` ${selectedShip.name}` : "";
        a.download = ids.length === 1
          ? `Folha de Ponto ${tipoLabel}${shipPart} - ${periodo}.${format}`
          : `Folhas de Ponto ${tipoLabel}${shipPart} (${ids.length}) - ${periodo}.${format}`;
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
  const canGenerate = !generating && selectedCount > 0 && rangeOk;
  const periodoTexto = rangeOk ? periodoFileLabel(startIso, endIso).toLowerCase() : "—";

  return (
    <div className="space-y-5">
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div>
          <h3 className="font-semibold text-text">Gerar Folha de Ponto</h3>
          <p className="text-xs text-text-light mt-0.5">
            Os dias trabalhados saem dos <strong>navios cadastrados</strong> (o tipo de cada dia vem do
            navio). Escolha a <strong>jornada</strong>: <strong>Embarque</strong> 7h20 (09:00–17:20),{" "}
            <strong>Costado</strong> 6h (só o 1º turno do dia) ou <strong>Ambas</strong> (Embarque e Costado
            na mesma folha — a carga horária ao lado diz qual é qual). O <strong>período</strong> pode ser
            um intervalo de datas livre (inclusive cruzando meses, ex.: 24/10 a 08/11) ou derivado de um{" "}
            <strong>navio</strong> (só os dias daquele navio entram na folha). O padrão é o período do
            cartão oficial: <strong>26 do mês anterior a 25 do mês atual</strong>. Vários colaboradores
            geram um único arquivo com uma aba (ou página) para cada.
          </p>
        </div>

        {/* Tipo de jornada — filtra a folha por tipo de navio */}
        <div>
          <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Tipo de jornada</label>
          <div className="mt-1 inline-flex rounded-lg border border-border overflow-hidden">
            {([["AMBAS", "Ambas"], ["EMBARQUE", "Embarque · 7h20"], ["COSTADO", "Costado · 6h"]] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setJornada(val)}
                aria-pressed={jornada === val}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  jornada === val ? "bg-primary text-white" : "bg-card text-text hover:bg-gray-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Período — por data livre ou por navio */}
        <div>
          <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Período</label>
          <div className="mt-1 inline-flex rounded-lg border border-border overflow-hidden">
            {([["DATA", "Por data"], ["NAVIO", "Por navio"]] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setFiltro(val)}
                aria-pressed={filtro === val}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  filtro === val ? "bg-primary text-white" : "bg-card text-text hover:bg-gray-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {filtro === "NAVIO" && (
            <div className="mt-2 sm:max-w-md">
              <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Navio</label>
              <select
                value={shipId}
                onChange={(e) => setShipId(e.target.value)}
                className={fieldCls}
                disabled={ships === null}
              >
                <option value="">
                  {ships === null
                    ? "Carregando navios…"
                    : shipsForJornada.length === 0
                      ? jornada === "COSTADO"
                        ? "Nenhum navio de Costado"
                        : jornada === "EMBARQUE"
                          ? "Nenhum navio de Embarque"
                          : "Selecione o navio…"
                      : "Selecione o navio…"}
                </option>
                {shipsForJornada.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.arrival_date ? ` — ${ddmmyy(s.arrival_date)} a ${ddmmyy(s.departure_date || s.arrival_date)}` : ""}
                  </option>
                ))}
              </select>
              {shipId && (
                <p className="mt-1 text-[11px] text-text-light">
                  {shipLoading ? (
                    "Carregando o período do navio…"
                  ) : (
                    <>
                      Período do navio:{" "}
                      <strong>
                        {ddmmyy(startIso)} a {ddmmyy(endIso)}
                      </strong>{" "}
                      (chegada → saída e turnos de Costado). A lista abaixo mostra só quem foi escalado neste
                      navio, já marcados.
                    </>
                  )}
                </p>
              )}
            </div>
          )}

          {/* Datas livres só no modo "Por data"; no modo "Por navio" o período
              vem do navio (mostrado acima) e não precisa ser digitado. */}
          {filtro === "DATA" && (
            <div className="mt-2 grid grid-cols-2 gap-3 sm:max-w-xs">
              <div>
                <label className="text-xs font-semibold text-text-light uppercase tracking-wider">De</label>
                <input
                  type="date"
                  value={startIso}
                  onChange={(e) => setStartIso(e.target.value)}
                  className={fieldCls}
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Até</label>
                <input
                  type="date"
                  value={endIso}
                  onChange={(e) => setEndIso(e.target.value)}
                  className={fieldCls}
                />
              </div>
            </div>
          )}
          {rangeError && filtro === "DATA" && (
            <p className="mt-1 text-[11px] text-amber-700">{rangeError}</p>
          )}
          {rangeError && filtro === "NAVIO" && shipId && (
            <p className="mt-1 text-[11px] text-amber-700">{rangeError}</p>
          )}
        </div>

        {/* Seleção de colaboradores */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">
              Colaboradores
            </label>
            <div className="flex items-center gap-3">
              {filtro === "NAVIO" && shipId && shipEmpIds.length > 0 && (
                <button
                  type="button"
                  onClick={selectShipCrew}
                  className="text-[11px] font-medium text-primary hover:underline"
                >
                  Selecionar todos ({shipEmpIds.length})
                </button>
              )}
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
              <p className="px-3 py-2 text-xs text-text-light">
                {filtro === "NAVIO" && shipId
                  ? shipLoading
                    ? "Carregando os escalados do navio…"
                    : empSearch.trim()
                      ? "Nenhum escalado do navio bate com a busca."
                      : "Nenhum colaborador escalado nesse navio."
                  : "Nenhum colaborador encontrado."}
              </p>
            ) : (
              filteredEmployees.map((e) => {
                const checked = selectedIds.has(e.id);
                const w = workedByEmp[e.id];
                const dias = w ? countWorkedKind(w, jornada) : undefined;
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
              : `${selectedCount} selecionado${selectedCount === 1 ? "" : "s"} · ${totalWorked} dia${totalWorked === 1 ? "" : "s"} trabalhado${totalWorked === 1 ? "" : "s"} no período (${periodoTexto}).`}
            {selectedCount > 0 && rangeOk && totalWorked === 0 && !previewLoading && (
              <span className="text-amber-700"> Nenhum dia encontrado nesse período — a folha sai em branco.</span>
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
      {selectedCount > 0 && rangeOk && previewEmp && (
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
            startIso={startIso}
            endIso={endIso}
            jornada={jornada}
            shipName={filtro === "NAVIO" ? selectedShip?.name ?? null : null}
          />
        </div>
      )}
    </div>
  );
}
