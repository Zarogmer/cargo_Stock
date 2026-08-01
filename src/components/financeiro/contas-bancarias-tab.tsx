"use client";

// Contas bancárias da empresa (Itaú/Santander) + cartões de crédito de cada
// conta (final 4 + dia de fechamento). Morava na Conciliação Bancária; virou
// componente próprio pra viver como aba do Contas a Pagar — é lá que se
// cadastra a conta e o cartão. A Conciliação segue lendo as mesmas contas.

import { useCallback, useEffect, useState } from "react";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import type { BankKind } from "@/types/financeiro";

export interface BankAccount {
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

const BANK_LABELS: Record<BankKind, string> = {
  ITAU: "Itaú",
  SANTANDER: "Santander",
  OUTRO: "Outro",
};

const inputCls =
  "w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40";

export function ContasBancariasTab({
  canEdit, profileName,
}: {
  canEdit: boolean;
  profileName: string;
}) {
  const [accounts, setAccounts] = useState<BankAccount[]>([]);

  // Modal de nova conta
  const [accountModal, setAccountModal] = useState(false);
  const [newAccount, setNewAccount] = useState({ bank: "ITAU" as BankKind, nickname: "", agency: "", account_number: "" });
  const [savingAccount, setSavingAccount] = useState(false);

  // Cartões de crédito por conta bancária (final 4 + dia de fechamento).
  const [cards, setCards] = useState<Card[]>([]);
  const [cardModalAccount, setCardModalAccount] = useState<BankAccount | null>(null);
  // Cartão em edição no modal (null = cadastrando um novo).
  const [editingCard, setEditingCard] = useState<Card | null>(null);
  const [newCard, setNewCard] = useState({ last4: "", closing_day: "", label: "" });
  const [savingCard, setSavingCard] = useState(false);
  const [deletingCardId, setDeletingCardId] = useState<number | null>(null);

  const loadAccounts = useCallback(async () => {
    const res = await fetch("/api/financeiro/contas-bancarias").then((r) => r.json());
    setAccounts((res.accounts as BankAccount[]) || []);
  }, []);

  const loadCards = useCallback(async () => {
    const { data } = await db.from("cards").select("*").order("last4");
    setCards((data as Card[]) || []);
  }, []);

  useEffect(() => {
    loadAccounts();
    loadCards();
  }, [loadAccounts, loadCards]);

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
      setAccountModal(false);
      setNewAccount({ bank: "ITAU", nickname: "", agency: "", account_number: "" });
    } finally {
      setSavingAccount(false);
    }
  }

  // ── Cartões (final 4 + dia de fechamento), vinculados a uma conta ──────────
  function openCardModal(account: BankAccount) {
    setCardModalAccount(account);
    setEditingCard(null);
    setNewCard({ last4: "", closing_day: "", label: "" });
  }

  function openEditCardModal(account: BankAccount, card: Card) {
    setCardModalAccount(account);
    setEditingCard(card);
    setNewCard({ last4: card.last4, closing_day: String(card.closing_day), label: card.label || "" });
  }

  function closeCardModal() {
    setCardModalAccount(null);
    setEditingCard(null);
  }

  async function handleSaveCard() {
    if (!cardModalAccount) return;
    const last4 = newCard.last4.replace(/\D/g, "");
    const closing = Number(newCard.closing_day);
    if (last4.length !== 4) return alert("Informe os 4 últimos dígitos do cartão");
    if (!Number.isInteger(closing) || closing < 1 || closing > 31) return alert("Dia de fechamento inválido (1 a 31)");
    setSavingCard(true);
    try {
      const payload = { last4, closing_day: closing, label: newCard.label.trim() || null };
      const { error } = editingCard
        ? await db.from("cards").update(payload).eq("id", editingCard.id)
        : await db.from("cards").insert({
            ...payload,
            bank_account_id: cardModalAccount.id,
            created_by: profileName,
          });
      if (error) {
        alert(error.message || "Erro ao salvar cartão");
        return;
      }
      await loadCards();
      closeCardModal();
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

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-text-light">Contas da empresa — usadas na Conciliação Bancária e nos cartões de crédito das compras</p>
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
                            <span className="flex items-center">
                              <button
                                onClick={() => openEditCardModal(a, c)}
                                className="text-text-light hover:text-primary leading-none px-1"
                                title="Editar cartão"
                              >
                                ✎
                              </button>
                              <button
                                onClick={() => handleDeleteCard(c)}
                                disabled={deletingCardId === c.id}
                                className="text-text-light hover:text-red-600 leading-none px-1"
                                title="Excluir cartão"
                              >
                                ✕
                              </button>
                            </span>
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

      {/* Modal novo/editar cartão */}
      <Modal
        open={!!cardModalAccount}
        onClose={closeCardModal}
        title={`${editingCard ? "Editar" : "Novo"} cartão${cardModalAccount ? ` — ${cardModalAccount.nickname}` : ""}`}
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
            <Button variant="secondary" onClick={closeCardModal}>
              Cancelar
            </Button>
            <Button onClick={handleSaveCard} disabled={savingCard}>
              {savingCard ? "Salvando..." : editingCard ? "Salvar" : "Adicionar cartão"}
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
              placeholder="Ex.: CARGO SHIPS CLEANING LTDA"
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
                placeholder="0099830-3"
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
