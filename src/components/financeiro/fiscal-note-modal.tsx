"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { useAuth } from "@/lib/auth-context";
import { canDeleteFiscalNote } from "@/lib/rbac";
import { parseDecimalBR } from "@/lib/utils";
import { fetchPtaxCompra } from "@/components/dollar-ticker";
import {
  CALC_METHODS,
  calcFiscalNoteTotals,
  convertUsdItem,
  findInvoiceClient,
  formatMoney,
  formatNoteNumber,
  normalizeCalcMethod,
  resolveHeaderLine,
  type FiscalNoteCalcMethod,
  type FiscalNoteCurrency,
  type FiscalNoteKind,
  type FiscalNoteLanguage,
  type InvoiceClientRow,
} from "@/lib/fiscal-note";

// Emissão da Nota de Débito / Crédito a partir do Pagamento de Navios.
//
// O que o SISTEMA já sabe entra pré-preenchido (navio, cliente, porto, entrada/
// saída, porões, serviços contratados, cadastro fiscal do cliente — Financeiro ›
// Dados dos Clientes). O que só vem de fora é digitado:
//   • OI — número da ordem de serviço da agência. Só a Wilson Sons trabalha
//     com OI, então o campo aparece só pra cliente com `requires_oi`;
//   • ISS do mês — vem da CONTABILIDADE, por isso é sempre perguntado;
//   • valor de cada serviço.
// A taxa do dólar vem sugerida: a mesma da última nota DESTE navio (a Wilson
// Sons recebe lavagem e lancha em notas separadas, com a mesma taxa) ou, sem
// nota ainda, a PTAX de compra do dia — e pode ser trocada pela negociada.
//
// Cada cliente fatura de um jeito (invoice_clients.calc_method): o modal mostra
// a fórmula DO CLIENTE do navio e a memória de cálculo ao vivo, igual à coluna
// lateral das planilhas da diretoria. Wilson Sons = USD × qtd × taxa → R$, com
// ISS no crédito; Continental e demais = valor fechado digitado na moeda da nota.
//
// Uma nota por documento: pra faturar lavagem e lancha em notas separadas (como
// a Wilson Sons exige), emite-se duas, cada uma com seus itens.

interface ExistingNote {
  id: string;
  kind: string;
  number: number;
  year: number;
  ship_name: string;
  issue_date: string;
  currency: string;
  language?: string;
  total: string | number;
  exchange_rate: string | number | null;
}

interface ItemDraft {
  description: string;
  unit: string;
  qty: string;
  amount: string;
}

export interface FiscalNoteJob {
  id: string;
  name: string;
  client: string | null;
  port: string | null;
  holds_count: number | null;
  start_date: string;
  end_date: string | null;
  contract_value: string | number | null;
}

const inputCls =
  "w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/40";
const labelCls = "block text-xs font-medium text-text-light mb-1";

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Números digitados em pt-BR (vírgula decimal). parseDecimalBR só trata ponto
// como milhar quando há vírgula — "5.15" é 5.15, não 515.
const parseBR = parseDecimalBR;

const fmtNum = (v: number, digits = 2) =>
  v.toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });

// Taxa gravada (4 casas) → texto pt-BR do campo ("5,1508").
function rateToText(v: string | number | null | undefined): string {
  const n = Number(v);
  return n > 0 ? n.toFixed(4).replace(".", ",") : "";
}

export function FiscalNoteModal({
  open, job, services, onClose, onSaved,
}: {
  open: boolean;
  job: FiscalNoteJob | null;
  // Serviços do navio (ships.services) — viram a primeira sugestão de itens.
  services: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { user, profile } = useAuth();
  // Apagar nota emitida: só Guilherme e EXECUTIVO (mesma régua da rota DELETE).
  const canDelete = canDeleteFiscalNote(profile?.role, user?.email);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Idioma escolhido pra baixar cada nota emitida (padrão = o gravado na nota).
  const [downloadLang, setDownloadLang] = useState<Record<string, FiscalNoteLanguage>>({});

  const [kind, setKind] = useState<FiscalNoteKind>("DEBITO");
  const [clients, setClients] = useState<InvoiceClientRow[]>([]);
  const [notes, setNotes] = useState<ExistingNote[]>([]);
  const [nextDebito, setNextDebito] = useState(1);
  const [nextCredito, setNextCredito] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [number, setNumber] = useState("");
  const [issueDate, setIssueDate] = useState(todayISO());
  const [dueDate, setDueDate] = useState("");
  const [oi, setOi] = useState("");
  const [currency, setCurrency] = useState<FiscalNoteCurrency>("BRL");
  const [language, setLanguage] = useState<FiscalNoteLanguage>("PT");
  const [exchangeRate, setExchangeRate] = useState("");
  // De onde veio a taxa sugerida — só pra avisar o usuário no campo.
  const [rateSource, setRateSource] = useState<"NOTA" | "PTAX" | null>(null);
  const [issPercent, setIssPercent] = useState("");
  const [obs, setObs] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([]);
  // Cadastro fiscal do cliente, editável na hora (o que for digitado é gravado
  // no cadastro pra próxima nota já vir pronta — o mesmo de Dados dos Clientes).
  const [legalName, setLegalName] = useState("");
  const [address, setAddress] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [ie, setIe] = useState("");
  const [municipal, setMunicipal] = useState("");
  const [headerLine, setHeaderLine] = useState("");
  const [requiresOi, setRequiresOi] = useState(false);
  // Rótulo da caixa do valor do cliente ("Valor total a Fatura:" / "Valor").
  const [valueLabel, setValueLabel] = useState("");
  // Forma de cálculo do cliente (Dados dos Clientes) — decide a fórmula do modal.
  const [calcMethod, setCalcMethod] = useState<FiscalNoteCalcMethod>("DIRETO");
  const converted = calcMethod === "USD_CONVERTIDO";

  const year = Number(issueDate.slice(0, 4)) || new Date().getFullYear();

  // Descrição sugerida por serviço contratado do navio.
  // Segue o modelo de cada cliente: nota em inglês (Wilson Sons) usa "HOLD
  // CLEANING OF 05 HOLDS OF THE SHIP: BSM QINZHOU"; em português, "Prestação de
  // Serviço de Limpeza em 5 Porões do MV …".
  const suggestedItems = useCallback((lang: FiscalNoteLanguage): ItemDraft[] => {
    const holds = Math.max(1, Number(job?.holds_count || 1));
    const ship = job?.name || "";
    const hh = String(holds).padStart(2, "0");
    const bare = ship.replace(/^M\/?V\s+/i, "").toUpperCase();
    const map: Record<string, string> = lang === "EN" ? {
      LAVAGEM_PORAO: `HOLD CLEANING OF ${hh} HOLDS OF THE SHIP: ${bare}`,
      RASPAGEM: `HOLD SCRAPING OF ${hh} HOLDS OF THE SHIP: ${bare}`,
      PINTURA: `HOLD PAINTING OF ${hh} HOLDS OF THE SHIP: ${bare}`,
    } : {
      LAVAGEM_PORAO: `Prestação de Serviço de Limpeza em ${holds} Porões do ${ship}`,
      RASPAGEM: `Prestação de Serviço de Raspagem em ${holds} Porões do ${ship}`,
      PINTURA: `Prestação de Serviço de Pintura em ${holds} Porões do ${ship}`,
    };
    const list = (services.length ? services : ["LAVAGEM_PORAO"])
      .map((s) => map[s])
      .filter(Boolean)
      .map((description) => ({ description, unit: "", qty: String(holds), amount: "" }));
    return list.length ? list : [{ description: "", unit: "", qty: "", amount: "" }];
  }, [job, services]);

  // Notas do navio + próximo número da sequência DO ANO. Separado do loadAll
  // porque o ano acompanha a data de emissão: se o usuário retroagir a data pra
  // outro ano, o "Sai como NNN/YY" precisa ser refeito pra sequência daquele ano.
  const loadNotes = useCallback(async (): Promise<ExistingNote[]> => {
    if (!job) return [];
    const res = await fetch(`/api/financeiro/notas?job_id=${encodeURIComponent(job.id)}&year=${year}`)
      .then((r) => r.json())
      .catch(() => null);
    if (!res) return [];
    const list: ExistingNote[] = res.notes || [];
    setNotes(list);
    setNextDebito(res.nextDebito || 1);
    setNextCredito(res.nextCredito || 1);
    return list;
  }, [job, year]);

  useEffect(() => {
    if (!open || !job) return;
    loadNotes();
    // `job` chega como literal novo a cada render do pai — depender do id (e do
    // ano, que segue a data de emissão) evita refetch em todo render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job?.id, year]);

  const loadAll = useCallback(async (): Promise<FiscalNoteLanguage> => {
    if (!job) return "PT";
    setError(null);
    const { data: clientRows } = await db.from("invoice_clients").select("*");
    const list = (clientRows as InvoiceClientRow[] | null) || [];
    setClients(list);
    const match = findInvoiceClient(list, job.client);
    setLegalName(match?.legal_name || "");
    setAddress(match?.address || "");
    setCnpj(match?.cnpj || "");
    setIe(match?.ie || "");
    setMunicipal(match?.municipal_reg || "");
    setHeaderLine(match?.header_line || "");
    setRequiresOi(!!match?.requires_oi);
    setValueLabel(match?.value_label || "");
    const lang: FiscalNoteLanguage = match?.language === "EN" ? "EN" : "PT";
    setLanguage(lang);
    const method = normalizeCalcMethod(match?.calc_method);
    setCalcMethod(method);
    // USD convertido (Wilson Sons): a nota sai sempre em R$.
    setCurrency((method === "USD_CONVERTIDO" ? "BRL" : match?.default_currency === "USD" ? "USD" : "BRL") as FiscalNoteCurrency);
    return lang;
  }, [job]);

  // Sugestão da taxa do dólar: última nota deste navio com taxa; senão PTAX
  // de compra do dia. Só preenche se o campo ainda estiver vazio (o usuário
  // pode ter digitado a negociada enquanto a PTAX carregava).
  const suggestRate = useCallback(async (shipNotes: ExistingNote[]) => {
    const fromNote = shipNotes
      .slice()
      .sort((a, b) => String(b.issue_date).localeCompare(String(a.issue_date)))
      .find((n) => Number(n.exchange_rate) > 0);
    if (fromNote) {
      setExchangeRate((cur) => cur || rateToText(fromNote.exchange_rate));
      setRateSource("NOTA");
      return;
    }
    const ptax = await fetchPtaxCompra();
    if (ptax) {
      setExchangeRate((cur) => cur || rateToText(ptax));
      setRateSource("PTAX");
    }
  }, []);

  useEffect(() => {
    if (!open || !job) return;
    setKind("DEBITO");
    setNumber("");
    setIssueDate(todayISO());
    setDueDate("");
    setOi("");
    setExchangeRate("");
    setRateSource(null);
    setIssPercent("");
    setObs("");
    setItems([]);
    // Os itens sugeridos dependem do idioma do cliente — só depois do cadastro.
    loadAll().then((lang) => setItems(suggestedItems(lang)));
    loadNotes().then(suggestRate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job?.id]);

  const effectiveNumber = number.trim()
    ? Number(number)
    : kind === "DEBITO" ? nextDebito : nextCredito;

  // Valor de cada linha conforme a fórmula do cliente. USD convertido: unit
  // (USD) × qtd × taxa = R$; sem unit/qtd vale o total digitado direto em R$.
  const rate = parseBR(exchangeRate);
  const calcRows = useMemo(() => items.map((it) => {
    const unit = parseBR(it.unit);
    const qty = parseBR(it.qty);
    if (converted && unit > 0 && qty > 0) {
      const { totalUsd, amountBrl } = convertUsdItem(unit, qty, rate);
      return { unit, qty, totalUsd, amount: amountBrl, derived: true };
    }
    return { unit, qty, totalUsd: 0, amount: parseBR(it.amount), derived: false };
  }), [items, converted, rate]);

  const totals = useMemo(
    () => calcFiscalNoteTotals(calcRows.map((r) => ({ amount: r.amount })), issPercent ? parseBR(issPercent) : null),
    [calcRows, issPercent],
  );

  function patchItem(i: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  // Valor unitário × quantidade preenche o total da linha — é a memória de
  // cálculo das notas atuais (USD/porão × porões).
  function recalcAmount(i: number) {
    setItems((prev) => prev.map((it, idx) => {
      if (idx !== i) return it;
      const u = parseBR(it.unit);
      const q = parseBR(it.qty);
      // USD convertido calcula ao vivo (calcRows) — não grava o total no campo.
      if (!converted && u > 0 && q > 0) return { ...it, amount: (u * q).toFixed(2).replace(".", ",") };
      return it;
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!job) return;
    if (converted && !(rate > 0)) {
      setError("Informe a taxa do dólar negociada — o valor em R$ sai de USD × taxa.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Grava/atualiza o cadastro fiscal do cliente pra próxima nota já vir pronta.
      const clientName = (job.client || "").trim();
      if (clientName) {
        const existing = findInvoiceClient(clients, clientName);
        // Idioma e moeda são escolhas DESTA nota: não voltam pro cadastro de um
        // cliente que já existe (uma nota em USD não muda o padrão do cliente).
        const payload = {
          legal_name: legalName || null, address: address || null, cnpj: cnpj || null,
          ie: ie || null, municipal_reg: municipal || null, header_line: headerLine || null,
          requires_oi: requiresOi,
        };
        if (existing) await db.from("invoice_clients").update(payload as never).eq("id", existing.id);
        else await db.from("invoice_clients").insert({ name: clientName, ...payload, language, default_currency: currency, created_by: "Sistema" } as never);
      }

      const res = await fetch("/api/financeiro/notas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          number: number.trim() ? Number(number) : undefined,
          year,
          job_id: job.id,
          ship_name: job.name,
          client_name: clientName,
          client_legal_name: legalName || null,
          client_address: address || null,
          client_cnpj: cnpj || null,
          client_ie: ie || null,
          client_municipal: municipal || null,
          header_line: headerLine || null,
          language,
          oi: requiresOi && oi ? oi : null,
          port: job.port || null,
          arrival_date: job.start_date,
          departure_date: job.end_date,
          issue_date: issueDate,
          due_date: dueDate || null,
          currency,
          exchange_rate: exchangeRate ? parseBR(exchangeRate) : null,
          iss_percent: issPercent ? parseBR(issPercent) : null,
          calc_method: calcMethod,
          value_label: valueLabel || null,
          notes: obs || null,
          items: items
            .map((it, idx) => ({ it, row: calcRows[idx] }))
            .filter(({ it }) => it.description.trim())
            .map(({ it, row }, i) => ({
              position: i + 1,
              description: it.description.trim(),
              unit_value: it.unit ? parseBR(it.unit) : null,
              quantity: it.qty ? parseBR(it.qty) : null,
              amount: row.amount,
            })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Falha ao emitir a nota (HTTP ${res.status}).`);
      const [lang] = await Promise.all([loadAll(), loadNotes()]);
      setItems(suggestedItems(lang));
      setNumber("");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Apaga uma nota emitida. O servidor checa de novo quem pode; aqui o botão só
  // aparece pra quem passa em canDeleteFiscalNote.
  async function handleDelete(n: ExistingNote) {
    const label = `${n.kind === "DEBITO" ? "ND" : "NC"} ${formatNoteNumber(n.number, n.year)}`;
    if (!confirm(`Apagar a nota ${label} do ${n.ship_name}?\n\nO número ${formatNoteNumber(n.number, n.year)} sai da sequência do ano e a nota não pode ser recuperada.`)) return;
    setDeletingId(n.id);
    setError(null);
    try {
      const res = await fetch(`/api/financeiro/notas/${n.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Falha ao apagar a nota (HTTP ${res.status}).`);
      await loadNotes();
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  }

  if (!job) return null;
  const previewHeader = resolveHeaderLine(headerLine, job.name, legalName || job.client || "");

  return (
    <Modal open={open} onClose={onClose} title={`Notas · ${job.name}`} maxWidth="max-w-4xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Notas já emitidas para este navio */}
        {notes.length > 0 && (
          <div className="rounded-lg border border-border bg-gray-50 p-3">
            <p className="text-xs font-semibold text-text mb-1.5">📄 Notas emitidas deste navio</p>
            <div className="space-y-1">
              {notes.map((n) => (
                <div key={n.id} className="flex items-center gap-2 text-xs">
                  <span className={`px-1.5 py-0.5 rounded font-semibold ${n.kind === "DEBITO" ? "bg-red-100 text-red-700" : "bg-emerald-100 text-emerald-700"}`}>
                    {n.kind === "DEBITO" ? "ND" : "NC"} {formatNoteNumber(n.number, n.year)}
                  </span>
                  <span className="text-text-light">{String(n.issue_date).slice(0, 10).split("-").reverse().join("/")}</span>
                  <span className="font-semibold tabular-nums">
                    {formatMoney(Number(n.total), (n.currency === "USD" ? "USD" : "BRL") as FiscalNoteCurrency)}
                  </span>
                  <select value={downloadLang[n.id] ?? (n.language === "EN" ? "EN" : "PT")}
                    onChange={(e) => setDownloadLang((m) => ({ ...m, [n.id]: e.target.value as FiscalNoteLanguage }))}
                    title="Idioma do arquivo baixado"
                    className="ml-auto border border-border rounded px-1 py-0.5 text-[11px] bg-white">
                    <option value="PT">PT</option>
                    <option value="EN">EN</option>
                  </select>
                  <a href={`/api/financeiro/notas/${n.id}/arquivo?formato=pdf&idioma=${(downloadLang[n.id] ?? n.language ?? "PT").toLowerCase()}`}
                    className="px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700">📕 PDF</a>
                  <a href={`/api/financeiro/notas/${n.id}/arquivo?formato=xlsx&idioma=${(downloadLang[n.id] ?? n.language ?? "PT").toLowerCase()}`}
                    className="px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700">📗 XLSX</a>
                  {canDelete && (
                    <button type="button" onClick={() => handleDelete(n)} disabled={deletingId === n.id}
                      title="Apagar nota emitida (só Guilherme e Executivo)"
                      className="px-2 py-0.5 rounded border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50">
                      {deletingId === n.id ? "…" : "🗑"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Numeração à esquerda + tipo + datas. O número vem em branco (próximo
            do ano) — digitar um número serve pra emitir a segunda nota do mesmo
            navio em sequência (058/26 lavagem, 059/26 lancha). */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className={labelCls}>Número</label>
            <input type="number" min="1" value={number} onChange={(e) => setNumber(e.target.value)}
              placeholder={String(kind === "DEBITO" ? nextDebito : nextCredito)} className={`${inputCls} font-semibold`} />
            <p className="text-[10px] text-text-light mt-0.5">
              Sai como <strong>{formatNoteNumber(effectiveNumber, year)}</strong> — em branco usa o próximo do ano.
            </p>
          </div>
          <div>
            <label className={labelCls}>Tipo *</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as FiscalNoteKind)} className={inputCls}>
              <option value="DEBITO">Nota de Débito (cobrança)</option>
              <option value="CREDITO">Nota de Crédito (repasse)</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Emissão *</label>
            <input type="date" required value={issueDate} onChange={(e) => setIssueDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Vencimento</label>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={inputCls} />
          </div>
        </div>

        {/* Moeda, taxa e ISS — a taxa vem sugerida; o ISS vem de fora */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className={labelCls}>Moeda</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value as FiscalNoteCurrency)}
              disabled={converted} className={`${inputCls} disabled:bg-gray-100`}>
              <option value="BRL">R$ (Real)</option>
              <option value="USD">USD (Dólar)</option>
            </select>
            {converted && <p className="text-[10px] text-text-light mt-0.5">Nota em R$ — o USD é convertido pela taxa.</p>}
          </div>
          <div>
            <label className={labelCls}>Taxa do dólar negociada{converted ? " *" : ""}</label>
            <input type="text" value={exchangeRate} onChange={(e) => { setExchangeRate(e.target.value); setRateSource(null); }}
              placeholder="5,1508" className={inputCls} />
            {rateSource && exchangeRate && (
              <p className="text-[10px] text-text-light mt-0.5">
                {rateSource === "NOTA" ? "Mesma taxa da última nota deste navio." : "PTAX de compra do dia (Banco Central) — troque pela negociada."}
              </p>
            )}
          </div>
          <div>
            <label className={labelCls}>ISS do mês (%)</label>
            <input type="text" value={issPercent} onChange={(e) => setIssPercent(e.target.value)} placeholder="2,71" className={inputCls} />
            <p className="text-[10px] text-amber-700 mt-0.5">Vem da contabilidade — abate do total.</p>
          </div>
          <div>
            <label className={labelCls}>Idioma da nota</label>
            <select value={language} onChange={(e) => setLanguage(e.target.value as FiscalNoteLanguage)} className={inputCls}>
              <option value="PT">Português</option>
              <option value="EN">Inglês (DEBIT NOTE)</option>
            </select>
            <p className="text-[10px] text-text-light mt-0.5">Vem do cadastro do cliente. Depois de emitida, a nota baixa nos dois idiomas.</p>
          </div>
        </div>

        {/* Título da nota deste cliente, já pronto (cadastro em Dados dos Clientes). */}
        <div className="rounded-lg border border-border bg-gray-50 px-3 py-2">
          <p className="text-[10px] font-semibold text-text-light">
            {kind === "DEBITO" ? (language === "EN" ? "DEBIT NOTE" : "NOTA DE DÉBITO") : (language === "EN" ? "CREDIT NOTE" : "NOTA DE CRÉDITO")} {formatNoteNumber(effectiveNumber, year)} — título do cliente {job.client ? `(${job.client})` : ""}
          </p>
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm font-bold text-text">{previewHeader || "—"}</p>
            <span className="shrink-0 text-xs font-bold italic bg-yellow-200 px-2 py-0.5 rounded">
              {valueLabel || (language === "EN" ? "Valor" : "Valor total a Fatura:")} {formatMoney(totals.total, currency)}
            </span>
          </div>
          <p className="text-[11px] text-text-light">
            {[address, [cnpj && `CNPJ: ${cnpj}`, ie && `I.E.: ${ie}`, municipal && `Insc. Munic.: ${municipal}`].filter(Boolean).join(" - ")].filter(Boolean).join(" · ")}
          </p>
        </div>

        {/* OI — só pra cliente que trabalha com ordem da agência (Wilson Sons).
            Fica embaixo, separado, porque os demais clientes não têm. */}
        {requiresOi && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="col-span-2">
              <label className={labelCls}>OI (ordem da agência) — {job.client}</label>
              <input type="text" value={oi} onChange={(e) => setOi(e.target.value)} placeholder="AGVSSZ260673" className={inputCls} />
              <p className="text-[10px] text-text-light mt-0.5">Sai na nota como <strong>OI: {oi || "…"}</strong>, logo abaixo do navio.</p>
            </div>
          </div>
        )}

        {/* Itens */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-semibold text-text">Itens da nota *</label>
            <button type="button" onClick={() => setItems((p) => [...p, { description: "", unit: "", qty: "", amount: "" }])}
              className="text-xs px-2 py-1 bg-primary text-white rounded hover:bg-primary-dark">+ Item</button>
          </div>
          <div className="space-y-2">
            {converted && (
              <div className="hidden md:grid grid-cols-12 gap-2 text-[10px] font-semibold text-text-light">
                <span className="col-span-4">Descrição</span>
                <span className="col-span-2">USD por porão / lancha</span>
                <span className="col-span-1">Qtd</span>
                <span className="col-span-2">Total USD</span>
                <span className="col-span-2">Valor em R$ (débito)</span>
              </div>
            )}
            {items.map((it, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-start">
                <input type="text" value={it.description} onChange={(e) => patchItem(i, { description: e.target.value })}
                  placeholder="Prestação de Serviço de Limpeza em 5 Porões do MV…"
                  className={`${inputCls} col-span-12 ${converted ? "md:col-span-4" : "md:col-span-6"}`} />
                <input type="text" value={it.unit} onChange={(e) => patchItem(i, { unit: e.target.value })} onBlur={() => recalcAmount(i)}
                  placeholder={converted ? "USD unit." : "Unit."} title={converted ? "Valor em USD por porão / por lancha" : "Valor por porão/unidade"}
                  className={`${inputCls} col-span-3 md:col-span-2`} />
                <input type="text" value={it.qty} onChange={(e) => patchItem(i, { qty: e.target.value })} onBlur={() => recalcAmount(i)}
                  placeholder="Qtd" title="Porões / lanchas" className={`${inputCls} col-span-3 md:col-span-1`} />
                {converted && (
                  <input type="text" readOnly tabIndex={-1} value={calcRows[i]?.derived ? fmtNum(calcRows[i].totalUsd) : ""}
                    placeholder="Total USD" title="USD unitário × quantidade"
                    className={`${inputCls} col-span-3 md:col-span-2 bg-gray-100 tabular-nums`} />
                )}
                {converted && calcRows[i]?.derived ? (
                  <input type="text" readOnly tabIndex={-1} value={rate > 0 ? fmtNum(calcRows[i].amount) : ""}
                    placeholder="Falta a taxa" title="Total USD × taxa do dólar"
                    className={`${inputCls} col-span-4 md:col-span-2 font-semibold bg-gray-100 tabular-nums`} />
                ) : (
                  <input type="text" value={it.amount} onChange={(e) => patchItem(i, { amount: e.target.value })}
                    placeholder={converted ? "R$" : "Total"} className={`${inputCls} col-span-4 md:col-span-2 font-semibold`} />
                )}
                <button type="button" onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))}
                  className="col-span-2 md:col-span-1 text-red-600 hover:bg-red-50 rounded py-2 text-sm" title="Remover item">🗑</button>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-text-light mt-1">
            {converted
              ? "Digite o valor em USD e a quantidade — o R$ sai de USD × Qtd × taxa do dólar. Lancha e lavagem vão em notas separadas: emita duas."
              : "Unit. × Qtd preenche o Total ao sair do campo. Pra faturar lancha e lavagem em notas separadas, emita duas notas."}
          </p>
        </div>

        {/* Cadastro fiscal do cliente — vem de Financeiro › Dados dos Clientes;
            o que for corrigido aqui volta pro cadastro. */}
        <details className="rounded-lg border border-border p-3" open={!cnpj}>
          <summary className="text-xs font-semibold cursor-pointer">
            🏢 Dados do cliente {job.client ? `(${job.client})` : ""} — do cadastro em Dados dos Clientes
          </summary>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
            <div className="col-span-2 md:col-span-3">
              <label className={labelCls}>Título da nota (linha do destinatário)</label>
              <input type="text" value={headerLine} onChange={(e) => setHeaderLine(e.target.value)}
                placeholder={legalName || job.client || "Razão social do cliente"} className={inputCls} />
              <p className="text-[10px] text-text-light mt-0.5">
                Já vem pronto do cadastro do cliente. Em branco usa a razão social; <code>{"{NAVIO}"}</code> vira o nome do navio.
              </p>
            </div>
            <div><label className={labelCls}>Razão social</label>
              <input type="text" value={legalName} onChange={(e) => setLegalName(e.target.value)} className={inputCls} /></div>
            <div className="col-span-2"><label className={labelCls}>Endereço</label>
              <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} className={inputCls} /></div>
            <div><label className={labelCls}>CNPJ</label>
              <input type="text" value={cnpj} onChange={(e) => setCnpj(e.target.value)} className={inputCls} /></div>
            <div><label className={labelCls}>Inscrição Estadual</label>
              <input type="text" value={ie} onChange={(e) => setIe(e.target.value)} className={inputCls} /></div>
            <div><label className={labelCls}>Inscrição Municipal</label>
              <input type="text" value={municipal} onChange={(e) => setMunicipal(e.target.value)} className={inputCls} /></div>
            <div className="flex items-end">
              <label className="inline-flex items-center gap-2 text-sm cursor-pointer pb-2">
                <input type="checkbox" checked={requiresOi} onChange={(e) => setRequiresOi(e.target.checked)} className="w-4 h-4" />
                Nota com OI (ordem da agência)
              </label>
            </div>
            <div className="col-span-2 md:col-span-1"><label className={labelCls}>Observação na nota</label>
              <input type="text" value={obs} onChange={(e) => setObs(e.target.value)} className={inputCls} /></div>
          </div>
        </details>

        {/* Como este cliente é calculado + memória de cálculo ao vivo — a mesma
            conta da coluna lateral das planilhas de nota da diretoria. */}
        <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3">
          <p className="text-xs font-semibold text-text">
            🧮 Como a nota {job.client ? `da ${job.client}` : "deste cliente"} é calculada — {CALC_METHODS[calcMethod].label}
          </p>
          <ol className="text-[11px] text-text-light mt-1 list-decimal pl-4 space-y-0.5">
            {CALC_METHODS[calcMethod].steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
          <table className="mt-2 text-xs tabular-nums">
            <tbody>
              {items.map((it, i) => {
                const r = calcRows[i];
                if (!r || !(r.amount > 0 || r.derived)) return null;
                const line = (v: string, label: string, strong = false) => (
                  <tr className={strong ? "font-semibold bg-blue-100/70" : ""}>
                    <td className="text-right pr-2 py-0.5 pl-2">{v}</td>
                    <td className="py-0.5 pr-2">{label}</td>
                  </tr>
                );
                return (
                  <Fragment key={i}>
                    <tr><td colSpan={2} className="pt-1.5 text-[11px] font-semibold text-text">{i + 1}- {it.description.trim() || `Item ${i + 1}`}</td></tr>
                    {r.derived ? (
                      <>
                        {line(fmtNum(r.unit), "Valor unitário (USD)")}
                        {line(fmtNum(r.qty, 0), "Qtde (porões / lanchas)")}
                        {line(fmtNum(r.totalUsd), "Total (USD)")}
                        {line(rate > 0 ? fmtNum(rate, 4) : "—", "tx dólar")}
                        {line(fmtNum(r.amount), "Total em R$", true)}
                      </>
                    ) : (
                      <>
                        {r.unit > 0 && r.qty > 0 && line(`${fmtNum(r.unit)} × ${fmtNum(r.qty, 0)}`, "Unitário × Qtde")}
                        {line(fmtNum(r.amount), `Valor do item (${currency === "USD" ? "USD" : "R$"})`, true)}
                      </>
                    )}
                  </Fragment>
                );
              })}
              <tr><td colSpan={2} className="pt-1.5" /></tr>
              <tr><td className="text-right pr-2 pl-2 py-0.5">{fmtNum(totals.subtotal)}</td><td>Total da fatura</td></tr>
              {(converted || totals.issValue > 0) && (
                <>
                  <tr><td className="text-right pr-2 pl-2 py-0.5">{issPercent ? `${issPercent}%` : "—"}</td><td>ISS do mês</td></tr>
                  <tr><td className="text-right pr-2 pl-2 py-0.5">{fmtNum(totals.issValue)}</td><td>Valor do ISS (crédito)</td></tr>
                </>
              )}
              <tr className="font-semibold"><td className="text-right pr-2 pl-2 py-0.5">{fmtNum(totals.total)}</td><td>Valor total da NF/ND</td></tr>
            </tbody>
          </table>
          <p className="text-[10px] text-text-light mt-1.5">A forma de cálculo é do cliente — muda em Financeiro › Dados dos Clientes.</p>
        </div>

        {/* Totais */}
        <div className="rounded-lg border border-border bg-gray-50 p-3 text-sm">
          <div className="flex justify-between"><span className="text-text-light">Subtotal</span>
            <span className="font-semibold tabular-nums">{formatMoney(totals.subtotal, currency)}</span></div>
          {totals.issValue > 0 && (
            <div className="flex justify-between text-amber-700"><span>ISS ({issPercent}%)</span>
              <span className="font-semibold tabular-nums">− {formatMoney(totals.issValue, currency)}</span></div>
          )}
          <div className="flex justify-between border-t border-border mt-1.5 pt-1.5">
            <span className="font-semibold">Total da nota</span>
            <span className="text-lg font-bold text-emerald-700 tabular-nums">{formatMoney(totals.total, currency)}</span>
          </div>
        </div>

        {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Fechar</Button>
          <Button type="submit" disabled={saving || totals.subtotal <= 0}>
            {saving ? "Emitindo…" : `📄 Emitir ${kind === "DEBITO" ? "Nota de Débito" : "Nota de Crédito"}`}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
