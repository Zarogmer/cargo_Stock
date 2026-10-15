"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { DollarQuote } from "@/components/dollar-ticker";
import { computeShipYearNumbers } from "@/lib/ship-number";
import type { AnnualShipRow } from "@/lib/relatorios-anuais-xlsx";
import { DEFAULT_CLIENTS } from "@/lib/port-client-options";
import { employeeHasRole } from "@/lib/utils";
import { pickFunctionByName } from "@/lib/jobUnits";
import {
  COMPANY_FOOTER,
  SERVICE_CHARGE_LABEL,
  applyClosingServiceKind,
  buildClosingDraft,
  buildClosingTitle,
  closingServiceKind,
  computeClosing,
  diffWorkersToEscala,
  formatBRL,
  groupClosingWorkers,
  insertWorkerInGroup,
  formatNumberBR,
  formatUSD,
  newId,
  normalizeClosingDoc,
  parseNumberBR,
  shortDateBR,
  supervisorFromEscala,
  syncWorkersFromEscala,
  type ClosingAdminRow,
  type ClosingCharge,
  type ClosingDoc,
  type ClosingExpense,
  type ClosingWorker,
  type EscalaAllocation,
} from "@/lib/fechamento-navio";
import { closingFileName } from "@/lib/fechamento-navio-file";
import { shareOrDownloadBlob } from "@/lib/print";
import type { Job, JobAdjustment, JobAllocation, JobFunction } from "@/types/database";

// Financeiro › Fechamento de Navio — a planilha de fechamento da diretoria
// ("42 - FECHAMENTO EUROPA GRAECA - WILSONSONS - SANTOS.xlsx") na tela.
//
// À esquerda ficam as caixinhas que o executivo preenche (porões, paga de cada
// um, extras, valores cobrados, taxa do dólar, despesas); à direita a folha,
// igual ao Excel, recalculando a cada tecla. O rascunho nasce da escala e das
// despesas do Resultado do Navio; o que o usuário mexe fica salvo por navio
// em job_closings (sem tocar nos valores da escala). "Refazer da escala"
// descarta o salvo e monta de novo.
//
// QUEM trabalhou, porém, é um só no sistema: cada linha de Funcionários fica
// ligada à alocação da escala (allocation_ids) e o nome é um select do RH.
// Trocar a pessoa aqui troca na escala ao salvar; trocar na escala aparece
// aqui ao abrir (syncWorkersFromEscala / diffWorkersToEscala).

const inputCls =
  "w-full px-2 py-1.5 border border-border rounded-lg text-sm bg-card focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:bg-gray-50 disabled:text-text-light";
const labelCls = "block text-[11px] font-semibold uppercase tracking-wider text-text-light mb-1";
const sectionCls = "bg-card border border-border rounded-xl p-4 space-y-3";

interface ClosingRow {
  id: number;
  job_id: string;
  data: unknown;
  updated_by: string | null;
  updated_at: string;
}

// Colaborador do RH com o que esta tela usa: supervisores pro cabeçalho e o
// setor Administrativo (com o valor padrão por navio) pra tabela Administrativo.
interface EmployeeRow {
  id: number;
  name: string;
  role: string | null;
  secondary_role: string | null;
  status: string | null;
  sector: string | null;
  admin_ship_rate: string | number | null;
}

interface DebitNoteRow {
  kind: string;
  currency: string | null;
  subtotal: string | number;
  exchange_rate: string | number | null;
  created_at: string;
}

// Campo numérico que aceita "1.234,56", "250" ou "5.0856" e devolve número.
// Mantém o texto enquanto digita e formata ao sair.
function NumInput({
  value, onChange, decimals = 2, nullable = false, disabled, className = "", placeholder, title,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  decimals?: number;
  nullable?: boolean;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  title?: string;
}) {
  const fmt = useCallback(
    (v: number | null) => (v == null ? "" : formatNumberBR(v, decimals)),
    [decimals],
  );
  const [text, setText] = useState(fmt(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmt(value));
  }, [value, focused, fmt]);
  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      title={title}
      className={`${inputCls} text-right tabular-nums ${className}`}
      onFocus={(e) => { setFocused(true); e.target.select(); }}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t.trim() === "") { onChange(nullable ? null : 0); return; }
        onChange(parseNumberBR(t));
      }}
      onBlur={() => {
        setFocused(false);
        setText(fmt(text.trim() === "" ? (nullable ? null : 0) : parseNumberBR(text)));
      }}
    />
  );
}

function supervisorFromAllocations(allocs: JobAllocation[], jobId: string): string | null {
  const a = allocs.find((x) =>
    x.job_id === jobId &&
    x.status === "ATIVO" &&
    (x.job_functions?.name || "").trim().toUpperCase() === "SUPERVISOR" &&
    x.employees?.name,
  );
  return a?.employees?.name || null;
}

const ESCALA_SELECT = "id, employee_id, function_id, kind, status, removal_reason, rate, employees(name), job_functions(name)";

export function FechamentoNavioPage({
  jobs, allocations, adjustments, functions, shipsAll, canEdit, profileName, dollar, loading, onEscalaChanged,
}: {
  jobs: Job[];
  allocations: JobAllocation[];
  adjustments: JobAdjustment[];
  functions: JobFunction[];
  shipsAll: AnnualShipRow[];
  canEdit: boolean;
  profileName: string;
  dollar: DollarQuote | null;
  loading: boolean;
  // Chamado depois de salvar, com true quando a escala do navio mudou — o
  // Financeiro recarrega pra o Resultado do Navio mostrar a troca.
  onEscalaChanged?: (changed: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [jobId, setJobId] = useState<string>("");
  const [doc, setDoc] = useState<ClosingDoc | null>(null);
  const [savedJson, setSavedJson] = useState<string | null>(null); // null = sem linha salva
  const [savedAt, setSavedAt] = useState<{ by: string | null; at: string } | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<"pdf" | "xlsx" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const loadSeq = useRef(0);
  // Escala atual do navio lida direto do banco (não das props, que só mudam no
  // reload do Financeiro): é com ela que a folha sincroniza quem trabalhou.
  const [escalaAllocs, setEscalaAllocs] = useState<EscalaAllocation[]>([]);
  // Linhas em que o usuário preferiu digitar o nome em vez de escolher do RH.
  const [typingIds, setTypingIds] = useState<Set<string>>(() => new Set());

  // Colaboradores do RH: supervisores (função principal ou 2ª = SUPERVISOR,
  // não demitidos) pro select do cabeçalho e o setor Administrativo pra
  // tabela Administrativo. O rascunho só monta depois que isso chega
  // (empLoaded), senão o administrativo entraria vazio.
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [empLoaded, setEmpLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await db.from("employees").select("id, name, role, secondary_role, status, sector, admin_ship_rate").order("name");
      if (!alive) return;
      setEmployees(((res.data as EmployeeRow[] | null) || []));
      setEmpLoaded(true);
    })();
    return () => { alive = false; };
  }, []);
  const supervisors = useMemo(
    () => employees
      .filter((e) => e.status !== "INATIVO" && employeeHasRole(e, "SUPERVISOR"))
      .map((e) => (e.name || "").trim())
      .filter(Boolean),
    [employees],
  );
  // Setor Administrativo (menos demitidos) — quem entra pré-pronto na tabela,
  // igual ao auto-add do Resultado do Navio.
  const adminEmployees = useMemo(
    () => employees.filter((e) => e.sector === "ADMINISTRATIVO" && (e.status ?? "ATIVO") !== "INATIVO"),
    [employees],
  );
  const employeeById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  // Lista do select de nome em Funcionários: todo mundo do RH que não foi demitido.
  const employeeOptions = useMemo(
    () => employees
      .filter((e) => (e.status ?? "ATIVO") !== "INATIVO" && (e.name || "").trim())
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "pt-BR")),
    [employees],
  );
  const escalaByAllocId = useMemo(() => new Map(escalaAllocs.map((a) => [a.id, a])), [escalaAllocs]);
  // Funções ativas pro "+ pessoa em…" (qualquer uma do cadastro, não só as já na folha).
  const functionOptions = useMemo(
    () => functions
      .filter((f) => f.active !== false && (f.name || "").trim().toUpperCase() !== "ADMINISTRATIVO")
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [functions],
  );
  // Função-carregador ADMINISTRATIVO: é nela que o Resultado do Navio guarda
  // as alocações do administrativo (kind=ADMINISTRATIVO).
  const adminFn = useMemo(() => pickFunctionByName(functions, "ADMINISTRATIVO", "EMBARQUE") || null, [functions]);

  // Clientes pro select: os das operações e dos navios cadastrados + as
  // sementes da aba Navios, sem repetir por caixa ("Deep" = "DEEP").
  const clientOptions = useMemo(() => {
    const map = new Map<string, string>();
    const add = (v: string | null | undefined) => {
      const t = (v || "").trim();
      if (t && !map.has(t.toUpperCase())) map.set(t.toUpperCase(), t);
    };
    for (const j of jobs) { add(j.client); add(j.ships?.client_name); }
    for (const s of shipsAll) add(s.client_name);
    for (const c of DEFAULT_CLIENTS) add(c);
    return [...map.values()].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [jobs, shipsAll]);

  // Nº do navio no ano (planilha da diretoria) por ship_id.
  const shipNumbers = useMemo(() => computeShipYearNumbers(shipsAll), [shipsAll]);
  const shipById = useMemo(() => new Map(shipsAll.map((s) => [s.id, s])), [shipsAll]);
  const numberOf = useCallback(
    (j: Job) => (j.ship_id ? shipNumbers.get(j.ship_id)?.n : undefined),
    [shipNumbers],
  );

  const sortedJobs = useMemo(
    () => [...jobs].sort((a, b) => (b.start_date || "").localeCompare(a.start_date || "")),
    [jobs],
  );
  const filteredJobs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sortedJobs;
    return sortedJobs.filter((j) => {
      const n = numberOf(j);
      const hay = [j.name, j.ships?.name, j.client, j.ships?.client_name, j.port, n != null ? String(n) : ""]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [sortedJobs, search, numberOf]);

  const jobsByYear = useMemo(() => {
    const groups = new Map<string, Job[]>();
    for (const j of filteredJobs) {
      const y = (j.start_date || "").slice(0, 4) || "Sem data";
      const list = groups.get(y) || [];
      list.push(j);
      groups.set(y, list);
    }
    return [...groups.entries()];
  }, [filteredJobs]);

  const job = useMemo(() => jobs.find((j) => j.id === jobId) || null, [jobs, jobId]);
  // Serviço extra por porão do navio (Raspagem/Pintura), já somado na paga
  // pelas props — quando a função de alguém muda na escala, a paga nova leva
  // o mesmo extra.
  const serviceExtraRate = useMemo(() => {
    const a = allocations.find((x) => x.job_id === job?.id && (x.kind || "EMBARQUE") === "EMBARQUE" && Number(x.service_extra_rate) > 0);
    return a ? Number(a.service_extra_rate) : 0;
  }, [allocations, job?.id]);

  // Escala → folha: aplica a escala atual (quem, função/paga e supervisor) na
  // folha. A escala é a verdade sobre QUEM trabalhou e como; os valores
  // digitados ficam. `changes` é o que a tela avisa.
  const mergeEscala = useCallback((base: ClosingDoc, escala: EscalaAllocation[]): { doc: ClosingDoc; changes: string[] } => {
    const synced = syncWorkersFromEscala(base.workers, escala, { serviceExtraRate });
    const changes = [...synced.changes];
    let supervisor = base.supervisor;
    const sup = supervisorFromEscala(escala);
    if (sup && sup.toUpperCase() !== base.supervisor.trim().toUpperCase()) {
      changes.push(`supervisor ${base.supervisor.trim() || "—"} → ${sup}`);
      supervisor = sup;
    }
    return { doc: { ...base, workers: synced.workers, supervisor }, changes };
  }, [serviceExtraRate]);
  const mergeEscalaRef = useRef(mergeEscala);
  useEffect(() => { mergeEscalaRef.current = mergeEscala; }, [mergeEscala]);

  const buildDraft = useCallback(
    (j: Job, notes: DebitNoteRow[]): ClosingDoc => {
      const n = numberOf(j);
      const debit = notes.find((x) => x.kind === "DEBITO");
      return buildClosingDraft({
        job: j,
        number: n != null ? String(n) : "",
        allocations,
        adjustments,
        functions,
        supervisorName: supervisorFromAllocations(allocations, j.id),
        services: j.ships?.services ?? (j.ship_id ? shipById.get(j.ship_id)?.services : null),
        debitNote: debit
          ? { currency: debit.currency, subtotal: Number(debit.subtotal || 0), exchange_rate: debit.exchange_rate == null ? null : Number(debit.exchange_rate) }
          : null,
        adminEmployees,
      });
    },
    [allocations, adjustments, functions, numberOf, shipById, adminEmployees],
  );

  // Troca de navio: lê o fechamento salvo; sem linha, monta o rascunho.
  useEffect(() => {
    if (!job || loading || !empLoaded) { setDoc(null); setSavedJson(null); setSavedAt(null); return; }
    const seq = ++loadSeq.current;
    setLoadingDoc(true);
    setMsg(null);
    (async () => {
      const [rowRes, noteRes, escalaRes] = await Promise.all([
        db.from("job_closings").select("*").eq("job_id", job.id).limit(1),
        db.from("fiscal_notes").select("kind, currency, subtotal, exchange_rate, created_at").eq("job_id", job.id).order("created_at", { ascending: false }),
        db.from("job_allocations").select(ESCALA_SELECT).eq("job_id", job.id),
      ]);
      if (seq !== loadSeq.current) return;
      const notes = ((noteRes.data as DebitNoteRow[] | null) || []);
      const escala = ((escalaRes.data as EscalaAllocation[] | null) || []);
      setEscalaAllocs(escala);
      setTypingIds(new Set());
      const row = ((rowRes.data as ClosingRow[] | null) || [])[0];
      const saved = row ? normalizeClosingDoc(row.data) : null;
      if (saved) {
        // Escala → folha: quem foi trocado na escala (pessoa, função/paga,
        // supervisor) troca aqui também e deixa a folha "não salva"; o
        // vínculo de linhas antigas (salvas antes do select) é silencioso.
        const synced = mergeEscalaRef.current(saved, escala);
        setDoc(synced.doc);
        setSavedJson(JSON.stringify(synced.changes.length > 0 ? saved : synced.doc));
        setSavedAt({ by: row.updated_by, at: row.updated_at });
        if (synced.changes.length > 0) {
          setMsg({ kind: "ok", text: `A escala mudou (${synced.changes.join(", ")}) — folha atualizada, salve pra manter.` });
        }
      } else {
        if (rowRes.error) setMsg({ kind: "err", text: `Não foi possível ler o fechamento salvo: ${rowRes.error.message}` });
        setDoc(buildDraft(job, notes));
        setSavedJson(null);
        setSavedAt(null);
      }
      setLoadingDoc(false);
    })();
    // buildDraft muda a cada reload do Financeiro; o rascunho só deve ser
    // montado na troca de navio (senão sobrescreve o que o usuário digitou).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, loading, empLoaded]);

  // A escala pode mudar em outra aba do navegador (Navios) com esta folha
  // aberta: ao voltar pra esta janela, relê a escala e aplica na folha — a
  // troca de função feita lá aparece aqui sem precisar recarregar.
  const docRef = useRef(doc);
  useEffect(() => { docRef.current = doc; }, [doc]);
  const hasDoc = doc != null;
  useEffect(() => {
    if (!job || !hasDoc || loadingDoc || saving) return;
    const jobIdNow = job.id;
    let busy = false;
    const resync = async () => {
      if (busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const res = await db.from("job_allocations").select(ESCALA_SELECT).eq("job_id", jobIdNow);
        if (res.error) return;
        const escala = ((res.data as EscalaAllocation[] | null) || []);
        const cur = docRef.current;
        if (!cur) return;
        setEscalaAllocs(escala);
        const merged = mergeEscalaRef.current(cur, escala);
        if (JSON.stringify(merged.doc) === JSON.stringify(cur)) return;
        setDoc(merged.doc);
        if (merged.changes.length > 0) {
          setMsg({ kind: "ok", text: `A escala mudou (${merged.changes.join(", ")}) — folha atualizada, salve pra manter.` });
        }
      } finally {
        busy = false;
      }
    };
    window.addEventListener("focus", resync);
    document.addEventListener("visibilitychange", resync);
    return () => {
      window.removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", resync);
    };
  }, [job, hasDoc, loadingDoc, saving]);

  const totals = useMemo(() => (doc ? computeClosing(doc) : null), [doc]);
  // Funcionários por função (ESFREGÃO…, WAP…); a folha numera na mesma ordem.
  const workerGroups = useMemo(() => groupClosingWorkers(doc?.workers || []), [doc?.workers]);
  // Embarque é sempre por porão (sem coluna Tipo); o Costado mistura turnos
  // já somados (fixo) com quem fez por porão, então mantém a escolha.
  const isCostado = doc != null && closingServiceKind(doc) === "COSTADO";
  const dirty = doc != null && JSON.stringify(doc) !== savedJson;

  const update = useCallback((patch: Partial<ClosingDoc>) => {
    setDoc((d) => (d ? { ...d, ...patch } : d));
  }, []);
  const updateWorker = useCallback((id: string, patch: Partial<ClosingWorker>) => {
    setDoc((d) => (d ? { ...d, workers: d.workers.map((w) => (w.id === id ? { ...w, ...patch } : w)) } : d));
  }, []);
  const updateAdmin = useCallback((id: string, patch: Partial<ClosingAdminRow>) => {
    setDoc((d) => (d ? { ...d, admin: d.admin.map((a) => (a.id === id ? { ...a, ...patch } : a)) } : d));
  }, []);
  const updateCharge = useCallback((id: string, patch: Partial<ClosingCharge>) => {
    setDoc((d) => (d ? { ...d, charges: d.charges.map((c) => (c.id === id ? { ...c, ...patch } : c)) } : d));
  }, []);
  const updateExpense = useCallback((id: string, patch: Partial<ClosingExpense>) => {
    setDoc((d) => (d ? { ...d, expenses: d.expenses.map((e) => (e.id === id ? { ...e, ...patch } : e)) } : d));
  }, []);

  async function handleSave() {
    if (!job || !doc || !canEdit) return;
    setSaving(true);
    setMsg(null);
    // Folha → escala primeiro: trocas de pessoa e linhas novas vão pro
    // job_allocations, e as linhas novas voltam já ligadas à alocação criada.
    const escalaSync = await syncWorkersToEscala(job, doc.workers);
    const docToSave: ClosingDoc = escalaSync.workers === doc.workers ? doc : { ...doc, workers: escalaSync.workers };
    if (docToSave !== doc) setDoc(docToSave);
    const payload = { data: docToSave as unknown as Record<string, unknown>, updated_by: profileName };
    const res = savedJson == null
      ? await db.from("job_closings").insert({ job_id: job.id, ...payload })
      : await db.from("job_closings").update(payload).eq("job_id", job.id);
    setSaving(false);
    if (res.error) {
      setMsg({ kind: "err", text: `Falha ao salvar: ${res.error.message}` });
      return;
    }
    setSavedJson(JSON.stringify(docToSave));
    setSavedAt({ by: profileName, at: new Date().toISOString() });
    const syncErr = await syncAdminToResultado(job, docToSave.admin);
    const errors = [
      escalaSync.error ? `a escala não foi atualizada: ${escalaSync.error}` : null,
      syncErr ? `o administrativo não foi pro Resultado do Navio: ${syncErr}` : null,
    ].filter((x): x is string => x != null);
    if (errors.length > 0) {
      setMsg({ kind: "err", text: `Fechamento salvo, mas ${errors.join("; ")}.` });
      return;
    }
    const escalaNote = escalaSync.changed > 0
      ? ` Escala do navio atualizada (${escalaSync.changed} ${escalaSync.changed === 1 ? "alocação" : "alocações"}).`
      : "";
    setMsg({ kind: "ok", text: `Fechamento salvo. Administrativo atualizado no Resultado do Navio.${escalaNote}` });
    onEscalaChanged?.(escalaSync.changed > 0);
  }

  // Folha → escala (job_allocations): a pessoa trocada numa linha ligada à
  // escala é trocada lá (todas as alocações da linha — no Costado, cada turno);
  // linha nova com colaborador + função entra na escala como alocação de
  // Embarque com o valor padrão da função (o valor desta folha fica aqui).
  // Remover uma linha daqui não tira ninguém da escala.
  async function syncWorkersToEscala(j: Job, workers: ClosingWorker[]): Promise<{ workers: ClosingWorker[]; error: string | null; changed: number }> {
    const res = await db.from("job_allocations").select(ESCALA_SELECT).eq("job_id", j.id);
    if (res.error) return { workers, error: res.error.message, changed: 0 };
    const allocs = ((res.data as EscalaAllocation[] | null) || []);
    const { reassign, insert } = diffWorkersToEscala(workers, allocs);
    let changed = 0;
    let out = workers;
    let error: string | null = null;
    for (const r of reassign) {
      const up = await db.from("job_allocations").update({ employee_id: r.employee_id }).eq("id", r.allocation_id);
      if (up.error) { error = up.error.message; break; }
      changed += 1;
    }
    if (!error) {
      for (const ins of insert) {
        const fn = functions.find((f) => f.id === ins.function_id);
        const created = await db.from("job_allocations").insert({
          job_id: j.id,
          function_id: ins.function_id,
          employee_id: ins.employee_id,
          quantity: 1,
          rate: Number(fn?.default_rate || 0),
          pluxee_value: null,
          status: "ATIVO",
          kind: "EMBARQUE",
        });
        if (created.error) { error = created.error.message; break; }
        changed += 1;
        const createdId = Number((created.data as { id?: number } | null)?.id);
        if (Number.isFinite(createdId) && createdId > 0) {
          out = out.map((w) => (w.id === ins.worker_id ? { ...w, allocation_ids: [createdId] } : w));
        }
      }
    }
    if (changed > 0) {
      const re = await db.from("job_allocations").select(ESCALA_SELECT).eq("job_id", j.id);
      if (!re.error) setEscalaAllocs(((re.data as EscalaAllocation[] | null) || []));
    }
    return { workers: out, error, changed };
  }

  function addWorker(functionId: number | null, functionName: string) {
    if (!doc) return;
    const name = functionName.trim().toUpperCase();
    const fnId = functionId ?? (name ? pickFunctionByName(functions, name, isCostado ? "COSTADO" : "EMBARQUE")?.id ?? null : null);
    update({
      workers: insertWorkerInGroup(doc.workers, {
        id: newId("w"), name: "", mode: closingServiceKind(doc) === "COSTADO" ? "FIXO" : "PORAO",
        rate: 0, holds: null, extra_per_hold: 0, fixed_extra: 0, discount: 0, note: "",
        employee_id: null, allocation_ids: [], function_id: fnId, function_name: name,
      }),
    });
  }

  // Leva a tabela Administrativo pro Resultado do Navio (alocações
  // kind=ADMINISTRATIVO do navio): quem já está lá tem o valor atualizado,
  // quem falta é incluído. Linhas sem colaborador do cadastro ficam só na
  // folha. Não remove ninguém de lá — isso se faz no próprio Resultado.
  async function syncAdminToResultado(j: Job, rows: ClosingAdminRow[]): Promise<string | null> {
    const linked = rows.filter((r) => r.employee_id != null);
    if (linked.length === 0) return null;
    const res = await db.from("job_allocations").select("id, employee_id, rate, kind, status").eq("job_id", j.id);
    if (res.error) return res.error.message;
    const existing = ((res.data as Array<{ id: number; employee_id: number | null; rate: string | number; kind: string | null; status: string }> | null) || [])
      .filter((a) => a.kind === "ADMINISTRATIVO" && a.status === "ATIVO");
    const toInsert: Array<Record<string, unknown>> = [];
    for (const r of linked) {
      const amount = Number(r.amount) || 0;
      const cur = existing.find((a) => a.employee_id === r.employee_id);
      if (cur) {
        if (Number(cur.rate) !== amount) {
          const up = await db.from("job_allocations").update({ rate: amount }).eq("id", cur.id);
          if (up.error) return up.error.message;
        }
      } else if (adminFn) {
        toInsert.push({
          job_id: j.id,
          function_id: adminFn.id,
          employee_id: r.employee_id,
          quantity: 1,
          rate: amount,
          pluxee_value: null,
          status: "ATIVO",
          kind: "ADMINISTRATIVO",
        });
      }
    }
    if (toInsert.length > 0) {
      const ins = await db.from("job_allocations").insert(toInsert);
      if (ins.error) return ins.error.message;
    }
    return null;
  }

  // 💾 grava o valor da linha como padrão do colaborador
  // (employees.admin_ship_rate): os PRÓXIMOS navios já entram com ele, tanto
  // aqui quanto no Resultado do Navio.
  async function handleSaveAdminDefault(row: ClosingAdminRow) {
    if (row.employee_id == null) return;
    const amount = Number(row.amount) || 0;
    const res = await db.from("employees").update({ admin_ship_rate: amount }).eq("id", row.employee_id);
    if (res.error) { setMsg({ kind: "err", text: `Não gravou o padrão: ${res.error.message}` }); return; }
    setEmployees((list) => list.map((e) => (e.id === row.employee_id ? { ...e, admin_ship_rate: amount } : e)));
    setMsg({ kind: "ok", text: `${formatBRL(amount)} gravado como padrão de ${row.name.split(" ")[0] || "colaborador"} pros próximos navios.` });
  }

  async function handleReset() {
    if (!job) return;
    setConfirmReset(false);
    const noteRes = await db.from("fiscal_notes").select("kind, currency, subtotal, exchange_rate, created_at").eq("job_id", job.id).order("created_at", { ascending: false });
    setDoc(buildDraft(job, ((noteRes.data as DebitNoteRow[] | null) || [])));
    setMsg({ kind: "ok", text: "Rascunho remontado da escala — salve pra manter." });
  }

  // 📄 PDF / 📊 Excel do que está NA TELA (rascunho, salvo ou não — o mesmo
  // documento que o "Salvar fechamento" manda). O PDF é montado no servidor
  // (fechamento-navio-pdf.ts); o Excel no cliente, com o logo no topo. No
  // celular abre o menu de compartilhar; no desktop/Electron baixa.
  async function handleExport(format: "pdf" | "xlsx") {
    if (!doc) return;
    setExporting(format);
    setMsg(null);
    try {
      let blob: Blob;
      if (format === "pdf") {
        const res = await fetch("/api/financeiro/fechamento/pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(doc),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Erro ${res.status}`);
        }
        blob = await res.blob();
      } else {
        const mod = await import("@/lib/fechamento-navio-xlsx");
        blob = await mod.buildFechamentoXlsxBlob(doc);
      }
      await shareOrDownloadBlob(blob, closingFileName(doc, format));
    } catch (err) {
      setMsg({ kind: "err", text: `Não foi possível gerar o ${format === "pdf" ? "PDF" : "Excel"}: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setExporting(null);
    }
  }

  const disabled = !canEdit || loadingDoc;

  return (
    <div className="space-y-4">
      {/* Seleção do navio */}
      <div className="bg-card border border-border rounded-xl p-4 flex flex-col md:flex-row md:items-end gap-3">
        <div className="flex-1 min-w-0">
          <label className={labelCls}>Navio</label>
          <select
            className={inputCls}
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            disabled={loading}
          >
            <option value="">{loading ? "Carregando navios…" : "Escolha o navio…"}</option>
            {jobsByYear.map(([year, list]) => (
              <optgroup key={year} label={year}>
                {list.map((j) => {
                  const n = numberOf(j);
                  const client = (j.client || j.ships?.client_name || "").trim();
                  return (
                    <option key={j.id} value={j.id}>
                      {n != null ? `${n} - ` : ""}{(j.name || j.ships?.name || "").toUpperCase()}
                      {client ? ` · ${client}` : ""}{j.start_date ? ` · ${shortDateBR(j.start_date)}` : ""}
                    </option>
                  );
                })}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="md:w-64">
          <label className={labelCls}>Buscar</label>
          <input
            type="text"
            className={inputCls}
            placeholder="nome, cliente, porto, nº…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {!job && !loading && (
        <div className="bg-card border border-dashed border-border rounded-xl p-8 text-center text-sm text-text-light">
          Escolha um navio acima. A folha nasce da escala e das despesas do Resultado do Navio —
          daí é só ajustar porões, paga e extras nas caixinhas e salvar.
        </div>
      )}

      {job && doc && totals && (
        <>
          {/* Barra de ações */}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
            <div className="text-xs text-text-light">
              {loadingDoc ? (
                "Lendo fechamento…"
              ) : savedJson == null ? (
                <span className="inline-flex items-center gap-1.5 text-amber-700"><span className="w-2 h-2 rounded-full bg-amber-500" /> Rascunho montado da escala — ainda não salvo</span>
              ) : dirty ? (
                <span className="inline-flex items-center gap-1.5 text-amber-700"><span className="w-2 h-2 rounded-full bg-amber-500" /> Alterações não salvas</span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-emerald-700">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" /> Salvo
                  {savedAt ? ` · ${savedAt.by || "—"} · ${new Date(savedAt.at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}` : ""}
                </span>
              )}
              {msg && (
                <span className={`ml-3 ${msg.kind === "ok" ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => handleExport("pdf")} disabled={loadingDoc || exporting != null} title="PDF da folha como está na tela (salva ou não)">
                {exporting === "pdf" ? "Gerando…" : "📄 PDF"}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => handleExport("xlsx")} disabled={loadingDoc || exporting != null} title="Excel da folha como está na tela, no formato da planilha da diretoria">
                {exporting === "xlsx" ? "Gerando…" : "📊 Excel"}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConfirmReset(true)} disabled={disabled} title="Descarta o que foi digitado e remonta a folha da escala/despesas atuais">
                ↻ Refazer da escala
              </Button>
              <Button size="sm" onClick={handleSave} disabled={disabled || saving || !dirty}>
                {saving ? "Salvando…" : "💾 Salvar fechamento"}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,460px)_minmax(0,1fr)] gap-4 items-start">
            {/* ───────────── Editor ───────────── */}
            <div className="space-y-4">
              {/* Cabeçalho */}
              <section className={sectionCls}>
                <h3 className="text-sm font-bold text-text">Cabeçalho</h3>
                <div className="grid grid-cols-[72px_1fr] gap-2">
                  <div>
                    <label className={labelCls}>Nº</label>
                    <input className={inputCls} value={doc.number} disabled={disabled} onChange={(e) => update({ number: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelCls}>Navio</label>
                    <input className={inputCls} value={doc.ship_name} disabled={disabled} onChange={(e) => update({ ship_name: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className={labelCls} title="Multiplica a paga de todo mundo que é por porão">Porões</label>
                    <NumInput value={doc.holds_count} decimals={0} disabled={disabled} className="font-bold" onChange={(n) => update({ holds_count: Math.max(0, Math.round(n || 0)) })} />
                  </div>
                  <div>
                    <label className={labelCls}>Carga</label>
                    <input className={inputCls} value={doc.cargo_type} disabled={disabled} onChange={(e) => update({ cargo_type: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelCls}>Porto</label>
                    <input className={inputCls} value={doc.port} disabled={disabled} onChange={(e) => update({ port: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className={labelCls}>Início</label>
                    <input type="date" className={inputCls} value={doc.start_date} disabled={disabled} onChange={(e) => update({ start_date: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelCls}>Término</label>
                    <input type="date" className={inputCls} value={doc.end_date} disabled={disabled} onChange={(e) => update({ end_date: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelCls} title="Tipo da operação, como na aba Navios. Costado troca porões/carga por LIMPEZA DE COSTADO no título.">Serviço</label>
                    <select
                      className={inputCls}
                      value={closingServiceKind(doc)}
                      disabled={disabled}
                      onChange={(e) => setDoc((d) => (d ? applyClosingServiceKind(d, e.target.value === "COSTADO" ? "COSTADO" : "EMBARQUE") : d))}
                    >
                      <option value="EMBARQUE">Embarque</option>
                      <option value="COSTADO">Costado</option>
                    </select>
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between">
                    <label className={labelCls}>Título da folha</label>
                    {doc.title_override != null && (
                      <button type="button" className="text-[11px] text-primary hover:underline mb-1" disabled={disabled} onClick={() => update({ title_override: null })}>
                        voltar ao automático
                      </button>
                    )}
                  </div>
                  <input
                    className={`${inputCls} ${doc.title_override == null ? "text-text-light" : ""}`}
                    value={doc.title_override ?? buildClosingTitle({ ...doc, title_override: null })}
                    disabled={disabled}
                    onChange={(e) => update({ title_override: e.target.value })}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelCls}>Cliente</label>
                    <select className={inputCls} value={doc.client} disabled={disabled} onChange={(e) => update({ client: e.target.value })}>
                      <option value="">(sem cliente)</option>
                      {doc.client.trim() && !clientOptions.some((c) => c.toUpperCase() === doc.client.trim().toUpperCase()) && (
                        <option value={doc.client}>{doc.client}</option>
                      )}
                      {clientOptions.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Supervisor</label>
                    <select className={inputCls} value={doc.supervisor} disabled={disabled} onChange={(e) => update({ supervisor: e.target.value })}>
                      <option value="">(sem supervisor)</option>
                      {doc.supervisor.trim() && !supervisors.some((s) => s.toUpperCase() === doc.supervisor.trim().toUpperCase()) && (
                        <option value={doc.supervisor}>{doc.supervisor}</option>
                      )}
                      {supervisors.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                </div>
              </section>

              {/* Valores cobrados */}
              <section className={sectionCls}>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-text">Valor cobrado</h3>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    disabled={disabled}
                    onClick={() => update({ charges: [...doc.charges, { id: newId("c"), label: "", amount: 0, currency: doc.charges[0]?.currency || "BRL" }] })}
                  >
                    + linha
                  </button>
                </div>
                <div className="space-y-2">
                  {doc.charges.map((c) => (
                    <div key={c.id} className="grid grid-cols-[1fr_72px_110px_24px] gap-1.5 items-center">
                      <input className={inputCls} placeholder={SERVICE_CHARGE_LABEL[closingServiceKind(doc)]} value={c.label} disabled={disabled} onChange={(e) => updateCharge(c.id, { label: e.target.value })} />
                      <select className={inputCls} value={c.currency} disabled={disabled} onChange={(e) => updateCharge(c.id, { currency: e.target.value === "USD" ? "USD" : "BRL" })}>
                        <option value="BRL">R$</option>
                        <option value="USD">USD</option>
                      </select>
                      <NumInput value={c.amount} disabled={disabled} onChange={(n) => updateCharge(c.id, { amount: n || 0 })} />
                      <button type="button" className="text-text-light hover:text-red-600 text-lg leading-none" title="Remover" disabled={disabled} onClick={() => update({ charges: doc.charges.filter((x) => x.id !== c.id) })}>×</button>
                    </div>
                  ))}
                  {doc.charges.length === 0 && <p className="text-xs text-text-light">Nenhuma linha — a folha sai sem “VALOR COBRADO”.</p>}
                </div>
                {totals.hasUSD && (
                  <div className="grid grid-cols-[1fr_auto] gap-2 items-end pt-1 border-t border-border">
                    <div>
                      <label className={labelCls}>Taxa do dólar (R$)</label>
                      <NumInput value={doc.exchange_rate} nullable decimals={4} disabled={disabled} placeholder="5,0856" onChange={(n) => update({ exchange_rate: n })} />
                    </div>
                    {dollar && (
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline pb-2"
                        disabled={disabled}
                        title={`PTAX compra de ${dollar.date}`}
                        onClick={() => update({ exchange_rate: parseNumberBR(dollar.compra) })}
                      >
                        usar PTAX {formatNumberBR(parseNumberBR(dollar.compra), 4)}
                      </button>
                    )}
                  </div>
                )}
              </section>

              {/* Funcionários */}
              <section className={sectionCls}>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-text">Funcionários <span className="font-normal text-text-light">({doc.workers.length})</span></h3>
                  <select
                    className="text-xs text-primary bg-transparent cursor-pointer disabled:text-text-light"
                    value=""
                    disabled={disabled}
                    title="Acrescenta uma linha na função escolhida"
                    onChange={(e) => {
                      const v = e.target.value;
                      if (!v) return;
                      if (v === "__none") { addWorker(null, ""); return; }
                      const fn = functionOptions.find((f) => String(f.id) === v);
                      if (fn) addWorker(fn.id, fn.name);
                    }}
                  >
                    <option value="">+ pessoa em…</option>
                    {functionOptions.map((f) => <option key={f.id} value={String(f.id)}>{f.name}</option>)}
                    <option value="__none">Sem função</option>
                  </select>
                </div>
                <p className="text-[11px] text-text-light -mt-1">
                  {isCostado
                    ? "Costado: valor = paga (turnos já somados) − desconto. "
                    : `Embarque: valor = paga × porões − desconto. Porões já vêm com os ${doc.holds_count || 0} do navio — mude só pra quem fez menos. `}
                  Desc.: o que tirar desta pessoa (R$ 50 de material, vale…).
                  Agrupado pela função da escala; o nome é o colaborador do RH — trocar aqui troca na escala do navio ao salvar (e o que mudar na escala aparece aqui ao abrir). Remover daqui não tira da escala.
                </p>
                <div className="overflow-x-auto -mx-4 px-4">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-text-light">
                        <th className="text-left font-semibold pb-1">Nome</th>
                        <th className="text-right font-semibold pb-1 w-[84px]">Paga</th>
                        <th className="text-right font-semibold pb-1 w-[52px]" title="Porões desta pessoa">Por.</th>
                        <th className="text-right font-semibold pb-1 w-[76px]" title="Desconto desta pessoa, abatido do valor">Desc.</th>
                        <th className="text-right font-semibold pb-1 w-[88px]">Valor</th>
                        <th className="w-5" />
                      </tr>
                    </thead>
                    <tbody>
                      {workerGroups.map((g) => (
                        <Fragment key={g.key}>
                          <tr>
                            <td colSpan={6} className="pt-2.5 pb-1">
                              <div className="flex items-center justify-between border-b border-border pb-0.5">
                                <span className="text-[10px] font-bold uppercase tracking-wider text-primary">
                                  {g.function_name || "Sem função"} <span className="font-normal text-text-light">({g.rows.length})</span>
                                </span>
                                <button type="button" className="text-[11px] text-primary hover:underline" disabled={disabled} title={`Acrescentar pessoa em ${g.function_name || "sem função"}`} onClick={() => addWorker(g.function_id, g.function_name)}>
                                  + pessoa
                                </button>
                              </div>
                            </td>
                          </tr>
                          {g.rows.map(({ worker: w, index: i }) => {
                        // Porões em branco no documento = os do navio; a caixa
                        // mostra o número cheio e só grava quando difere.
                        const holdsShown = w.holds ?? doc.holds_count;
                        const extra = Number(w.fixed_extra) || 0;
                        // O que esta linha vai mudar na escala ao salvar.
                        const linkedAlloc = w.allocation_ids.map((id) => escalaByAllocId.get(id)).find((a) => a != null);
                        const pendingSwap = linkedAlloc != null && w.employee_id != null && linkedAlloc.employee_id !== w.employee_id;
                        const pendingNew = linkedAlloc == null && w.employee_id != null && w.function_id != null && w.mode === "PORAO";
                        const inList = w.employee_id != null && employeeOptions.some((e) => e.id === w.employee_id);
                        return (
                        <tr key={w.id} className="align-middle">
                          <td className="py-0.5 pr-1">
                            {typingIds.has(w.id) ? (
                              <div className="flex items-center gap-1 min-w-[180px]">
                                <input className={`${inputCls} py-1`} value={w.name} disabled={disabled} placeholder="NOME" autoFocus onChange={(e) => updateWorker(w.id, { name: e.target.value, employee_id: null })} />
                                <button type="button" className="text-xs text-primary hover:underline shrink-0" title="Voltar a escolher do RH" disabled={disabled} onClick={() => setTypingIds((prev) => { const n = new Set(prev); n.delete(w.id); return n; })}>lista</button>
                              </div>
                            ) : (
                              <select
                                className={`${inputCls} py-1 min-w-[180px] ${w.employee_id == null && w.name ? "text-amber-800" : ""}`}
                                value={w.employee_id != null ? String(w.employee_id) : w.name ? "__cur" : ""}
                                disabled={disabled}
                                title={[w.note, w.employee_id == null && w.name ? "Nome digitado — não está ligado ao RH" : ""].filter(Boolean).join(" · ") || undefined}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (v === "__type") { setTypingIds((prev) => new Set(prev).add(w.id)); updateWorker(w.id, { employee_id: null }); return; }
                                  if (v === "" || v === "__cur") return;
                                  const emp = employeeById.get(parseInt(v));
                                  if (emp) updateWorker(w.id, { employee_id: emp.id, name: (emp.name || "").trim() });
                                }}
                              >
                                <option value="">— escolher —</option>
                                {w.employee_id == null && w.name && <option value="__cur">{w.name}</option>}
                                {w.employee_id != null && !inList && <option value={String(w.employee_id)}>{w.name}</option>}
                                {employeeOptions.map((e) => <option key={e.id} value={String(e.id)}>{e.name}</option>)}
                                <option value="__type">Outro (digitar nome)…</option>
                              </select>
                            )}
                            {pendingSwap && (
                              <div className="text-[10px] text-amber-700 leading-tight mt-0.5">troca na escala ao salvar (era {(linkedAlloc.employees?.name || "—").split(" ")[0]})</div>
                            )}
                            {pendingNew && (
                              <div className="text-[10px] text-amber-700 leading-tight mt-0.5">entra na escala ao salvar</div>
                            )}
                          </td>
                          <td className="py-0.5 pr-1">
                            <NumInput value={w.rate} className="py-1 px-1.5" disabled={disabled} onChange={(n) => updateWorker(w.id, { rate: n || 0 })} />
                          </td>
                          <td className="py-0.5 pr-1">
                            {w.mode === "FIXO" ? (
                              <input className={`${inputCls} py-1 px-1.5 text-right`} value="—" disabled readOnly />
                            ) : (
                              <NumInput
                                value={holdsShown}
                                decimals={0}
                                className="py-1 px-1.5"
                                disabled={disabled}
                                onChange={(n) => {
                                  const v = Math.max(0, Math.round(n || 0));
                                  updateWorker(w.id, { holds: v <= 0 || v === doc.holds_count ? null : v });
                                }}
                              />
                            )}
                          </td>
                          <td className="py-0.5 pr-1">
                            <NumInput value={w.discount} className={`py-1 px-1.5 ${w.discount ? "text-red-700" : ""}`} disabled={disabled} onChange={(n) => updateWorker(w.id, { discount: Math.max(0, n || 0) })} />
                          </td>
                          <td className="py-0.5 text-right font-semibold tabular-nums whitespace-nowrap" title={extra !== 0 ? `Inclui ${extra > 0 ? "+" : ""}${formatNumberBR(extra)} de rateio/adicional da escala` : undefined}>
                            {formatNumberBR(totals.workerValues[i])}
                            {extra !== 0 && <div className="text-[10px] font-normal text-amber-700 leading-none">incl. {extra > 0 ? "+" : ""}{formatNumberBR(extra)}</div>}
                          </td>
                          <td className="py-0.5 text-center">
                            <button type="button" className="text-text-light hover:text-red-600 text-base leading-none" title="Remover desta folha (não tira da escala)" disabled={disabled} onClick={() => update({ workers: doc.workers.filter((x) => x.id !== w.id) })}>×</button>
                          </td>
                        </tr>
                        );
                      })}
                        </Fragment>
                      ))}
                      {doc.workers.length === 0 && (
                        <tr><td colSpan={6} className="py-2 text-xs text-text-light">Ninguém na folha — use “+ pessoa em…”.</td></tr>
                      )}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border">
                        <td colSpan={4} className="pt-1.5 text-right font-bold uppercase text-text-light">Equipe</td>
                        <td className="pt-1.5 text-right font-bold tabular-nums whitespace-nowrap">{formatNumberBR(totals.equipe)}</td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>

              {/* Administrativo */}
              <section className={sectionCls}>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-text">Administrativo <span className="font-normal text-text-light">({doc.admin.length})</span></h3>
                  {(() => {
                    const inDoc = new Set(doc.admin.map((a) => a.employee_id).filter((id): id is number => id != null));
                    const candidates = adminEmployees.filter((e) => !inDoc.has(e.id));
                    return (
                      <select
                        className="text-xs text-primary bg-transparent cursor-pointer disabled:text-text-light"
                        value=""
                        disabled={disabled}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "__free") {
                            update({ admin: [...doc.admin, { id: newId("ad"), employee_id: null, name: "", amount: 0 }] });
                            return;
                          }
                          const id = parseInt(v);
                          const emp = candidates.find((c) => c.id === id);
                          if (!emp) return;
                          update({ admin: [...doc.admin, { id: newId("ad"), employee_id: emp.id, name: (emp.name || "").trim(), amount: Number(emp.admin_ship_rate) || 0 }] });
                        }}
                      >
                        <option value="">+ pessoa</option>
                        {candidates.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                        <option value="__free">Outro (digitar nome)…</option>
                      </select>
                    );
                  })()}
                </div>
                <p className="text-[11px] text-text-light -mt-1">
                  Setor Administrativo (RH › Colaboradores), valor fixo por navio — entra na mão de obra, fora da folha.
                  Já vem com o padrão de cada um; mude o valor pra valer só neste navio, ou clique no 💾 pra virar o padrão dos próximos.
                  Ao salvar, vai junto pro Resultado do Navio.
                </p>
                <div className="overflow-x-auto -mx-4 px-4">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-text-light">
                        <th className="text-left font-semibold pb-1">Nome</th>
                        <th className="text-right font-semibold pb-1 w-[100px]">Valor</th>
                        <th className="w-6" />
                        <th className="w-5" />
                      </tr>
                    </thead>
                    <tbody>
                      {doc.admin.map((a) => {
                        const emp = a.employee_id != null ? employeeById.get(a.employee_id) : undefined;
                        const savedDefault = Number(emp?.admin_ship_rate) || 0;
                        const differs = emp != null && (Number(a.amount) || 0) !== savedDefault;
                        return (
                          <tr key={a.id} className="align-middle">
                            <td className="py-0.5 pr-1">
                              <input
                                className={`${inputCls} py-1 min-w-[180px]`}
                                value={a.name}
                                disabled={disabled || emp != null}
                                placeholder="NOME"
                                title={emp?.role && emp.role.trim().toUpperCase() !== "ADMINISTRATIVO" ? emp.role : undefined}
                                onChange={(e) => updateAdmin(a.id, { name: e.target.value })}
                              />
                            </td>
                            <td className="py-0.5 pr-1">
                              <NumInput value={a.amount} className="py-1 px-1.5" disabled={disabled} onChange={(n) => updateAdmin(a.id, { amount: n || 0 })} />
                            </td>
                            <td className="py-0.5 text-center">
                              {differs && !disabled && (
                                <button
                                  type="button"
                                  className="text-sm leading-none hover:bg-primary/10 rounded px-0.5"
                                  title={`Gravar ${formatBRL(Number(a.amount) || 0)} como padrão de ${a.name.split(" ")[0]} pros próximos navios (hoje: ${formatBRL(savedDefault)})`}
                                  onClick={() => handleSaveAdminDefault(a)}
                                >
                                  💾
                                </button>
                              )}
                            </td>
                            <td className="py-0.5 text-center">
                              <button type="button" className="text-text-light hover:text-red-600 text-base leading-none" title="Remover desta folha" disabled={disabled} onClick={() => update({ admin: doc.admin.filter((x) => x.id !== a.id) })}>×</button>
                            </td>
                          </tr>
                        );
                      })}
                      {doc.admin.length === 0 && (
                        <tr><td colSpan={4} className="py-2 text-xs text-text-light">Ninguém do administrativo nesta folha.</td></tr>
                      )}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border">
                        <td className="pt-1.5 text-right font-bold uppercase text-text-light">Administrativo</td>
                        <td className="pt-1.5 text-right font-bold tabular-nums whitespace-nowrap">{formatNumberBR(totals.administrativo)}</td>
                        <td colSpan={2} />
                      </tr>
                      <tr>
                        <td className="pt-0.5 text-right font-bold uppercase text-text-light">Mão de obra</td>
                        <td className="pt-0.5 text-right font-bold tabular-nums whitespace-nowrap" title="Equipe + Administrativo">{formatNumberBR(totals.maoDeObra)}</td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </section>

              {/* Despesas */}
              <section className={sectionCls}>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-text">Despesas</h3>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    disabled={disabled}
                    onClick={() => update({ expenses: [...doc.expenses, { id: newId("x"), label: "", amount: 0 }] })}
                  >
                    + despesa
                  </button>
                </div>
                <div className="space-y-1.5">
                  {doc.expenses.map((e) => (
                    <div key={e.id} className="grid grid-cols-[1fr_120px_24px] gap-1.5 items-center">
                      <input className={`${inputCls} py-1`} placeholder="COMPRAS" value={e.label} disabled={disabled} onChange={(ev) => updateExpense(e.id, { label: ev.target.value })} />
                      <NumInput value={e.amount} className="py-1" disabled={disabled} onChange={(n) => updateExpense(e.id, { amount: n || 0 })} />
                      <button type="button" className="text-text-light hover:text-red-600 text-lg leading-none" title="Remover" disabled={disabled} onClick={() => update({ expenses: doc.expenses.filter((x) => x.id !== e.id) })}>×</button>
                    </div>
                  ))}
                  {doc.expenses.length === 0 && <p className="text-xs text-text-light">Sem despesas lançadas.</p>}
                  <div className="flex justify-between border-t border-border pt-1.5 text-xs font-bold">
                    <span className="uppercase text-text-light">Despesas diversas</span>
                    <span className="tabular-nums">{formatNumberBR(totals.despesas)}</span>
                  </div>
                </div>
              </section>

              <section className={sectionCls}>
                <label className={labelCls}>Observações (só na tela)</label>
                <textarea className={`${inputCls} min-h-[60px]`} value={doc.notes} disabled={disabled} onChange={(e) => update({ notes: e.target.value })} />
              </section>
            </div>

            {/* ───────────── Folha (preview) ───────────── */}
            <div className="space-y-3 xl:sticky xl:top-4">
              <ClosingSheet doc={doc} totals={totals} />
              <div className="grid grid-cols-3 gap-2">
                <ResultCard label="Receita (R$)" value={formatBRL(totals.totalBRL)} tone="blue" hint={totals.hasUSD ? `${formatUSD(totals.usdTotal)} × ${doc.exchange_rate ? formatNumberBR(doc.exchange_rate, 4) : "taxa?"}` : undefined} />
                <ResultCard label="Custo total" value={formatBRL(totals.totalGeral)} tone="red" />
                <ResultCard
                  label={totals.resultado >= 0 ? "Lucro" : "Prejuízo"}
                  value={formatBRL(Math.abs(totals.resultado))}
                  tone={totals.resultado >= 0 ? "green" : "red"}
                  hint={totals.totalBRL > 0 ? `${formatNumberBR((totals.resultado / totals.totalBRL) * 100, 1)}% da receita` : undefined}
                />
              </div>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={handleReset}
        title="Refazer da escala?"
        message="Descarta o que foi digitado nesta folha e monta tudo de novo a partir da escala e das despesas atuais do navio. O salvo só muda se você salvar depois."
        confirmLabel="Refazer"
        variant="warning"
      />
    </div>
  );
}

function ResultCard({ label, value, tone, hint }: { label: string; value: string; tone: "blue" | "red" | "green"; hint?: string }) {
  const cls = {
    blue: "border-blue-200 bg-blue-50 text-blue-900",
    red: "border-red-200 bg-red-50 text-red-900",
    green: "border-emerald-200 bg-emerald-50 text-emerald-900",
  }[tone];
  return (
    <div className={`rounded-xl border px-3 py-2 ${cls}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">{label}</div>
      <div className="text-base font-bold tabular-nums leading-tight">{value}</div>
      {hint && <div className="text-[10px] opacity-70 mt-0.5">{hint}</div>}
    </div>
  );
}

// A folha em si — reproduz a aba LIMPEZA da planilha: logo, título em negrito,
// CLIENTE/SUPERVISOR, linhas de VALOR COBRADO, taxa do dólar e total em real
// (quando cobra em USD), tabela numerada de funcionários, MÃO DE OBRA,
// despesas, DESPESAS DIVERSAS, TOTAL GERAL e rodapé da empresa.
function ClosingSheet({ doc, totals }: { doc: ClosingDoc; totals: ReturnType<typeof computeClosing> }) {
  const chargeLine = (c: ClosingCharge) =>
    c.currency === "USD"
      ? `VALOR COBRADO USD ${formatNumberBR(c.amount)} ( DOLARES )${c.label ? ` ${c.label.toUpperCase()}` : ""}`
      : `VALOR COBRADO R$ ${formatNumberBR(c.amount)}${c.label ? ` ( ${c.label.toUpperCase()} )` : ""}`;
  let rowNo = 0;
  const cell = "border border-black px-2 py-1";
  return (
    <div className="bg-white text-black rounded-xl border border-border shadow-sm p-6 md:p-8 overflow-x-auto">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/cargo-logo.png" alt="Cargo Ships Cleaning" className="h-16 md:h-20 w-auto mb-5" />

      <div className="font-serif text-base md:text-lg font-bold tracking-wide mb-3">{totals.title || "—"}</div>
      <div className="text-sm md:text-base uppercase mb-2">
        CLIENTE: {doc.client || "—"}{doc.supervisor ? <> - SUPERVISOR&nbsp; {doc.supervisor}</> : null}
      </div>
      {doc.charges.map((c) => (
        <div key={c.id} className="text-sm md:text-base uppercase mb-2">{chargeLine(c)}</div>
      ))}

      {totals.hasUSD ? (
        <div className="mt-3 mb-2 space-y-1">
          <div className="flex items-baseline justify-between gap-4 text-sm md:text-base uppercase">
            <span>TAXA DO DOLLAR R$ {doc.exchange_rate ? formatNumberBR(doc.exchange_rate, 4) : "—"} total serviço USD:</span>
            <span className="font-serif text-xs md:text-sm whitespace-nowrap">{formatUSD(totals.usdTotal)}</span>
          </div>
          <div className="flex items-baseline justify-between gap-4 text-sm md:text-base">
            <span>Total em Real:</span>
            <span className="font-serif text-xs md:text-sm whitespace-nowrap">{formatBRL(totals.totalBRL)}</span>
          </div>
        </div>
      ) : doc.charges.length > 1 ? (
        <div className="mt-3 mb-2 text-sm md:text-base uppercase">TOTAL COBRADO: R$ {formatNumberBR(totals.totalBRL)}</div>
      ) : null}

      <table className="font-serif text-sm border-collapse w-full max-w-xl mt-2">
        <tbody>
          {groupClosingWorkers(doc.workers).flatMap((g) => g.rows).map(({ worker: w, index: i }) => {
            rowNo += 1;
            return (
              <tr key={w.id}>
                <td className={`${cell} w-8 text-center`}>{rowNo}</td>
                <td className={`${cell} uppercase`}>{w.name || <span className="text-gray-400">—</span>}</td>
                <td className={`${cell} w-32 text-center tabular-nums`}>{formatNumberBR(totals.workerValues[i])}</td>
              </tr>
            );
          })}
          {/* Administrativo: na planilha da diretoria vem logo abaixo da equipe,
              numerado em sequência (a "CAMILA … 200,00"). */}
          {doc.admin.map((a) => (
            <tr key={a.id}>
              <td className={`${cell} w-8 text-center`}>{++rowNo}</td>
              <td className={`${cell} uppercase`}>{a.name || <span className="text-gray-400">—</span>}</td>
              <td className={`${cell} w-32 text-center tabular-nums`}>{formatNumberBR(a.amount)}</td>
            </tr>
          ))}
          <tr>
            <td className={`${cell} w-8 text-center`}>{++rowNo}</td>
            <td className={cell}>&nbsp;</td>
            <td className={cell}>&nbsp;</td>
          </tr>
          <tr className="font-bold">
            <td className={`${cell} text-center`}>{++rowNo}</td>
            <td className={cell}>MÃO DE OBRA</td>
            <td className={`${cell} text-center tabular-nums`}>{formatNumberBR(totals.maoDeObra)}</td>
          </tr>
          {doc.expenses.map((e) => (
            <tr key={e.id}>
              <td className={`${cell} text-center`}>{++rowNo}</td>
              <td className={`${cell} uppercase`}>{e.label || <span className="text-gray-400">—</span>}</td>
              <td className={`${cell} text-center tabular-nums`}>{formatNumberBR(e.amount)}</td>
            </tr>
          ))}
          <tr>
            <td className={`${cell} text-center`}>{++rowNo}</td>
            <td className={cell}>&nbsp;</td>
            <td className={cell}>&nbsp;</td>
          </tr>
          <tr className="font-bold">
            <td className={`${cell} text-center`}>{++rowNo}</td>
            <td className={cell}>DESPESAS DIVERSAS</td>
            <td className={`${cell} text-center tabular-nums`}>{formatNumberBR(totals.despesas)}</td>
          </tr>
          <tr>
            <td className={`${cell} text-center`}>{++rowNo}</td>
            <td className={cell}>&nbsp;</td>
            <td className={cell}>&nbsp;</td>
          </tr>
          <tr className="font-bold">
            <td className={`${cell} text-center`}>{++rowNo}</td>
            <td className={cell}>TOTAL GERAL</td>
            <td className={`${cell} text-center tabular-nums`}>{formatNumberBR(totals.totalGeral)}</td>
          </tr>
        </tbody>
      </table>

      <div className="mt-8 text-[10px] text-gray-500 leading-relaxed">
        {COMPANY_FOOTER.map((line) => <div key={line}>{line}</div>)}
      </div>
    </div>
  );
}
