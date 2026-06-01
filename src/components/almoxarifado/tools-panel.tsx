"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { TOOL_STATUS_LABELS, MOVEMENT_TYPE_LABELS } from "@/lib/utils";
import type { Tool, ToolStatus, AssetType, ToolMovementType } from "@/types/database";

// Painel de Ferramentas ou Maquinário (tabela `tools` filtrada por asset_type).
// Corpo da antiga página /equipamentos, parametrizado pra servir as duas abas
// do Almoxarifado. O histórico de movimentações fica no painel Histórico.
export function ToolsPanel({ assetType }: { assetType: AssetType }) {
  const { profile } = useAuth();
  const pathname = usePathname();
  const role = profile?.role || "RH";
  const moduleName = assetType === "FERRAMENTA" ? "FERRAMENTAS" : "MAQUINARIO";
  const singular = assetType === "FERRAMENTA" ? "Ferramenta" : "Maquinário";

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
  const [actionTool, setActionTool] = useState<{ tool: Tool; action: ToolMovementType } | null>(null);

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
    const payload = { ...data, asset_type: assetType, updated_by: actor } as Record<string, unknown>;
    if (editTool) {
      await db.from("tools").update(payload).eq("id", editTool.id);
    } else {
      await db.from("tools").insert(payload);
    }
    setSaving(false); setShowForm(false); setEditTool(null); loadAll();
  }

  async function handleAction(notes: string) {
    if (!actionTool) return;
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const { tool, action } = actionTool;

    let newStatus: ToolStatus = tool.status;
    if (action === "EQUIPE_1") newStatus = "EQUIPE_1";
    else if (action === "EQUIPE_2") newStatus = "EQUIPE_2";
    else if (action === "DEVOLUCAO") newStatus = "DISPONIVEL";
    else if (action === "MANUTENCAO") newStatus = "MANUTENCAO";

    await db.from("tool_movements").insert({
      tool_id: tool.id, employee_name: actor, movement_type: action,
      movement_date: new Date().toISOString().split("T")[0], notes, created_by: actor,
    } as Record<string, unknown>);
    const toolUpdate: Record<string, unknown> = { status: newStatus, updated_by: actor };
    if (notes) toolUpdate.notes = notes;
    await db.from("tools").update(toolUpdate).eq("id", tool.id);

    setSaving(false); setActionTool(null); loadAll();
  }

  const columns = [
    { key: "name", label: "Nome", render: (t: Tool) => <span className="font-medium">{t.name}</span> },
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
    { key: "location", label: "Local", hideOnMobile: true, render: (t: Tool) => t.location || "—" },
    {
      key: "notes", label: "Obs", hideOnMobile: true,
      render: (t: Tool) => t.notes ? (
        <span className="text-xs text-text-light max-w-[200px] truncate block" title={t.notes}>{t.notes}</span>
      ) : <span className="text-text-light">—</span>,
    },
    {
      key: "actions", label: "",
      render: (t: Tool) => (
        <div className="flex items-center gap-1">
          {t.status === "DISPONIVEL" && (
            <>
              <button onClick={(e) => { e.stopPropagation(); setActionTool({ tool: t, action: "EQUIPE_1" }); }} className="px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded hover:bg-blue-100 whitespace-nowrap">E1</button>
              <button onClick={(e) => { e.stopPropagation(); setActionTool({ tool: t, action: "EQUIPE_2" }); }} className="px-2 py-1 text-xs bg-purple-50 text-purple-700 rounded hover:bg-purple-100 whitespace-nowrap">E2</button>
              <button onClick={(e) => { e.stopPropagation(); setActionTool({ tool: t, action: "MANUTENCAO" }); }} className="px-2 py-1 text-xs bg-amber-50 text-amber-700 rounded hover:bg-amber-100 whitespace-nowrap">Man</button>
            </>
          )}
          {(t.status === "EQUIPE_1" || t.status === "EQUIPE_2") && (
            <>
              <button onClick={(e) => { e.stopPropagation(); setActionTool({ tool: t, action: "DEVOLUCAO" }); }} className="px-2 py-1 text-xs bg-green-50 text-green-700 rounded hover:bg-green-100 whitespace-nowrap">Dev</button>
              <button onClick={(e) => { e.stopPropagation(); setActionTool({ tool: t, action: "MANUTENCAO" }); }} className="px-2 py-1 text-xs bg-amber-50 text-amber-700 rounded hover:bg-amber-100 whitespace-nowrap">Man</button>
            </>
          )}
          {t.status === "MANUTENCAO" && (
            <button onClick={(e) => { e.stopPropagation(); setActionTool({ tool: t, action: "DEVOLUCAO" }); }} className="px-2 py-1 text-xs bg-green-50 text-green-700 rounded hover:bg-green-100 whitespace-nowrap">Disponível</button>
          )}
          {canEdit && <button onClick={(e) => { e.stopPropagation(); setEditTool(t); setShowForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded"><EditIcon /></button>}
          {canDelete && <button onClick={(e) => { e.stopPropagation(); setDeleteTool(t); }} className="p-1.5 text-danger hover:bg-red-50 rounded"><TrashIcon /></button>}
        </div>
      ),
    },
  ];

  const filtered = tools.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      <DataTable columns={columns} data={filtered} loading={loading}
        keyExtractor={(t) => t.id} searchValue={search} onSearchChange={setSearch}
        mobileCards
        onRowClick={canEdit ? (t) => { setEditTool(t); setShowForm(true); } : undefined}
        searchPlaceholder={`Buscar ${singular.toLowerCase()}...`}
        actions={canCreate ? <Button size="sm" onClick={() => { setEditTool(null); setShowForm(true); }}><PlusIcon className="w-4 h-4" />Adicionar</Button> : undefined}
      />

      <ToolFormModal open={showForm} onClose={() => { setShowForm(false); setEditTool(null); }} onSave={saveTool} item={editTool} singular={singular} saving={saving} />

      <ConfirmDialog open={!!deleteTool} onClose={() => setDeleteTool(null)}
        onConfirm={async () => { setSaving(true); await db.from("tools").delete().eq("id", deleteTool!.id); setSaving(false); setDeleteTool(null); loadAll(); }}
        title={`Excluir ${singular}`} message={`Excluir "${deleteTool?.name}"?`} loading={saving} />

      <ActionModal open={!!actionTool} onClose={() => setActionTool(null)} onConfirm={(notes) => handleAction(notes)}
        title={actionTool ? `${MOVEMENT_TYPE_LABELS[actionTool.action]}: ${actionTool.tool.name}` : ""} saving={saving} />
    </>
  );
}

function ToolFormModal({ open, onClose, onSave, item, singular, saving }: {
  open: boolean; onClose: () => void; onSave: (d: Partial<Tool>) => void; item: Tool | null; singular: string; saving: boolean;
}) {
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<ToolStatus>("DISPONIVEL");

  useEffect(() => {
    if (item) { setName(item.name); setLocation(item.location || ""); setNotes(item.notes || ""); setStatus(item.status); }
    else { setName(""); setLocation(""); setNotes(""); setStatus("DISPONIVEL"); }
  }, [item, open]);

  return (
    <Modal open={open} onClose={onClose} title={item ? `Editar ${singular}` : `Novo ${singular}`}>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name, location: location || null, notes: notes || null, status }); }} className="space-y-4">
        <div><label className="block text-sm font-medium mb-1">Nome *</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        <div>
          <label className="block text-sm font-medium mb-1">Status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value as ToolStatus)} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none">
            {Object.entries(TOOL_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div><label className="block text-sm font-medium mb-1">Local</label><input type="text" value={location} onChange={(e) => setLocation(e.target.value)} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        <div><label className="block text-sm font-medium mb-1">Observações</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none" /></div>
        <div className="flex gap-3 justify-end pt-2"><Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button></div>
      </form>
    </Modal>
  );
}

function ActionModal({ open, onClose, onConfirm, title, saving }: {
  open: boolean; onClose: () => void; onConfirm: (notes: string) => void; title: string; saving: boolean;
}) {
  const [notes, setNotes] = useState("");

  useEffect(() => { setNotes(""); }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(notes); }} className="space-y-4">
        <div><label className="block text-sm font-medium mb-1">Observações</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Opcional..." className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none" /></div>
        <div className="flex gap-3 justify-end pt-2"><Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={saving}>{saving ? "Registrando..." : "Confirmar"}</Button></div>
      </form>
    </Modal>
  );
}
