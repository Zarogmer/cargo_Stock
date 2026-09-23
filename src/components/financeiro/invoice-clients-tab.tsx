"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { resolveHeaderLine, type InvoiceClientRow } from "@/lib/fiscal-note";

// Financeiro › Dados dos Clientes — cadastro fiscal que sai no cabeçalho das
// Notas de Débito/Crédito (razão social, endereço, CNPJ, IE, Insc. Municipal,
// linha do destinatário, idioma, moeda, OI e dados de depósito).
//
// `name` casa com o cliente do navio (ships.client_name / jobs.client): quando
// o navio é desse cliente, o modal da nota já abre com tudo preenchido. Os
// clientes das pastas "2- INVOICE" da diretoria entraram por migration
// (Continental, Wilson Sons, Transatlântica, Naabsa, Deep); aqui dá pra
// corrigir e cadastrar novos.

const inputCls =
  "w-full px-3 py-2 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/40";
const labelCls = "block text-xs font-medium text-text-light mb-1";

interface Draft {
  name: string;
  legal_name: string;
  header_line: string;
  address: string;
  cnpj: string;
  ie: string;
  municipal_reg: string;
  language: "PT" | "EN";
  default_currency: "BRL" | "USD";
  requires_oi: boolean;
  deposit_bank: string;
  notes: string;
}

const EMPTY: Draft = {
  name: "", legal_name: "", header_line: "", address: "", cnpj: "", ie: "", municipal_reg: "",
  language: "PT", default_currency: "BRL", requires_oi: false, deposit_bank: "", notes: "",
};

function toDraft(c: InvoiceClientRow): Draft {
  return {
    name: c.name || "",
    legal_name: c.legal_name || "",
    header_line: c.header_line || "",
    address: c.address || "",
    cnpj: c.cnpj || "",
    ie: c.ie || "",
    municipal_reg: c.municipal_reg || "",
    language: c.language === "EN" ? "EN" : "PT",
    default_currency: c.default_currency === "USD" ? "USD" : "BRL",
    requires_oi: !!c.requires_oi,
    deposit_bank: c.deposit_bank || "",
    notes: c.notes || "",
  };
}

export function InvoiceClientsTab({ canEdit, profileName }: { canEdit: boolean; profileName: string }) {
  const [clients, setClients] = useState<InvoiceClientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<InvoiceClientRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await db.from("invoice_clients").select("*").order("name");
    if (err) setError(err.message);
    setClients(
      ((data as InvoiceClientRow[] | null) || []).slice().sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    );
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) =>
      [c.name, c.legal_name, c.cnpj].some((v) => (v || "").toLowerCase().includes(q)),
    );
  }, [clients, search]);

  function openCreate() {
    setDraft(EMPTY);
    setFormError(null);
    setEditing(null);
    setCreating(true);
  }
  function openEdit(c: InvoiceClientRow) {
    setDraft(toDraft(c));
    setFormError(null);
    setEditing(c);
    setCreating(true);
  }
  function closeForm() {
    setCreating(false);
    setEditing(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const name = draft.name.trim();
    if (!name) {
      setFormError("Informe o nome do cliente (o mesmo usado no cadastro do navio).");
      return;
    }
    const clash = clients.find((c) => c.name.trim().toLowerCase() === name.toLowerCase() && c.id !== editing?.id);
    if (clash) {
      setFormError(`Já existe um cliente chamado "${clash.name}".`);
      return;
    }
    setSaving(true);
    setFormError(null);
    const payload = {
      name,
      legal_name: draft.legal_name.trim() || null,
      header_line: draft.header_line.trim() || null,
      address: draft.address.trim() || null,
      cnpj: draft.cnpj.trim() || null,
      ie: draft.ie.trim() || null,
      municipal_reg: draft.municipal_reg.trim() || null,
      language: draft.language,
      default_currency: draft.default_currency,
      requires_oi: draft.requires_oi,
      deposit_bank: draft.deposit_bank.trim() || null,
      notes: draft.notes.trim() || null,
      updated_at: new Date().toISOString(),
    };
    const res = editing
      ? await db.from("invoice_clients").update(payload as never).eq("id", editing.id)
      : await db.from("invoice_clients").insert({ ...payload, created_by: profileName } as never);
    setSaving(false);
    if (res.error) {
      setFormError(res.error.message);
      return;
    }
    closeForm();
    await load();
  }

  async function handleDelete(c: InvoiceClientRow) {
    if (!confirm(`Apagar o cadastro fiscal de "${c.name}"?\n\nAs notas já emitidas não mudam (guardam uma cópia dos dados).`)) return;
    const { error: err } = await db.from("invoice_clients").delete().eq("id", c.id);
    if (err) {
      setError(err.message);
      return;
    }
    await load();
  }

  const previewHeader = resolveHeaderLine(draft.header_line, "MV EXEMPLO", draft.legal_name || draft.name || "—");

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <p className="text-sm text-text-light">
          Dados fiscais que saem no cabeçalho da Nota de Débito/Crédito. O <strong>nome</strong> precisa ser o
          mesmo do cadastro do navio — assim a nota já abre preenchida.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar cliente…"
            className="px-3 py-1.5 border border-border rounded-lg text-sm w-48"
          />
          {canEdit && <Button type="button" onClick={openCreate}>+ Cadastrar cliente</Button>}
        </div>
      </div>

      {error && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">{error}</p>}

      {loading ? (
        <p className="text-sm text-text-light">Carregando…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-text-light">Nenhum cliente cadastrado.</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {filtered.map((c) => (
            <div key={c.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-bold text-text truncate">🏢 {c.name}</h3>
                  {c.legal_name && <p className="text-sm text-text-light truncate">{c.legal_name}</p>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                    {c.language === "EN" ? "EN" : "PT"}
                  </span>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                    {c.default_currency === "USD" ? "USD" : "R$"}
                  </span>
                  {c.requires_oi && (
                    <span
                      className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700"
                      title="Nota com OI (ordem da agência)"
                    >
                      OI
                    </span>
                  )}
                </div>
              </div>
              <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <div className="sm:col-span-2">
                  <dt className="text-text-light inline">Endereço: </dt>
                  <dd className="inline">{c.address || "—"}</dd>
                </div>
                <div>
                  <dt className="text-text-light inline">CNPJ: </dt>
                  <dd className="inline">{c.cnpj || "—"}</dd>
                </div>
                <div>
                  <dt className="text-text-light inline">I.E.: </dt>
                  <dd className="inline">{c.ie || "—"}</dd>
                </div>
                <div>
                  <dt className="text-text-light inline">Insc. Munic.: </dt>
                  <dd className="inline">{c.municipal_reg || "—"}</dd>
                </div>
                <div>
                  <dt className="text-text-light inline">Depósito: </dt>
                  <dd className="inline">{c.deposit_bank ? c.deposit_bank.split(/\r?\n/)[0] : "Itaú (padrão)"}</dd>
                </div>
                {c.header_line && (
                  <div className="sm:col-span-2">
                    <dt className="text-text-light inline">Destinatário: </dt>
                    <dd className="inline italic">{c.header_line}</dd>
                  </div>
                )}
                {c.notes && (
                  <div className="sm:col-span-2">
                    <dt className="text-text-light inline">Obs.: </dt>
                    <dd className="inline">{c.notes}</dd>
                  </div>
                )}
              </dl>
              {canEdit && (
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => openEdit(c)}
                    className="text-xs px-2.5 py-1 rounded-lg border border-border hover:bg-gray-50"
                  >
                    ✏️ Editar
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(c)}
                    className="text-xs px-2.5 py-1 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                  >
                    🗑 Apagar
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal
        open={creating}
        onClose={closeForm}
        title={editing ? `Editar cliente · ${editing.name}` : "Cadastrar cliente"}
        maxWidth="max-w-3xl"
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Nome (como no navio) *</label>
              <input
                type="text"
                required
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Wilson Sons"
                className={inputCls}
              />
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>Razão social</label>
              <input
                type="text"
                value={draft.legal_name}
                onChange={(e) => setDraft({ ...draft, legal_name: e.target.value })}
                placeholder="WILSON SONS SHIPPING SERVICES"
                className={inputCls}
              />
            </div>
            <div className="md:col-span-3">
              <label className={labelCls}>Linha do destinatário</label>
              <input
                type="text"
                value={draft.header_line}
                onChange={(e) => setDraft({ ...draft, header_line: e.target.value })}
                placeholder="AO COMANDANTE E/OU ARMADOR DO {NAVIO} A/C WILSON SONS SHIPPING SERVICES."
                className={inputCls}
              />
              <p className="text-[10px] text-text-light mt-0.5">
                <code>{"{NAVIO}"}</code> vira o nome do navio. Em branco usa a razão social. Sai como: <em>{previewHeader}</em>
              </p>
            </div>
            <div className="md:col-span-3">
              <label className={labelCls}>Endereço</label>
              <input
                type="text"
                value={draft.address}
                onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                placeholder="Av. Ana Costa nº 291 - 9º andar, conj. 92 - Gonzaga - Santos/SP CEP: 11060-001"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>CNPJ</label>
              <input
                type="text"
                value={draft.cnpj}
                onChange={(e) => setDraft({ ...draft, cnpj: e.target.value })}
                placeholder="00.000.000/0000-00"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Inscrição Estadual</label>
              <input type="text" value={draft.ie} onChange={(e) => setDraft({ ...draft, ie: e.target.value })} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Inscrição Municipal</label>
              <input
                type="text"
                value={draft.municipal_reg}
                onChange={(e) => setDraft({ ...draft, municipal_reg: e.target.value })}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Idioma da nota</label>
              <select
                value={draft.language}
                onChange={(e) => setDraft({ ...draft, language: e.target.value as "PT" | "EN" })}
                className={inputCls}
              >
                <option value="PT">Português</option>
                <option value="EN">Inglês (DEBIT NOTE / BARTHED / SAILED)</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>Moeda padrão</label>
              <select
                value={draft.default_currency}
                onChange={(e) => setDraft({ ...draft, default_currency: e.target.value as "BRL" | "USD" })}
                className={inputCls}
              >
                <option value="BRL">R$ (Real)</option>
                <option value="USD">USD (Dólar)</option>
              </select>
            </div>
            <div className="flex items-end">
              <label className="inline-flex items-center gap-2 text-sm cursor-pointer pb-2">
                <input
                  type="checkbox"
                  checked={draft.requires_oi}
                  onChange={(e) => setDraft({ ...draft, requires_oi: e.target.checked })}
                  className="w-4 h-4"
                />
                Nota com OI (ordem da agência)
              </label>
            </div>
            <div className="md:col-span-3">
              <label className={labelCls}>Dados para depósito na nota</label>
              <textarea
                value={draft.deposit_bank}
                onChange={(e) => setDraft({ ...draft, deposit_bank: e.target.value })}
                rows={3}
                placeholder={"Em branco usa o Itaú padrão.\nEx.: SANTANDER 033\nAG: 0002\nC/C: 13008950-4"}
                className={inputCls}
              />
              <p className="text-[10px] text-text-light mt-0.5">Uma linha por informação (banco, agência, conta, PIX).</p>
            </div>
            <div className="md:col-span-3">
              <label className={labelCls}>Observações</label>
              <input type="text" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} className={inputCls} />
            </div>
          </div>

          {formError && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-2">{formError}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={closeForm}>Cancelar</Button>
            <Button type="submit" disabled={saving}>{saving ? "Salvando…" : editing ? "Salvar" : "Cadastrar"}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
