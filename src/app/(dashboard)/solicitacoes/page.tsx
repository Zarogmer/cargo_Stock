"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission, COMPRAS_ROLES } from "@/lib/rbac";
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
  product_url: string | null;
  estimated_value: number | string | null;
  supplier: string | null;
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

// Sentinela de equipe usada pelos materiais do galpão na tabela stock_items —
// precisa bater com o TEAM da aba Almoxarifado › Estoque (materiais-panel.tsx).
const STOCK_TEAM = "GALPAO";

// Categorias do Estoque de materiais (espelha os grupos da aba Almoxarifado ›
// Estoque). Usadas quando uma compra é lançada direto no estoque do galpão.
// É uma datalist (texto livre), então categorias novas também valem.
const STOCK_CATEGORIES = [
  "Cozinha",
  "Elétrica",
  "Embarque",
  "EPI e Químicos",
  "Ferramentas",
  "Hidrojato",
  "Líquidos",
  "Mangueiras e Conexões",
  "Pistola e Caneta",
  "Rodas",
  "Varões",
  "Outros",
];

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
  const [editRequest, setEditRequest] = useState<ToolRequest | null>(null);
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [editLink, setEditLink] = useState<ProductLink | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<ToolRequest | null>(null);
  const [deleteLink, setDeleteLink] = useState<ProductLink | null>(null);
  // Aprovação = conclusão num passo só (registra compra + lança no estoque).
  const [concludeRequest, setConcludeRequest] = useState<ToolRequest | null>(null);

  // Imagem em tela cheia (lightbox)
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Controle de Compras
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [editPurchase, setEditPurchase] = useState<PurchaseOrder | null>(null);
  const [purchaseFromRequest, setPurchaseFromRequest] = useState<ToolRequest | null>(null);
  const [deletePurchase, setDeletePurchase] = useState<PurchaseOrder | null>(null);
  // "Armazenar no Estoque": lança uma solicitação já comprada no estoque do galpão.
  const [stockRequest, setStockRequest] = useState<ToolRequest | null>(null);
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
  const canEditRequests = hasPermission(role, "SOLICITACOES", "edit");
  const canDeleteRequests = hasPermission(role, "SOLICITACOES", "delete");
  // Gerir compras (Registrar Compra, Armazenar no estoque, Nova/editar compra) é
  // dos papéis de gestão — os mesmos que veem a aba Controle de Compras. Manutenção
  // tem permissão "create" em SOLICITACOES só pra ABRIR pedidos, então NÃO basta
  // checar a permissão: separamos pelo COMPRAS_ROLES pra Manutenção só pedir.
  const canManagePurchases = COMPRAS_ROLES.includes(role);

  const [dbError, setDbError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);

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

  async function handleSaveRequest(data: {
    toolName: string; quantity: number; reason: string; imageUrl: string | null;
    productUrl: string | null; estimatedValue: number | null; supplier: string | null;
  }) {
    setSaving(true);
    setSaveError(null);
    try {
      if (editRequest) {
        // Edição: atualiza os campos sem mexer em status/autor nem reavisar.
        const { error } = await db.from("tool_requests").update({
          tool_name: data.toolName,
          quantity: data.quantity,
          reason: data.reason,
          image_url: data.imageUrl,
          product_url: data.productUrl,
          estimated_value: data.estimatedValue,
          supplier: data.supplier,
          updated_at: new Date().toISOString(),
        } as any).eq("id", editRequest.id);
        if (error) throw error;
        setShowRequestForm(false);
        setEditRequest(null);
        loadAll();
        return;
      }

      const { error } = await db.from("tool_requests").insert({
        tool_name: data.toolName,
        quantity: data.quantity,
        reason: data.reason,
        status: "PENDENTE",
        requested_by: profile?.full_name || "Sistema",
        image_url: data.imageUrl,
        product_url: data.productUrl,
        estimated_value: data.estimatedValue,
        supplier: data.supplier,
      } as any);
      if (error) throw error;
      // Avisa os supervisores por WhatsApp (best-effort — não bloqueia nem
      // falha a criação da solicitação se a Evolution estiver fora do ar).
      fetch("/api/solicitacoes/notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolName: data.toolName,
          quantity: data.quantity,
          reason: data.reason,
          requestedBy: profile?.full_name || "Sistema",
          value: data.estimatedValue,
          supplier: data.supplier,
          productUrl: data.productUrl,
          imageUrl: data.imageUrl,
        }),
      }).catch((err) => console.warn("[solicitacoes] notify failed:", err));
      setShowRequestForm(false);
      loadAll();
    } catch (err: any) {
      console.error("Erro ao salvar solicitação:", err);
      setSaveError(`Erro ao salvar solicitação: ${err?.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  // Aprovar = concluir num passo só: registra a compra automaticamente a partir
  // da solicitação, marca como concluída (status APROVADO, exibido "Concluído") e
  // lança o item no Estoque do galpão. Substitui o antigo "Aprovar → Registrar
  // Compra → Armazenar". Não há mais recusa — a solicitação ou é concluída ou
  // apagada.
  async function handleConcludeRequest() {
    const req = concludeRequest;
    if (!req) return;
    setSaving(true);
    setSaveError(null);
    setSaveOk(null);
    try {
      const actor = profile?.full_name || "Sistema";
      const unit = parseDecimalBR(req.estimated_value);
      const qty = req.quantity > 0 ? req.quantity : 1;
      const today = new Date();
      const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

      // 1) Registra a compra (valor estimado da solicitação vira o valor unitário).
      const { error: buyErr } = await db.from("purchase_orders").insert({
        description: req.tool_name,
        department: null,
        supplier: req.supplier || null,
        purchase_date: todayISO,
        unit_value: unit,
        quantity: qty,
        total_value: unit * qty,
        payment_method: null,
        notes: null,
        image_url: req.image_url,
        request_id: req.id,
        created_by: actor,
      } as any);
      if (buyErr) throw buyErr;

      // 2) Marca a solicitação como concluída.
      const { error: updErr } = await db.from("tool_requests").update({
        status: "APROVADO",
        responded_by: actor,
        updated_at: new Date().toISOString(),
      } as any).eq("id", req.id);
      if (updErr) throw updErr;

      // 3) Lança no Estoque do galpão (não-fatal: a compra já foi salva). Sem
      // categoria definida na solicitação, entra como "Outros" — recategorizável
      // depois em Almoxarifado › Estoque.
      let stockMsg = "";
      try {
        const r = await storeInStock({ name: req.tool_name, quantity: qty, category: "Outros" });
        stockMsg = ` ${r.created ? "Material criado" : "Estoque reposto"} (+${formatQty(r.quantity)}) em ${r.category}.`;
      } catch (stockErr: any) {
        stockMsg = ` ⚠️ Falhou ao lançar no Estoque: ${stockErr?.message || String(stockErr)}`;
      }

      // 4) Avisa o grupo "Compras" no WhatsApp (best-effort — a conclusão já está
      // gravada; só anexa o resultado ao toast). NÃO mira o grupo oficial
      // "Compras Cargo Ships" — ver src/lib/services/compras-group.ts.
      let groupMsg = "";
      try {
        const res = await fetch("/api/solicitacoes/notify-compras", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toolName: req.tool_name,
            quantity: qty,
            value: unit,
            supplier: req.supplier,
            requestedBy: req.requested_by,
            concludedBy: actor,
            productUrl: req.product_url,
            imageUrl: req.image_url,
          }),
        });
        const data = await res.json().catch(() => null);
        if (data?.sent) {
          groupMsg = data.withPhoto
            ? " 📨 Avisado no grupo Compras (com foto)."
            : ` 📨 Avisado no grupo Compras${data.photoError ? ` (foto falhou: ${data.photoError})` : ""}.`;
        } else if (data?.warning) {
          groupMsg = ` ⚠️ ${data.warning}`;
        }
      } catch {
        groupMsg = " ⚠️ Não consegui avisar o grupo Compras.";
      }

      setConcludeRequest(null);
      setSaveOk(`✅ "${req.tool_name}" concluído — compra registrada.${stockMsg}${groupMsg}`);
      loadAll();
    } catch (err: any) {
      console.error("Erro ao concluir solicitação:", err);
      setSaveError(`Erro ao concluir solicitação: ${err?.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  // Lança um item no Estoque de materiais do galpão (stock_items, team=GALPAO) —
  // a mesma tabela da aba Almoxarifado › Estoque. Se já existe um material com o
  // mesmo nome, soma a quantidade (reposição); senão cria um material novo com a
  // categoria escolhida. Também registra um movimento de ENTRADA pro histórico.
  // É a "ponte" entre Solicitações de compra e o Estoque.
  const storeInStock = useCallback(async (opts: { name: string; quantity: number; category: string }) => {
    const actor = profile?.full_name || "Sistema";
    const name = (opts.name || "").trim();
    const qty = opts.quantity > 0 ? opts.quantity : 1;
    const category = (opts.category || "").trim() || "Outros";
    if (!name) throw new Error("Nome do material vazio");

    // Procura material existente no galpão por nome (match exato, sem caixa) —
    // o cliente db não tem "equals" case-insensitive, então casamos em JS.
    const { data: galpao, error: loadErr } = await db
      .from("stock_items")
      .select("id, name, quantity, location")
      .eq("team", STOCK_TEAM);
    if (loadErr) throw new Error(loadErr.message);
    const norm = (s: string) => (s || "").trim().toLowerCase();
    const existing = (galpao || []).find((s: any) => norm(s.name) === norm(name)) as
      | { id: number; name: string; quantity: number; location: string | null }
      | undefined;

    let stockItemId: number | undefined;
    let created: boolean;
    if (existing) {
      created = false;
      stockItemId = existing.id;
      const newQty = Math.round((Number(existing.quantity || 0) + qty) * 1000) / 1000;
      const { error } = await db.from("stock_items").update({
        quantity: newQty,
        // Preenche a categoria só se ainda não havia uma definida.
        location: existing.location && existing.location.trim() && existing.location !== "Outros"
          ? existing.location
          : category,
        updated_by: actor,
      } as any).eq("id", existing.id);
      if (error) throw new Error(error.message);
    } else {
      created = true;
      const { data: inserted, error } = await db.from("stock_items").insert({
        name,
        location: category,
        quantity: qty,
        default_quantity: qty,
        category: "OUTROS",
        team: STOCK_TEAM,
        min_quantity: 0,
        updated_by: actor,
      } as any);
      if (error) throw new Error(error.message);
      stockItemId = (inserted as any)?.id;
    }

    // Movimento de ENTRADA pro histórico do almoxarifado (não-fatal).
    if (stockItemId) {
      try {
        await db.from("stock_movements").insert({
          stock_item_id: stockItemId,
          movement_type: "ENTRADA",
          quantity: qty,
          movement_date: new Date().toISOString().split("T")[0],
          notes: "Entrada via Solicitações de compra",
          created_by: actor,
        } as any);
      } catch { /* histórico é best-effort */ }
    }

    return { created, name, category, quantity: qty };
  }, [profile]);

  async function handleSavePurchase(
    data: Partial<PurchaseOrder>,
    fromRequestId: string | null,
    stock?: { category: string } | null,
  ) {
    setSaving(true);
    setSaveError(null);
    setSaveOk(null);
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
        // Lança no Estoque do galpão, se o usuário marcou a opção na compra.
        // Falha aqui é não-fatal: a compra já foi salva, só avisamos.
        if (stock) {
          try {
            const r = await storeInStock({
              name: data.description || "",
              quantity: Number(data.quantity) || 1,
              category: stock.category,
            });
            setSaveOk(
              `📦 ${r.created ? "Material criado" : "Estoque reposto"}: "${r.name}" (+${formatQty(r.quantity)}) em ${r.category}.`,
            );
          } catch (stockErr: any) {
            setSaveError(`Compra salva, mas falhou ao lançar no Estoque: ${stockErr?.message || String(stockErr)}`);
          }
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

  // "Armazenar no Estoque" a partir de uma solicitação já comprada (botão no card).
  async function handleStoreRequest(category: string) {
    if (!stockRequest) return;
    setSaving(true);
    setSaveError(null);
    setSaveOk(null);
    try {
      const r = await storeInStock({
        name: stockRequest.tool_name,
        quantity: stockRequest.quantity,
        category,
      });
      setStockRequest(null);
      setSaveOk(
        `📦 ${r.created ? "Material criado" : "Estoque reposto"}: "${r.name}" (+${formatQty(r.quantity)}) em ${r.category}.`,
      );
    } catch (err: any) {
      console.error("Erro ao lançar no estoque:", err);
      setSaveError(`Erro ao lançar no Estoque: ${err?.message || String(err)}`);
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
            <Button size="sm" onClick={() => { setEditRequest(null); setShowRequestForm(true); }}>
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
                  APROVADO: { color: "bg-green-100 text-green-700", label: "Concluído" },
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
                        {(req.estimated_value != null || req.supplier || req.product_url) && (
                          <div className="flex gap-2 mt-2 flex-wrap items-center">
                            {req.estimated_value != null && Number(req.estimated_value) > 0 && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">
                                {formatCurrency(Number(req.estimated_value))}
                              </span>
                            )}
                            {req.supplier && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-text-light font-medium">🏬 {req.supplier}</span>
                            )}
                            {req.product_url && (
                              <a href={req.product_url} target="_blank" rel="noopener noreferrer"
                                className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-primary font-medium hover:bg-blue-100 transition">
                                🔗 Ver produto
                              </a>
                            )}
                          </div>
                        )}
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
                          <button
                            onClick={() => setConcludeRequest(req)}
                            className="px-3 py-1.5 text-xs bg-green-50 text-green-700 rounded-lg hover:bg-green-100 font-medium transition"
                            title="Registra a compra e lança no Estoque automaticamente"
                          >
                            Aprovar
                          </button>
                        )}
                        {canManagePurchases && req.status === "COMPRADO" && (
                          <button
                            onClick={() => setStockRequest(req)}
                            className="px-3 py-1.5 text-xs bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 font-medium transition"
                            title="Lançar este item no Estoque do galpão"
                          >
                            📦 Armazenar
                          </button>
                        )}
                        {canEditRequests && (
                          <button
                            onClick={() => { setEditRequest(req); setShowRequestForm(true); }}
                            className="p-1.5 text-primary hover:bg-blue-50 rounded-lg transition"
                            title="Editar solicitação"
                          >
                            <EditIcon />
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
  ]
    .filter((t) => t.key !== "produtos" || role === "TECNOLOGIA")
    // "Controle de Compras" só pros papéis de gestão (mesma regra do menu em
    // rbac.ts). Manutenção/RH não veem a aba nem acessando ?tab=compras direto —
    // o effectiveTab abaixo cai pra primeira aba disponível (Solicitações).
    .filter((t) => t.key !== "compras" || COMPRAS_ROLES.includes(role));

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

      {saveOk && (
        <div className="bg-emerald-50 border border-emerald-300 rounded-lg p-3 text-sm text-emerald-700 flex justify-between items-start gap-2">
          <span>{saveOk}</span>
          <button onClick={() => setSaveOk(null)} className="text-emerald-500 hover:text-emerald-700 font-bold shrink-0">✕</button>
        </div>
      )}

      <Tabs tabs={tabs} defaultTab={effectiveTab} hideHeader />

      {/* Request Form Modal */}
      <RequestFormModal open={showRequestForm} onClose={() => { setShowRequestForm(false); setEditRequest(null); }} onSave={handleSaveRequest} item={editRequest} suppliers={suppliers} saving={saving} />

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

      {/* Aprovar = concluir: registra a compra + lança no Estoque */}
      <ConfirmDialog
        open={!!concludeRequest}
        onClose={() => setConcludeRequest(null)}
        onConfirm={handleConcludeRequest}
        title="Aprovar e concluir"
        message={`Aprovar "${concludeRequest?.tool_name}" (x${concludeRequest?.quantity})? A compra é registrada no Controle de Compras e o item entra no Estoque do galpão automaticamente.`}
        confirmLabel="Aprovar e concluir"
        variant="primary"
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

      {/* Armazenar no Estoque (a partir de uma solicitação comprada) */}
      <ArmazenarEstoqueModal
        open={!!stockRequest}
        onClose={() => setStockRequest(null)}
        onConfirm={handleStoreRequest}
        request={stockRequest}
        saving={saving}
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

// Campo de fornecedor reutilizável: dropdown com os fornecedores cadastrados +
// a opção "Outro" para digitar um novo. Não usa <datalist> de propósito — o
// navegador filtra a datalist pelo texto já preenchido, escondendo os demais
// fornecedores ao editar uma compra/solicitação que já tem fornecedor. Um
// <select> nativo sempre mostra a lista inteira e não é cortado pelo overflow
// do modal.
function SupplierField({ value, onChange, suppliers, className, placeholder = "Selecionar..." }: {
  value: string; onChange: (v: string) => void; suppliers: Supplier[];
  className?: string; placeholder?: string;
}) {
  const OTHER = "__outro__";
  const [typing, setTyping] = useState(false);
  const known = suppliers.some((s) => s.name === value);

  if (typing) {
    return (
      <div className="flex gap-2">
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} autoFocus
          placeholder="Nome do fornecedor" className={`flex-1 ${className ?? ""}`} />
        <button type="button" onClick={() => { setTyping(false); onChange(""); }}
          className="px-3 text-sm font-medium text-text-light hover:text-text border border-border rounded-lg whitespace-nowrap">
          Lista
        </button>
      </div>
    );
  }

  return (
    <select value={value}
      onChange={(e) => {
        if (e.target.value === OTHER) { onChange(""); setTyping(true); }
        else onChange(e.target.value);
      }}
      className={className}>
      <option value="">{placeholder}</option>
      {value && !known && <option value={value}>{value}</option>}
      {suppliers.map((s) => <option key={s.id} value={s.name}>{s.name}</option>)}
      <option value={OTHER}>➕ Outro (digitar)…</option>
    </select>
  );
}

function RequestFormModal({ open, onClose, onSave, item, suppliers, saving }: {
  open: boolean; onClose: () => void;
  onSave: (data: {
    toolName: string; quantity: number; reason: string; imageUrl: string | null;
    productUrl: string | null; estimatedValue: number | null; supplier: string | null;
  }) => void;
  item: ToolRequest | null;
  suppliers: Supplier[];
  saving: boolean;
}) {
  const [toolName, setToolName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // Link + dados puxados automaticamente da página do produto.
  const [link, setLink] = useState("");
  const [value, setValue] = useState("");
  const [supplier, setSupplier] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const lastFetchedRef = useRef<string>("");

  useEffect(() => {
    if (!open) return;
    if (item) {
      setToolName(item.tool_name || "");
      setQuantity(item.quantity || 1);
      setReason(item.reason || "");
      setImageUrl(item.image_url || null);
      setLink(item.product_url || "");
      setValue(numToInput(parseDecimalBR(item.estimated_value)));
      setSupplier(item.supplier || "");
      // Já tem dados preenchidos — não dispara o auto-fetch do link ao abrir.
      lastFetchedRef.current = (item.product_url || "").trim();
    } else {
      setToolName(""); setQuantity(1); setReason(""); setImageUrl(null);
      setLink(""); setValue(""); setSupplier("");
      lastFetchedRef.current = "";
    }
    setFetching(false); setFetchError(null);
  }, [open, item]);

  const isUrl = (s: string) => /^https?:\/\/.+/i.test(s.trim());

  // Busca os dados do link no servidor (Open Graph / JSON-LD). `force` sobrescreve
  // campos já preenchidos; sem force, só preenche o que estiver vazio.
  const fetchPreview = useCallback(async (rawUrl: string, force: boolean) => {
    const u = rawUrl.trim();
    if (!isUrl(u)) return;
    lastFetchedRef.current = u;
    setFetching(true);
    setFetchError(null);
    try {
      const res = await fetch("/api/solicitacoes/link-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: u }),
      });
      const data = await res.json();
      if (!res.ok || data?.error) {
        setFetchError(data?.error || "Não consegui buscar os dados do link.");
        return;
      }
      if (data.name) setToolName((p) => (force || !p.trim() ? data.name : p));
      if (data.value != null) setValue((p) => (force || !p.trim() ? String(data.value).replace(".", ",") : p));
      if (data.supplier) setSupplier((p) => (force || !p.trim() ? data.supplier : p));
      if (data.image) setImageUrl((p) => (force || !p ? data.image : p));
      if (!data.name && data.value == null && !data.image) {
        setFetchError("Não achei dados nessa página. Preencha manualmente.");
      }
    } catch {
      setFetchError("Não consegui buscar os dados do link.");
    } finally {
      setFetching(false);
    }
  }, []);

  // Auto-busca ao colar/digitar o link (debounce), só quando o modal está aberto.
  useEffect(() => {
    if (!open) return;
    const u = link.trim();
    if (!isUrl(u) || u === lastFetchedRef.current) return;
    const t = setTimeout(() => { fetchPreview(u, false); }, 700);
    return () => clearTimeout(t);
  }, [link, open, fetchPreview]);

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      toolName, quantity, reason, imageUrl,
      productUrl: link.trim() || null,
      estimatedValue: value.trim() ? parseDecimalBR(value) : null,
      supplier: supplier.trim() || null,
    });
  }

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Solicitação" : "Nova Solicitação"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Link do produto (opcional)</label>
          <div className="flex gap-2">
            <input type="url" value={link} onChange={(e) => setLink(e.target.value)}
              onBlur={() => { const u = link.trim(); if (isUrl(u) && u !== lastFetchedRef.current) fetchPreview(u, false); }}
              placeholder="Cole o link do Mercado Livre ou outro site..."
              className={`flex-1 px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none ${fetching ? "opacity-70" : ""}`} />
            <button type="button" onClick={() => fetchPreview(link, true)} disabled={fetching || !isUrl(link)}
              className="px-3 py-2.5 text-sm font-medium bg-gray-100 hover:bg-gray-200 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">
              {fetching ? "Buscando..." : "Buscar"}
            </button>
          </div>
          {fetching ? (
            <p className="text-xs text-text-light mt-1">🔎 Buscando dados do produto...</p>
          ) : fetchError ? (
            <p className="text-xs text-amber-600 mt-1">⚠️ {fetchError}</p>
          ) : (
            <p className="text-[10px] text-text-light mt-1">Cole o link e o nome, valor, imagem e fornecedor são preenchidos automaticamente.</p>
          )}
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Produto / Equipamento *</label>
          <input type="text" value={toolName} onChange={(e) => setToolName(e.target.value)} required
            placeholder="Ex: Furadeira, Chave inglesa, Luvas..." className={inputCls} />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">Quantidade</label>
            <input type="number" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} min={1} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Valor estimado (R$)</label>
            <input type="text" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)}
              placeholder="0,00" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Fornecedor</label>
            <SupplierField value={supplier} onChange={setSupplier} suppliers={suppliers} className={inputCls} />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Motivo / Justificativa *</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} required rows={3}
            placeholder="Para que será utilizado..." className={`${inputCls} resize-none`} />
        </div>
        <ImagePicker value={imageUrl} onChange={setImageUrl} />
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : item ? "Salvar" : "Enviar Solicitação"}</Button>
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
  onSave: (data: Partial<PurchaseOrder>, fromRequestId: string | null, stock?: { category: string } | null) => void;
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
  // Lançar a compra direto no Estoque do galpão (ponte com Almoxarifado › Estoque).
  // Marcado por padrão em compras novas; some ao editar (pra não contar duas vezes).
  const [addToStock, setAddToStock] = useState(true);
  const [stockCategory, setStockCategory] = useState("");

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
      setSupplier(fromRequest.supplier || "");
      setPurchaseDate(todayISO);
      setUnitValue(numToInput(parseDecimalBR(fromRequest.estimated_value)));
      setQuantity(numToInput(fromRequest.quantity) || "1");
      setPaymentMethod("");
      setNotes("");
      setImageUrl(fromRequest.image_url || null);
    } else {
      setDescription(""); setDepartment(""); setSupplier(""); setPurchaseDate(todayISO);
      setUnitValue(""); setQuantity("1"); setPaymentMethod(""); setNotes(""); setImageUrl(null);
    }
    // Estoque: compras novas vêm com a opção marcada e categoria em branco.
    setAddToStock(true);
    setStockCategory("");
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
    }, fromRequest?.id || null,
      // Só lança no estoque em compras novas (não na edição) e quando marcado.
      !item && addToStock ? { category: stockCategory } : null);
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
            <SupplierField value={supplier} onChange={setSupplier} suppliers={suppliers} className={inputCls} />
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

        {/* Ponte com o Estoque: lança a compra como material no almoxarifado.
            Só aparece em compras novas — editar não relança pra não duplicar. */}
        {!item && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={addToStock}
                onChange={(e) => setAddToStock(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-emerald-600"
              />
              <span className="text-sm">
                <span className="font-medium text-emerald-800">📦 Lançar no Estoque do almoxarifado</span>
                <span className="block text-xs text-emerald-700/80">
                  Cria (ou repõe) o material no galpão com a quantidade desta compra.
                </span>
              </span>
            </label>
            {addToStock && (
              <div>
                <label className="block text-xs font-medium text-emerald-800 mb-1">Categoria no Estoque</label>
                <input
                  type="text"
                  list="stock-categories"
                  value={stockCategory}
                  onChange={(e) => setStockCategory(e.target.value)}
                  placeholder="Ex: Elétrica, Hidrojato, Ferramentas..."
                  className="w-full px-3 py-2 border border-emerald-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-emerald-500 outline-none"
                />
                <datalist id="stock-categories">
                  {STOCK_CATEGORIES.map((c) => <option key={c} value={c} />)}
                </datalist>
                <p className="text-[10px] text-emerald-700/80 mt-1">
                  Sem categoria, entra como <strong>Outros</strong>. Se já existir um material com esse nome, a quantidade é somada.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar Compra"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// Lança uma solicitação já comprada no Estoque do galpão: o usuário só confirma
// a categoria. Nome e quantidade vêm da própria solicitação. Usado pelo botão
// "📦 Armazenar" dos cards COMPRADO.
function ArmazenarEstoqueModal({ open, onClose, onConfirm, request, saving }: {
  open: boolean; onClose: () => void;
  onConfirm: (category: string) => void;
  request: ToolRequest | null;
  saving: boolean;
}) {
  const [category, setCategory] = useState("");

  useEffect(() => { if (open) setCategory(""); }, [open]);

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title="Armazenar no Estoque" maxWidth="max-w-md">
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(category); }} className="space-y-4">
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm text-emerald-800">
          Lançar <strong>{request?.tool_name}</strong> (x{request?.quantity}) no Estoque de materiais do galpão.
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Categoria no Estoque</label>
          <input
            type="text"
            list="stock-categories-armazenar"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Ex: Elétrica, Hidrojato, Ferramentas..."
            autoFocus
            className={inputCls}
          />
          <datalist id="stock-categories-armazenar">
            {STOCK_CATEGORIES.map((c) => <option key={c} value={c} />)}
          </datalist>
          <p className="text-[11px] text-text-light mt-1">
            Sem categoria, entra como <strong>Outros</strong>. Se já existir um material com esse nome,
            a quantidade é somada (reposição).
          </p>
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Lançando..." : "Lançar no Estoque"}</Button>
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
