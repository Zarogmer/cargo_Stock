"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/rbac";
import { createClient } from "@/lib/supabase-browser";
import { PlusIcon, EditIcon, TrashIcon, SearchIcon } from "@/components/icons";

// ─── Types ───────────────────────────────────────────────────────────────────

type ShipStatus = "AGENDADO" | "EM_OPERACAO" | "CONCLUIDO" | "CANCELADO";

interface Ship {
  id: string;
  name: string;
  arrival_date: string | null;
  departure_date: string | null;
  port: string | null;
  status: ShipStatus;
  assigned_team: string | null;
  notes: string | null;
  created_at: string;
  created_by: string;
}

interface Employee {
  id: number;
  name: string;
  team: string | null;
}

interface ShipEmployee {
  id: string;
  ship_id: string;
  employee_id: number;
  role_in_ship: string | null;
  employees: { name: string; team: string | null } | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_OPTIONS: ShipStatus[] = ["AGENDADO", "EM_OPERACAO", "CONCLUIDO", "CANCELADO"];

const STATUS_LABELS: Record<ShipStatus, string> = {
  AGENDADO: "Agendado",
  EM_OPERACAO: "Em Operação",
  CONCLUIDO: "Concluído",
  CANCELADO: "Cancelado",
};

const STATUS_COLORS: Record<ShipStatus, string> = {
  AGENDADO: "bg-blue-100 text-blue-700",
  EM_OPERACAO: "bg-amber-100 text-amber-700",
  CONCLUIDO: "bg-emerald-100 text-emerald-700",
  CANCELADO: "bg-red-100 text-red-700",
};

const EMPTY_FORM = {
  name: "",
  arrival_date: "",
  departure_date: "",
  port: "",
  status: "AGENDADO" as ShipStatus,
  assigned_team: "" as string,
  notes: "",
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function NaviosPage() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const supabase = createClient();

  const [ships, setShips] = useState<Ship[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<ShipStatus | "TODOS">("TODOS");

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingShip, setEditingShip] = useState<Ship | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // Ship detail / crew panel
  const [selectedShip, setSelectedShip] = useState<Ship | null>(null);
  const [shipTeam, setShipTeam] = useState<string | null>(null); // "EQUIPE_1" | "EQUIPE_2" | null
  const [shipTeamLoading, setShipTeamLoading] = useState(false);

  // Delete confirm
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const canEdit = profile ? hasPermission(profile.role, "NAVIOS", "edit") : false;
  const canCreate = profile ? hasPermission(profile.role, "NAVIOS", "create") : false;
  const canDelete = profile ? hasPermission(profile.role, "NAVIOS", "delete") : false;

  // ── Load data ──────────────────────────────────────────────────────────────

  const loadShips = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from("ships")
        .select("*")
        .order("arrival_date", { ascending: false });
      setShips(data || []);
    } catch (err) {
      console.error("loadShips error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEmployees = useCallback(async () => {
    try {
      const { data } = await supabase
        .from("employees")
        .select("id, name, team")
        .order("name");
      setEmployees((data as any[]) || []);
    } catch (err) {
      console.error("loadEmployees error:", err);
    }
  }, []);

  // Get team members for a ship based on assigned_team
  const getShipTeamMembers = useCallback((ship: Ship) => {
    if (!ship.assigned_team) return [];
    return employees.filter((e) => e.team === ship.assigned_team);
  }, [employees]);

  useEffect(() => {
    loadShips();
    loadEmployees();
  }, [loadShips, loadEmployees, pathname]);

  // ── Filter ─────────────────────────────────────────────────────────────────

  const filtered = ships.filter((s) => {
    const matchSearch =
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      (s.port || "").toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === "TODOS" || s.status === filterStatus;
    return matchSearch && matchStatus;
  });

  // ── Modal helpers ──────────────────────────────────────────────────────────

  function openCreate() {
    setEditingShip(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setShowModal(true);
  }

  function openEdit(ship: Ship) {
    setEditingShip(ship);
    setForm({
      name: ship.name,
      arrival_date: ship.arrival_date || "",
      departure_date: ship.departure_date || "",
      port: ship.port || "",
      status: ship.status,
      assigned_team: ship.assigned_team || "",
      notes: ship.notes || "",
    });
    setFormError("");
    setShowModal(true);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setFormError("Nome do navio é obrigatório.");
      return;
    }
    setSaving(true);
    setFormError("");

    const payload = {
      name: form.name.trim(),
      arrival_date: form.arrival_date || null,
      departure_date: form.departure_date || null,
      port: form.port.trim() || null,
      status: form.status,
      assigned_team: form.assigned_team || null,
      notes: form.notes.trim() || null,
      created_by: profile?.full_name || "sistema",
    };

    if (editingShip) {
      const { error } = await supabase
        .from("ships")
        .update(payload)
        .eq("id", editingShip.id);
      if (error) { setFormError(error.message); setSaving(false); return; }
      if (selectedShip?.id === editingShip.id) {
        setSelectedShip({ ...editingShip, ...payload });
      }
    } else {
      const { error } = await supabase.from("ships").insert(payload);
      if (error) { setFormError(error.message); setSaving(false); return; }
    }

    setSaving(false);
    setShowModal(false);
    loadShips();
  }

  async function handleDelete(id: string) {
    await supabase.from("ships").delete().eq("id", id);
    if (selectedShip?.id === id) setSelectedShip(null);
    setDeleteId(null);
    loadShips();
  }

  // ── Crew helpers ───────────────────────────────────────────────────────────

  function openDetail(ship: Ship) {
    setSelectedShip(ship);
    setShipTeam(ship.assigned_team);
  }

  async function handleAssignTeam(team: string | null) {
    if (!selectedShip) return;
    setShipTeamLoading(true);
    await supabase.from("ships").update({ assigned_team: team } as any).eq("id", selectedShip.id);
    setShipTeam(team);
    setSelectedShip({ ...selectedShip, assigned_team: team });
    // Refresh ship list
    loadShips();
    setShipTeamLoading(false);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-2">
          <span className="text-4xl animate-bounce">🚢</span>
          <span className="text-sm text-text-light animate-pulse">Carregando navios...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text">Navios ⚓</h1>
          <p className="text-text-light text-sm mt-0.5">
            Controle de operações de lavagem de porão
          </p>
        </div>
        {canCreate && (
          <button
            onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-dark transition text-sm font-medium shadow-sm"
          >
            <PlusIcon className="w-4 h-4" />
            Novo Navio
          </button>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {STATUS_OPTIONS.map((s) => {
          const count = ships.filter((sh) => sh.status === s).length;
          return (
            <button
              key={s}
              onClick={() => setFilterStatus(filterStatus === s ? "TODOS" : s)}
              className={`rounded-xl p-3 text-left border transition ${
                filterStatus === s ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-gray-50"
              }`}
            >
              <p className="text-2xl font-bold text-text">{count}</p>
              <p className="text-xs text-text-light mt-0.5">{STATUS_LABELS[s]}</p>
            </button>
          );
        })}
      </div>

      <div className="flex gap-4 flex-col lg:flex-row">
        {/* Ship list */}
        <div className="flex-1 min-w-0">
          {/* Filters */}
          <div className="flex gap-2 mb-4">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-light" />
              <input
                type="text"
                placeholder="Buscar navio ou porto..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 bg-card"
              />
            </div>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as ShipStatus | "TODOS")}
              className="px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 bg-card"
            >
              <option value="TODOS">Todos</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>

          {/* List */}
          {filtered.length === 0 ? (
            <div className="bg-card rounded-xl border border-border p-12 text-center">
              <p className="text-4xl mb-3">⚓</p>
              <p className="text-text-light">Nenhum navio encontrado</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((ship) => (
                <div
                  key={ship.id}
                  onClick={() => openDetail(ship)}
                  className={`bg-card rounded-xl border transition cursor-pointer p-4 hover:shadow-md ${
                    selectedShip?.id === ship.id ? "border-primary shadow-md" : "border-border"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-text truncate">{ship.name}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${STATUS_COLORS[ship.status]}`}>
                          {STATUS_LABELS[ship.status]}
                        </span>
                      </div>
                      {ship.assigned_team && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
                          ship.assigned_team === "EQUIPE_1" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                        }`}>
                          {ship.assigned_team === "EQUIPE_1" ? "Equipe 1" : "Equipe 2"}
                        </span>
                      )}
                      {ship.port && (
                        <p className="text-xs text-text-light mt-1 flex items-center gap-1">
                          <span>📍</span> {ship.port}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-3 mt-2 text-xs text-text-light">
                        {ship.arrival_date && (
                          <span>🚢 Chegada: <span className="font-medium text-text">{formatDate(ship.arrival_date)}</span></span>
                        )}
                        {ship.departure_date && (
                          <span>🏁 Saída: <span className="font-medium text-text">{formatDate(ship.departure_date)}</span></span>
                        )}
                      </div>
                      {ship.notes && (
                        <p className="text-xs text-text-light mt-1.5 line-clamp-1 italic">&ldquo;{ship.notes}&rdquo;</p>
                      )}
                    </div>

                    {(canEdit || canDelete) && (
                      <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                        {canEdit && (
                          <button
                            onClick={() => openEdit(ship)}
                            className="p-1.5 text-text-light hover:text-primary hover:bg-primary/10 rounded-lg transition"
                            title="Editar"
                          >
                            <EditIcon className="w-4 h-4" />
                          </button>
                        )}
                        {canDelete && (
                          <button
                            onClick={() => setDeleteId(ship.id)}
                            className="p-1.5 text-text-light hover:text-danger hover:bg-danger/10 rounded-lg transition"
                            title="Excluir"
                          >
                            <TrashIcon className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selectedShip && (
          <div className="lg:w-80 bg-card rounded-xl border border-border p-4 space-y-4 self-start lg:sticky lg:top-4">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-bold text-text">{selectedShip.name}</h2>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[selectedShip.status]}`}>
                  {STATUS_LABELS[selectedShip.status]}
                </span>
              </div>
              <button onClick={() => setSelectedShip(null)} className="p-1 hover:bg-gray-100 rounded-lg transition text-text-light">
                ✕
              </button>
            </div>

            <div className="space-y-1.5 text-sm">
              {selectedShip.port && (
                <p><span className="text-text-light">Porto:</span> <span className="font-medium">{selectedShip.port}</span></p>
              )}
              {selectedShip.arrival_date && (
                <p><span className="text-text-light">Chegada:</span> <span className="font-medium">{formatDate(selectedShip.arrival_date)}</span></p>
              )}
              {selectedShip.departure_date && (
                <p><span className="text-text-light">Saída:</span> <span className="font-medium">{formatDate(selectedShip.departure_date)}</span></p>
              )}
              {selectedShip.notes && (
                <p className="text-text-light italic text-xs pt-1">&ldquo;{selectedShip.notes}&rdquo;</p>
              )}
            </div>

            <div className="border-t border-border pt-3">
              <p className="text-xs font-semibold text-text-light uppercase tracking-wider mb-2">
                Equipe Designada
              </p>

              {canEdit ? (
                <div className="flex gap-2 mb-3">
                  {["EQUIPE_1", "EQUIPE_2"].map((t) => (
                    <button
                      key={t}
                      onClick={() => handleAssignTeam(shipTeam === t ? null : t)}
                      disabled={shipTeamLoading}
                      className={`flex-1 py-2 text-xs font-medium rounded-lg transition border ${
                        shipTeam === t
                          ? t === "EQUIPE_1"
                            ? "bg-blue-500 text-white border-blue-500"
                            : "bg-purple-500 text-white border-purple-500"
                          : "border-border hover:bg-gray-50 text-text-light"
                      }`}
                    >
                      {t === "EQUIPE_1" ? "⚓ Equipe 1" : "⚓ Equipe 2"}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm font-medium mb-3">
                  {shipTeam === "EQUIPE_1" ? (
                    <span className="text-blue-700">⚓ Equipe 1</span>
                  ) : shipTeam === "EQUIPE_2" ? (
                    <span className="text-purple-700">⚓ Equipe 2</span>
                  ) : (
                    <span className="text-text-light italic">Nenhuma equipe designada</span>
                  )}
                </p>
              )}

              {/* Show team members */}
              {shipTeam ? (
                <>
                  {(() => {
                    const members = getShipTeamMembers(selectedShip);
                    return members.length === 0 ? (
                      <p className="text-xs text-text-light italic">
                        Nenhum colaborador cadastrado na {shipTeam === "EQUIPE_1" ? "Equipe 1" : "Equipe 2"}.
                        Defina a equipe dos colaboradores em Colaboradores.
                      </p>
                    ) : (
                      <div>
                        <p className="text-xs text-text-light mb-2">{members.length} colaborador{members.length > 1 ? "es" : ""}</p>
                        <ul className="space-y-1.5">
                          {members.map((m) => (
                            <li key={m.id} className="flex items-center gap-2 text-sm py-1 px-2 bg-gray-50 rounded-lg">
                              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${
                                shipTeam === "EQUIPE_1" ? "bg-blue-500" : "bg-purple-500"
                              }`}>
                                {m.name.charAt(0).toUpperCase()}
                              </div>
                              <span className="font-medium text-text truncate">{m.name}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })()}
                </>
              ) : (
                <p className="text-xs text-text-light italic">Selecione Equipe 1 ou Equipe 2 para ver os colaboradores.</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-5 border-b border-border flex items-center justify-between">
              <h2 className="font-bold text-lg text-text">
                {editingShip ? "Editar Navio" : "Novo Navio"}
              </h2>
              <button onClick={() => setShowModal(false)} className="p-1.5 hover:bg-gray-100 rounded-lg transition text-text-light">✕</button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-text mb-1">Nome do Navio *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ex: MV Nordic Star"
                  className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-text mb-1">Data de Chegada</label>
                  <input
                    type="date"
                    value={form.arrival_date}
                    onChange={(e) => setForm({ ...form, arrival_date: e.target.value })}
                    className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text mb-1">Data de Saída</label>
                  <input
                    type="date"
                    value={form.departure_date}
                    onChange={(e) => setForm({ ...form, departure_date: e.target.value })}
                    className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Porto / Local</label>
                <div className="relative">
                  <input
                    type="text"
                    value={form.port}
                    onChange={(e) => setForm({ ...form, port: e.target.value })}
                    placeholder="Selecione ou digite um porto..."
                    list="port-options"
                    className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
                  />
                  <datalist id="port-options">
                    <option value="Santos" />
                    <option value="Paranaguá" />
                    <option value="São Francisco do Sul" />
                  </datalist>
                </div>
                <p className="text-[10px] text-text-light mt-1">Selecione um porto ou digite um novo</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Status</label>
                <select
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as ShipStatus })}
                  className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm bg-white"
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Equipe Designada</label>
                <select
                  value={form.assigned_team}
                  onChange={(e) => setForm({ ...form, assigned_team: e.target.value })}
                  className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm bg-white"
                >
                  <option value="">Sem equipe</option>
                  <option value="EQUIPE_1">Equipe 1</option>
                  <option value="EQUIPE_2">Equipe 2</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Observações</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Informações adicionais sobre a operação..."
                  rows={3}
                  className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm resize-none"
                />
              </div>

              {formError && (
                <p className="text-sm text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">{formError}</p>
              )}
            </div>
            <div className="p-5 border-t border-border flex justify-end gap-3">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm text-text-light hover:text-text hover:bg-gray-100 rounded-lg transition"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-dark transition disabled:opacity-50"
              >
                {saving ? "Salvando..." : editingShip ? "Salvar Alterações" : "Cadastrar Navio"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm">
            <div className="text-center">
              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <TrashIcon className="w-6 h-6 text-danger" />
              </div>
              <h3 className="font-bold text-text mb-1">Excluir Navio</h3>
              <p className="text-sm text-text-light mb-4">
                Esta ação removerá o navio e toda a equipe atribuída. Não pode ser desfeita.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteId(null)}
                className="flex-1 py-2 text-sm text-text-light hover:text-text hover:bg-gray-100 rounded-lg transition"
              >
                Cancelar
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                className="flex-1 py-2 bg-danger text-white text-sm font-medium rounded-lg hover:bg-red-600 transition"
              >
                Excluir
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(dateStr: string) {
  const [year, month, day] = dateStr.split("-");
  return `${day}/${month}/${year}`;
}
