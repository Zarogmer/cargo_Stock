"use client";

// Conciliação Bancária (Itaú/Santander) — Fase 3 do módulo (docs/financeiro/).
// Cadastro de contas + importação de extrato por arquivo (OFX). O motor de
// conciliação automática e a fila de revisão entram na Fase 4; aqui já dá pra
// trazer o extrato pra dentro do sistema, idempotente.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, canAccessFinanceiroBanco } from "@/lib/rbac";
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
  const canView = canAccessFinanceiroBanco(role);
  const canEdit =
    canView && (hasPermission(role, "FINANCEIRO_MOD", "edit") || hasPermission(role, "FINANCEIRO_MOD", "create"));

  const [tab, setTab] = useState<"conciliacao" | "contas">("conciliacao");
  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loadingTx, setLoadingTx] = useState(false);
  const [showNonRecon, setShowNonRecon] = useState(true);
  // Nota (lançamento reescrito) em edição, por linha.
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>({});

  // Modal de nova conta
  const [accountModal, setAccountModal] = useState(false);
  const [newAccount, setNewAccount] = useState({ bank: "ITAU" as BankKind, nickname: "", agency: "", account_number: "" });
  const [savingAccount, setSavingAccount] = useState(false);

  // Import
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);

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

  useEffect(() => {
    if (canView) loadAccounts();
  }, [canView, loadAccounts]);

  useEffect(() => {
    if (selectedAccount != null) loadTransactions(selectedAccount);
  }, [selectedAccount, loadTransactions]);

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

  // O banco é detectado no próprio OFX — não precisa escolher conta. A lista
  // aponta sozinha pro banco que acabou de importar.
  async function handleImport(file: File) {
    setImporting(true);
    setImportSummary(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/financeiro/extrato/import", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao importar o extrato");
        return;
      }
      setImportSummary(data as ImportSummary);
      const detectedId = accounts.find((a) => a.bank === data.bankDetected)?.id ?? selectedAccount;
      await loadAccounts();
      if (detectedId != null) {
        setSelectedAccount(detectedId);
        await loadTransactions(detectedId);
      }
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

  // Gera a planilha de conciliação do ano (uma aba por mês, formato da
  // contabilidade) pro banco escolhido — resolve a conta pelo banco no backend.
  function gerarConciliacao(bank: "ITAU" | "SANTANDER") {
    const year = new Date().getFullYear();
    window.open(`/api/financeiro/extrato/export?bank=${bank}&year=${year}`, "_blank");
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
        {(["conciliacao", "contas"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition ${
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-text-light hover:text-text"
            }`}
          >
            {t === "conciliacao" ? "Conciliação" : "Contas bancárias"}
          </button>
        ))}
      </div>

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

      {tab === "conciliacao" && (
        <div className="space-y-4">
          {accounts.length === 0 ? (
            <div className="bg-card border border-border rounded-xl p-8 text-center text-text-light text-sm">
              Cadastre uma conta bancária na aba <b>Contas bancárias</b> antes de importar o extrato.
            </div>
          ) : (
            <>
              <div className="flex gap-3 flex-wrap items-center">
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
                <span className="text-xs text-text-light">O banco é reconhecido no próprio arquivo.</span>
                <div className="ml-auto flex items-center gap-2">
                  <Button variant="secondary" onClick={() => gerarConciliacao("ITAU")}>
                    Gerar conciliação Itaú
                  </Button>
                  <Button variant="secondary" onClick={() => gerarConciliacao("SANTANDER")}>
                    Gerar conciliação Santander
                  </Button>
                </div>
              </div>

              {/* Toggle de visualização: qual banco mostrar na lista abaixo */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-text-light">Ver extrato:</span>
                {accounts.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setSelectedAccount(a.id)}
                    className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition ${
                      selectedAccount === a.id
                        ? "border-primary text-primary bg-primary/5"
                        : "border-border text-text-light hover:text-text"
                    }`}
                  >
                    {BANK_LABELS[a.bank]}
                  </button>
                ))}
                <label className="ml-2 text-xs text-text-light inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showNonRecon}
                    onChange={(e) => setShowNonRecon(e.target.checked)}
                  />
                  mostrar transferências internas (aplicação/resgate automático)
                </label>
              </div>

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

              {/* Preview no formato da planilha de conciliação */}
              <div className="bg-card border border-border rounded-xl overflow-x-auto">
                {loadingTx ? (
                  <p className="p-8 text-center text-text-light text-sm">Carregando...</p>
                ) : visibleTx.length === 0 ? (
                  <p className="p-8 text-center text-text-light text-sm">
                    Nenhuma movimentação. Importe um extrato .ofx para começar.
                  </p>
                ) : (
                  <>
                    {/* Cabeçalho estilo planilha */}
                    {(() => {
                      const acc = accounts.find((a) => a.id === selectedAccount);
                      if (!acc) return null;
                      return (
                        <div className="px-4 pt-4 pb-2 text-xs text-text-light space-y-0.5">
                          <p><span className="font-medium text-text">Nome:</span> {acc.nickname}</p>
                          <p>
                            <span className="font-medium text-text">Banco:</span> {BANK_LABELS[acc.bank]}
                            {acc.agency ? ` · Ag ${acc.agency}` : ""}
                            {acc.account_number ? ` · CC ${acc.account_number}` : ""}
                          </p>
                          <p>
                            <span className="font-medium text-text">Período:</span> todos os lançamentos
                          </p>
                        </div>
                      );
                    })()}
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
                      {(() => {
                        const acc = accounts.find((a) => a.id === selectedAccount);
                        const open = acc ? Number(acc.opening_balance) : 0;
                        return (
                          <tr className="border-b border-border bg-gray-50/60 text-xs">
                            <td className="px-3 py-2" />
                            <td className="px-3 py-2 text-text-light" />
                            <td className="px-3 py-2 font-medium text-text-light">SALDO ANTERIOR</td>
                            <td className="px-3 py-2" />
                            <td className="px-3 py-2" />
                            <td className="px-3 py-2 text-right text-text-light">{formatCurrency(open)}</td>
                          </tr>
                        );
                      })()}
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
                  </>
                )}
              </div>
              <p className="text-xs text-text-light">
                Este é o <b>preview</b> da planilha de conciliação. Marque <b>ok</b> nas linhas conferidas
                e edite o <b>lançamento</b>. Depois clique <b>Gerar conciliação {"{"}banco{"}"}</b> pra baixar
                o arquivo no formato da contabilidade.
              </p>
            </>
          )}
        </div>
      )}

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
