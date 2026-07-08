"use client";

// Conciliação Bancária (Itaú/Santander) — Fase 3 do módulo (docs/financeiro/).
// Cadastro de contas + importação de extrato por arquivo (OFX). O motor de
// conciliação automática e a fila de revisão entram na Fase 4; aqui já dá pra
// trazer o extrato pra dentro do sistema, idempotente.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, hasModuleAccess } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { formatCurrency } from "@/lib/utils";
import type { BankKind, ReconciliationStatus } from "@/types/financeiro";

interface BankAccount {
  id: number;
  bank: BankKind;
  nickname: string;
  agency: string | null;
  account_number: string | null;
  active: boolean;
  opening_balance: string;
  _count: { transactions: number };
}

interface Transaction {
  id: string;
  posted_at: string;
  amount: string;
  description: string | null;
  payee_name: string | null;
  payee_document: string | null;
  reconcilable: boolean;
  source: string;
  review_status: "PENDENTE" | "CONCILIADO" | "IGNORADO";
  review_note: string | null;
  reconciliation: {
    id: number;
    status: ReconciliationStatus;
    score: number;
    invoice_id: string;
    invoices: { description: string } | null;
  } | null;
}

interface ImportSummary {
  result: { inserted: number; duplicates: number; skippedBalanceMarkers: number; total: number };
  bankDetected: BankKind;
  accountDetected: string | null;
  openingBalance: number | null;
  warnings: string[];
}

interface ReconciliationRow {
  id: number;
  status: ReconciliationStatus;
  score: number;
  reason: string;
  matched_by: string;
  transactions: {
    id: string;
    posted_at: string;
    amount: string;
    description: string | null;
    payee_name: string | null;
    payee_document: string | null;
  };
  invoices: {
    id: string;
    description: string;
    amount: string;
    due_date: string | null;
    status: string;
    payee_name: string | null;
  } | null;
}

interface OpenInvoice {
  id: string;
  description: string;
  amount: string;
  due_date: string | null;
  status: string;
}

const BANK_LABELS: Record<BankKind, string> = {
  ITAU: "Itaú",
  SANTANDER: "Santander",
  OUTRO: "Outro",
};

const inputCls =
  "w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40";

function fmtDateOnly(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export function ConciliacaoPage() {
  const { profile } = useAuth();
  const role = profile?.role || "FINANCEIRO";
  const canView = hasModuleAccess(role, "FINANCEIRO_MOD");
  const canEdit =
    hasPermission(role, "FINANCEIRO_MOD", "edit") || hasPermission(role, "FINANCEIRO_MOD", "create");

  const [tab, setTab] = useState<"extrato" | "conciliacao" | "contas">("extrato");
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loadingTx, setLoadingTx] = useState(false);
  const [showNonRecon, setShowNonRecon] = useState(true);
  // Mês selecionado pro export ("" = todos). Formato "YYYY-MM".
  const [exportMonth, setExportMonth] = useState("");
  // Nota (lançamento reescrito) em edição, por linha.
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>({});

  // Modal de nova conta
  const [accountModal, setAccountModal] = useState(false);
  const [newAccount, setNewAccount] = useState({ bank: "ITAU" as BankKind, nickname: "", agency: "", account_number: "" });
  const [savingAccount, setSavingAccount] = useState(false);

  // Import
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);

  // Conciliação
  const [queue, setQueue] = useState<ReconciliationRow[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [running, setRunning] = useState(false);
  const [deciding, setDeciding] = useState<number | null>(null);
  // Casamento manual: linha da fila sendo casada → lista de títulos em aberto
  const [manualFor, setManualFor] = useState<ReconciliationRow | null>(null);
  const [openInvoices, setOpenInvoices] = useState<OpenInvoice[]>([]);

  const loadAccounts = useCallback(async () => {
    const res = await fetch("/api/financeiro/contas-bancarias").then((r) => r.json());
    const list = (res.accounts as BankAccount[]) || [];
    setAccounts(list);
    setSelectedAccount((cur) => cur ?? (list.find((a) => a.active)?.id ?? list[0]?.id ?? null));
  }, []);

  const loadTransactions = useCallback(async (accountId: number) => {
    setLoadingTx(true);
    try {
      const res = await fetch(`/api/financeiro/extrato?account=${accountId}`).then((r) => r.json());
      setTransactions((res.transactions as Transaction[]) || []);
    } finally {
      setLoadingTx(false);
    }
  }, []);

  const loadQueue = useCallback(async () => {
    setLoadingQueue(true);
    try {
      const res = await fetch("/api/financeiro/conciliacao?status=SUGERIDA").then((r) => r.json());
      setQueue((res.reconciliations as ReconciliationRow[]) || []);
    } finally {
      setLoadingQueue(false);
    }
  }, []);

  useEffect(() => {
    if (canView) loadAccounts();
  }, [canView, loadAccounts]);

  useEffect(() => {
    if (selectedAccount != null) loadTransactions(selectedAccount);
  }, [selectedAccount, loadTransactions]);

  useEffect(() => {
    if (canView && tab === "conciliacao") loadQueue();
  }, [canView, tab, loadQueue]);

  async function handleRun() {
    setRunning(true);
    try {
      const res = await fetch("/api/financeiro/conciliacao/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return alert(data.error || "Erro ao rodar a conciliação");
      const s = data.summary;
      alert(
        `Conciliação: ${s.confirmed} automáticas, ${s.suggested} sugestões, ${s.unmatched} sem par (de ${s.scanned} débitos).`
      );
      await loadQueue();
      if (selectedAccount != null) loadTransactions(selectedAccount);
    } finally {
      setRunning(false);
    }
  }

  async function decide(row: ReconciliationRow, decision: "ACEITAR" | "REJEITAR") {
    setDeciding(row.id);
    try {
      const res = await fetch(`/api/financeiro/conciliacao/${row.id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return alert(data.error || "Erro ao decidir");
      setQueue((q) => q.filter((r) => r.id !== row.id));
    } finally {
      setDeciding(null);
    }
  }

  async function openManual(row: ReconciliationRow) {
    setManualFor(row);
    // Carrega títulos em aberto (não pagos/cancelados) pra escolher.
    const res = await fetch("/api/financeiro/contas?status=RECEBIDO,AGUARDANDO_APROVACAO,APROVADO").then((r) => r.json());
    setOpenInvoices((res.invoices as OpenInvoice[]) || []);
  }

  async function confirmManual(invoiceId: string) {
    if (!manualFor) return;
    const res = await fetch("/api/financeiro/conciliacao/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction_id: manualFor.transactions.id, invoice_id: invoiceId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(data.error || "Erro ao casar manualmente");
    setQueue((q) => q.filter((r) => r.id !== manualFor.id));
    setManualFor(null);
  }

  const visibleTx = useMemo(
    () => (showNonRecon ? transactions : transactions.filter((t) => t.reconcilable)),
    [transactions, showNonRecon]
  );

  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const t of transactions) {
      if (!t.reconcilable) continue;
      const v = Number(t.amount);
      if (v < 0) debit += v;
      else credit += v;
    }
    return { debit, credit };
  }, [transactions]);

  async function handleCreateAccount() {
    if (!newAccount.nickname.trim()) return alert("Informe um apelido para a conta");
    setSavingAccount(true);
    try {
      const res = await fetch("/api/financeiro/contas-bancarias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newAccount),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return alert(data.error || "Erro ao criar conta");
      await loadAccounts();
      setSelectedAccount(data.account.id);
      setAccountModal(false);
      setNewAccount({ bank: "ITAU", nickname: "", agency: "", account_number: "" });
    } finally {
      setSavingAccount(false);
    }
  }

  async function handleImport(file: File) {
    if (selectedAccount == null) return alert("Selecione uma conta antes de importar");
    setImporting(true);
    setImportSummary(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("bank_account_id", String(selectedAccount));
      const res = await fetch("/api/financeiro/extrato/import", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao importar o extrato");
        return;
      }
      setImportSummary(data as ImportSummary);
      await Promise.all([loadAccounts(), loadTransactions(selectedAccount)]);
    } finally {
      setImporting(false);
    }
  }

  // Saldo corrente por linha: parte do saldo inicial da conta e acumula na
  // ordem cronológica (inclui transferências internas, que movem caixa).
  const runningById = useMemo(() => {
    const acc = accounts.find((a) => a.id === selectedAccount);
    let running = acc ? Number(acc.opening_balance) : 0;
    const map: Record<string, number> = {};
    for (const t of transactions) {
      running += Number(t.amount);
      map[t.id] = running;
    }
    return map;
  }, [transactions, accounts, selectedAccount]);

  // Meses presentes no extrato (pro seletor de export).
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const t of transactions) set.add(t.posted_at.slice(0, 7));
    return [...set].sort().reverse();
  }, [transactions]);

  function isConciliada(t: Transaction): boolean {
    return t.review_status === "CONCILIADO" || t.reconciliation?.status === "CONFIRMADA";
  }

  async function toggleOk(t: Transaction) {
    // Auto-conciliada (via conta a pagar) não é desmarcada aqui — se preciso,
    // rejeita na aba Conciliação.
    if (t.reconciliation?.status === "CONFIRMADA") return;
    const next = t.review_status === "CONCILIADO" ? "PENDENTE" : "CONCILIADO";
    setTransactions((prev) => prev.map((x) => (x.id === t.id ? { ...x, review_status: next } : x)));
    await fetch(`/api/financeiro/extrato/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ review_status: next }),
    });
  }

  async function saveNote(t: Transaction) {
    const note = noteEdits[t.id];
    if (note === undefined || note === (t.review_note ?? "")) return;
    setTransactions((prev) => prev.map((x) => (x.id === t.id ? { ...x, review_note: note || null } : x)));
    await fetch(`/api/financeiro/extrato/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ review_note: note }),
    });
  }

  function exportExcel() {
    if (selectedAccount == null) return;
    const params = new URLSearchParams({ account: String(selectedAccount) });
    if (exportMonth) {
      const [y, m] = exportMonth.split("-").map(Number);
      const from = `${exportMonth}-01`;
      const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // último dia do mês
      params.set("from", from);
      params.set("to", to);
    }
    window.open(`/api/financeiro/extrato/export?${params.toString()}`, "_blank");
  }

  if (!canView) {
    return (
      <div className="max-w-7xl mx-auto">
        <p className="text-text-light">Você não tem acesso a este módulo.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <h1 className="text-2xl font-bold text-text">Financeiro 💰</h1>
          <span className="text-text-light">›</span>
          <span className="text-lg font-semibold text-text-light">Conciliação Bancária</span>
        </div>
        <p className="text-text-light text-sm mt-0.5">
          Extrato bancário (Itaú e Santander) casado com as contas a pagar
        </p>
      </div>

      {/* Abas */}
      <div className="flex gap-1 border-b border-border">
        {(["extrato", "conciliacao", "contas"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-text-light hover:text-text"
            }`}
          >
            {t === "extrato" ? "Extrato" : t === "conciliacao" ? "Conciliação" : "Contas bancárias"}
            {t === "conciliacao" && queue.length > 0 && (
              <span className="ml-1.5 text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">
                {queue.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "conciliacao" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center flex-wrap gap-3">
            <p className="text-sm text-text-light">
              Fila de revisão — sugestões que o motor não teve confiança pra conciliar sozinho.
              As de alta confiança já viraram título pago automaticamente.
            </p>
            {canEdit && (
              <Button onClick={handleRun} disabled={running}>
                {running ? "Rodando..." : "Rodar conciliação"}
              </Button>
            )}
          </div>

          {loadingQueue ? (
            <p className="p-8 text-center text-text-light text-sm">Carregando...</p>
          ) : queue.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-8 text-center text-text-light text-sm">
              Nenhuma sugestão pendente. Rode a conciliação após importar o extrato e cadastrar as contas a pagar.
            </div>
          ) : (
            <div className="space-y-3">
              {queue.map((row) => (
                <div key={row.id} className="bg-card border border-border rounded-xl p-4">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                      score {row.score} · {row.reason}
                    </span>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3 text-sm">
                    {/* Movimentação */}
                    <div className="border border-border rounded-lg p-3">
                      <p className="text-xs text-text-light mb-1">Movimentação do extrato</p>
                      <p className="font-medium text-text">{fmtDateOnly(row.transactions.posted_at)}</p>
                      <p className="text-text-light truncate" title={row.transactions.description || ""}>
                        {row.transactions.description || "—"}
                      </p>
                      <p className="font-bold text-red-600">{formatCurrency(Number(row.transactions.amount))}</p>
                    </div>
                    {/* Título */}
                    <div className="border border-border rounded-lg p-3">
                      <p className="text-xs text-text-light mb-1">Conta a pagar sugerida</p>
                      <p className="font-medium text-text">{row.invoices?.description || "—"}</p>
                      <p className="text-text-light">
                        venc. {fmtDateOnly(row.invoices?.due_date || null)}
                      </p>
                      <p className="font-bold text-text">
                        {row.invoices ? formatCurrency(Number(row.invoices.amount)) : "—"}
                      </p>
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex gap-2 justify-end mt-3">
                      <Button variant="secondary" size="sm" onClick={() => openManual(row)} disabled={deciding === row.id}>
                        Casar com outro
                      </Button>
                      <Button variant="danger" size="sm" onClick={() => decide(row, "REJEITAR")} disabled={deciding === row.id}>
                        Rejeitar
                      </Button>
                      <Button variant="success" size="sm" onClick={() => decide(row, "ACEITAR")} disabled={deciding === row.id}>
                        Aceitar
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "contas" && (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-text-light">Contas monitoradas na conciliação</p>
            {canEdit && <Button onClick={() => setAccountModal(true)}>+ Nova conta</Button>}
          </div>
          {accounts.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-8 text-center text-text-light text-sm">
              Nenhuma conta cadastrada. Crie a conta do Itaú e a do Santander para começar.
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {accounts.map((a) => (
                <div key={a.id} className="bg-card border border-border rounded-xl p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-semibold text-text">{a.nickname}</p>
                      <p className="text-xs text-text-light">
                        {BANK_LABELS[a.bank]}
                        {a.agency ? ` · ag ${a.agency}` : ""}
                        {a.account_number ? ` · cc ${a.account_number}` : ""}
                      </p>
                    </div>
                    {!a.active && (
                      <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">inativa</span>
                    )}
                  </div>
                  <p className="text-xs text-text-light mt-2">{a._count.transactions} movimentação(ões)</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "extrato" && (
        <div className="space-y-4">
          {accounts.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-8 text-center text-text-light text-sm">
              Cadastre uma conta bancária na aba <b>Contas bancárias</b> antes de importar o extrato.
            </div>
          ) : (
            <>
              <div className="flex gap-3 flex-wrap items-center">
                <select
                  value={selectedAccount ?? ""}
                  onChange={(e) => setSelectedAccount(Number(e.target.value))}
                  className="text-sm border border-border rounded-lg px-3 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nickname} ({BANK_LABELS[a.bank]})
                    </option>
                  ))}
                </select>
                {canEdit && (
                  <label className={`inline-flex items-center gap-2 ${importing ? "opacity-50" : "cursor-pointer"}`}>
                    <span className="bg-primary hover:bg-primary-dark text-white text-sm font-medium px-4 py-2 rounded-lg transition">
                      {importing ? "Importando..." : "Importar extrato (.ofx)"}
                    </span>
                    <input
                      type="file"
                      accept=".ofx,application/x-ofx,application/octet-stream"
                      className="hidden"
                      disabled={importing}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleImport(f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <select
                    value={exportMonth}
                    onChange={(e) => setExportMonth(e.target.value)}
                    className="text-sm border border-border rounded-lg px-2 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
                    title="Mês do Excel"
                  >
                    <option value="">Excel: tudo</option>
                    {months.map((m) => {
                      const [y, mo] = m.split("-");
                      return (
                        <option key={m} value={m}>
                          {mo}/{y}
                        </option>
                      );
                    })}
                  </select>
                  <Button variant="secondary" onClick={exportExcel} disabled={transactions.length === 0}>
                    Exportar Excel
                  </Button>
                </div>
              </div>
              <label className="text-xs text-text-light inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showNonRecon}
                  onChange={(e) => setShowNonRecon(e.target.checked)}
                />
                mostrar transferências internas (aplicação/resgate automático)
              </label>

              {/* Resumo da última importação */}
              {importSummary && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800">
                  <p className="font-medium">
                    Extrato do {BANK_LABELS[importSummary.bankDetected]} importado:{" "}
                    {importSummary.result.inserted} nova(s), {importSummary.result.duplicates} já existiam
                    {importSummary.result.skippedBalanceMarkers > 0 &&
                      `, ${importSummary.result.skippedBalanceMarkers} marcador(es) de saldo ignorado(s)`}
                    .
                  </p>
                  {importSummary.warnings?.map((w, i) => (
                    <p key={i} className="text-amber-700 mt-1">⚠ {w}</p>
                  ))}
                </div>
              )}

              {/* Totais */}
              <div className="grid grid-cols-2 gap-3 max-w-md">
                <div className="bg-card border border-border rounded-xl p-3">
                  <p className="text-xs text-text-light">Débitos (conciliáveis)</p>
                  <p className="text-lg font-bold text-red-600">{formatCurrency(totals.debit)}</p>
                </div>
                <div className="bg-card border border-border rounded-xl p-3">
                  <p className="text-xs text-text-light">Créditos (conciliáveis)</p>
                  <p className="text-lg font-bold text-emerald-600">{formatCurrency(totals.credit)}</p>
                </div>
              </div>

              {/* Tabela de movimentações */}
              <div className="bg-card border border-border rounded-xl overflow-x-auto">
                {loadingTx ? (
                  <p className="p-8 text-center text-text-light text-sm">Carregando...</p>
                ) : visibleTx.length === 0 ? (
                  <p className="p-8 text-center text-text-light text-sm">
                    Nenhuma movimentação. Importe um extrato .ofx para começar.
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-text-light">
                        <th className="px-3 py-3 font-medium text-center">ok</th>
                        <th className="px-3 py-3 font-medium">Data</th>
                        <th className="px-3 py-3 font-medium">Lançamento</th>
                        <th className="px-3 py-3 font-medium text-right">Débito</th>
                        <th className="px-3 py-3 font-medium text-right">Crédito</th>
                        <th className="px-3 py-3 font-medium text-right">Saldo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleTx.map((t) => {
                        const v = Number(t.amount);
                        const ok = isConciliada(t);
                        const auto = t.reconciliation?.status === "CONFIRMADA";
                        const noteVal = noteEdits[t.id] ?? t.review_note ?? "";
                        return (
                          <tr
                            key={t.id}
                            className={`border-b border-border last:border-0 ${t.reconcilable ? "" : "opacity-60"} ${
                              ok ? "bg-emerald-50/40" : ""
                            }`}
                          >
                            <td className="px-3 py-2 text-center">
                              {t.reconcilable ? (
                                <input
                                  type="checkbox"
                                  checked={ok}
                                  disabled={!canEdit || auto}
                                  title={auto ? "Conciliado automaticamente (via conta a pagar)" : "Marcar como conciliado"}
                                  onChange={() => toggleOk(t)}
                                />
                              ) : (
                                <span className="text-[10px] text-text-light" title="Transferência interna — não concilia">
                                  —
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap text-text">{fmtDateOnly(t.posted_at)}</td>
                            <td className="px-3 py-2">
                              {canEdit ? (
                                <input
                                  value={noteVal}
                                  placeholder={t.payee_name || t.description || ""}
                                  onChange={(e) => setNoteEdits((prev) => ({ ...prev, [t.id]: e.target.value }))}
                                  onBlur={() => saveNote(t)}
                                  className="w-full min-w-[240px] bg-transparent border border-transparent hover:border-border focus:border-primary rounded px-1.5 py-1 text-text focus:outline-none"
                                  title={t.description || ""}
                                />
                              ) : (
                                <span className="text-text" title={t.description || ""}>
                                  {t.review_note || t.payee_name || t.description || "—"}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right font-medium whitespace-nowrap text-red-600">
                              {v < 0 ? formatCurrency(v) : ""}
                            </td>
                            <td className="px-3 py-2 text-right font-medium whitespace-nowrap text-emerald-600">
                              {v > 0 ? formatCurrency(v) : ""}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap text-text-light">
                              {formatCurrency(runningById[t.id] ?? 0)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <p className="text-xs text-text-light">
                Marque <b>ok</b> nas linhas conferidas e edite o <b>lançamento</b> — as conciliadas
                automaticamente já vêm marcadas. Depois clique <b>Exportar Excel</b> pra gerar a planilha
                no formato da contabilidade.
              </p>
            </>
          )}
        </div>
      )}

      {/* Modal casamento manual */}
      <Modal
        open={!!manualFor}
        onClose={() => setManualFor(null)}
        title="Casar movimentação com outro título"
        maxWidth="max-w-2xl"
      >
        {manualFor && (
          <div className="space-y-3">
            <div className="border border-border rounded-lg p-3 text-sm bg-gray-50">
              <p className="text-xs text-text-light">Movimentação</p>
              <p className="font-medium text-text">
                {fmtDateOnly(manualFor.transactions.posted_at)} ·{" "}
                {formatCurrency(Number(manualFor.transactions.amount))}
              </p>
              <p className="text-text-light truncate">{manualFor.transactions.description}</p>
            </div>
            <p className="text-xs font-medium text-text-light">Escolha o título a pagar:</p>
            {openInvoices.length === 0 ? (
              <p className="text-sm text-text-light">Nenhum título em aberto.</p>
            ) : (
              <div className="max-h-[360px] overflow-y-auto divide-y divide-border border border-border rounded-lg">
                {openInvoices.map((inv) => (
                  <button
                    key={inv.id}
                    onClick={() => confirmManual(inv.id)}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 transition flex justify-between gap-3"
                  >
                    <span className="text-sm text-text truncate">{inv.description}</span>
                    <span className="text-sm font-medium text-text whitespace-nowrap">
                      {formatCurrency(Number(inv.amount))}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Modal nova conta */}
      <Modal open={accountModal} onClose={() => setAccountModal(false)} title="Nova conta bancária">
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-text-light">Banco</label>
            <select
              value={newAccount.bank}
              onChange={(e) => setNewAccount({ ...newAccount, bank: e.target.value as BankKind })}
              className={inputCls}
            >
              <option value="ITAU">Itaú</option>
              <option value="SANTANDER">Santander</option>
              <option value="OUTRO">Outro</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-text-light">Apelido *</label>
            <input
              value={newAccount.nickname}
              onChange={(e) => setNewAccount({ ...newAccount, nickname: e.target.value })}
              className={inputCls}
              placeholder="Ex.: Itaú principal"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-text-light">Agência</label>
              <input
                value={newAccount.agency}
                onChange={(e) => setNewAccount({ ...newAccount, agency: e.target.value })}
                className={inputCls}
                placeholder="0447"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-text-light">Conta</label>
              <input
                value={newAccount.account_number}
                onChange={(e) => setNewAccount({ ...newAccount, account_number: e.target.value })}
                className={inputCls}
                placeholder="99830-3"
              />
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setAccountModal(false)}>
              Cancelar
            </Button>
            <Button onClick={handleCreateAccount} disabled={savingAccount}>
              {savingAccount ? "Salvando..." : "Criar conta"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
