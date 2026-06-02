"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { db } from "@/lib/db";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/rbac";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon, EditIcon, TrashIcon, SearchIcon } from "@/components/icons";

interface MarketingClient {
  id: number;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  cnpj: string | null;
  city: string | null;
  state: string | null;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const EMPTY_FORM = {
  name: "",
  company: "",
  email: "",
  phone: "",
  cnpj: "",
  city: "",
  state: "",
  notes: "",
};

export function ClientsPanel() {
  const { profile } = useAuth();
  const router = useRouter();

  const [clients, setClients] = useState<MarketingClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<MarketingClient | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const canCreate = profile ? hasPermission(profile.role, "MARKETING", "create") : false;
  const canEdit = profile ? hasPermission(profile.role, "MARKETING", "edit") : false;
  const canDelete = profile ? hasPermission(profile.role, "MARKETING", "delete") : false;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await db.from("marketing_clients").select("*").order("name");
      setClients((data as MarketingClient[]) || []);
    } catch (err) {
      console.error("load clients error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((c) =>
      [c.name, c.company, c.email, c.city, c.cnpj].some((v) =>
        (v || "").toLowerCase().includes(q),
      ),
    );
  }, [clients, search]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setShowModal(true);
  }

  function openEdit(c: MarketingClient) {
    setEditing(c);
    setForm({
      name: c.name || "",
      company: c.company || "",
      email: c.email || "",
      phone: c.phone || "",
      cnpj: c.cnpj || "",
      city: c.city || "",
      state: c.state || "",
      notes: c.notes || "",
    });
    setFormError("");
    setShowModal(true);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setFormError("Nome é obrigatório.");
      return;
    }
    setSaving(true);
    setFormError("");
    const payload = {
      name: form.name.trim(),
      company: form.company.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      cnpj: form.cnpj.trim() || null,
      city: form.city.trim() || null,
      state: form.state.trim() || null,
      notes: form.notes.trim() || null,
    };
    try {
      if (editing) {
        const { error } = await db.from("marketing_clients").update(payload).eq("id", editing.id);
        if (error) {
          setFormError(error.message);
          return;
        }
      } else {
        const { error } = await db.from("marketing_clients").insert({
          ...payload,
          created_by: profile?.full_name || "sistema",
        });
        if (error) {
          setFormError(error.message);
          return;
        }
      }
      setShowModal(false);
      load();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (deleteId == null) return;
    setDeleting(true);
    await db.from("marketing_clients").delete().eq("id", deleteId);
    setDeleteId(null);
    setDeleting(false);
    load();
  }

  // Leva o cliente pro compositor de email já preenchido (destinatário + saudação).
  function sendEmail(c: MarketingClient) {
    const params = new URLSearchParams({ tab: "email" });
    if (c.email) params.set("to", c.email);
    const nome = c.company || c.name;
    if (nome) params.set("nome", nome);
    router.push(`/marketing?${params.toString()}`);
  }

  const inputClass =
    "w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm bg-card";

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <span className="text-sm text-text-light animate-pulse">Carregando clientes...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-light" />
          <input
            type="text"
            placeholder="Buscar por nome, empresa, email, cidade ou CNPJ..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 bg-card"
          />
        </div>
        {canCreate && (
          <button
            onClick={openCreate}
            className="flex items-center justify-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-dark transition text-sm font-medium shadow-sm shrink-0"
          >
            <PlusIcon className="w-4 h-4" />
            Novo cliente
          </button>
        )}
      </div>

      {/* Lista */}
      {filtered.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <p className="text-4xl mb-3">📇</p>
          <p className="text-text-light">
            {clients.length === 0 ? "Nenhum cliente cadastrado ainda." : "Nenhum cliente encontrado."}
          </p>
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-light uppercase tracking-wider">
                <th className="px-4 py-3 font-semibold">Cliente</th>
                <th className="px-4 py-3 font-semibold">Contato</th>
                <th className="px-4 py-3 font-semibold">Local</th>
                <th className="px-4 py-3 font-semibold">CNPJ</th>
                <th className="px-4 py-3 font-semibold text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-text">{c.name}</p>
                    {c.company && c.company !== c.name && (
                      <p className="text-xs text-text-light">{c.company}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {c.email && <p className="text-text">{c.email}</p>}
                    {c.phone && <p className="text-xs text-text-light">{c.phone}</p>}
                    {!c.email && !c.phone && <span className="text-text-light">—</span>}
                  </td>
                  <td className="px-4 py-3 text-text-light">
                    {[c.city, c.state].filter(Boolean).join(" / ") || "—"}
                  </td>
                  <td className="px-4 py-3 text-text-light">{c.cnpj || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => sendEmail(c)}
                        disabled={!c.email}
                        title={c.email ? "Enviar email" : "Sem email cadastrado"}
                        className="p-1.5 text-text-light hover:text-primary hover:bg-primary/10 rounded-lg transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                      >
                        <span aria-hidden>📧</span>
                      </button>
                      {canEdit && (
                        <button
                          onClick={() => openEdit(c)}
                          title="Editar"
                          className="p-1.5 text-text-light hover:text-primary hover:bg-primary/10 rounded-lg transition"
                        >
                          <EditIcon className="w-4 h-4" />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          onClick={() => setDeleteId(c.id)}
                          title="Excluir"
                          className="p-1.5 text-text-light hover:text-danger hover:bg-danger/10 rounded-lg transition"
                        >
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal criar/editar */}
      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        title={editing ? "Editar cliente" : "Novo cliente"}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-text mb-1">Nome / Razão social *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Ex: Transatlântica Comércio Marítimo"
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text mb-1">
              Empresa <span className="text-text-light font-normal">(se diferente do nome)</span>
            </label>
            <input
              type="text"
              value={form.company}
              onChange={(e) => setForm({ ...form, company: e.target.value })}
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text mb-1">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="contato@empresa.com"
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-1">Telefone</label>
              <input
                type="text"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className={inputClass}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-text mb-1">Cidade</label>
              <input
                type="text"
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                className={inputClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text mb-1">Estado (UF)</label>
              <input
                type="text"
                value={form.state}
                onChange={(e) => setForm({ ...form, state: e.target.value })}
                placeholder="SP"
                maxLength={2}
                className={`${inputClass} uppercase`}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text mb-1">CNPJ</label>
            <input
              type="text"
              value={form.cnpj}
              onChange={(e) => setForm({ ...form, cnpj: e.target.value })}
              placeholder="00.000.000/0000-00"
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text mb-1">Observações</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={3}
              className={`${inputClass} resize-y`}
            />
          </div>

          {formError && <p className="text-sm text-danger">{formError}</p>}

          <div className="flex gap-3 justify-end pt-1">
            <button
              onClick={() => setShowModal(false)}
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-text-light hover:text-text transition"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-dark transition text-sm font-medium shadow-sm disabled:opacity-60"
            >
              {saving ? "Salvando..." : editing ? "Salvar" : "Cadastrar"}
            </button>
          </div>
        </div>
      </Modal>

      {/* Confirmação de exclusão */}
      <ConfirmDialog
        open={deleteId != null}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title="Excluir cliente"
        message="Tem certeza que deseja excluir este cliente do cadastro? Esta ação não pode ser desfeita."
        confirmLabel="Excluir"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
