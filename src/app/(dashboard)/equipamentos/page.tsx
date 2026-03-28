"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase-browser";
import { hasPermission } from "@/lib/rbac";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs } from "@/components/ui/tabs";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { formatDateTime, matchSearch, TOOL_STATUS_LABELS, MOVEMENT_TYPE_LABELS } from "@/lib/utils";
import type { Tool, ToolStatus, AssetType, ToolMovementType } from "@/types/database";

interface ToolRequest {
  id: string;
  tool_name: string;
  quantity: number;
  reason: string;
  status: "PENDENTE" | "APROVADO" | "RECUSADO";
  requested_by: string;
  responded_by: string | null;
  response_notes: string | null;
  created_at: string;
  updated_at: string;
}

export default function EquipamentosPage() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const supabase = createClient();
  const role = profile?.role || "RH";

  const [tools, setTools] = useState<Tool[]>([]);
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);
  const [requests, setRequests] = useState<ToolRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editTool, setEditTool] = useState<Tool | null>(null);
  const [formAssetType, setFormAssetType] = useState<AssetType>("FERRAMENTA");
  const [deleteTool, setDeleteTool] = useState<Tool | null>(null);
  const [actionTool, setActionTool] = useState<{ tool: Tool; action: ToolMovementType } | null>(null);
  const [showRequestForm, setShowRequestForm] = useState(false);

  const canCreate = hasPermission(role, "FERRAMENTAS", "create");
  const canEdit = hasPermission(role, "FERRAMENTAS", "edit");
  const canDelete = hasPermission(role, "FERRAMENTAS", "delete");
  const canApproveRequests = ["GESTOR", "EXECUTIVO", "TECNOLOGIA"].includes(role);

  const [dbError, setDbError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      const [toolsRes, movRes, reqRes] = await Promise.all([
        supabase.from("tools").select("*").order("name"),
        supabase.from("tool_movements").select("*, tools(name, asset_type)").order("created_at", { ascending: false }).limit(50),
        supabase.from("tool_requests").select("*").order("created_at", { ascending: false }),
      ]);

      const errors: string[] = [];
      if (toolsRes.error) errors.push(`tools: ${toolsRes.error.code} ${toolsRes.error.message}`);
      if (movRes.error) errors.push(`tool_movements: ${movRes.error.code} ${movRes.error.message}`);
      if (reqRes.error) errors.push(`tool_requests: ${reqRes.error.code} ${reqRes.error.message}`);
      if (errors.length > 0) {
        console.error("DB errors:", errors);
        setDbError(errors.join(" | "));
      }

      setTools(toolsRes.data || []);
      setRequests((reqRes.data as ToolRequest[]) || []);

      const hist = (movRes.data || []).map((m: Record<string, unknown>) => {
        const tool = m.tools as Record<string, unknown> | null;
        return { ...m, tool_name: tool?.name || "—", asset_type: tool?.asset_type || "—" };
      });
      setHistory(hist);
    } catch (err) {
      console.error("loadAll error:", err);
      setDbError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll, pathname]);

  async function saveTool(data: Partial<Tool>) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const payload = { ...data, updated_by: actor } as any;
    if (editTool) {
      await supabase.from("tools").update(payload).eq("id", editTool.id);
    } else {
      await supabase.from("tools").insert(payload);
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

    await supabase.from("tool_movements").insert({
      tool_id: tool.id, employee_name: actor, movement_type: action,
      movement_date: new Date().toISOString().split("T")[0], notes, created_by: actor,
    } as any);
    await supabase.from("tools").update({ status: newStatus, updated_by: actor } as any).eq("id", tool.id);

    setSaving(false); setActionTool(null); loadAll();
  }

  function getColumns(assetType: AssetType) {
    return [
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
            {canEdit && <button onClick={(e) => { e.stopPropagation(); setEditTool(t); setFormAssetType(t.asset_type); setShowForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded"><EditIcon /></button>}
            {canDelete && <button onClick={(e) => { e.stopPropagation(); setDeleteTool(t); }} className="p-1.5 text-danger hover:bg-red-50 rounded"><TrashIcon /></button>}
          </div>
        ),
      },
    ];
  }

  const ferramentas = tools.filter((t) => t.asset_type === "FERRAMENTA").filter((t) => matchSearch(t.name, search));
  const maquinarios = tools.filter((t) => t.asset_type === "MAQUINARIO").filter((t) => matchSearch(t.name, search));

  async function handleCreateRequest(toolName: string, quantity: number, reason: string) {
    setSaving(true);
    await supabase.from("tool_requests").insert({
      tool_name: toolName,
      quantity,
      reason,
      status: "PENDENTE",
      requested_by: profile?.full_name || "Sistema",
    } as any);
    setSaving(false);
    setShowRequestForm(false);
    loadAll();
  }

  async function handleRespondRequest(reqId: string, status: "APROVADO" | "RECUSADO", notes: string) {
    await supabase.from("tool_requests").update({
      status,
      responded_by: profile?.full_name || "Sistema",
      response_notes: notes || null,
      updated_at: new Date().toISOString(),
    } as any).eq("id", reqId);
    loadAll();
  }

  const pendingCount = requests.filter((r) => r.status === "PENDENTE").length;

  const tabs = [
    {
      key: "ferramentas", label: "Ferramentas",
      content: (
        <DataTable columns={getColumns("FERRAMENTA")} data={ferramentas} loading={loading}
          keyExtractor={(t) => t.id} searchValue={search} onSearchChange={setSearch}
          searchPlaceholder="Buscar ferramenta..."
          actions={canCreate ? <Button size="sm" onClick={() => { setEditTool(null); setFormAssetType("FERRAMENTA"); setShowForm(true); }}><PlusIcon className="w-4 h-4" />Adicionar</Button> : undefined}
        />
      ),
    },
    {
      key: "maquinario", label: "Maquinário",
      content: (
        <DataTable columns={getColumns("MAQUINARIO")} data={maquinarios} loading={loading}
          keyExtractor={(t) => t.id} searchValue={search} onSearchChange={setSearch}
          searchPlaceholder="Buscar maquinário..."
          actions={canCreate ? <Button size="sm" onClick={() => { setEditTool(null); setFormAssetType("MAQUINARIO"); setShowForm(true); }}><PlusIcon className="w-4 h-4" />Adicionar</Button> : undefined}
        />
      ),
    },
    {
      key: "solicitacoes", label: `Solicitações${pendingCount > 0 ? ` (${pendingCount})` : ""}`,
      content: (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setShowRequestForm(true)}>
              <PlusIcon className="w-4 h-4" />Nova Solicitação
            </Button>
          </div>
          {requests.length === 0 ? (
            <div className="text-center py-12 text-text-light">
              <span className="text-3xl block mb-2">📋</span>
              Nenhuma solicitação encontrada
            </div>
          ) : (
            <div className="space-y-3">
              {requests.map((req) => {
                const statusColors: Record<string, string> = {
                  PENDENTE: "bg-amber-100 text-amber-700",
                  APROVADO: "bg-green-100 text-green-700",
                  RECUSADO: "bg-red-100 text-red-700",
                };
                return (
                  <div key={req.id} className="bg-card border border-border rounded-xl p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-text">{req.tool_name}</span>
                          <span className="text-xs text-text-light">x{req.quantity}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusColors[req.status]}`}>
                            {req.status === "PENDENTE" ? "Pendente" : req.status === "APROVADO" ? "Aprovado" : "Recusado"}
                          </span>
                        </div>
                        <p className="text-sm text-text-light mt-1">{req.reason}</p>
                        <div className="flex gap-3 mt-2 text-xs text-text-light">
                          <span>Solicitado por: <strong>{req.requested_by}</strong></span>
                          <span>{formatDateTime(req.created_at)}</span>
                        </div>
                        {req.responded_by && (
                          <p className="text-xs text-text-light mt-1">
                            Resposta de <strong>{req.responded_by}</strong>: {req.response_notes || "—"}
                          </p>
                        )}
                      </div>
                      {canApproveRequests && req.status === "PENDENTE" && (
                        <div className="flex gap-1 shrink-0">
                          <button
                            onClick={() => {
                              const notes = prompt("Observação (opcional):");
                              handleRespondRequest(req.id, "APROVADO", notes || "");
                            }}
                            className="px-3 py-1.5 text-xs bg-green-50 text-green-700 rounded-lg hover:bg-green-100 font-medium transition"
                          >
                            Aprovar
                          </button>
                          <button
                            onClick={() => {
                              const notes = prompt("Motivo da recusa:");
                              if (notes) handleRespondRequest(req.id, "RECUSADO", notes);
                            }}
                            className="px-3 py-1.5 text-xs bg-red-50 text-red-700 rounded-lg hover:bg-red-100 font-medium transition"
                          >
                            Recusar
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "historico", label: "Histórico",
      content: (
        <DataTable
          columns={[
            { key: "tool_name", label: "Equipamento", render: (h: Record<string, unknown>) => <span className="font-medium">{h.tool_name as string}</span> },
            { key: "asset_type", label: "Tipo", hideOnMobile: true, render: (h: Record<string, unknown>) => <span className="text-xs">{h.asset_type === "FERRAMENTA" ? "Ferramenta" : "Maquinário"}</span> },
            { key: "movement_type", label: "Ação", render: (h: Record<string, unknown>) => MOVEMENT_TYPE_LABELS[h.movement_type as string] || h.movement_type as string },
            { key: "employee_name", label: "Responsável", render: (h: Record<string, unknown>) => h.employee_name as string },
            { key: "created_at", label: "Data", hideOnMobile: true, render: (h: Record<string, unknown>) => <span className="text-xs text-text-light">{formatDateTime(h.created_at as string)}</span> },
          ]}
          data={history}
          loading={loading}
          keyExtractor={(h) => h.id as number}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-text">Equipamentos</h1>

      {dbError && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 font-mono break-all">
          ⚠️ Erro ao carregar dados: {dbError}
        </div>
      )}

      <Tabs tabs={tabs} />

      {/* Form Modal */}
      <ToolFormModal open={showForm} onClose={() => { setShowForm(false); setEditTool(null); }} onSave={saveTool} item={editTool} assetType={formAssetType} saving={saving} />

      {/* Delete */}
      <ConfirmDialog open={!!deleteTool} onClose={() => setDeleteTool(null)}
        onConfirm={async () => { setSaving(true); await supabase.from("tools").delete().eq("id", deleteTool!.id); setSaving(false); setDeleteTool(null); loadAll(); }}
        title="Excluir Equipamento" message={`Excluir "${deleteTool?.name}"?`} loading={saving} />

      {/* Action Modal */}
      <ActionModal open={!!actionTool} onClose={() => setActionTool(null)} onConfirm={(notes) => handleAction(notes)}
        title={actionTool ? `${MOVEMENT_TYPE_LABELS[actionTool.action]}: ${actionTool.tool.name}` : ""} saving={saving} />

      {/* Request Form Modal */}
      <RequestFormModal open={showRequestForm} onClose={() => setShowRequestForm(false)} onSave={handleCreateRequest} saving={saving} />
    </div>
  );
}

function ToolFormModal({ open, onClose, onSave, item, assetType, saving }: {
  open: boolean; onClose: () => void; onSave: (d: Partial<Tool>) => void; item: Tool | null; assetType: AssetType; saving: boolean;
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
    <Modal open={open} onClose={onClose} title={item ? "Editar Equipamento" : `Novo ${assetType === "FERRAMENTA" ? "Ferramenta" : "Maquinário"}`}>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name, location: location || null, notes: notes || null, status, asset_type: assetType }); }} className="space-y-4">
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

function RequestFormModal({ open, onClose, onSave, saving }: {
  open: boolean; onClose: () => void; onSave: (toolName: string, qty: number, reason: string) => void; saving: boolean;
}) {
  const [toolName, setToolName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState("");

  useEffect(() => { setToolName(""); setQuantity(1); setReason(""); }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Nova Solicitação de Equipamento">
      <form onSubmit={(e) => { e.preventDefault(); onSave(toolName, quantity, reason); }} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Ferramenta / Equipamento *</label>
          <input type="text" value={toolName} onChange={(e) => setToolName(e.target.value)} required
            placeholder="Ex: Furadeira, Chave inglesa..."
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Quantidade</label>
          <input type="number" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} min={1}
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Motivo / Justificativa *</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} required rows={3}
            placeholder="Para que será utilizado..."
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none" />
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Enviando..." : "Enviar Solicitação"}</Button>
        </div>
      </form>
    </Modal>
  );
}
