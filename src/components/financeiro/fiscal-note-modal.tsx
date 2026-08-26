"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { parseDecimalBR } from "@/lib/utils";
import {
  calcFiscalNoteTotals,
  formatMoney,
  formatNoteNumber,
  resolveHeaderLine,
  type FiscalNoteCurrency,
  type FiscalNoteKind,
  type FiscalNoteLanguage,
} from "@/lib/fiscal-note";

// Emissão da Nota de Débito / Crédito a partir do Pagamento de Navios.
//
// O que o SISTEMA já sabe entra pré-preenchido (navio, cliente, porto, entrada/
// saída, porões, serviços contratados). O que só vem de fora é digitado:
//   • OI — número da ordem de serviço da agência;
//   • ISS do mês — vem da CONTABILIDADE, por isso é sempre perguntado;
//   • taxa do dólar negociada e o valor de cada serviço.
//
// Uma nota por documento: pra faturar lavagem e lancha em notas separadas (como
// a Wilson Sons exige), emite-se duas, cada uma com seus itens.

interface InvoiceClient {
  id: number;
  name: string;
  legal_name: string | null;
  address: string | null;
  cnpj: string | null;
  ie: string | null;
  municipal_reg: string | null;
  header_line: string | null;
  language: string;
  default_currency: string;
}

interface ExistingNote {
  id: string;
  kind: string;
  number: number;
  year: number;
  ship_name: string;
  issue_date: string;
  currency: string;
  total: string | number;
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
  const [kind, setKind] = useState<FiscalNoteKind>("DEBITO");
  const [clients, setClients] = useState<InvoiceClient[]>([]);
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
  const [issPercent, setIssPercent] = useState("");
  const [obs, setObs] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([]);
  // Cadastro fiscal do cliente, editável na hora (o que for digitado é gravado
  // no cadastro pra próxima nota já vir pronta).
  const [legalName, setLegalName] = useState("");
  const [address, setAddress] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [ie, setIe] = useState("");
  const [municipal, setMunicipal] = useState("");
  const [headerLine, setHeaderLine] = useState("");

  const year = Number(issueDate.slice(0, 4)) || new Date().getFullYear();

  // Descrição sugerida por serviço contratado do navio.
  const suggestedItems = useCallback((): ItemDraft[] => {
    const holds = Math.max(1, Number(job?.holds_count || 1));
    const ship = job?.name || "";
    const map: Record<string, string> = {
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
  const loadNotes = useCallback(async () => {
    if (!job) return;
    const res = await fetch(`/api/financeiro/notas?job_id=${encodeURIComponent(job.id)}&year=${year}`)
      .then((r) => r.json())
      .catch(() => null);
    if (res) {
      setNotes(res.notes || []);
      setNextDebito(res.nextDebito || 1);
      setNextCredito(res.nextCredito || 1);
    }
  }, [job, year]);

  useEffect(() => {
    if (!open || !job) return;
    loadNotes();
    // `job` chega como literal novo a cada render do pai — depender do id (e do
    // ano, que segue a data de emissão) evita refetch em todo render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job?.id, year]);

  const loadAll = useCallback(async () => {
    if (!job) return;
    setError(null);
    const { data: clientRows } = await db.from("invoice_clients").select("*");
    const list = (clientRows as InvoiceClient[] | null) || [];
    setClients(list);
    const match = list.find(
      (c) => c.name.trim().toUpperCase() === (job.client || "").trim().toUpperCase(),
    );
    setLegalName(match?.legal_name || "");
    setAddress(match?.address || "");
    setCnpj(match?.cnpj || "");
    setIe(match?.ie || "");
    setMunicipal(match?.municipal_reg || "");
    setHeaderLine(match?.header_line || "");
    setLanguage((match?.language === "EN" ? "EN" : "PT") as FiscalNoteLanguage);
    setCurrency((match?.default_currency === "USD" ? "USD" : "BRL") as FiscalNoteCurrency);
  }, [job]);

  useEffect(() => {
    if (!open || !job) return;
    setKind("DEBITO");
    setNumber("");
    setIssueDate(todayISO());
    setDueDate("");
    setOi("");
    setExchangeRate("");
    setIssPercent("");
    setObs("");
    setItems(suggestedItems());
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, job?.id]);

  const effectiveNumber = number.trim()
    ? Number(number)
    : kind === "DEBITO" ? nextDebito : nextCredito;

  const totals = useMemo(
    () => calcFiscalNoteTotals(items.map((it) => ({ amount: parseBR(it.amount) })), issPercent ? parseBR(issPercent) : null),
    [items, issPercent],
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
      if (u > 0 && q > 0) return { ...it, amount: (u * q).toFixed(2).replace(".", ",") };
      return it;
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!job) return;
    setSaving(true);
    setError(null);
    try {
      // Grava/atualiza o cadastro fiscal do cliente pra próxima nota já vir pronta.
      const clientName = (job.client || "").trim();
      if (clientName) {
        const existing = clients.find((c) => c.name.trim().toUpperCase() === clientName.toUpperCase());
        const payload = {
          legal_name: legalName || null, address: address || null, cnpj: cnpj || null,
          ie: ie || null, municipal_reg: municipal || null, header_line: headerLine || null,
          language, default_currency: currency,
        };
        if (existing) await db.from("invoice_clients").update(payload as never).eq("id", existing.id);
        else await db.from("invoice_clients").insert({ name: clientName, ...payload, created_by: "Sistema" } as never);
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
          oi: oi || null,
          port: job.port || null,
          arrival_date: job.start_date,
          departure_date: job.end_date,
          issue_date: issueDate,
          due_date: dueDate || null,
          currency,
          exchange_rate: exchangeRate ? parseBR(exchangeRate) : null,
          iss_percent: issPercent ? parseBR(issPercent) : null,
          notes: obs || null,
          items: items
            .filter((it) => it.description.trim())
            .map((it, i) => ({
              position: i + 1,
              description: it.description.trim(),
              unit_value: it.unit ? parseBR(it.unit) : null,
              quantity: it.qty ? parseBR(it.qty) : null,
              amount: parseBR(it.amount),
            })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || `Falha ao emitir a nota (HTTP ${res.status}).`);
      await Promise.all([loadAll(), loadNotes()]);
      setItems(suggestedItems());
      setNumber("");
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
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
                  <a href={`/api/financeiro/notas/${n.id}/arquivo?formato=pdf`}
                    className="ml-auto px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700">📕 PDF</a>
                  <a href={`/api/financeiro/notas/${n.id}/arquivo?formato=xlsx`}
                    className="px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700">📗 XLSX</a>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tipo + numeração */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className={labelCls}>Tipo *</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as FiscalNoteKind)} className={inputCls}>
              <option value="DEBITO">Nota de Débito (cobrança)</option>
              <option value="CREDITO">Nota de Crédito (repasse)</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Número</label>
            <input type="number" min="1" value={number} onChange={(e) => setNumber(e.target.value)}
              placeholder={String(kind === "DEBITO" ? nextDebito : nextCredito)} className={inputCls} />
            <p className="text-[10px] text-text-light mt-0.5">
              Sai como <strong>{formatNoteNumber(effectiveNumber, year)}</strong> — em branco usa o próximo do ano.
            </p>
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

        {/* Dados que só existem fora do sistema */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className={labelCls}>OI (ordem da agência)</label>
            <input type="text" value={oi} onChange={(e) => setOi(e.target.value)} placeholder="AGVSSZ260673" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Moeda</label>
            <select value={currency} onChange={(e) => setCurrency(e.target.value as FiscalNoteCurrency)} className={inputCls}>
              <option value="BRL">R$ (Real)</option>
              <option value="USD">USD (Dólar)</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>Taxa do dólar negociada</label>
            <input type="text" value={exchangeRate} onChange={(e) => setExchangeRate(e.target.value)} placeholder="5,1508" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>ISS do mês (%)</label>
            <input type="text" value={issPercent} onChange={(e) => setIssPercent(e.target.value)} placeholder="2,71" className={inputCls} />
            <p className="text-[10px] text-amber-700 mt-0.5">Vem da contabilidade — abate do total.</p>
          </div>
        </div>

        {/* Itens */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-semibold text-text">Itens da nota *</label>
            <button type="button" onClick={() => setItems((p) => [...p, { description: "", unit: "", qty: "", amount: "" }])}
              className="text-xs px-2 py-1 bg-primary text-white rounded hover:bg-primary-dark">+ Item</button>
          </div>
          <div className="space-y-2">
            {items.map((it, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-start">
                <input type="text" value={it.description} onChange={(e) => patchItem(i, { description: e.target.value })}
                  placeholder="Prestação de Serviço de Limpeza em 5 Porões do MV…"
                  className={`${inputCls} col-span-12 md:col-span-6`} />
                <input type="text" value={it.unit} onChange={(e) => patchItem(i, { unit: e.target.value })} onBlur={() => recalcAmount(i)}
                  placeholder="Unit." title="Valor por porão/unidade" className={`${inputCls} col-span-3 md:col-span-2`} />
                <input type="text" value={it.qty} onChange={(e) => patchItem(i, { qty: e.target.value })} onBlur={() => recalcAmount(i)}
                  placeholder="Qtd" title="Porões / lanchas" className={`${inputCls} col-span-3 md:col-span-1`} />
                <input type="text" value={it.amount} onChange={(e) => patchItem(i, { amount: e.target.value })}
                  placeholder="Total" className={`${inputCls} col-span-4 md:col-span-2 font-semibold`} />
                <button type="button" onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))}
                  className="col-span-2 md:col-span-1 text-red-600 hover:bg-red-50 rounded py-2 text-sm" title="Remover item">🗑</button>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-text-light mt-1">
            Unit. × Qtd preenche o Total ao sair do campo. Pra faturar lancha e lavagem em notas separadas, emita duas notas.
          </p>
        </div>

        {/* Cadastro fiscal do cliente */}
        <details className="rounded-lg border border-border p-3" open={!cnpj}>
          <summary className="text-xs font-semibold cursor-pointer">
            🏢 Dados do cliente {job.client ? `(${job.client})` : ""} — salvos pro próximo navio
          </summary>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-3">
            <div className="col-span-2 md:col-span-3">
              <label className={labelCls}>Linha do destinatário</label>
              <input type="text" value={headerLine} onChange={(e) => setHeaderLine(e.target.value)}
                placeholder="AO COMANDANTE E/OU ARMADOR DO {NAVIO} A/C WILSON SONS SHIPPING SERVICES." className={inputCls} />
              <p className="text-[10px] text-text-light mt-0.5">
                <code>{"{NAVIO}"}</code> vira o nome do navio. Em branco usa a razão social. Sai como: <em>{previewHeader}</em>
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
            <div><label className={labelCls}>Idioma da nota</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value as FiscalNoteLanguage)} className={inputCls}>
                <option value="PT">Português</option>
                <option value="EN">Inglês (DEBIT NOTE / BARTHED / SAILED)</option>
              </select></div>
            <div className="col-span-2"><label className={labelCls}>Observação na nota</label>
              <input type="text" value={obs} onChange={(e) => setObs(e.target.value)} className={inputCls} /></div>
          </div>
        </details>

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
