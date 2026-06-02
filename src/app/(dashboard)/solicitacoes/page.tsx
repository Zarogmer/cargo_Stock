"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs } from "@/components/ui/tabs";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { formatDateTime, formatCurrency, formatQty, parseDecimalBR } from "@/lib/utils";

interface ToolRequest {
  id: string;
  tool_name: string;
  quantity: number;
  reason: string;
  status: "PENDENTE" | "APROVADO" | "RECUSADO" | "COMPRADO";
  requested_by: string;
  responded_by: string | null;
  response_notes: string | null;
  image_url: string | null;
  created_at: string;
  updated_at: string;
}

interface PurchaseOrder {
  id: string;
  description: string;
  department: string | null;
  supplier: string | null;
  purchase_date: string | null;
  unit_value: number;
  quantity: number;
  total_value: number;
  payment_method: string | null;
  notes: string | null;
  image_url: string | null;
  request_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface Supplier {
  id: number;
  name: string;
  contact: string | null;
  address: string | null;
  category: string | null;
  website: string | null;
  notes: string | null;
  created_by: string;
  updated_at: string;
  updated_by: string;
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

// Departamentos da planilha oficial de compras (coluna "SELECIONE DEPTO.").
const PURCHASE_DEPARTMENTS = [
  "MANUTENÇÃO",
  "ESCRITÓRIO",
  "OPERAÇÃO",
  "RANCHO",
  "EPI",
  "OUTROS",
];

const PAYMENT_METHODS = [
  "FATURADO",
  "CARTÃO DE CRÉDITO",
  "CARTÃO DE DÉBITO",
  "PIX",
  "DINHEIRO",
  "BOLETO",
  "TRANSFERÊNCIA",
];

const DEPARTMENT_BADGE: Record<string, string> = {
  "MANUTENÇÃO": "bg-orange-100 text-orange-700",
  "ESCRITÓRIO": "bg-purple-100 text-purple-700",
  "OPERAÇÃO": "bg-blue-100 text-blue-700",
  "RANCHO": "bg-green-100 text-green-700",
  "EPI": "bg-amber-100 text-amber-700",
  "OUTROS": "bg-gray-100 text-gray-700",
};

// Comprime/redimensiona uma imagem escolhida pelo usuário para um data URL
// (base64) pequeno antes de guardar no banco — a infra é só Railway/Postgres,
// sem storage externo, então a foto vai inline. Máx. ~1024px, JPEG qualidade 0.72.
function fileToCompressedDataUrl(file: File, maxSize = 1024, quality = 0.72): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Falha ao ler o arquivo"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Arquivo de imagem inválido"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          const ratio = Math.min(maxSize / width, maxSize / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas indisponível"));
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

// Converte um valor de data do banco (ISO ou Date) para dd/mm/aaaa sem sofrer
// o deslocamento de fuso (datas @db.Date voltam como meia-noite UTC).
function formatPurchaseDate(value: string | null): string {
  if (!value) return "—";
  const iso = String(value).slice(0, 10);
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return "—";
  return `${d}/${m}/${y}`;
}

// "YYYY-MM" -> "Junho de 2026"
const MONTH_NAMES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];
function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  const idx = Number(m) - 1;
  if (idx < 0 || idx > 11) return ym;
  return `${MONTH_NAMES[idx]} de ${y}`;
}

export default function SolicitacoesPage() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") || "solicitacoes";
  const role = profile?.role || "RH";

  const [requests, setRequests] = useState<ToolRequest[]>([]);
  const [productLinks, setProductLinks] = useState<ProductLink[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchases, setPurchases] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [showRequestForm, setShowRequestForm] = useState(false);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [editLink, setEditLink] = useState<ProductLink | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<ToolRequest | null>(null);
  const [deleteLink, setDeleteLink] = useState<ProductLink | null>(null);

  // Imagem em tela cheia (lightbox)
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Controle de Compras
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [editPurchase, setEditPurchase] = useState<PurchaseOrder | null>(null);
  const [purchaseFromRequest, setPurchaseFromRequest] = useState<ToolRequest | null>(null);
  const [deletePurchase, setDeletePurchase] = useState<PurchaseOrder | null>(null);
  const now = new Date();
  const [purchaseMonth, setPurchaseMonth] = useState(
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  );

  // Fornecedores
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [editSupplier, setEditSupplier] = useState<Supplier | null>(null);
  const [deleteSupplier, setDeleteSupplier] = useState<Supplier | null>(null);
  const [supplierSearch, setSupplierSearch] = useState("");

  const canApproveRequests = ["GESTOR", "EXECUTIVO", "TECNOLOGIA"].includes(role);
  const canManageLinks = ["GESTOR", "EXECUTIVO", "TECNOLOGIA"].includes(role);
  const canDeleteRequests = hasPermission(role, "SOLICITACOES", "delete");
  const canManagePurchases = hasPermission(role, "SOLICITACOES", "create");

  const [dbError, setDbError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      const [reqRes, linksRes, suppRes, purchRes] = await Promise.all([
        db.from("tool_requests").select("*").order("created_at", { ascending: false }),
        db.from("product_links").select("*").order("category").order("name"),
        db.from("suppliers").select("*").order("name"),
        db.from("purchase_orders").select("*").order("purchase_date", { ascending: false }).order("created_at", { ascending: false }),
      ]);

      const errors: string[] = [];
      if (reqRes.error) errors.push(`tool_requests: ${reqRes.error.code} ${reqRes.error.message}`);
      if (linksRes.error) errors.push(`product_links: ${linksRes.error.code} ${linksRes.error.message}`);
      if (suppRes.error) errors.push(`suppliers: ${suppRes.error.code} ${suppRes.error.message}`);
      if (purchRes.error) errors.push(`purchase_orders: ${purchRes.error.code} ${purchRes.error.message}`);
      if (errors.length > 0) {
        console.error("DB errors:", errors);
        setDbError(errors.join(" | "));
      }

      setRequests((reqRes.data as ToolRequest[]) || []);
      setProductLinks((linksRes.data as ProductLink[]) || []);
      setSuppliers((suppRes.data as Supplier[]) || []);
      setPurchases((purchRes.data as PurchaseOrder[]) || []);
    } catch (err) {
      console.error("loadAll error:", err);
      setDbError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll, pathname]);

  async function handleCreateRequest(toolName: string, quantity: number, reason: string, imageUrl: string | null) {
    setSaving(true);
    setSaveError(null);
    try {
      const { error } = await db.from("tool_requests").insert({
        tool_name: toolName,
        quantity,
        reason,
        status: "PENDENTE",
        requested_by: profile?.full_name || "Sistema",
        image_url: imageUrl,
      } as any);
      if (error) throw error;
      setShowRequestForm(false);
      loadAll();
    } catch (err: any) {
      console.error("Erro ao criar solicitação:", err);
      setSaveError(`Erro ao criar solicitação: ${err?.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleRespondRequest(reqId: string, status: "APROVADO" | "RECUSADO", notes: string) {
    try {
      const { error } = await db.from("tool_requests").update({
        status,
        responded_by: profile?.full_name || "Sistema",
        response_notes: notes || null,
        updated_at: new Date().toISOString(),
      } as any).eq("id", reqId);
      if (error) throw error;
      loadAll();
    } catch (err) {
      console.error("Erro ao responder solicitação:", err);
      setSaveError(`Erro ao responder solicitação: ${(err as any)?.message || String(err)}`);
    }
  }

  // Abre o formulário de compra já preenchido a partir de uma solicitação aprovada.
  function openPurchaseFromRequest(req: ToolRequest) {
    setEditPurchase(null);
    setPurchaseFromRequest(req);
    setShowPurchaseForm(true);
  }

  async function handleSavePurchase(data: Partial<PurchaseOrder>, fromRequestId: string | null) {
    setSaving(true);
    setSaveError(null);
    try {
      const actor = profile?.full_name || "Sistema";
      if (editPurchase) {
        const { error } = await db.from("purchase_orders").update(data as any).eq("id", editPurchase.id);
        if (error) throw error;
      } else {
        const { error } = await db.from("purchase_orders").insert({
          ...data,
          request_id: fromRequestId,
          created_by: actor,
        } as any);
        if (error) throw error;
        // Compra originada de uma solicitação aprovada -> marca como Comprada.
        if (fromRequestId) {
          await db.from("tool_requests").update({
            status: "COMPRADO",
            responded_by: actor,
          } as any).eq("id", fromRequestId);
        }
      }
      setShowPurchaseForm(false);
      setEditPurchase(null);
      setPurchaseFromRequest(null);
      loadAll();
    } catch (err: any) {
      console.error("Erro ao salvar compra:", err);
      setSaveError(`Erro ao salvar compra: ${err?.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeletePurchase() {
    if (!deletePurchase) return;
    setSaving(true);
    try {
      const { error } = await db.from("purchase_orders").delete().eq("id", deletePurchase.id);
      if (error) throw error;
      setDeletePurchase(null);
      loadAll();
    } catch (err: any) {
      console.error("Erro ao excluir compra:", err);
      setSaveError(`Erro ao excluir compra: ${err?.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRequest() {
    if (!deleteRequest) return;
    setSaving(true);
    try {
      const { error } = await db.from("tool_requests").delete().eq("id", deleteRequest.id);
      if (error) throw error;
      setDeleteRequest(null);
      loadAll();
    } catch (err) {
      console.error("Erro ao excluir solicitação:", err);
      setSaveError(`Erro ao excluir solicitação: ${(err as any)?.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveLink(data: { name: string; url: string; category: string; description: string }) {
    setSaving(true);
    setSaveError(null);
    try {
      const payload = {
        name: data.name,
        url: data.url,
        category: data.category,
        description: data.description || null,
      };

      if (editLink) {
        const { error } = await db.from("product_links").update({ ...payload, updated_at: new Date().toISOString() }).eq("id", editLink.id);
        if (error) throw error;
      } else {
        const { error } = await db.from("product_links").insert({ ...payload, created_by: profile?.full_name || "Sistema" });
        if (error) throw error;
      }

      setSaveError(null);
      setShowLinkForm(false);
      setEditLink(null);
      loadAll();
    } catch (err: any) {
      console.error("Erro ao salvar produto:", err);
      setSaveError(`Erro ao salvar produto: ${err?.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteLink() {
    if (!deleteLink) return;
    setSaving(true);
    try {
      const { error } = await db.from("product_links").delete().eq("id", deleteLink.id);
      if (error) throw error;
      setDeleteLink(null);
      loadAll();
    } catch (err) {
      console.error("Erro ao excluir produto:", err);
      setSaveError(`Erro ao excluir produto: ${(err as any)?.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  // --- Supplier handlers ---
  async function handleSaveSupplier(data: Partial<Supplier>) {
    setSaving(true);
    setSaveError(null);
    try {
      const actor = profile?.full_name || "Sistema";
      if (editSupplier) {
        const { error } = await db.from("suppliers").update({ ...data, updated_by: actor } as any).eq("id", editSupplier.id);
        if (error) throw error;
      } else {
        const { error } = await db.from("suppliers").insert({ ...data, created_by: actor, updated_by: actor } as any);
        if (error) throw error;
      }
      setShowSupplierForm(false);
      setEditSupplier(null);
      loadAll();
    } catch (err: any) {
      setSaveError(`Erro ao salvar fornecedor: ${err?.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteSupplier() {
    if (!deleteSupplier) return;
    setSaving(true);
    try {
      const { error } = await db.from("suppliers").delete().eq("id", deleteSupplier.id);
      if (error) throw error;
      setDeleteSupplier(null);
      loadAll();
    } catch (err: any) {
      setSaveError(`Erro ao excluir fornecedor: ${err?.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  const filteredSuppliers = suppliers.filter((s) => {
    const q = supplierSearch.toLowerCase();
    if (!q) return true;
    return (s.name?.toLowerCase().includes(q)) || (s.category?.toLowerCase().includes(q)) || (s.contact?.toLowerCase().includes(q));
  });

  const pendingCount = requests.filter((r) => r.status === "PENDENTE").length;

  // --- Controle de Compras: dados derivados ---
  const purchasesForMonth = purchases.filter(
    (p) => (p.purchase_date || "").slice(0, 7) === purchaseMonth
  );
  const monthTotal = purchasesForMonth.reduce((sum, p) => sum + (p.total_value || 0), 0);
  const monthCount = purchasesForMonth.length;
  // Solicitações aprovadas que ainda não viraram compra (aguardando registro).
  const linkedRequestIds = new Set(purchases.map((p) => p.request_id).filter(Boolean));
  const approvedAwaitingPurchase = requests.filter(
    (r) => r.status === "APROVADO" && !linkedRequestIds.has(r.id)
  );

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
                      {req.image_url && (
                        <button
                          type="button"
                          onClick={() => setLightboxImage(req.image_url)}
                          className="shrink-0 w-16 h-16 rounded-lg overflow-hidden border border-border bg-gray-50 hover:ring-2 hover:ring-primary transition"
                          title="Ver imagem"
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={req.image_url} alt={req.tool_name} className="w-full h-full object-cover" />
                        </button>
                      )}
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
                        {canManagePurchases && req.status === "APROVADO" && (
                          <button
                            onClick={() => openPurchaseFromRequest(req)}
                            className="px-3 py-1.5 text-xs bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 font-medium transition"
                          >
                            Registrar Compra
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
      key: "compras",
      label: "Controle de Compras",
      content: (
        <div className="space-y-5">
          <div className="flex flex-wrap justify-between items-center gap-3">
            <p className="text-sm text-text-light">Registro das compras realizadas, por mês — inspirado na planilha oficial de compras</p>
            {canManagePurchases && (
              <Button size="sm" onClick={() => { setEditPurchase(null); setPurchaseFromRequest(null); setShowPurchaseForm(true); }}>
                <PlusIcon className="w-4 h-4" />Nova Compra
              </Button>
            )}
          </div>

          {/* Seletor de mês + total */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-text-light">Mês:</span>
              <input
                type="month"
                value={purchaseMonth}
                onChange={(e) => setPurchaseMonth(e.target.value)}
                className="px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
              />
            </label>
            <div className="flex-1" />
            <div className="bg-primary/5 border border-primary/20 rounded-xl px-4 py-2.5 text-right">
              <p className="text-[11px] uppercase tracking-wide text-text-light">Total de {formatMonthLabel(purchaseMonth)}</p>
              <p className="text-lg font-bold text-primary">{formatCurrency(monthTotal)}</p>
              <p className="text-[11px] text-text-light">{monthCount} {monthCount === 1 ? "compra" : "compras"}</p>
            </div>
          </div>

          {/* Solicitações aprovadas aguardando registro de compra */}
          {approvedAwaitingPurchase.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
              <p className="text-sm font-semibold text-amber-800 mb-2">
                Solicitações aprovadas aguardando registro ({approvedAwaitingPurchase.length})
              </p>
              <div className="space-y-2">
                {approvedAwaitingPurchase.map((req) => (
                  <div key={req.id} className="flex items-center justify-between gap-3 bg-white rounded-lg border border-amber-100 px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {req.image_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={req.image_url} alt="" className="w-8 h-8 rounded object-cover border border-border shrink-0" />
                      )}
                      <span className="text-sm font-medium truncate">{req.tool_name}</span>
                      <span className="text-xs text-text-light shrink-0">x{req.quantity}</span>
                    </div>
                    {canManagePurchases && (
                      <button
                        onClick={() => openPurchaseFromRequest(req)}
                        className="px-3 py-1.5 text-xs bg-primary text-white rounded-lg hover:bg-primary-dark font-medium transition shrink-0"
                      >
                        Registrar compra
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Lista de compras do mês */}
          {purchasesForMonth.length === 0 ? (
            <div className="text-center py-12 text-text-light">
              <span className="text-4xl block mb-3">🧾</span>
              <p className="font-medium">Nenhuma compra em {formatMonthLabel(purchaseMonth)}</p>
              <p className="text-xs mt-1">Clique em &quot;Nova Compra&quot; para registrar</p>
            </div>
          ) : (
            <>
              {/* Tabela (desktop) */}
              <div className="hidden md:block overflow-x-auto border border-border rounded-xl">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-text-light text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-left font-medium px-3 py-2.5">Descrição</th>
                      <th className="text-left font-medium px-3 py-2.5">Depto.</th>
                      <th className="text-left font-medium px-3 py-2.5">Fornecedor</th>
                      <th className="text-left font-medium px-3 py-2.5">Data</th>
                      <th className="text-right font-medium px-3 py-2.5">Unit.</th>
                      <th className="text-right font-medium px-3 py-2.5">Qtd</th>
                      <th className="text-right font-medium px-3 py-2.5">Total</th>
                      <th className="text-left font-medium px-3 py-2.5">Pagamento</th>
                      {canManagePurchases && <th className="px-3 py-2.5"></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {purchasesForMonth.map((p) => (
                      <tr key={p.id} className="hover:bg-gray-50/60">
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            {p.image_url && (
                              <button type="button" onClick={() => setLightboxImage(p.image_url)} className="shrink-0">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={p.image_url} alt="" className="w-9 h-9 rounded object-cover border border-border" />
                              </button>
                            )}
                            <div className="min-w-0">
                              <p className="font-medium text-text truncate max-w-[220px]">{p.description}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          {p.department ? (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${DEPARTMENT_BADGE[p.department] || "bg-gray-100 text-gray-700"}`}>{p.department}</span>
                          ) : "—"}
                        </td>
                        <td className="px-3 py-2.5">{p.supplier || "—"}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{formatPurchaseDate(p.purchase_date)}</td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">{formatCurrency(p.unit_value || 0)}</td>
                        <td className="px-3 py-2.5 text-right">{formatQty(p.quantity)}</td>
                        <td className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">{formatCurrency(p.total_value || 0)}</td>
                        <td className="px-3 py-2.5">{p.payment_method || "—"}</td>
                        {canManagePurchases && (
                          <td className="px-3 py-2.5">
                            <div className="flex gap-0.5 justify-end">
                              <button onClick={() => { setEditPurchase(p); setPurchaseFromRequest(null); setShowPurchaseForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded" title="Editar"><EditIcon /></button>
                              <button onClick={() => setDeletePurchase(p)} className="p-1.5 text-danger hover:bg-red-50 rounded" title="Excluir"><TrashIcon /></button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-50 font-semibold">
                      <td className="px-3 py-2.5" colSpan={6}>Total</td>
                      <td className="px-3 py-2.5 text-right text-primary whitespace-nowrap">{formatCurrency(monthTotal)}</td>
                      <td className="px-3 py-2.5" colSpan={canManagePurchases ? 2 : 1}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Cards (mobile) */}
              <div className="md:hidden space-y-3">
                {purchasesForMonth.map((p) => (
                  <div key={p.id} className="bg-card border border-border rounded-xl p-3">
                    <div className="flex items-start gap-3">
                      {p.image_url && (
                        <button type="button" onClick={() => setLightboxImage(p.image_url)} className="shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={p.image_url} alt="" className="w-12 h-12 rounded-lg object-cover border border-border" />
                        </button>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium text-text truncate">{p.description}</p>
                          <span className="font-semibold text-primary whitespace-nowrap">{formatCurrency(p.total_value || 0)}</span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-text-light items-center">
                          {p.department && <span className={`px-1.5 py-0.5 rounded-full font-medium ${DEPARTMENT_BADGE[p.department] || "bg-gray-100 text-gray-700"}`}>{p.department}</span>}
                          {p.supplier && <span>{p.supplier}</span>}
                          <span>{formatPurchaseDate(p.purchase_date)}</span>
                          <span>{formatQty(p.quantity)} × {formatCurrency(p.unit_value || 0)}</span>
                          {p.payment_method && <span>{p.payment_method}</span>}
                        </div>
                        {p.notes && <p className="text-xs text-text-light mt-1">{p.notes}</p>}
                      </div>
                    </div>
                    {canManagePurchases && (
                      <div className="flex gap-1 justify-end mt-2 pt-2 border-t border-border">
                        <button onClick={() => { setEditPurchase(p); setPurchaseFromRequest(null); setShowPurchaseForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded"><EditIcon /></button>
                        <button onClick={() => setDeletePurchase(p)} className="p-1.5 text-danger hover:bg-red-50 rounded"><TrashIcon /></button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ),
    },
    {
      key: "produtos",
      label: "Lista de Produtos",
      content: (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <p className="text-sm text-text-light">Links de produtos frequentemente comprados, organizados por categoria</p>
            {canManageLinks && (
              <Button size="sm" onClick={() => { setEditLink(null); setShowLinkForm(true); }}>
                <PlusIcon className="w-4 h-4" />Adicionar Produto
              </Button>
            )}
          </div>

          {productLinks.length === 0 ? (
            <div className="text-center py-12 text-text-light">
              <span className="text-4xl block mb-3">🛒</span>
              <p className="font-medium">Nenhum produto na lista</p>
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
    {
      key: "fornecedores",
      label: "Fornecedores",
      content: (
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-sm text-text-light">Cadastro de fornecedores e contatos</p>
            {canManageLinks && (
              <Button size="sm" onClick={() => { setEditSupplier(null); setShowSupplierForm(true); }}>
                <PlusIcon className="w-4 h-4" />Adicionar
              </Button>
            )}
          </div>

          {/* Search */}
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-light" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <input type="text" value={supplierSearch} onChange={(e) => setSupplierSearch(e.target.value)} placeholder="Buscar fornecedor..."
              className="w-full pl-10 pr-4 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" />
          </div>

          {filteredSuppliers.length === 0 ? (
            <div className="text-center py-12 text-text-light">
              <span className="text-4xl block mb-3">🏭</span>
              <p className="font-medium">{suppliers.length === 0 ? "Nenhum fornecedor cadastrado" : "Nenhum resultado"}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredSuppliers.map((s) => (
                <div key={s.id} className="bg-card border border-border rounded-xl p-4 hover:shadow-sm transition">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-text">{s.name}</span>
                        {s.category && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">{s.category}</span>}
                      </div>
                      <div className="mt-2 space-y-1 text-sm text-text-light">
                        <div className="flex items-center gap-2">
                          <span className="shrink-0">📞</span>
                          <span>{s.contact || "—"}</span>
                        </div>
                        {s.address && (
                          <div className="flex items-center gap-2">
                            <span className="shrink-0">📍</span>
                            <span>{s.address}</span>
                          </div>
                        )}
                        {s.website && (
                          <div className="flex items-center gap-2">
                            <span className="shrink-0">🌐</span>
                            <a href={s.website.startsWith("http") ? s.website : `https://${s.website}`} target="_blank" rel="noopener noreferrer"
                              className="text-primary hover:underline truncate">{s.website}</a>
                          </div>
                        )}
                        {s.notes && (
                          <div className="flex items-center gap-2">
                            <span className="shrink-0">📝</span>
                            <span>{s.notes}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    {canManageLinks && (
                      <div className="flex gap-1 shrink-0">
                        <button onClick={() => { setEditSupplier(s); setShowSupplierForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded"><EditIcon /></button>
                        <button onClick={() => setDeleteSupplier(s)} className="p-1.5 text-danger hover:bg-red-50 rounded"><TrashIcon /></button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ),
    },
  ].filter((t) => t.key !== "produtos" || role === "TECNOLOGIA");

  // If the URL points to a tab the current role can't see (e.g. someone with a
  // stale bookmark to ?tab=produtos), fall back to the first available tab.
  const effectiveTab = tabs.some((t) => t.key === initialTab) ? initialTab : tabs[0]?.key;
  const activeTabLabel = tabs.find((t) => t.key === effectiveTab)?.label;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h1 className="text-2xl font-bold text-text">Controle</h1>
        {activeTabLabel && (
          <>
            <span className="text-text-light">›</span>
            <span className="text-lg font-semibold text-text-light">{activeTabLabel}</span>
          </>
        )}
      </div>

      {dbError && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 font-mono break-all">
          Erro ao carregar dados: {dbError}
        </div>
      )}

      {saveError && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 flex justify-between items-start gap-2">
          <span>{saveError}</span>
          <button onClick={() => setSaveError(null)} className="text-red-500 hover:text-red-700 font-bold shrink-0">✕</button>
        </div>
      )}

      <Tabs tabs={tabs} defaultTab={effectiveTab} hideHeader />

      {/* Request Form Modal */}
      <RequestFormModal open={showRequestForm} onClose={() => setShowRequestForm(false)} onSave={handleCreateRequest} saving={saving} />

      {/* Product Link Form Modal */}
      <LinkFormModal open={showLinkForm} onClose={() => { setShowLinkForm(false); setEditLink(null); setSaveError(null); }} onSave={handleSaveLink} item={editLink} saving={saving} error={saveError} />

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
        message={`Excluir "${deleteLink?.name}" da lista?`}
        loading={saving}
      />

      {/* Supplier Form Modal */}
      <SupplierFormModal open={showSupplierForm} onClose={() => { setShowSupplierForm(false); setEditSupplier(null); }} onSave={handleSaveSupplier} item={editSupplier} saving={saving} />

      {/* Delete Supplier Confirm */}
      <ConfirmDialog
        open={!!deleteSupplier}
        onClose={() => setDeleteSupplier(null)}
        onConfirm={handleDeleteSupplier}
        title="Excluir Fornecedor"
        message={`Excluir "${deleteSupplier?.name}"?`}
        loading={saving}
      />

      {/* Purchase Form Modal */}
      <PurchaseFormModal
        open={showPurchaseForm}
        onClose={() => { setShowPurchaseForm(false); setEditPurchase(null); setPurchaseFromRequest(null); }}
        onSave={handleSavePurchase}
        item={editPurchase}
        fromRequest={purchaseFromRequest}
        suppliers={suppliers}
        saving={saving}
      />

      {/* Delete Purchase Confirm */}
      <ConfirmDialog
        open={!!deletePurchase}
        onClose={() => setDeletePurchase(null)}
        onConfirm={handleDeletePurchase}
        title="Excluir Compra"
        message={`Excluir a compra "${deletePurchase?.description}"?`}
        loading={saving}
      />

      {/* Image Lightbox */}
      {lightboxImage && (
        <div
          className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4"
          onClick={() => setLightboxImage(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightboxImage} alt="Imagem do produto" className="max-w-full max-h-[90vh] rounded-lg shadow-2xl" />
          <button
            onClick={() => setLightboxImage(null)}
            className="absolute top-4 right-4 text-white/80 hover:text-white text-3xl font-light leading-none"
            title="Fechar"
          >
            ×
          </button>
        </div>
      )}
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

// Seletor de imagem reutilizável (solicitação e compra). Comprime no cliente
// e devolve um data URL (base64), ou null quando removida.
function ImagePicker({ value, onChange, label = "Imagem do produto (opcional)" }: {
  value: string | null; onChange: (dataUrl: string | null) => void; label?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite re-selecionar o mesmo arquivo
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Selecione um arquivo de imagem"); return; }
    setError(null);
    setProcessing(true);
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      onChange(dataUrl);
    } catch (err: any) {
      setError(err?.message || "Falha ao processar imagem");
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      {value ? (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt="Pré-visualização" className="w-20 h-20 rounded-lg object-cover border border-border" />
          <div className="flex flex-col gap-1.5">
            <label className="px-3 py-1.5 text-xs font-medium bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer transition text-center">
              Trocar
              <input type="file" accept="image/*" onChange={handleFile} className="hidden" />
            </label>
            <button type="button" onClick={() => onChange(null)} className="px-3 py-1.5 text-xs font-medium text-danger hover:bg-red-50 rounded-lg transition">
              Remover
            </button>
          </div>
        </div>
      ) : (
        <label className="flex flex-col items-center justify-center gap-1 w-full py-6 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary/50 hover:bg-gray-50 transition text-text-light">
          <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
          <span className="text-xs font-medium">{processing ? "Processando..." : "Adicionar foto"}</span>
          <input type="file" accept="image/*" onChange={handleFile} className="hidden" disabled={processing} />
        </label>
      )}
      {error && <p className="text-xs text-danger mt-1">{error}</p>}
    </div>
  );
}

function RequestFormModal({ open, onClose, onSave, saving }: {
  open: boolean; onClose: () => void; onSave: (toolName: string, qty: number, reason: string, imageUrl: string | null) => void; saving: boolean;
}) {
  const [toolName, setToolName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => { setToolName(""); setQuantity(1); setReason(""); setImageUrl(null); }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Nova Solicitação">
      <form onSubmit={(e) => { e.preventDefault(); onSave(toolName, quantity, reason, imageUrl); }} className="space-y-4">
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
        <ImagePicker value={imageUrl} onChange={setImageUrl} />
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Enviando..." : "Enviar Solicitação"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// Converte número do banco para o texto do input em pt-BR (vírgula decimal).
function numToInput(n: number | null | undefined): string {
  if (n == null || n === 0) return "";
  return String(n).replace(".", ",");
}

function PurchaseFormModal({ open, onClose, onSave, item, fromRequest, suppliers, saving }: {
  open: boolean; onClose: () => void;
  onSave: (data: Partial<PurchaseOrder>, fromRequestId: string | null) => void;
  item: PurchaseOrder | null;
  fromRequest: ToolRequest | null;
  suppliers: Supplier[];
  saving: boolean;
}) {
  const [description, setDescription] = useState("");
  const [department, setDepartment] = useState("");
  const [supplier, setSupplier] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [unitValue, setUnitValue] = useState("");
  const [quantity, setQuantity] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const today = new Date();
    const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    if (item) {
      setDescription(item.description || "");
      setDepartment(item.department || "");
      setSupplier(item.supplier || "");
      setPurchaseDate((item.purchase_date || "").slice(0, 10) || todayISO);
      setUnitValue(numToInput(item.unit_value));
      setQuantity(numToInput(item.quantity) || "1");
      setPaymentMethod(item.payment_method || "");
      setNotes(item.notes || "");
      setImageUrl(item.image_url || null);
    } else if (fromRequest) {
      setDescription(fromRequest.tool_name || "");
      setDepartment("");
      setSupplier("");
      setPurchaseDate(todayISO);
      setUnitValue("");
      setQuantity(numToInput(fromRequest.quantity) || "1");
      setPaymentMethod("");
      setNotes("");
      setImageUrl(fromRequest.image_url || null);
    } else {
      setDescription(""); setDepartment(""); setSupplier(""); setPurchaseDate(todayISO);
      setUnitValue(""); setQuantity("1"); setPaymentMethod(""); setNotes(""); setImageUrl(null);
    }
  }, [item, fromRequest, open]);

  const unit = parseDecimalBR(unitValue);
  const qty = parseDecimalBR(quantity);
  const total = unit * qty;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      description,
      department: department || null,
      supplier: supplier || null,
      purchase_date: purchaseDate || null,
      unit_value: unit,
      quantity: qty || 1,
      total_value: total,
      payment_method: paymentMethod || null,
      notes: notes || null,
      image_url: imageUrl,
    }, fromRequest?.id || null);
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";
  const title = item ? "Editar Compra" : fromRequest ? "Registrar Compra" : "Nova Compra";

  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="max-w-xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        {fromRequest && !item && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-800">
            Compra a partir da solicitação de <strong>{fromRequest.requested_by}</strong>. Ao salvar, a solicitação é marcada como <strong>Comprada</strong>.
          </div>
        )}
        <div>
          <label className="block text-sm font-medium mb-1">Descrição *</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} required
            placeholder="Ex: Fita silver tape, Água 1,5 L..." className={inputCls} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Departamento</label>
            <select value={department} onChange={(e) => setDepartment(e.target.value)} className={inputCls}>
              <option value="">Selecionar...</option>
              {PURCHASE_DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Fornecedor</label>
            <input type="text" list="purchase-suppliers" value={supplier} onChange={(e) => setSupplier(e.target.value)}
              placeholder="Ex: POTENCYA" className={inputCls} />
            <datalist id="purchase-suppliers">
              {suppliers.map((s) => <option key={s.id} value={s.name} />)}
            </datalist>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Data da compra</label>
            <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Forma de pagamento</label>
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className={inputCls}>
              <option value="">Selecionar...</option>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Valor unit. (R$)</label>
            <input type="text" inputMode="decimal" value={unitValue} onChange={(e) => setUnitValue(e.target.value)}
              placeholder="0,00" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Quantidade</label>
            <input type="text" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)}
              placeholder="1" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Valor total</label>
            <div className="w-full px-3 py-2.5 border border-border rounded-lg text-sm bg-gray-50 font-semibold text-primary">
              {formatCurrency(total)}
            </div>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Observação</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            placeholder="Ex: Crédito de 354,22, frete incluso..." className={`${inputCls} resize-none`} />
        </div>
        <ImagePicker value={imageUrl} onChange={setImageUrl} />
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar Compra"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function LinkFormModal({ open, onClose, onSave, item, saving, error }: {
  open: boolean; onClose: () => void;
  onSave: (data: { name: string; url: string; category: string; description: string }) => void;
  item: ProductLink | null; saving: boolean; error: string | null;
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
    <Modal open={open} onClose={onClose} title={item ? "Editar Produto" : "Adicionar Produto"}>
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
        {error && (
          <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

const SUPPLIER_CATEGORIES = [
  "EPI", "EMBALAGENS", "TECNOLOGIA", "AGUA", "FILTROS", "CARNES",
  "HORTI FRUTI", "TINTAS", "ELETRICA", "ESPUMAS", "MANUT, MAQUINAS",
  "VEDACOES", "FITAS", "PISTOLAS", "MANGUEIRA E NIPLE", "RODAS MAQUINA", "OUTROS",
];

function SupplierFormModal({ open, onClose, onSave, item, saving }: {
  open: boolean; onClose: () => void;
  onSave: (data: Partial<Supplier>) => void;
  item: Supplier | null; saving: boolean;
}) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [address, setAddress] = useState("");
  const [category, setCategory] = useState("");
  const [website, setWebsite] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (item) {
      setName(item.name); setContact(item.contact || ""); setAddress(item.address || "");
      setCategory(item.category || ""); setWebsite(item.website || ""); setNotes(item.notes || "");
    } else {
      setName(""); setContact(""); setAddress(""); setCategory(""); setWebsite(""); setNotes("");
    }
  }, [item, open]);

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Fornecedor" : "Novo Fornecedor"}>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name, contact: contact || null, address: address || null, category: category || null, website: website || null, notes: notes || null }); }} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Nome do Fornecedor *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Ex: POTENCYA" className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Contato</label>
            <input type="text" value={contact} onChange={(e) => setContact(e.target.value)} placeholder="13 3229-9350" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Categoria</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
              <option value="">Selecionar...</option>
              {SUPPLIER_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Endereço</label>
          <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="R. Lucas Fortunato, 96 - Loja 01" className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Website / Link</label>
          <input type="text" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://www.exemplo.com.br/" className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Observações</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Conexões, pistola latão, etc" className={`${inputCls} resize-none`} />
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}
