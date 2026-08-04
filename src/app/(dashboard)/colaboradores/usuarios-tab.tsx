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
  // O email é montado como usuário + domínio: o campo digitável é só a parte da
  // esquerda; o domínio fica travado (ver EMAIL_DOMAIN).
  email_user: string;
  email_domain: string;
  password: string;
  employee_id: string; // value do select ("" = nenhum)
}

// Todo login de supervisor é do domínio da empresa — o RH não digita mais o
// "@" nem erra o domínio. Logins antigos de outro domínio continuam valendo:
// na edição o domínio salvo é preservado (trocar login quebraria o acesso de
// quem já usa).
const EMAIL_DOMAIN = "cargoships.com.br";

const EMPTY_FORM: FormState = {
  full_name: "",
  email_user: "",
  email_domain: EMAIL_DOMAIN,
  password: "",
  employee_id: "",
};

// Nome do colaborador → sugestão de login: primeiro nome + primeiro sobrenome,
// sem acento nem espaço ("GABRIEL SALES FREITAS" → "gabrielsales"), no formato
// que os logins já existentes seguem.
function suggestEmailUser(name: string): string {
  const parts = String(name || "")
    // NFD separa a letra do acento; o range abaixo tira só os acentos.
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .split(/\s+/)
    // "JOSE DA SILVA" → josesilva (a partícula não entra no login).
    .filter((w) => w && !["da", "de", "di", "do", "dos", "das", "e"].includes(w));
  return parts.slice(0, 2).join("");
}

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
    // Login antigo de outro domínio (@cargoships.com, por exemplo) mantém o
    // domínio dele — mudar o email aqui trocaria o login de quem já usa.
    const at = u.email.lastIndexOf("@");
    setForm({
      full_name: u.full_name,
      email_user: at > 0 ? u.email.slice(0, at) : u.email,
      email_domain: at > 0 ? u.email.slice(at + 1) : EMAIL_DOMAIN,
      password: "",
      employee_id: u.employee_id ? String(u.employee_id) : "",
    });
    setFormError("");
    setShowPassword(false);
    setFormOpen(true);
  }

  // Escolher o colaborador é o 1º passo: já preenche nome e sugestão de login
  // (os dois seguem editáveis). Trocar o colaborador refaz a sugestão.
  function pickEmployee(value: string) {
    const emp = employees.find((e) => String(e.id) === value);
    setForm((f) => ({
      ...f,
      employee_id: value,
      full_name: emp ? emp.name : f.full_name,
      email_user: emp ? suggestEmailUser(emp.name) : f.email_user,
    }));
  }

  async function save() {
    setFormError("");
    setSaving(true);
    try {
      const emailUser = form.email_user.trim().toLowerCase();
      if (!emailUser) {
        setFormError("Informe o usuário do email (a parte antes do @).");
        return;
      }
      const payload: Record<string, unknown> = {
        full_name: form.full_name,
        email: `${emailUser}@${form.email_domain}`,
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

  // Só quem tem a função SUPERVISOR no cadastro entra na lista: este login É o
  // acesso do supervisor de bordo. Mostrar a empresa inteira só dava chance de
  // vincular a pessoa errada — e um não-supervisor não assina o Cleaning Report
  // nem lança avaliação. Editando um usuário antigo, o colaborador já vinculado
  // continua na lista mesmo que a função dele tenha mudado (senão o select
  // abriria vazio e o formulário travaria no "obrigatório").
  const isSupervisor = (e: Employee) => (e.role || "").trim().toUpperCase() === "SUPERVISOR";
  const linkedId = editUser?.employee_id ?? null;
  // Ativos primeiro; inativos ficam no fim, marcados.
  const employeeOptions = employees
    .filter((e) => isSupervisor(e) || e.id === linkedId)
    .sort((a, b) => {
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
          {/* 1º passo: o colaborador. Escolher já preenche nome e login. */}
          <div>
            <label className="block text-sm font-medium text-text mb-1">Colaborador vinculado *</label>
            <select
              value={form.employee_id}
              onChange={(e) => pickEmployee(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none bg-white"
              required
              autoFocus
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
            {employeeOptions.length === 0 ? (
              <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mt-1">
                ⚠️ Nenhum colaborador com a função <strong>SUPERVISOR</strong> no cadastro. Ajuste a função dele na aba Colaboradores pra poder criar o login.
              </p>
            ) : (
              <p className="text-xs text-text-light mt-1">
                Só colaboradores com a função <strong>SUPERVISOR</strong> aparecem aqui. O supervisor verá os navios em que ESTE colaborador estiver escalado.
              </p>
            )}
          </div>

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

          {/* Email = usuário + domínio fixo da empresa: o RH digita só a parte
              da esquerda, o "@dominio" não é editável. */}
          <div>
            <label className="block text-sm font-medium text-text mb-1">Email (login) *</label>
            <div className="flex items-stretch">
              <input
                type="text"
                value={form.email_user}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    // Login não tem espaço, acento nem maiúscula.
                    email_user: e.target.value.trim().toLowerCase().replace(/[^a-z0-9._-]/g, ""),
                  }))
                }
                className="flex-1 min-w-0 px-3 py-2 border border-border rounded-l-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                placeholder="nome.sobrenome"
                required
              />
              <span
                className="shrink-0 flex items-center px-3 bg-gray-100 border border-l-0 border-border rounded-r-lg text-sm text-text-light"
                title="Domínio fixo — todo login de supervisor é da empresa"
              >
                @{form.email_domain}
              </span>
            </div>
            <p className="text-xs text-text-light mt-1">
              {editUser && form.email_domain !== EMAIL_DOMAIN
                ? `Login antigo neste domínio — mantido pra não tirar o acesso de quem já usa.`
                : `O domínio é fixo: todo login de supervisor é @${EMAIL_DOMAIN}.`}
            </p>
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
