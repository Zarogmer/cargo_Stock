"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase-browser";
import { hasPermission } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs } from "@/components/ui/tabs";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { formatDateTime } from "@/lib/utils";

interface ToolRequest {
  id: string;
  tool_name: string;
  quantity: number;
  reason: string;
  status: "PENDENTE" | "APROVADO" | "RECUSADO" | "COMPRADO";
  requested_by: string;
  responded_by: string | null;
  response_notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ProductLink {
  id: string;
  name: string;
  url: string;
  category: string;
  description: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const PRODUCT_CATEGORIES = [
  "Ferramentas",
  "Maquinário",
  "EPIs",
  "Suprimentos",
  "Material Elétrico",
  "Material Hidráulico",
  "Pintura",
  "Limpeza",
  "Outros",
];

export default function SolicitacoesPage() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const supabase = createClient();
  const role = profile?.role || "RH";

  const [requests, setRequests] = useState<ToolRequest[]>([]);
  const [productLinks, setProductLinks] = useState<ProductLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [showRequestForm, setShowRequestForm] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [editLink, setEditLink] = useState<ProductLink | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<ToolRequest | null>(null);
  const [deleteLink, setDeleteLink] = useState<ProductLink | null>(null);

  const canApproveRequests = ["GESTOR", "EXECUTIVO", "TECNOLOGIA"].includes(role);
  const canManageLinks = ["GESTOR", "EXECUTIVO", "TECNOLOGIA"].includes(role);
  const canDeleteRequests = hasPermission(role, "SOLICITACOES", "delete");

  const [dbError, setDbError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      const [reqRes, linksRes] = await Promise.all([
        supabase.from("tool_requests").select("*").order("created_at", { ascending: false }),
        supabase.from("product_links").select("*").order("category").order("name"),
      ]);

      const errors: string[] = [];
      if (reqRes.error) errors.push(`tool_requests: ${reqRes.error.code} ${reqRes.error.message}`);
      if (linksRes.error && linksRes.error.code !== "42P01") errors.push(`product_links: ${linksRes.error.code} ${linksRes.error.message}`);
      if (errors.length > 0) {
        console.error("DB errors:", errors);
        setDbError(errors.join(" | "));
      }

      setRequests((reqRes.data as ToolRequest[]) || []);
      setProductLinks((linksRes.data as ProductLink[]) || []);
    } catch (err) {
      console.error("loadAll error:", err);
      setDbError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll, pathname]);

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

  async function handleMarkPurchased(reqId: string) {
    await supabase.from("tool_requests").update({
      status: "COMPRADO",
      responded_by: profile?.full_name || "Sistema",
      updated_at: new Date().toISOString(),
    } as any).eq("id", reqId);
    loadAll();
  }

  async function handleDeleteRequest() {
    if (!deleteRequest) return;
    setSaving(true);
    await supabase.from("tool_requests").delete().eq("id", deleteRequest.id);
    setSaving(false);
    setDeleteRequest(null);
    loadAll();
  }

  async function handleSaveLink(data: { name: string; url: string; category: string; description: string }) {
    setSaving(true);
    const payload = {
      ...data,
      description: data.description || null,
      updated_by: profile?.full_name || "Sistema",
    } as any;
    if (editLink) {
      await supabase.from("product_links").update({ ...payload, updated_at: new Date().toISOString() }).eq("id", editLink.id);
    } else {
      await supabase.from("product_links").insert({ ...payload, created_by: profile?.full_name || "Sistema" });
    }
    setSaving(false);
    setShowLinkForm(false);
    setEditLink(null);
    loadAll();
  }

  async function handleDeleteLink() {
    if (!deleteLink) return;
    setSaving(true);
    await supabase.from("product_links").delete().eq("id", deleteLink.id);
    setSaving(false);
    setDeleteLink(null);
    loadAll();
  }

  const pendingCount = requests.filter((r) => r.status === "PENDENTE").length;

  // Group product links by category
  const linksByCategory = productLinks.reduce<Record<string, ProductLink[]>>((acc, link) => {
    if (!acc[link.category]) acc[link.category] = [];
    acc[link.category].push(link);
    return acc;
  }, {});

  const tabs = [
    {
      key: "solicitacoes",
      label: `Solicitações${pendingCount > 0 ? ` (${pendingCount})` : ""}`,
      content: (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-text-light">Solicitações de compra de equipamentos e materiais</p>
            <Button size="sm" onClick={() => setShowRequestForm(true)}>
              <PlusIcon className="w-4 h-4" />Nova Solicitação
            </Button>
          </div>
          {requests.length === 0 ? (
            <div className="text-center py-12 text-text-light">
              <span className="text-4xl block mb-3">📋</span>
              <p className="font-medium">Nenhuma solicitação encontrada</p>
              <p className="text-xs mt-1">Clique em &quot;Nova Solicitação&quot; para criar uma</p>
            </div>
          ) : (
            <div className="space-y-3">
              {requests.map((req) => {
                const statusConfig: Record<string, { color: string; label: string }> = {
                  PENDENTE: { color: "bg-amber-100 text-amber-700", label: "Pendente" },
                  APROVADO: { color: "bg-green-100 text-green-700", label: "Aprovado" },
                  RECUSADO: { color: "bg-red-100 text-red-700", label: "Recusado" },
                  COMPRADO: { color: "bg-blue-100 text-blue-700", label: "Comprado" },
                };
                const cfg = statusConfig[req.status] || statusConfig.PENDENTE;
                return (
                  <div key={req.id} className="bg-card border border-border rounded-xl p-4 hover:shadow-sm transition">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-text">{req.tool_name}</span>
                          <span className="text-xs text-text-light bg-gray-100 px-2 py-0.5 rounded-full">x{req.quantity}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.color}`}>
                            {cfg.label}
                          </span>
                        </div>
                        <p className="text-sm text-text-light mt-1.5">{req.reason}</p>
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
                      <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                        {canApproveRequests && req.status === "PENDENTE" && (
                          <>
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
                          </>
                        )}
                        {canApproveRequests && req.status === "APROVADO" && (
                          <button
                            onClick={() => handleMarkPurchased(req.id)}
                            className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 font-medium transition"
                          >
                            Marcar Comprado
                          </button>
                        )}
                        {canDeleteRequests && (
                          <button
                            onClick={() => setDeleteRequest(req)}
                            className="p-1.5 text-danger hover:bg-red-50 rounded-lg transition"
                            title="Excluir solicitação"
                          >
                            <TrashIcon />
                          </button>
                        )}
                      </div>
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
      key: "catalogo",
      label: "Catálogo de Produtos",
      content: (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <div>
              <p className="text-sm text-text-light">Links de produtos frequentemente comprados, organizados por categoria</p>
            </div>
            {canManageLinks && (
              <Button size="sm" onClick={() => { setEditLink(null); setShowLinkForm(true); }}>
                <PlusIcon className="w-4 h-4" />Adicionar Produto
              </Button>
            )}
          </div>

          {productLinks.length === 0 ? (
            <div className="text-center py-12 text-text-light">
              <span className="text-4xl block mb-3">🛒</span>
              <p className="font-medium">Nenhum produto no catálogo</p>
              <p className="text-xs mt-1">Adicione links de produtos para facilitar as compras</p>
            </div>
          ) : (
            <div className="space-y-6">
              {Object.entries(linksByCategory).map(([category, links]) => (
                <div key={category}>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-lg">{getCategoryIcon(category)}</span>
                    <h3 className="font-semibold text-text">{category}</h3>
                    <span className="text-xs text-text-light bg-gray-100 px-2 py-0.5 rounded-full">{links.length}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {links.map((link) => (
                      <div key={link.id} className="bg-card border border-border rounded-xl p-4 hover:shadow-md hover:border-primary/30 transition-all group">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <a
                              href={link.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-medium text-primary hover:text-primary-dark hover:underline block truncate"
                              title={link.name}
                            >
                              {link.name}
                            </a>
                            {link.description && (
                              <p className="text-xs text-text-light mt-1 line-clamp-2">{link.description}</p>
                            )}
                            <p className="text-[10px] text-text-light mt-2">
                              Adicionado por {link.created_by}
                            </p>
                          </div>
                          {canManageLinks && (
                            <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition shrink-0">
                              <button
                                onClick={() => { setEditLink(link); setShowLinkForm(true); }}
                                className="p-1.5 text-primary hover:bg-blue-50 rounded"
                                title="Editar"
                              >
                                <EditIcon />
                              </button>
                              <button
                                onClick={() => setDeleteLink(link)}
                                className="p-1.5 text-danger hover:bg-red-50 rounded"
                                title="Excluir"
                              >
                                <TrashIcon />
                              </button>
                            </div>
                          )}
                        </div>
                        <div className="mt-3 pt-3 border-t border-border">
                          <a
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-xs text-primary hover:text-primary-dark font-medium transition"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                            Abrir link
                          </a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-text">Solicitações</h1>

      {dbError && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 font-mono break-all">
          Erro ao carregar dados: {dbError}
        </div>
      )}

      <Tabs tabs={tabs} />

      {/* Request Form Modal */}
      <RequestFormModal open={showRequestForm} onClose={() => setShowRequestForm(false)} onSave={handleCreateRequest} saving={saving} />

      {/* Product Link Form Modal */}
      <LinkFormModal open={showLinkForm} onClose={() => { setShowLinkForm(false); setEditLink(null); }} onSave={handleSaveLink} item={editLink} saving={saving} />

      {/* Delete Request Confirm */}
      <ConfirmDialog
        open={!!deleteRequest}
        onClose={() => setDeleteRequest(null)}
        onConfirm={handleDeleteRequest}
        title="Excluir Solicitação"
        message={`Excluir a solicitação "${deleteRequest?.tool_name}"?`}
        loading={saving}
      />

      {/* Delete Link Confirm */}
      <ConfirmDialog
        open={!!deleteLink}
        onClose={() => setDeleteLink(null)}
        onConfirm={handleDeleteLink}
        title="Excluir Produto"
        message={`Excluir "${deleteLink?.name}" do catálogo?`}
        loading={saving}
      />
    </div>
  );
}

function getCategoryIcon(category: string): string {
  const icons: Record<string, string> = {
    "Ferramentas": "🔧",
    "Maquinário": "⚙️",
    "EPIs": "⛑️",
    "Suprimentos": "📦",
    "Material Elétrico": "⚡",
    "Material Hidráulico": "🔩",
    "Pintura": "🎨",
    "Limpeza": "🧹",
    "Outros": "📋",
  };
  return icons[category] || "📦";
}

function RequestFormModal({ open, onClose, onSave, saving }: {
  open: boolean; onClose: () => void; onSave: (toolName: string, qty: number, reason: string) => void; saving: boolean;
}) {
  const [toolName, setToolName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState("");

  useEffect(() => { setToolName(""); setQuantity(1); setReason(""); }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Nova Solicitação">
      <form onSubmit={(e) => { e.preventDefault(); onSave(toolName, quantity, reason); }} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Produto / Equipamento *</label>
          <input type="text" value={toolName} onChange={(e) => setToolName(e.target.value)} required
            placeholder="Ex: Furadeira, Chave inglesa, Luvas..."
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

function LinkFormModal({ open, onClose, onSave, item, saving }: {
  open: boolean; onClose: () => void;
  onSave: (data: { name: string; url: string; category: string; description: string }) => void;
  item: ProductLink | null; saving: boolean;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("Ferramentas");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (item) {
      setName(item.name);
      setUrl(item.url);
      setCategory(item.category);
      setDescription(item.description || "");
    } else {
      setName(""); setUrl(""); setCategory("Ferramentas"); setDescription("");
    }
  }, [item, open]);

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Produto" : "Adicionar Produto ao Catálogo"}>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name, url, category, description }); }} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Nome do Produto *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
            placeholder="Ex: Luva de procedimento P"
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Link / URL *</label>
          <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} required
            placeholder="https://www.mercadolivre.com.br/..."
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Categoria *</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none">
            {PRODUCT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Descrição (opcional)</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
            placeholder="Observações sobre o produto, tamanho, cor..."
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none" />
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}
