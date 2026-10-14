"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { DollarQuote } from "@/components/dollar-ticker";
import { computeShipYearNumbers } from "@/lib/ship-number";
import type { AnnualShipRow } from "@/lib/relatorios-anuais-xlsx";
import {
  COMPANY_FOOTER,
  buildClosingDraft,
  buildClosingTitle,
  computeClosing,
  formatBRL,
  formatNumberBR,
  formatUSD,
  newId,
  normalizeClosingDoc,
  parseNumberBR,
  shortDateBR,
  type ClosingCharge,
  type ClosingDoc,
  type ClosingExpense,
  type ClosingWorker,
} from "@/lib/fechamento-navio";
import type { Job, JobAdjustment, JobAllocation, JobFunction } from "@/types/database";

// Financeiro › Fechamento de Navio — a planilha de fechamento da diretoria
// ("42 - FECHAMENTO EUROPA GRAECA - WILSONSONS - SANTOS.xlsx") na tela.
//
// À esquerda ficam as caixinhas que o executivo preenche (porões, paga de cada
// um, extras, valores cobrados, taxa do dólar, despesas); à direita a folha,
// igual ao Excel, recalculando a cada tecla. O rascunho nasce da escala e das
// despesas do Resultado do Navio; o que o usuário mexe fica salvo por navio
// em job_closings (sem tocar na escala). "Refazer da escala" descarta o salvo
// e monta de novo.

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

export function FechamentoNavioPage({
  jobs, allocations, adjustments, functions, shipsAll, canEdit, profileName, dollar, loading,
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
}) {
  const [search, setSearch] = useState("");
  const [jobId, setJobId] = useState<string>("");
  const [doc, setDoc] = useState<ClosingDoc | null>(null);
  const [savedJson, setSavedJson] = useState<string | null>(null); // null = sem linha salva
  const [savedAt, setSavedAt] = useState<{ by: string | null; at: string } | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const loadSeq = useRef(0);

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
      });
    },
    [allocations, adjustments, functions, numberOf, shipById],
  );

  // Troca de navio: lê o fechamento salvo; sem linha, monta o rascunho.
  useEffect(() => {
    if (!job || loading) { setDoc(null); setSavedJson(null); setSavedAt(null); return; }
    const seq = ++loadSeq.current;
    setLoadingDoc(true);
    setMsg(null);
    (async () => {
      const [rowRes, noteRes] = await Promise.all([
        db.from("job_closings").select("*").eq("job_id", job.id).limit(1),
        db.from("fiscal_notes").select("kind, currency, subtotal, exchange_rate, created_at").eq("job_id", job.id).order("created_at", { ascending: false }),
      ]);
      if (seq !== loadSeq.current) return;
      const notes = ((noteRes.data as DebitNoteRow[] | null) || []);
      const row = ((rowRes.data as ClosingRow[] | null) || [])[0];
      const saved = row ? normalizeClosingDoc(row.data) : null;
      if (saved) {
        setDoc(saved);
        setSavedJson(JSON.stringify(saved));
        setSavedAt({ by: row.updated_by, at: row.updated_at });
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
  }, [job?.id, loading]);

  const totals = useMemo(() => (doc ? computeClosing(doc) : null), [doc]);
  const dirty = doc != null && JSON.stringify(doc) !== savedJson;

  const update = useCallback((patch: Partial<ClosingDoc>) => {
    setDoc((d) => (d ? { ...d, ...patch } : d));
  }, []);
  const updateWorker = useCallback((id: string, patch: Partial<ClosingWorker>) => {
    setDoc((d) => (d ? { ...d, workers: d.workers.map((w) => (w.id === id ? { ...w, ...patch } : w)) } : d));
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
    const payload = { data: doc as unknown as Record<string, unknown>, updated_by: profileName };
    const res = savedJson == null
      ? await db.from("job_closings").insert({ job_id: job.id, ...payload })
      : await db.from("job_closings").update(payload).eq("job_id", job.id);
    setSaving(false);
    if (res.error) {
      setMsg({ kind: "err", text: `Falha ao salvar: ${res.error.message}` });
      return;
    }
    setSavedJson(JSON.stringify(doc));
    setSavedAt({ by: profileName, at: new Date().toISOString() });
    setMsg({ kind: "ok", text: "Fechamento salvo." });
  }

  async function handleReset() {
    if (!job) return;
    setConfirmReset(false);
    const noteRes = await db.from("fiscal_notes").select("kind, currency, subtotal, exchange_rate, created_at").eq("job_id", job.id).order("created_at", { ascending: false });
    setDoc(buildDraft(job, ((noteRes.data as DebitNoteRow[] | null) || [])));
    setMsg({ kind: "ok", text: "Rascunho remontado da escala — salve pra manter." });
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
                    <label className={labelCls} title="Ex.: LIMPEZA DE COSTADO — substitui porões/carga no título">Serviço</label>
                    <input className={inputCls} value={doc.service_label} disabled={disabled} placeholder="(porões)" onChange={(e) => update({ service_label: e.target.value })} />
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
                    <input className={inputCls} value={doc.client} disabled={disabled} onChange={(e) => update({ client: e.target.value })} />
                  </div>
                  <div>
                    <label className={labelCls}>Supervisor</label>
                    <input className={inputCls} value={doc.supervisor} disabled={disabled} onChange={(e) => update({ supervisor: e.target.value })} />
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
                      <input className={inputCls} placeholder="LAVAGEM DOS PORÕES" value={c.label} disabled={disabled} onChange={(e) => updateCharge(c.id, { label: e.target.value })} />
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
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    disabled={disabled}
                    onClick={() => update({ workers: [...doc.workers, { id: newId("w"), name: "", mode: "PORAO", rate: 0, holds: null, extra_per_hold: 0, fixed_extra: 0, note: "" }] })}
                  >
                    + pessoa
                  </button>
                </div>
                <p className="text-[11px] text-text-light -mt-1">
                  Por porão: (paga + extra/porão) × porões + extra fixo. Fixo: paga + extra. Porões em branco = os {doc.holds_count || 0} do navio.
                </p>
                <div className="overflow-x-auto -mx-4 px-4">
                  <table className="w-full text-xs min-w-[520px]">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-text-light">
                        <th className="text-left font-semibold pb-1">Nome</th>
                        <th className="text-left font-semibold pb-1 w-16">Tipo</th>
                        <th className="text-right font-semibold pb-1 w-20">Paga</th>
                        <th className="text-right font-semibold pb-1 w-14" title="Porões só desta pessoa">Por.</th>
                        <th className="text-right font-semibold pb-1 w-20" title="Extra por porão (ex.: produto no piso)">+/porão</th>
                        <th className="text-right font-semibold pb-1 w-20" title="Valor fixo somado (rateio, adicional)">Extra</th>
                        <th className="text-right font-semibold pb-1 w-24">Valor</th>
                        <th className="w-5" />
                      </tr>
                    </thead>
                    <tbody>
                      {doc.workers.map((w, i) => (
                        <tr key={w.id} className="align-middle">
                          <td className="py-0.5 pr-1">
                            <input className={`${inputCls} py-1`} value={w.name} disabled={disabled} placeholder="NOME" title={w.note || undefined} onChange={(e) => updateWorker(w.id, { name: e.target.value })} />
                          </td>
                          <td className="py-0.5 pr-1">
                            <select className={`${inputCls} py-1 px-1`} value={w.mode} disabled={disabled} onChange={(e) => updateWorker(w.id, { mode: e.target.value === "FIXO" ? "FIXO" : "PORAO" })}>
                              <option value="PORAO">porão</option>
                              <option value="FIXO">fixo</option>
                            </select>
                          </td>
                          <td className="py-0.5 pr-1">
                            <NumInput value={w.rate} className="py-1 px-1.5" disabled={disabled} onChange={(n) => updateWorker(w.id, { rate: n || 0 })} />
                          </td>
                          <td className="py-0.5 pr-1">
                            <NumInput value={w.holds} nullable decimals={0} className="py-1 px-1.5" disabled={disabled || w.mode === "FIXO"} placeholder={w.mode === "FIXO" ? "—" : String(doc.holds_count || "")} onChange={(n) => updateWorker(w.id, { holds: n == null || n <= 0 ? null : Math.round(n) })} />
                          </td>
                          <td className="py-0.5 pr-1">
                            <NumInput value={w.extra_per_hold} className="py-1 px-1.5" disabled={disabled || w.mode === "FIXO"} onChange={(n) => updateWorker(w.id, { extra_per_hold: n || 0 })} />
                          </td>
                          <td className="py-0.5 pr-1">
                            <NumInput value={w.fixed_extra} className="py-1 px-1.5" disabled={disabled} onChange={(n) => updateWorker(w.id, { fixed_extra: n || 0 })} />
                          </td>
                          <td className="py-0.5 text-right font-semibold tabular-nums whitespace-nowrap">{formatNumberBR(totals.workerValues[i])}</td>
                          <td className="py-0.5 text-center">
                            <button type="button" className="text-text-light hover:text-red-600 text-base leading-none" title="Remover" disabled={disabled} onClick={() => update({ workers: doc.workers.filter((x) => x.id !== w.id) })}>×</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border">
                        <td colSpan={6} className="pt-1.5 text-right font-bold uppercase text-text-light">Mão de obra</td>
                        <td className="pt-1.5 text-right font-bold tabular-nums whitespace-nowrap">{formatNumberBR(totals.maoDeObra)}</td>
                        <td />
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
          {doc.workers.map((w, i) => {
            rowNo += 1;
            return (
              <tr key={w.id}>
                <td className={`${cell} w-8 text-center`}>{rowNo}</td>
                <td className={`${cell} uppercase`}>{w.name || <span className="text-gray-400">—</span>}</td>
                <td className={`${cell} w-32 text-center tabular-nums`}>{formatNumberBR(totals.workerValues[i])}</td>
              </tr>
            );
          })}
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
