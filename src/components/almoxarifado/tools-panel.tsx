"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { TOOL_STATUS_LABELS, ASSET_TYPE_LABELS, buildCodeMap } from "@/lib/utils";
import type { Tool, ToolStatus, AssetType, ToolMovementType } from "@/types/database";

// Painel de Maquinário (tabela `tools`, asset_type=MAQUINARIO). Mesmo conjunto
// de ações do EPI/Uniforme — Entregar (📤) / Devolver (📥) / Editar / Excluir —
// mas a entrega é feita para uma EQUIPE (não um colaborador): a máquina vai pra
// Equipe 1 ou 2 e a devolução volta pra Disponível. Cada ação grava em
// tool_movements (histórico no painel Histórico).
type Team = "EQUIPE_1" | "EQUIPE_2";
const TEAMS: { value: Team; label: string }[] = [
  { value: "EQUIPE_1", label: "Equipe 1" },
  { value: "EQUIPE_2", label: "Equipe 2" },
];

export function ToolsPanel({ assetType }: { assetType: AssetType }) {
  const { profile } = useAuth();
  const pathname = usePathname();
  const role = profile?.role || "RH";
  const moduleName = assetType === "FERRAMENTA" ? "FERRAMENTAS" : assetType === "ELETRICA" ? "ELETRICA" : "MAQUINARIO";
  const singular = assetType === "FERRAMENTA" ? "Ferramenta" : assetType === "ELETRICA" ? "Elétrica" : "Maquinário";

  const canCreate = hasPermission(role, moduleName, "create");
  const canEdit = hasPermission(role, moduleName, "edit");
  const canDelete = hasPermission(role, moduleName, "delete");

  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editTool, setEditTool] = useState<Tool | null>(null);
  const [deleteTool, setDeleteTool] = useState<Tool | null>(null);
  const [action, setAction] = useState<{ tool: Tool; mode: "ENTREGAR" | "DEVOLVER" } | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await db.from("tools").select("*").eq("asset_type", assetType).order("name");
      setTools(res.data || []);
    } catch (err) {
      console.error("load tools error:", err);
    } finally {
      setLoading(false);
    }
  }, [assetType]);

  useEffect(() => { loadAll(); }, [loadAll, pathname]);

  async function saveTool(data: Partial<Tool>) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    // O Tipo vem do formulário (permite reclassificar entre Maquinário /
    // Ferramenta / Elétrica); na criação cai no assetType da aba atual.
    const payload = { ...data, asset_type: data.asset_type ?? assetType, updated_by: actor } as Record<string, unknown>;
    if (editTool) {
      await db.from("tools").update(payload).eq("id", editTool.id);
    } else {
      await db.from("tools").insert(payload);
    }
    setSaving(false); setShowForm(false); setEditTool(null); loadAll();
  }

  // Entrega para equipe (status -> EQUIPE_X) ou devolução (status -> DISPONIVEL).
  async function handleAction(team: Team | null, notes: string) {
    if (!action) return;
    const { tool, mode } = action;
    const isEntrega = mode === "ENTREGAR";
    if (isEntrega && !team) return;
    setSaving(true);
    const actor = profile?.full_name || "Sistema";

    const newStatus: ToolStatus = isEntrega ? team! : "DISPONIVEL";
    const movementType: ToolMovementType = isEntrega ? team! : "DEVOLUCAO";
    const teamLabel = TEAMS.find((t) => t.value === team)?.label || "";

    await db.from("tool_movements").insert({
      tool_id: tool.id,
      employee_name: isEntrega ? teamLabel : actor,
      movement_type: movementType,
      movement_date: new Date().toISOString().split("T")[0],
      notes, created_by: actor,
    } as Record<string, unknown>);

    const toolUpdate: Record<string, unknown> = { status: newStatus, updated_by: actor };
    if (notes) toolUpdate.notes = notes;
    await db.from("tools").update(toolUpdate).eq("id", tool.id);

    setSaving(false); setAction(null); loadAll();
  }

  // Código derivado do nome (prefixo de iniciais + sequência), por item.
  const codeMap = useMemo(() => buildCodeMap(tools, (t) => t.id, (t) => t.name), [tools]);
  // Máquinas prontas pra uso (status Disponível) — base do alerta de mínimo.
  const availableCount = useMemo(() => tools.filter((t) => t.status === "DISPONIVEL").length, [tools]);

  const columns = [
    { key: "name", label: "Nome", render: (t: Tool) => <span className="font-medium">{t.name}</span> },
    { key: "code", label: "Código", render: (t: Tool) => <span className="font-mono text-xs text-text-light">{codeMap.get(t.id) || "—"}</span> },
    {
      key: "status", label: "Status",
      render: (t: Tool) => {
        const colors: Record<string, string> = {
          DISPONIVEL: "bg-green-100 text-green-700",
          EQUIPE_1: "bg-blue-100 text-blue-700",
          EQUIPE_2: "bg-purple-100 text-purple-700",
          MANUTENCAO: "bg-red-100 text-red-700",
        };
        return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors[t.status] || ""}`}>{TOOL_STATUS_LABELS[t.status]}</span>;
      },
    },
    {
      key: "notes", label: "Obs", hideOnMobile: true,
      render: (t: Tool) => t.notes ? (
        <span className="text-xs text-text-light max-w-[200px] truncate block" title={t.notes}>{t.notes}</span>
      ) : <span className="text-text-light">—</span>,
    },
    {
      key: "actions", label: "", className: "w-40",
      render: (t: Tool) => (
        <div className="flex items-center gap-1">
          <button onClick={(e) => { e.stopPropagation(); setAction({ tool: t, mode: "ENTREGAR" }); }} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded text-xs" title="Entregar">📤</button>
          <button onClick={(e) => { e.stopPropagation(); setAction({ tool: t, mode: "DEVOLVER" }); }} className="p-1.5 text-green-600 hover:bg-green-50 rounded text-xs" title="Devolver">📥</button>
          {canEdit && <button onClick={(e) => { e.stopPropagation(); setEditTool(t); setShowForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded" title="Editar"><EditIcon /></button>}
          {canDelete && <button onClick={(e) => { e.stopPropagation(); setDeleteTool(t); }} className="p-1.5 text-danger hover:bg-red-50 rounded" title="Excluir"><TrashIcon /></button>}
        </div>
      ),
    },
  ];

  const filtered = tools.filter((t) =>
    t.name.toLowerCase().includes(search.toLowerCase()) ||
    (codeMap.get(t.id) || "").toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <>
      {assetType === "MAQUINARIO" && (
        <div className="mb-4">
          <MachineMinAlert available={availableCount} canEdit={canEdit} />
        </div>
      )}
      <DataTable columns={columns} data={filtered} loading={loading}
        keyExtractor={(t) => t.id} searchValue={search} onSearchChange={setSearch}
        mobileCards
        onRowClick={canEdit ? (t) => { setEditTool(t); setShowForm(true); } : undefined}
        searchPlaceholder={`Buscar ${singular.toLowerCase()}...`}
        actions={canCreate ? <Button size="sm" onClick={() => { setEditTool(null); setShowForm(true); }}><PlusIcon className="w-4 h-4" />Adicionar</Button> : undefined}
      />

      <ToolFormModal open={showForm} onClose={() => { setShowForm(false); setEditTool(null); }} onSave={saveTool} item={editTool} singular={singular} defaultType={assetType} saving={saving} />

      <ConfirmDialog open={!!deleteTool} onClose={() => setDeleteTool(null)}
        onConfirm={async () => { setSaving(true); await db.from("tools").delete().eq("id", deleteTool!.id); setSaving(false); setDeleteTool(null); loadAll(); }}
        title={`Excluir ${singular}`} message={`Excluir "${deleteTool?.name}"?`} loading={saving} />

      <TeamActionModal open={!!action} mode={action?.mode || "ENTREGAR"} toolName={action?.tool.name || ""}
        onClose={() => setAction(null)} onConfirm={handleAction} saving={saving} />
    </>
  );
}

function ToolFormModal({ open, onClose, onSave, item, singular, defaultType, saving }: {
  open: boolean; onClose: () => void; onSave: (d: Partial<Tool>) => void; item: Tool | null; singular: string; defaultType: AssetType; saving: boolean;
}) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<ToolStatus>("DISPONIVEL");
  const [type, setType] = useState<AssetType>(defaultType);

  useEffect(() => {
    if (item) { setName(item.name); setNotes(item.notes || ""); setStatus(item.status); setType(item.asset_type); }
    else { setName(""); setNotes(""); setStatus("DISPONIVEL"); setType(defaultType); }
  }, [item, open, defaultType]);

  return (
    <Modal open={open} onClose={onClose} title={item ? `Editar ${singular}` : `Novo ${singular}`}>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name, notes: notes || null, status, asset_type: type }); }} className="space-y-4">
        <div><label className="block text-sm font-medium mb-1">Nome *</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        <div>
          <label className="block text-sm font-medium mb-1">Tipo</label>
          <select value={type} onChange={(e) => setType(e.target.value as AssetType)} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none">
            {Object.entries(ASSET_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <p className="text-[10px] text-text-light mt-1">Mudar o tipo move o item para a aba correspondente (Maquinário / Ferramenta / Elétrica).</p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value as ToolStatus)} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none">
            {Object.entries(TOOL_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div><label className="block text-sm font-medium mb-1">Observações</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none" /></div>
        <div className="flex gap-3 justify-end pt-2"><Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button></div>
      </form>
    </Modal>
  );
}

// Modal de Entregar/Devolver. Na entrega, escolhe a equipe (não há colaborador).
function TeamActionModal({ open, mode, toolName, onClose, onConfirm, saving }: {
  open: boolean; mode: "ENTREGAR" | "DEVOLVER"; toolName: string;
  onClose: () => void; onConfirm: (team: Team | null, notes: string) => void; saving: boolean;
}) {
  const [team, setTeam] = useState<Team>("EQUIPE_1");
  const [notes, setNotes] = useState("");
  const isEntrega = mode === "ENTREGAR";

  useEffect(() => { setTeam("EQUIPE_1"); setNotes(""); }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={`${isEntrega ? "Entregar" : "Devolver"}: ${toolName}`}>
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(isEntrega ? team : null, notes); }} className="space-y-4">
        {isEntrega && (
          <div>
            <label className="block text-sm font-medium mb-1">Equipe *</label>
            <select value={team} onChange={(e) => setTeam(e.target.value as Team)} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none">
              {TEAMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        )}
        <div><label className="block text-sm font-medium mb-1">Observações</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Opcional..." className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none" /></div>
        <div className="flex gap-3 justify-end pt-2"><Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={saving}>{saving ? "Registrando..." : "Confirmar"}</Button></div>
      </form>
    </Modal>
  );
}

// Aviso de mínimo de máquinas disponíveis. Lê/grava o número em app_settings
// via /api/almoxarifado/maquinario-min. Fica vermelho quando as disponíveis
// (status DISPONIVEL) caem abaixo do mínimo configurado.
function MachineMinAlert({ available, canEdit }: { available: number; canEdit: boolean }) {
  const [min, setMin] = useState(0);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/almoxarifado/maquinario-min")
      .then((r) => r.json())
      .then((b) => { if (alive) setMin(Number(b.min) || 0); })
      .catch(() => {})
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  async function save() {
    const v = Math.max(0, Math.floor(Number(draft) || 0));
    setSaving(true);
    try {
      const res = await fetch("/api/almoxarifado/maquinario-min", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ min: v }),
      });
      const b = await res.json();
      if (res.ok) { setMin(Number(b.min) || 0); setEditing(false); }
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) return null;
  const below = min > 0 && available < min;

  return (
    <div className={`rounded-xl border p-3 flex items-center justify-between gap-3 flex-wrap ${below ? "bg-red-50 border-red-200" : "bg-card border-border"}`}>
      <div className="text-sm">
        {below ? (
          <span className="text-red-700 font-medium">
            ⚠️ Só {available} {available === 1 ? "máquina disponível" : "máquinas disponíveis"} — mínimo {min}.
          </span>
        ) : min > 0 ? (
          <span className="text-text-light">
            <strong className="text-text">{available}</strong> {available === 1 ? "disponível" : "disponíveis"} · mínimo {min} ✅
          </span>
        ) : (
          <span className="text-text-light">
            <strong className="text-text">{available}</strong> {available === 1 ? "disponível" : "disponíveis"} · sem mínimo definido
          </span>
        )}
      </div>
      {canEdit && (
        editing ? (
          <div className="flex items-center gap-2">
            <input
              type="number" min={0} value={draft} autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
              className="w-20 px-2 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
            />
            <Button size="sm" onClick={save} disabled={saving}>{saving ? "..." : "Salvar"}</Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={saving}>Cancelar</Button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => { setDraft(min ? String(min) : ""); setEditing(true); }}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-border bg-white hover:bg-gray-100 transition shrink-0"
          >
            {min > 0 ? "Editar mínimo" : "Definir mínimo"}
          </button>
        )
      )}
    </div>
  );
}
