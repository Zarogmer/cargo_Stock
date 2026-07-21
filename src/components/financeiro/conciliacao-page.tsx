"use client";

// Conciliação Bancária (Itaú/Santander) — Fase 3 do módulo (docs/financeiro/).
// Cadastro de contas + importação de extrato por arquivo (OFX). O motor de
// conciliação automática e a fila de revisão entram na Fase 4; aqui já dá pra
// trazer o extrato pra dentro do sistema, idempotente.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, canAccessFinanceiroBanco } from "@/lib/rbac";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { formatCurrency, parseDecimalBR } from "@/lib/utils";
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

interface Card {
  id: number;
  bank_account_id: number;
  last4: string;
  closing_day: number;
  label: string | null;
  active: boolean;
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
  raw: { manual?: boolean; from?: string; invoice_id?: string } | null;
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

const MONTHS_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

// "2026-02" → "fevereiro/2026"
function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTHS_PT[Number(m) - 1] ?? m}/${y}`;
}

function fmtDateOnly(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

// Normaliza nome de banco pra comparar (sem acento, minúsculo): "Itaú" ≈ "itau".
function normBank(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
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
  // Filtro de mês ("" = todos) — pra fazer a conciliação mês a mês.
  const [monthFilter, setMonthFilter] = useState("");
  // Nota (lançamento reescrito) em edição, por linha.
  const [noteEdits, setNoteEdits] = useState<Record<string, string>>({});

  // Modal de nova conta
  const [accountModal, setAccountModal] = useState(false);
  const [newAccount, setNewAccount] = useState({ bank: "ITAU" as BankKind, nickname: "", agency: "", account_number: "" });
  const [savingAccount, setSavingAccount] = useState(false);

  // Cartões de crédito por conta bancária (final 4 + dia de fechamento).
  const [cards, setCards] = useState<Card[]>([]);
  const [cardModalAccount, setCardModalAccount] = useState<BankAccount | null>(null);
  const [newCard, setNewCard] = useState({ last4: "", closing_day: "", label: "" });
  const [savingCard, setSavingCard] = useState(false);
  const [deletingCardId, setDeletingCardId] = useState<number | null>(null);

  // Import
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);

  // Adicionar título da Contas a Pagar como linha do extrato
  const [addOpen, setAddOpen] = useState(false);
  const [cpInvoices, setCpInvoices] = useState<{ id: string; description: string; amount: string; bank: string | null; payment_date: string | null }[]>([]);
  const [cpSearch, setCpSearch] = useState("");
  const [addingId, setAddingId] = useState<string | null>(null);

  // Editar/excluir linha MANUAL (adicionada do Contas a Pagar)
  const [editTx, setEditTx] = useState<Transaction | null>(null);
  const [editForm, setEditForm] = useState({ description: "", amount: "", posted_at: "" });
  const [savingTx, setSavingTx] = useState(false);

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

  const loadCards = useCallback(async () => {
    const { data } = await db.from("cards").select("*").order("last4");
    setCards((data as Card[]) || []);
  }, []);

  useEffect(() => {
    if (canView) {
      loadAccounts();
      loadCards();
    }
  }, [canView, loadAccounts, loadCards]);

  useEffect(() => {
    if (selectedAccount != null) loadTransactions(selectedAccount);
    setMonthFilter(""); // extrato de outra conta = outros meses
  }, [selectedAccount, loadTransactions]);

  // Meses disponíveis no extrato da conta selecionada (mais recente primeiro).
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const t of transactions) set.add(t.posted_at.slice(0, 7));
    return Array.from(set).sort().reverse();
  }, [transactions]);

  const visibleTx = useMemo(
    () => (monthFilter ? transactions.filter((t) => t.posted_at.slice(0, 7) === monthFilter) : transactions),
    [transactions, monthFilter]
  );

  // Totais acompanham o filtro de mês.
  const totals = useMemo(() => {
    let debit = 0;
    let credit = 0;
    for (const t of visibleTx) {
      if (!t.reconcilable) continue;
      const v = Number(t.amount);
      if (v < 0) debit += v;
      else credit += v;
    }
    return { debit, credit };
  }, [visibleTx]);

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

  // ── Cartões (final 4 + dia de fechamento), vinculados a uma conta ──────────
  function openCardModal(account: BankAccount) {
    setCardModalAccount(account);
    setNewCard({ last4: "", closing_day: "", label: "" });
  }

  async function handleCreateCard() {
    if (!cardModalAccount) return;
    const last4 = newCard.last4.replace(/\D/g, "");
    const closing = Number(newCard.closing_day);
    if (last4.length !== 4) return alert("Informe os 4 últimos dígitos do cartão");
    if (!Number.isInteger(closing) || closing < 1 || closing > 31) return alert("Dia de fechamento inválido (1 a 31)");
    setSavingCard(true);
    try {
      const { error } = await db.from("cards").insert({
        bank_account_id: cardModalAccount.id,
        last4,
        closing_day: closing,
        label: newCard.label.trim() || null,
        created_by: profile?.full_name || "Sistema",
      });
      if (error) {
        alert(error.message || "Erro ao cadastrar cartão");
        return;
      }
      await loadCards();
      setCardModalAccount(null);
    } finally {
      setSavingCard(false);
    }
  }

  async function handleDeleteCard(card: Card) {
    if (!window.confirm(`Excluir o cartão final ${card.last4}?`)) return;
    setDeletingCardId(card.id);
    try {
      const { error } = await db.from("cards").delete().eq("id", card.id);
      if (error) {
        alert(error.message || "Erro ao excluir cartão");
        return;
      }
      await loadCards();
    } finally {
      setDeletingCardId(null);
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

  // "SALDO ANTERIOR" da visão atual: com filtro de mês, é o saldo acumulado
  // até o fim do mês anterior; sem filtro, o saldo inicial da conta.
  const prevBalance = useMemo(() => {
    const acc = accounts.find((a) => a.id === selectedAccount);
    let running = acc ? Number(acc.opening_balance) : 0;
    if (!monthFilter) return running;
    for (const t of transactions) {
      if (t.posted_at.slice(0, 7) < monthFilter) running += Number(t.amount);
    }
    return running;
  }, [transactions, accounts, selectedAccount, monthFilter]);

  function isConciliada(t: Transaction): boolean {
    return t.review_status === "CONCILIADO" || t.reconciliation?.status === "CONFIRMADA";
  }

  // O PATCH falhava CALADO (ex.: sessão expirada → 401) e a edição sumia no
  // próximo reload, parecendo bug de UI. Agora qualquer falha avisa — e 401
  // manda pro login recarregando a página (o middleware redireciona).
  async function patchExtratoOrWarn(id: string, body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch(`/api/financeiro/extrato/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (res?.ok) return true;
    if (res?.status === 401) {
      alert("Sua sessão expirou — entre de novo pra salvar. A alteração NÃO foi salva.");
      window.location.reload();
      return false;
    }
    const data = res ? await res.json().catch(() => ({})) : {};
    alert((data as { error?: string }).error || "Erro ao salvar — a alteração NÃO foi salva.");
    if (selectedAccount != null) loadTransactions(selectedAccount); // desfaz o otimista
    return false;
  }

  async function toggleOk(t: Transaction) {
    // Auto-conciliada (via conta a pagar) não é desmarcada aqui — se preciso,
    // rejeita na aba Conciliação.
    if (t.reconciliation?.status === "CONFIRMADA") return;
    const next = t.review_status === "CONCILIADO" ? "PENDENTE" : "CONCILIADO";
    setTransactions((prev) => prev.map((x) => (x.id === t.id ? { ...x, review_status: next } : x)));
    await patchExtratoOrWarn(t.id, { review_status: next });
  }

  async function saveNote(t: Transaction) {
    const note = noteEdits[t.id];
    if (note === undefined || note === (t.review_note ?? "")) return;
    setTransactions((prev) => prev.map((x) => (x.id === t.id ? { ...x, review_note: note || null } : x)));
    await patchExtratoOrWarn(t.id, { review_note: note });
  }

  // Gera a planilha de conciliação do ano (uma aba por mês, formato da
  // contabilidade) pro banco escolhido — resolve a conta pelo banco no backend.
  // Baixa via âncora (NÃO window.open): no app Electron, window.open pra um
  // .xlsx abre uma janela nova que fica branca/travada (a resposta é download,
  // não HTML). A âncora dispara direto o "Salvar como", sem abrir janela.
  // Gera a planilha da conciliação RESPEITANDO o filtro de mês da tela:
  //   • mês escolhido  → só ele, numa aba (do dia 1 ao último dia do mês);
  //   • "Todos os meses" → o ano inteiro, uma aba por mês (formato que a
  //     contabilidade mantinha à mão).
  // Antes mandava sempre `year=<ano atual>` e ignorava o filtro — escolher
  // junho baixava o ano todo do mesmo jeito.
  function gerarConciliacao(bank: "ITAU" | "SANTANDER") {
    const params = new URLSearchParams({ bank });
    if (monthFilter) {
      const [y, m] = monthFilter.split("-").map(Number);
      // Dia 0 do mês seguinte = último dia deste mês (fecha fevereiro/bissexto).
      const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      params.set("from", `${monthFilter}-01`);
      params.set("to", to);
    } else {
      // O modo "ano" cobre um ano por arquivo: usa o ano dos lançamentos que
      // existem (months vem do mais recente pro mais antigo).
      params.set("year", months[0]?.slice(0, 4) || String(new Date().getFullYear()));
    }
    const a = document.createElement("a");
    a.href = `/api/financeiro/extrato/export?${params.toString()}`;
    a.download = ""; // nome vem do servidor (Content-Disposition)
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Abre o seletor de títulos da Contas a Pagar pra adicionar como linha.
  async function openAdd() {
    setAddOpen(true);
    const res = await fetch("/api/financeiro/contas").then((r) => r.json());
    setCpInvoices((res.invoices as typeof cpInvoices) || []);
  }

  // Adiciona o título escolhido como linha no extrato do banco selecionado.
  async function addInvoiceToExtrato(invoiceId: string) {
    if (selectedAccount == null) return;
    setAddingId(invoiceId);
    try {
      const res = await fetch("/api/financeiro/extrato/from-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bank_account_id: selectedAccount, invoice_id: invoiceId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao adicionar o título");
        return;
      }
      await Promise.all([loadTransactions(selectedAccount), loadAccounts()]);
      setAddOpen(false);
    } finally {
      setAddingId(null);
    }
  }

  const selectedBank = accounts.find((a) => a.id === selectedAccount)?.bank ?? null;
  const txCountByBank = (bank: BankKind) => accounts.find((a) => a.bank === bank)?._count.transactions ?? 0;

  // Linha manual (adicionada do Contas a Pagar) — pode editar/excluir.
  function isManualTx(t: Transaction): boolean {
    return t.raw?.manual === true;
  }

  function openEditTx(t: Transaction) {
    setEditTx(t);
    setEditForm({
      description: t.review_note || t.description || "",
      amount: String(Math.abs(Number(t.amount))).replace(".", ","),
      posted_at: t.posted_at.slice(0, 10),
    });
  }

  async function saveEditTx() {
    if (!editTx) return;
    const amount = parseDecimalBR(editForm.amount);
    if (!editForm.description.trim()) return alert("Informe a descrição");
    if (amount <= 0) return alert("Informe um valor válido");
    setSavingTx(true);
    try {
      const res = await fetch(`/api/financeiro/extrato/${editTx.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: editForm.description, amount, posted_at: editForm.posted_at }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao salvar");
        return;
      }
      if (selectedAccount != null) await loadTransactions(selectedAccount);
      setEditTx(null);
    } finally {
      setSavingTx(false);
    }
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

                  {/* Cartões de crédito vinculados a esta conta */}
                  <div className="mt-3 pt-3 border-t border-border">
                    <div className="flex items-center justify-between mb-1.5">
                      <p className="text-xs font-semibold text-text">Cartões</p>
                      {canEdit && (
                        <button onClick={() => openCardModal(a)} className="text-xs text-primary hover:underline">
                          + cartão
                        </button>
                      )}
                    </div>
                    {cards.filter((c) => c.bank_account_id === a.id).length === 0 ? (
                      <p className="text-[11px] text-text-light">Nenhum cartão cadastrado.</p>
                    ) : (
                      <ul className="space-y-1">
                        {cards
                          .filter((c) => c.bank_account_id === a.id)
                          .map((c) => (
                            <li key={c.id} className="flex items-center justify-between gap-2 text-xs">
                              <span className="text-text">
                                💳 {c.label?.trim() || `final ${c.last4}`}
                                <span className="text-text-light"> · fecha dia {c.closing_day}</span>
                              </span>
                              {canEdit && (
                                <button
                                  onClick={() => handleDeleteCard(c)}
                                  disabled={deletingCardId === c.id}
                                  className="text-text-light hover:text-red-600 leading-none px-1"
                                  title="Excluir cartão"
                                >
                                  ✕
                                </button>
                              )}
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
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
                <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
                  {/* O que sai no arquivo segue o filtro de mês logo abaixo. */}
                  <span className="text-xs text-text-light">
                    {monthFilter
                      ? <>Gera só <strong className="text-text">{fmtMonth(monthFilter)}</strong></>
                      : <>Gera <strong className="text-text">o ano inteiro</strong> (uma aba por mês)</>}
                  </span>
                  <Button
                    variant="secondary"
                    onClick={() => gerarConciliacao("ITAU")}
                    disabled={txCountByBank("ITAU") === 0}
                    title={
                      txCountByBank("ITAU") === 0
                        ? "Importe o extrato do Itaú primeiro"
                        : monthFilter
                          ? `Baixa a conciliação do Itaú de ${fmtMonth(monthFilter)}`
                          : "Baixa a conciliação do Itaú do ano, uma aba por mês"
                    }
                  >
                    Gerar conciliação Itaú
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => gerarConciliacao("SANTANDER")}
                    disabled={txCountByBank("SANTANDER") === 0}
                    title={
                      txCountByBank("SANTANDER") === 0
                        ? "Importe o extrato do Santander primeiro"
                        : monthFilter
                          ? `Baixa a conciliação do Santander de ${fmtMonth(monthFilter)}`
                          : "Baixa a conciliação do Santander do ano, uma aba por mês"
                    }
                  >
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
                <select
                  value={monthFilter}
                  onChange={(e) => setMonthFilter(e.target.value)}
                  title={months.length === 0 ? "Importe um extrato pra ter meses aqui" : "Filtrar por mês"}
                  className="text-sm font-medium px-3 py-1.5 rounded-lg border border-border bg-card text-text cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">Todos os meses</option>
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {fmtMonth(m)}
                    </option>
                  ))}
                </select>
                {canEdit && selectedAccount != null && (
                  <Button size="sm" onClick={openAdd} className="ml-2">
                    Adicionar
                  </Button>
                )}
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
                            <span className="font-medium text-text">Período:</span>{" "}
                            {monthFilter ? fmtMonth(monthFilter) : "todos os lançamentos"}
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
                      <tr className="border-b border-border bg-gray-50/60 text-xs">
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2 text-text-light" />
                        <td className="px-3 py-2 font-medium text-text-light">SALDO ANTERIOR</td>
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2 text-right text-text-light">{formatCurrency(prevBalance)}</td>
                      </tr>
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
                              {isManualTx(t) ? (
                                <div className="flex items-center gap-2 min-w-[240px]">
                                  <span className="text-text">{t.review_note || t.description || "—"}</span>
                                  <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                                    adicionado
                                  </span>
                                  {canEdit && (
                                    <button
                                      onClick={() => openEditTx(t)}
                                      className="text-xs text-primary hover:underline whitespace-nowrap"
                                    >
                                      editar
                                    </button>
                                  )}
                                </div>
                              ) : canEdit ? (
                                <div className="flex items-center gap-1 min-w-[240px]">
                                  <input
                                    value={noteVal}
                                    placeholder={t.payee_name || t.description || ""}
                                    onChange={(e) => setNoteEdits((prev) => ({ ...prev, [t.id]: e.target.value }))}
                                    onBlur={() => saveNote(t)}
                                    className="flex-1 bg-transparent border border-transparent hover:border-border focus:border-primary rounded px-1.5 py-1 text-text focus:outline-none"
                                    title={t.description || ""}
                                  />
                                </div>
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

      {/* Modal: editar/excluir linha manual (adicionada do Contas a Pagar) */}
      <Modal open={!!editTx} onClose={() => setEditTx(null)} title="Editar lançamento adicionado">
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-text-light">Descrição *</label>
            <input
              value={editForm.description}
              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              className={inputCls}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-text-light">Valor (R$) *</label>
              <input
                value={editForm.amount}
                onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })}
                className={inputCls}
                placeholder="0,00"
                inputMode="decimal"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-text-light">Data</label>
              <input
                type="date"
                value={editForm.posted_at}
                onChange={(e) => setEditForm({ ...editForm, posted_at: e.target.value })}
                className={inputCls}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setEditTx(null)}>
              Fechar
            </Button>
            <Button onClick={saveEditTx} disabled={savingTx}>
              {savingTx ? "Salvando..." : "Salvar"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Modal: adicionar título da Contas a Pagar como linha do extrato */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={`Adicionar do Contas a Pagar${selectedBank ? ` — ${BANK_LABELS[selectedBank]}` : ""}`}
        maxWidth="max-w-2xl"
      >
        <div className="space-y-3">
          <p className="text-xs text-text-light">
            Escolha um título lançado na Contas a Pagar pra incluir na conciliação
            {selectedBank ? ` do ${BANK_LABELS[selectedBank]}` : " deste banco"} (ex.: pagamento em
            dinheiro/pix que não veio no extrato). Entra já marcado como conciliado.
            {selectedBank && (
              <> Só aparecem títulos do {BANK_LABELS[selectedBank]} ou sem banco definido.</>
            )}
          </p>
          <input
            value={cpSearch}
            onChange={(e) => setCpSearch(e.target.value)}
            placeholder="Buscar por descrição ou banco..."
            className={inputCls}
          />
          {(() => {
            const bankLabel = selectedBank ? BANK_LABELS[selectedBank] : null;
            const list = cpInvoices.filter((i) => {
              // Não deixa puxar título de OUTRO banco (ex.: Itaú no Santander) —
              // são conciliações separadas. Título sem banco (dinheiro/pix) pode
              // entrar em qualquer uma.
              if (bankLabel && i.bank && normBank(i.bank) !== normBank(bankLabel)) return false;
              if (!cpSearch) return true;
              const blob = `${i.description} ${i.bank || ""}`.toLowerCase();
              return blob.includes(cpSearch.toLowerCase());
            });
            if (list.length === 0) {
              return <p className="text-sm text-text-light">Nenhum título encontrado.</p>;
            }
            return (
              <div className="max-h-[380px] overflow-y-auto divide-y divide-border border border-border rounded-lg">
                {list.map((inv) => (
                  <button
                    key={inv.id}
                    onClick={() => addInvoiceToExtrato(inv.id)}
                    disabled={addingId === inv.id}
                    className="w-full text-left px-3 py-2 hover:bg-gray-50 transition flex justify-between gap-3 disabled:opacity-50"
                  >
                    <span className="text-sm text-text truncate">
                      {inv.description}
                      {inv.bank ? <span className="text-text-light"> · {inv.bank}</span> : ""}
                    </span>
                    <span className="text-sm font-medium text-text whitespace-nowrap">
                      {formatCurrency(Number(inv.amount))}
                    </span>
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
      </Modal>

      {/* Modal novo cartão */}
      <Modal
        open={!!cardModalAccount}
        onClose={() => setCardModalAccount(null)}
        title={`Novo cartão${cardModalAccount ? ` — ${cardModalAccount.nickname}` : ""}`}
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-text-light">4 últimos dígitos *</label>
              <input
                value={newCard.last4}
                onChange={(e) => setNewCard({ ...newCard, last4: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                className={inputCls}
                placeholder="8403"
                inputMode="numeric"
                maxLength={4}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-text-light">Dia de fechamento *</label>
              <input
                type="number"
                min={1}
                max={31}
                value={newCard.closing_day}
                onChange={(e) => setNewCard({ ...newCard, closing_day: e.target.value })}
                className={inputCls}
                placeholder="Ex.: 12"
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-text-light">Apelido (opcional)</label>
            <input
              value={newCard.label}
              onChange={(e) => setNewCard({ ...newCard, label: e.target.value })}
              className={inputCls}
              placeholder="Ex.: Itaú 8168"
            />
          </div>
          <p className="text-[11px] text-text-light">
            Aparece no Nova Compra como &quot;Cartão com Final {newCard.last4 || "xxxx"}&quot; pra você saber qual cartão usou e quando fecha.
          </p>
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setCardModalAccount(null)}>
              Cancelar
            </Button>
            <Button onClick={handleCreateCard} disabled={savingCard}>
              {savingCard ? "Salvando..." : "Adicionar cartão"}
            </Button>
          </div>
        </div>
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
