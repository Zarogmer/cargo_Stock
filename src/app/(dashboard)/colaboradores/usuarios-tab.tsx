"use client";

import { useCallback, useEffect, useState } from "react";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { formatDateTime, matchSearch } from "@/lib/utils";
import type { Employee } from "@/types/database";

// Aba Rh › Usuários: o RH cria logins de SUPERVISOR (login = email + senha),
// sempre vinculados a um colaborador. O supervisor logado enxerga somente os
// Relatórios de Bordo dos navios em que o colaborador está escalado — a
// escala (Escalação de Embarque/Costado) é quem dá a visibilidade.

interface SupervisorUser {
  id: string;
  email: string;
  full_name: string;
  employee_id: number | null;
  created_at: string;
  employees: { name: string; role: string | null } | null;
}

interface FormState {
  full_name: string;
  email: string;
  password: string;
  employee_id: string; // value do select ("" = nenhum)
}

const EMPTY_FORM: FormState = { full_name: "", email: "", password: "", employee_id: "" };

export function UsuariosTab({ employees, canManage }: { employees: Employee[]; canManage: boolean }) {
  const [users, setUsers] = useState<SupervisorUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editUser, setEditUser] = useState<SupervisorUser | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [deleteUser, setDeleteUser] = useState<SupervisorUser | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/rh/usuarios");
      const json = await res.json();
      if (res.ok) setUsers(json.data || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditUser(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setShowPassword(false);
    setFormOpen(true);
  }

  function openEdit(u: SupervisorUser) {
    setEditUser(u);
    setForm({
      full_name: u.full_name,
      email: u.email,
      password: "",
      employee_id: u.employee_id ? String(u.employee_id) : "",
    });
    setFormError("");
    setShowPassword(false);
    setFormOpen(true);
  }

  async function save() {
    setFormError("");
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        full_name: form.full_name,
        email: form.email,
        employee_id: form.employee_id ? Number(form.employee_id) : null,
      };
      // Na edição, senha em branco = mantém a atual.
      if (!editUser || form.password) payload.password = form.password;
      if (editUser) payload.id = editUser.id;

      const res = await fetch("/api/rh/usuarios", {
        method: editUser ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setFormError(json.error || "Erro ao salvar.");
        return;
      }
      setFormOpen(false);
      load();
    } catch {
      setFormError("Erro ao conectar com o servidor.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!deleteUser) return;
    setSaving(true);
    try {
      await fetch(`/api/rh/usuarios?id=${deleteUser.id}`, { method: "DELETE" });
      setDeleteUser(null);
      load();
    } finally {
      setSaving(false);
    }
  }

  const filtered = users.filter((u) =>
    matchSearch(`${u.full_name} ${u.email} ${u.employees?.name || ""}`, search)
  );

  // Colaboradores ativos primeiro; inativos ficam no fim, marcados.
  const employeeOptions = [...employees].sort((a, b) => {
    const ai = a.status === "INATIVO" ? 1 : 0;
    const bi = b.status === "INATIVO" ? 1 : 0;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name);
  });

  const columns = [
    {
      key: "full_name",
      label: "Nome",
      render: (u: SupervisorUser) => (
        <div>
          <p className="font-medium text-text">{u.full_name}</p>
          <p className="text-xs text-text-light">{u.email}</p>
        </div>
      ),
    },
    {
      key: "employee",
      label: "Colaborador vinculado",
      render: (u: SupervisorUser) =>
        u.employees ? (
          <div>
            <p className="text-sm text-text">{u.employees.name}</p>
            {u.employees.role && <p className="text-xs text-text-light">{u.employees.role}</p>}
          </div>
        ) : (
          <span className="text-xs text-amber-600 font-medium">⚠️ sem vínculo — não vê navios</span>
        ),
    },
    {
      key: "created_at",
      label: "Criado em",
      hideOnMobile: true,
      render: (u: SupervisorUser) => (
        <span className="text-xs text-text-light">{formatDateTime(u.created_at)}</span>
      ),
    },
    {
      key: "actions",
      label: "",
      render: (u: SupervisorUser) =>
        canManage ? (
          <div className="flex items-center gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => openEdit(u)}
              title="Editar / trocar senha"
              className="p-1.5 text-text-light hover:text-primary hover:bg-primary/10 rounded-lg transition"
            >
              <EditIcon className="w-4 h-4" />
            </button>
            <button
              onClick={() => setDeleteUser(u)}
              title="Excluir"
              className="p-1.5 text-text-light hover:text-danger hover:bg-danger/10 rounded-lg transition"
            >
              <TrashIcon className="w-4 h-4" />
            </button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-900">
        <p className="font-semibold mb-1">👷 Usuários supervisores</p>
        <p>
          Os usuários criados aqui entram com <strong>email e senha</strong> e enxergam somente a aba{" "}
          <strong>Relatórios de Bordo</strong> — e apenas dos navios em que o colaborador vinculado
          está <strong>escalado</strong> (Escalação de Embarque ou de Costado). Lá eles registram a
          lavagem dos porões/costado, avaliam os colaboradores da equipe, adicionam fotos e geram os
          relatórios em PDF com a marca d&apos;água da Cargo.
        </p>
      </div>

      <DataTable
        columns={columns}
        data={filtered}
        loading={loading}
        keyExtractor={(u) => u.id}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar usuário..."
        emptyMessage="Nenhum usuário supervisor cadastrado ainda"
        mobileCards
        actions={
          canManage ? (
            <Button size="sm" onClick={openCreate}>
              <PlusIcon className="w-4 h-4" />
              Adicionar
            </Button>
          ) : undefined
        }
      />

      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editUser ? "Editar usuário supervisor" : "Novo usuário supervisor"}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-text mb-1">Nome completo *</label>
            <input
              type="text"
              value={form.full_name}
              onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
              placeholder="Ex.: Gabriel Sarmento"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text mb-1">Email (login) *</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
              placeholder="supervisor@cargoships.com.br"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text mb-1">
              Senha {editUser ? "(deixe em branco para manter a atual)" : "*"}
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                className="w-full px-3 py-2 pr-16 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                placeholder="Mínimo 6 caracteres"
                minLength={form.password || !editUser ? 6 : undefined}
                required={!editUser}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-text-light hover:text-primary"
              >
                {showPassword ? "ocultar" : "mostrar"}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text mb-1">Colaborador vinculado *</label>
            <select
              value={form.employee_id}
              onChange={(e) => setForm((f) => ({ ...f, employee_id: e.target.value }))}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none bg-white"
              required
            >
              <option value="">Selecione...</option>
              {employeeOptions.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.name}
                  {emp.role ? ` — ${emp.role}` : ""}
                  {emp.status === "INATIVO" ? " (inativo)" : ""}
                </option>
              ))}
            </select>
            <p className="text-xs text-text-light mt-1">
              O supervisor verá os navios em que ESTE colaborador estiver escalado.
            </p>
          </div>

          {formError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-2.5 text-sm text-red-700">
              {formError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setFormOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Salvando..." : editUser ? "Salvar" : "Criar usuário"}
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={!!deleteUser}
        onClose={() => setDeleteUser(null)}
        onConfirm={remove}
        title="Excluir usuário"
        message={`Excluir o acesso de "${deleteUser?.full_name}"? Os relatórios já preenchidos por ele não são apagados.`}
        loading={saving}
      />
    </div>
  );
}
