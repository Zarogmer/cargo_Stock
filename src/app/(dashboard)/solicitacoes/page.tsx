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
import { PlusIcon, EditIcon, TrashIcon, WhatsappIcon } from "@/components/icons";
import { formatDateTime, formatCurrency, formatQty, parseDecimalBR, buildCodeMap, codeForName } from "@/lib/utils";
import { ImagePicker } from "@/components/ui/image-picker";

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
  department: string | null;
  // Código do item no Almoxarifado (ex.: "AR01") — repõe exatamente aquele item ao abastecer.
  code: string | null;
  created_at: string;
  updated_at: string;
}

interface PurchaseOrder {
  id: string;
  description: string;
  department: string | null;
  code: string | null;
  supplier: string | null;
  purchase_date: string | null;
  unit_value: number;
  quantity: number;
  total_value: number;
  payment_method: string | null;
  notes: string | null;
  image_url: string | null;
  product_url: string | null;
  request_id: string | null;
  // Navio vinculado (aba Navios). ship_id é o link; ship_name é o snapshot do nome
  // (sobrevive à exclusão do navio, pra não perder o vínculo no histórico/relatório).
  ship_id: string | null;
  ship_name: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

// Navio cadastrado (aba Navios) — só os campos que o seletor/rotulagem usa aqui.
interface Ship {
  id: string;
  name: string;
  status: string;
  port: string | null;
  arrival_date: string | null;
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

// Destinos no Almoxarifado. O item de uma compra/solicitação é lançado no setor
// escolhido — é a ponte entre Compras/Solicitações e o Almoxarifado inteiro.
// Substitui o antigo "Departamento" (que era só rótulo e não batia com as abas
// do Almoxarifado). "OUTROS" = só registra a compra, sem mexer no estoque.
type WarehouseDest = "ESTOQUE" | "RANCHO" | "EPI" | "UNIFORME" | "MAQUINARIO" | "FERRAMENTA" | "ELETRICA" | "ESCRITORIO" | "OUTROS";

const WAREHOUSE_DESTINATIONS: { value: WarehouseDest; label: string }[] = [
  { value: "ESTOQUE", label: "📦 Estoque (galpão)" },
  { value: "RANCHO", label: "🍽️ Rancho (alimentos)" },
  { value: "EPI", label: "⛑️ EPI" },
  { value: "UNIFORME", label: "👕 Uniforme" },
  { value: "MAQUINARIO", label: "⚙️ Maquinário" },
  { value: "FERRAMENTA", label: "🔧 Ferramenta" },
  { value: "ELETRICA", label: "⚡ Elétrica" },
  { value: "ESCRITORIO", label: "🏢 Escritório (só registra a compra)" },
  { value: "OUTROS", label: "— Outros (não lançar no estoque)" },
];

// Destinos que NÃO mexem no Almoxarifado — só registram a compra/solicitação (não
// há setor de estoque pra eles). Escritório é o caso típico. Rancho (card #46)
// também entra aqui: a compra de comida só soma o gasto na aba de Compras, sem
// virar item de estoque nem usar código.
const STOCKLESS_DESTS: WarehouseDest[] = ["RANCHO", "ESCRITORIO", "OUTROS"];
function destStocks(dest: WarehouseDest): boolean {
  return !STOCKLESS_DESTS.includes(dest);
}

// Rótulo curto pro badge na tabela de Controle de Compras.
const DEST_SHORT_LABEL: Record<string, string> = {
  ESTOQUE: "Estoque", RANCHO: "Rancho", EPI: "EPI",
  UNIFORME: "Uniforme", MAQUINARIO: "Maquinário", FERRAMENTA: "Ferramenta", ELETRICA: "Elétrica", ESCRITORIO: "Escritório", OUTROS: "Outros",
};
function departmentLabel(dep: string | null): string {
  if (!dep) return "";
  return DEST_SHORT_LABEL[dep] || dep;
}

// Rótulo de status do navio (espelha STATUS_LABELS da aba Navios) — usado no
// seletor de navio do Nova Compra pra distinguir navios de mesmo nome.
const SHIP_STATUS_LABELS: Record<string, string> = {
  AGENDADO: "Agendado", EM_OPERACAO: "Em Operação", CONCLUIDO: "Concluído", CANCELADO: "Cancelado",
};
function shipSelectLabel(s: { name: string; status: string; port: string | null }): string {
  const parts = [s.name];
  if (s.status) parts.push(SHIP_STATUS_LABELS[s.status] || s.status);
  if (s.port) parts.push(s.port);
  return parts.join(" · ");
}

// Equipes do Rancho (comida por equipe — stock_items team=EQUIPE_x).
const RANCHO_TEAMS: { value: string; label: string }[] = [
  { value: "EQUIPE_1", label: "Equipe 1" },
  { value: "EQUIPE_2", label: "Equipe 2" },
  { value: "EQUIPE_3", label: "Reserva" },
];
// As categorias/unidades do Rancho saíram com o card #46 (Rancho agora só
// registra a compra na aba, sem campos de estoque). RANCHO_TEAMS continua em uso
// no rótulo curto do destino.

// Para onde a compra/solicitação será lançada no Almoxarifado, com os campos
// específicos de cada setor. Compartilhado por Nova Compra, Aprovar e Armazenar.
interface DestSpec { dest: WarehouseDest; category: string; unit: string; team: string; size: string }
const DEFAULT_DEST_SPEC: DestSpec = { dest: "ESTOQUE", category: "", unit: "UN", team: "EQUIPE_1", size: "" };

// Dados que o gestor confere/ajusta no "Aprovar e concluir" — além do destino
// (DestSpec), o resumo editável da compra (descrição, fornecedor, valor, etc.),
// tudo pré-preenchido a partir da solicitação.
interface ApproveData {
  toolName: string;
  supplier: string | null;
  paymentMethod: string | null;
  purchaseDate: string; // YYYY-MM-DD
  unitValue: number;
  quantity: number;
  spec: DestSpec;
  // Código no Almoxarifado conferido na aprovação. Em branco = gera pelo nome.
  code: string | null;
}

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
  // Destinos do Almoxarifado (atual)
  ESTOQUE: "bg-blue-100 text-blue-700",
  RANCHO: "bg-green-100 text-green-700",
  EPI: "bg-amber-100 text-amber-700",
  UNIFORME: "bg-purple-100 text-purple-700",
  MAQUINARIO: "bg-orange-100 text-orange-700",
  FERRAMENTA: "bg-slate-100 text-slate-700",
  ELETRICA: "bg-yellow-100 text-yellow-700",
  ESCRITORIO: "bg-purple-100 text-purple-700",
  OUTROS: "bg-gray-100 text-gray-700",
  // Departamentos legados da planilha (compras antigas continuam exibindo o rótulo)
  "MANUTENÇÃO": "bg-orange-100 text-orange-700",
  "ESCRITÓRIO": "bg-purple-100 text-purple-700",
  "OPERAÇÃO": "bg-blue-100 text-blue-700",
};

// Sentinela de equipe usada pelos materiais do galpão na tabela stock_items —
// precisa bater com o TEAM da aba Almoxarifado › Estoque (materiais-panel.tsx).
const STOCK_TEAM = "GALPAO";

// Converte um valor de data do banco (ISO ou Date) para dd/mm/aaaa sem sofrer
// o deslocamento de fuso (datas @db.Date voltam como meia-noite UTC).
function formatPurchaseDate(value: string | null): string {
  if (!value) return "—";
  const iso = String(value).slice(0, 10);
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return "—";
  return `${d}/${m}/${y}`;
}

// Nomes dos meses (pt-BR), usados nos filtros e no rótulo do período.
const MONTH_NAMES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

// Resolve qual item de um setor deve ser reposto ao abastecer: se veio um código
// (ex.: "AR01"), casa por ele — o código é derivado da lista inteira (buildCodeMap),
// idêntico ao exibido na aba do Almoxarifado; senão (ou se o código não bater) casa
// pelo nome, sem caixa. É a ponte que faz "abastecer pelo código" funcionar.
function findItemByCodeOrName<T extends { id: number; name: string }>(
  items: T[], code: string | null | undefined, name: string,
): T | undefined {
  const norm = (s: string) => (s || "").trim().toLowerCase();
  const wantCode = (code || "").trim().toUpperCase();
  if (wantCode) {
    const map = buildCodeMap(items, (i) => i.id, (i) => i.name);
    const hit = items.find((i) => (map.get(i.id) || "") === wantCode);
    if (hit) return hit;
  }
  return items.find((i) => norm(i.name) === norm(name));
}

// --- WhatsApp pro fornecedor ---------------------------------------------
// Alvo da mensagem: o contato bruto do fornecedor (ex.: "13 3229-9350"), o nome
// e a mensagem pré-pronta (editável no modal). Compartilhado pela aba
// Fornecedores ("Chamar") e pelo Nova Solicitação ("Pedir cotação").
interface WhatsappTarget { to: string; name: string; message: string }

// Telefone do contato → dígitos com DDI 55 (formato wa.me / Evolution). Vazio
// quando não dá pra extrair número (contato pode ser e-mail, "—" ou texto).
function waDigits(raw: string | null | undefined): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("55") ? digits : `55${digits}`;
}
// Só vale "chamar no WhatsApp" com um telefone plausível: 55 + DDD(2) + 8/9 dígitos.
function hasWhatsapp(raw: string | null | undefined): boolean {
  return waDigits(raw).length >= 12;
}

// Saudação padrão pra "Chamar no WhatsApp" da aba Fornecedores.
const SUPPLIER_GREETING =
  "Olá! Aqui é da *Cargo Ships Cleaning*. Tudo bem?\n\n" +
  "Gostaríamos de fazer uma cotação. Pode nos atender?";

// Mensagem de cotação disparada do Nova Solicitação — já leva o produto pedido.
function supplierQuoteMessage(opts: { toolName: string; quantity: number; productUrl?: string | null }): string {
  const qty = opts.quantity > 0 ? opts.quantity : 1;
  const link = opts.productUrl?.trim() ? `\n🔗 ${opts.productUrl.trim()}` : "";
  return (
    "Olá! Aqui é da *Cargo Ships Cleaning*. Tudo bem?\n\n" +
    "Gostaríamos de uma cotação:\n\n" +
    `📦 *${opts.toolName.trim() || "Produto"}*\n` +
    `🔢 Quantidade: ${qty}${link}\n\n` +
    "Consegue nos passar preço e disponibilidade? Obrigado!"
  );
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
  const [ships, setShips] = useState<Ship[]>([]);
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
  // Filtros do Controle de Compras — também alimentam o relatório em Excel.
  const [filterYear, setFilterYear] = useState(String(now.getFullYear()));
  const [filterMonth, setFilterMonth] = useState(String(now.getMonth() + 1)); // "1".."12" | "" = ano inteiro
  const [filterDept, setFilterDept] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterPayment, setFilterPayment] = useState("");
  const [filterShip, setFilterShip] = useState("");
  const [generatingReport, setGeneratingReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  // Fornecedores
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [editSupplier, setEditSupplier] = useState<Supplier | null>(null);
  const [deleteSupplier, setDeleteSupplier] = useState<Supplier | null>(null);
  const [supplierSearch, setSupplierSearch] = useState("");
  // Chamar o fornecedor no WhatsApp da Cargo (mensagem pré-pronta e editável).
  // Aberto pela aba Fornecedores e pelo Nova Solicitação (pedido de cotação).
  const [whatsappTarget, setWhatsappTarget] = useState<WhatsappTarget | null>(null);

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
      const [reqRes, linksRes, suppRes, purchRes, shipsRes] = await Promise.all([
        db.from("tool_requests").select("*").order("created_at", { ascending: false }),
        db.from("product_links").select("*").order("category").order("name"),
        db.from("suppliers").select("*").order("name"),
        db.from("purchase_orders").select("*").order("purchase_date", { ascending: false }).order("created_at", { ascending: false }),
        // Navios pro seletor de "Navio" do Nova Compra (mais recentes primeiro).
        db.from("ships").select("id, name, status, port, arrival_date").order("created_at", { ascending: false }),
      ]);

      const errors: string[] = [];
      if (reqRes.error) errors.push(`tool_requests: ${reqRes.error.code} ${reqRes.error.message}`);
      if (linksRes.error) errors.push(`product_links: ${linksRes.error.code} ${linksRes.error.message}`);
      if (suppRes.error) errors.push(`suppliers: ${suppRes.error.code} ${suppRes.error.message}`);
      if (purchRes.error) errors.push(`purchase_orders: ${purchRes.error.code} ${purchRes.error.message}`);
      if (shipsRes.error) errors.push(`ships: ${shipsRes.error.code} ${shipsRes.error.message}`);
      if (errors.length > 0) {
        console.error("DB errors:", errors);
        setDbError(errors.join(" | "));
      }

      setRequests((reqRes.data as ToolRequest[]) || []);
      setProductLinks((linksRes.data as ProductLink[]) || []);
      setSuppliers((suppRes.data as Supplier[]) || []);
      setPurchases((purchRes.data as PurchaseOrder[]) || []);
      setShips((shipsRes.data as Ship[]) || []);
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
    department: string; code: string | null;
  }) {
    setSaving(true);
    setSaveError(null);
    try {
      // Código no Almoxarifado: usa o que o usuário escolheu; em branco, GERA pelo
      // nome no setor de destino (próximo do prefixo) — assim todo item, mesmo novo,
      // já nasce com código, sem precisar cadastrar antes no Almoxarifado.
      const code = data.code || (await resolveWarehouseCode(data.department as WarehouseDest, data.toolName));

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
          department: data.department,
          code,
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
        department: data.department,
        code,
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
  async function handleConcludeRequest(data: ApproveData) {
    const req = concludeRequest;
    if (!req) return;
    setSaving(true);
    setSaveError(null);
    setSaveOk(null);
    try {
      const actor = profile?.full_name || "Sistema";
      const spec = data.spec;
      // Valores conferidos/ajustados pelo gestor no modal (pré-preenchidos da
      // solicitação). A compra e a reposição usam estes, não mais os da solicitação.
      const unit = data.unitValue;
      const qty = data.quantity > 0 ? data.quantity : 1;
      const description = data.toolName.trim() || req.tool_name;
      const supplier = data.supplier?.trim() || null;
      const today = new Date();
      const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const purchaseDate = data.purchaseDate || todayISO;
      // Código no Almoxarifado: usa o conferido na aprovação; em branco, GERA pelo
      // nome no setor escolhido (mesma regra do Almoxarifado). O destino pode ter
      // mudado aqui (ex.: o gestor trocou Estoque→Maquinário), então geramos pro
      // destino atual em vez de usar o código antigo da solicitação.
      const effectiveCode = data.code || (await resolveWarehouseCode(spec.dest, description));

      // 1) Registra a compra com os dados conferidos na aprovação.
      const { error: buyErr } = await db.from("purchase_orders").insert({
        description,
        department: spec.dest === "OUTROS" ? null : spec.dest,
        code: effectiveCode,
        supplier,
        purchase_date: purchaseDate,
        unit_value: unit,
        quantity: qty,
        total_value: unit * qty,
        payment_method: data.paymentMethod || null,
        notes: null,
        image_url: req.image_url,
        request_id: req.id,
        created_by: actor,
      } as any);
      if (buyErr) throw buyErr;

      // 2) Marca a solicitação como concluída e guarda os valores conferidos
      //    (o card passa a refletir o que foi de fato aprovado). quantity é Int
      //    na tabela — arredonda o que pode ter vindo decimal do campo.
      const { error: updErr } = await db.from("tool_requests").update({
        status: "APROVADO",
        responded_by: actor,
        tool_name: description,
        quantity: Math.max(1, Math.round(qty)),
        estimated_value: unit,
        supplier,
        // Reflete no card o destino e o código de fato usados (podem ter mudado aqui).
        department: spec.dest === "OUTROS" ? null : spec.dest,
        code: effectiveCode,
        updated_at: new Date().toISOString(),
      } as any).eq("id", req.id);
      if (updErr) throw updErr;

      // 3) Lança no destino escolhido do Almoxarifado (não-fatal: a compra já
      // foi salva). Escritório/Outros = só registra, não lança em estoque nenhum.
      let stockMsg = "";
      if (destStocks(spec.dest)) {
        try {
          const r = await storeInWarehouse(spec.dest, {
            name: description, quantity: qty,
            category: spec.category, unit: spec.unit, team: spec.team, size: spec.size,
            code: effectiveCode,
          });
          stockMsg = ` ${r.created ? "Criado" : "Reposto"} (+${formatQty(r.quantity)}) em ${r.where}.`;
        } catch (stockErr: any) {
          stockMsg = ` ⚠️ Falhou ao lançar no Almoxarifado: ${stockErr?.message || String(stockErr)}`;
        }
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
            toolName: description,
            quantity: qty,
            value: unit,
            supplier,
            requestedBy: req.requested_by,
            concludedBy: actor,
            productUrl: req.product_url,
            imageUrl: req.image_url,
          }),
        });
        const respData = await res.json().catch(() => null);
        if (respData?.sent) {
          const where = respData.group ? `no(s) grupo(s) ${respData.group}` : "no grupo";
          groupMsg = respData.withPhoto
            ? ` 📨 Avisado ${where} (com foto).`
            : ` 📨 Avisado ${where}${respData.photoError ? ` (foto falhou: ${respData.photoError})` : ""}.`;
        } else if (respData?.warning) {
          groupMsg = ` ⚠️ ${respData.warning}`;
        }
      } catch {
        groupMsg = " ⚠️ Não consegui avisar o grupo Compras.";
      }

      setConcludeRequest(null);
      setSaveOk(`✅ "${description}" concluído — compra registrada.${stockMsg}${groupMsg}`);
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
  const storeInStock = useCallback(async (opts: { name: string; quantity: number; category: string; code?: string | null; team?: string }) => {
    const actor = profile?.full_name || "Sistema";
    const name = (opts.name || "").trim();
    const qty = opts.quantity > 0 ? opts.quantity : 1;
    const category = (opts.category || "").trim() || "Outros";
    // Sentinela do inventário: GALPAO (Estoque) por padrão, ou FERRAMENTA/ELETRICA.
    const team = opts.team || STOCK_TEAM;
    if (!name) throw new Error("Nome do material vazio");

    // Procura o material existente no galpão pelo CÓDIGO (se informado) ou pelo nome
    // (match exato, sem caixa) — o cliente db não tem "equals" case-insensitive, então
    // casamos em JS. Código informado repõe exatamente aquele item.
    const { data: galpao, error: loadErr } = await db
      .from("stock_items")
      .select("id, name, quantity, location")
      .eq("team", team);
    if (loadErr) throw new Error(loadErr.message);
    const items = (galpao || []) as { id: number; name: string; quantity: number; location: string | null }[];
    const existing = findItemByCodeOrName(items, opts.code, name);

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
        team,
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

  // Ponte genérica Compras/Solicitações → Almoxarifado INTEIRO. Lança o item no
  // setor escolhido (`dest`), com casamento por nome onde faz sentido (repõe a
  // quantidade em vez de duplicar). Maquinário não tem quantidade: cada unidade
  // comprada vira uma máquina (status Disponível). Devolve um resumo pro toast.
  const storeInWarehouse = useCallback(async (
    dest: WarehouseDest,
    opts: { name: string; quantity: number; category?: string; unit?: string; team?: string; size?: string; code?: string | null },
  ): Promise<{ created: boolean; where: string; quantity: number }> => {
    const actor = profile?.full_name || "Sistema";
    const name = (opts.name || "").trim();
    if (!name) throw new Error("Nome do item vazio");
    const qty = opts.quantity > 0 ? opts.quantity : 1;
    const norm = (s: string) => (s || "").trim().toLowerCase();
    const round3 = (n: number) => Math.round(n * 1000) / 1000;
    const teamLbl = (t: string) => RANCHO_TEAMS.find((x) => x.value === t)?.label || t;

    // Estoque do galpão — reaproveita a ponte existente (stock_items team=GALPAO).
    if (dest === "ESTOQUE") {
      const r = await storeInStock({ name, quantity: qty, category: opts.category || "Outros", code: opts.code });
      return { created: r.created, where: `Estoque${r.category ? ` · ${r.category}` : ""}`, quantity: r.quantity };
    }

    // Rancho — comida por equipe (stock_items com team=EQUIPE_x). Casa por nome
    // dentro da equipe e soma; senão cria o item de comida.
    if (dest === "RANCHO") {
      const team = opts.team || "EQUIPE_1";
      const category = opts.category || "SUPRIMENTOS";
      const unit = opts.unit || "UN";
      const { data, error } = await db.from("stock_items").select("id, name, quantity").eq("team", team);
      if (error) throw new Error(error.message);
      const existing = findItemByCodeOrName(
        (data || []) as { id: number; name: string; quantity: number }[], opts.code, name,
      );
      let id: number | undefined;
      let created: boolean;
      if (existing) {
        created = false; id = existing.id;
        const { error: e } = await db.from("stock_items").update({
          quantity: round3(Number(existing.quantity || 0) + qty), updated_by: actor,
        } as any).eq("id", id);
        if (e) throw new Error(e.message);
      } else {
        created = true;
        const { data: ins, error: e } = await db.from("stock_items").insert({
          name, category, unit, quantity: qty, default_quantity: qty, team, min_quantity: 0, updated_by: actor,
        } as any);
        if (e) throw new Error(e.message);
        id = (ins as any)?.id;
      }
      if (id) {
        try {
          await db.from("stock_movements").insert({
            stock_item_id: id, movement_type: "ENTRADA", quantity: qty,
            movement_date: new Date().toISOString().split("T")[0],
            notes: "Entrada via Compras/Solicitações", created_by: actor,
          } as any);
        } catch { /* histórico best-effort */ }
      }
      return { created, where: `Rancho · ${teamLbl(team)}`, quantity: qty };
    }

    // EPI / Uniforme — tabelas próprias (epis/uniforms), quantidade INTEIRA.
    // Casa por nome (+ tamanho) e soma o stock_qty.
    if (dest === "EPI" || dest === "UNIFORME") {
      const table = dest === "EPI" ? "epis" : "uniforms";
      const size = (opts.size || "").trim() || null;
      const addQty = Math.max(1, Math.round(qty));
      const { data, error } = await db.from(table).select("id, name, size, stock_qty");
      if (error) throw new Error(error.message);
      // Com código, ele identifica o item sozinho (ignora o tamanho); sem código,
      // casa por nome + tamanho como antes (Luva P ≠ Luva G).
      const items = (data || []) as { id: number; name: string; size: string | null; stock_qty: number }[];
      const existing = (opts.code || "").trim()
        ? findItemByCodeOrName(items, opts.code, name)
        : items.find((s) => norm(s.name) === norm(name) && norm(s.size || "") === norm(size || ""));
      let created: boolean;
      if (existing) {
        created = false;
        const { error: e } = await db.from(table).update({
          stock_qty: Number(existing.stock_qty || 0) + addQty, updated_by: actor,
        } as any).eq("id", existing.id);
        if (e) throw new Error(e.message);
      } else {
        created = true;
        const { error: e } = await db.from(table).insert({
          name, size, stock_qty: addQty, min_quantity: 0, updated_by: actor,
        } as any);
        if (e) throw new Error(e.message);
      }
      return { created, where: dest === "EPI" ? "EPI" : "Uniforme", quantity: addQty };
    }

    // Ferramenta / Elétrica — inventário com quantidade (stock_items com o team
    // sentinela do setor). Mesma ponte do Estoque: casa por código/nome e soma a
    // quantidade (reposição) em vez de criar uma linha por unidade.
    if (dest === "FERRAMENTA" || dest === "ELETRICA") {
      const r = await storeInStock({ name, quantity: qty, category: opts.category || "Outros", code: opts.code, team: dest });
      const label = dest === "FERRAMENTA" ? "Ferramenta" : "Elétrica";
      return { created: r.created, where: `${label}${r.category && r.category !== "Outros" ? ` · ${r.category}` : ""}`, quantity: r.quantity };
    }

    // Maquinário — tabela `tools` (asset_type), cada unidade é um registro próprio
    // (controle de empréstimo), sem quantidade. Cria N itens Disponíveis (limite
    // de segurança de 50 por lançamento).
    if (dest === "MAQUINARIO") {
      const units = Math.min(50, Math.max(1, Math.round(qty)));
      for (let i = 0; i < units; i++) {
        const { error } = await db.from("tools").insert({
          name, asset_type: dest, status: "DISPONIVEL", updated_by: actor,
        } as any);
        if (error) throw new Error(error.message);
      }
      return { created: true, where: "Maquinário", quantity: units };
    }

    throw new Error(`Destino inválido: ${dest}`);
  }, [profile, storeInStock]);

  async function handleSavePurchase(
    data: Partial<PurchaseOrder>,
    fromRequestId: string | null,
    stock?: DestSpec | null,
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
        // Código no Almoxarifado: usa o escolhido; em branco, GERA pelo nome no setor
        // de destino (próximo do prefixo, mesma regra do Almoxarifado). Setor sem
        // código devolve null. Mesmo código vai pra compra e pra reposição.
        const code = data.code || (stock ? await resolveWarehouseCode(stock.dest, data.description || "") : null);
        const { error } = await db.from("purchase_orders").insert({
          ...data,
          code,
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
        // Lança no destino escolhido do Almoxarifado, se houver. Falha aqui é
        // não-fatal: a compra já foi salva, só avisamos.
        if (stock && destStocks(stock.dest)) {
          try {
            const r = await storeInWarehouse(stock.dest, {
              name: data.description || "",
              quantity: Number(data.quantity) || 1,
              category: stock.category, unit: stock.unit, team: stock.team, size: stock.size,
              code,
            });
            setSaveOk(
              `📦 ${r.created ? "Criado" : "Reposto"}: "${data.description}" (+${formatQty(r.quantity)}) em ${r.where}.`,
            );
          } catch (stockErr: any) {
            setSaveError(`Compra salva, mas falhou ao lançar no Almoxarifado: ${stockErr?.message || String(stockErr)}`);
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

  // "Armazenar no Almoxarifado" a partir de uma solicitação já comprada (botão no
  // card) — agora pode cair em qualquer setor (Estoque/Rancho/EPI/Uniforme/Maquinário).
  async function handleStoreInWarehouse(spec: DestSpec) {
    if (!stockRequest) return;
    if (!destStocks(spec.dest)) { setStockRequest(null); return; }
    setSaving(true);
    setSaveError(null);
    setSaveOk(null);
    try {
      // Código: usa o da solicitação; em branco, gera pelo nome no setor escolhido.
      const code = stockRequest.code || (await resolveWarehouseCode(spec.dest, stockRequest.tool_name));
      const r = await storeInWarehouse(spec.dest, {
        name: stockRequest.tool_name,
        quantity: stockRequest.quantity,
        category: spec.category, unit: spec.unit, team: spec.team, size: spec.size,
        code,
      });
      const itemName = stockRequest.tool_name;
      setStockRequest(null);
      setSaveOk(
        `📦 ${r.created ? "Criado" : "Reposto"}: "${itemName}" (+${formatQty(r.quantity)}) em ${r.where}.`,
      );
    } catch (err: any) {
      console.error("Erro ao lançar no Almoxarifado:", err);
      setSaveError(`Erro ao lançar no Almoxarifado: ${err?.message || String(err)}`);
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

  // --- Controle de Compras: filtros + dados derivados ---
  // Os mesmos filtros valem pra lista em tela e pro relatório em Excel.
  const filteredPurchases = purchases.filter((p) => {
    const iso = (p.purchase_date || "").slice(0, 10);
    if (!iso) return false; // sem data não entra num relatório por período
    const [y, m] = iso.split("-");
    if (filterYear && y !== filterYear) return false;
    if (filterMonth && String(Number(m)) !== filterMonth) return false;
    if (filterDept && (p.department || "") !== filterDept) return false;
    if (filterSupplier && (p.supplier || "") !== filterSupplier) return false;
    if (filterPayment && (p.payment_method || "") !== filterPayment) return false;
    if (filterShip && (p.ship_name || "") !== filterShip) return false;
    return true;
  });
  const filteredTotal = filteredPurchases.reduce((sum, p) => sum + (p.total_value || 0), 0);
  const filteredCount = filteredPurchases.length;
  const periodLabel = filterMonth
    ? `${MONTH_NAMES[Number(filterMonth) - 1]} de ${filterYear}`
    : `Ano de ${filterYear}`;

  // Opções dos selects, derivadas das compras já carregadas (só valores reais).
  const purchaseYears = Array.from(
    new Set([String(now.getFullYear()), ...purchases.map((p) => (p.purchase_date || "").slice(0, 4)).filter(Boolean)])
  ).sort((a, b) => b.localeCompare(a));
  const purchaseDepts = Array.from(new Set(purchases.map((p) => p.department).filter(Boolean) as string[])).sort();
  const purchaseSuppliers = Array.from(new Set(purchases.map((p) => p.supplier).filter(Boolean) as string[]))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const purchasePayments = Array.from(new Set(purchases.map((p) => p.payment_method).filter(Boolean) as string[])).sort();
  const purchaseShips = Array.from(new Set(purchases.map((p) => p.ship_name).filter(Boolean) as string[]))
    .sort((a, b) => a.localeCompare(b, "pt-BR"));
  const selCls = "px-3 py-2 border border-border rounded-lg text-sm bg-card focus:ring-2 focus:ring-primary outline-none";

  // Baixa o relatório em Excel do período/filtros atuais (layout da planilha oficial).
  async function handleGenerateReport() {
    setReportError(null);
    setGeneratingReport(true);
    try {
      const params = new URLSearchParams({ year: filterYear });
      if (filterMonth) params.set("month", filterMonth);
      if (filterDept) params.set("department", filterDept);
      if (filterSupplier) params.set("supplier", filterSupplier);
      if (filterPayment) params.set("payment_method", filterPayment);
      if (filterShip) params.set("ship", filterShip);
      const res = await fetch(`/api/documents/controle-compras?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Erro ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Controle de Compras - ${periodLabel}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setReportError(err instanceof Error ? err.message : "Falha ao gerar relatório.");
    } finally {
      setGeneratingReport(false);
    }
  }

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
                  <div
                    key={req.id}
                    onClick={canEditRequests ? (e) => {
                      // Clicar no card = editar. Ignora cliques nos botões/links
                      // internos (imagem, ver produto, Aprovar, Armazenar, editar,
                      // excluir) — eles têm ação própria e não devem abrir a edição.
                      if ((e.target as HTMLElement).closest("button, a")) return;
                      setEditRequest(req);
                      setShowRequestForm(true);
                    } : undefined}
                    className={`bg-card border border-border rounded-xl p-4 hover:shadow-sm transition ${canEditRequests ? "cursor-pointer" : ""}`}
                  >
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
                        {(req.estimated_value != null || req.supplier || req.product_url || req.department || req.code) && (
                          <div className="flex gap-2 mt-2 flex-wrap items-center">
                            {req.code && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-mono font-medium" title="Código no Almoxarifado">
                                🏷️ {req.code}
                              </span>
                            )}
                            {req.department && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium" title="Destino sugerido no Almoxarifado">
                                📍 {departmentLabel(req.department)}
                              </span>
                            )}
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
                            title="Registra a compra e lança no Almoxarifado (você escolhe o setor)"
                          >
                            Aprovar
                          </button>
                        )}
                        {canManagePurchases && req.status === "COMPRADO" && (
                          <button
                            onClick={() => setStockRequest(req)}
                            className="px-3 py-1.5 text-xs bg-emerald-50 text-emerald-700 rounded-lg hover:bg-emerald-100 font-medium transition"
                            title="Lançar este item no Almoxarifado (Estoque/Rancho/EPI/Uniforme/Maquinário)"
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

          {/* Filtros + total + relatório */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-text-light font-medium uppercase tracking-wide">Ano</span>
                <select value={filterYear} onChange={(e) => setFilterYear(e.target.value)} className={selCls}>
                  {purchaseYears.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-text-light font-medium uppercase tracking-wide">Mês</span>
                <select value={filterMonth} onChange={(e) => setFilterMonth(e.target.value)} className={selCls}>
                  <option value="">Ano inteiro</option>
                  {MONTH_NAMES.map((nm, i) => <option key={i} value={String(i + 1)}>{nm}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-text-light font-medium uppercase tracking-wide">Destino</span>
                <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)} className={selCls}>
                  <option value="">Todos</option>
                  {purchaseDepts.map((d) => <option key={d} value={d}>{departmentLabel(d)}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-text-light font-medium uppercase tracking-wide">Fornecedor</span>
                <select value={filterSupplier} onChange={(e) => setFilterSupplier(e.target.value)} className={`${selCls} max-w-[200px]`}>
                  <option value="">Todos</option>
                  {purchaseSuppliers.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-text-light font-medium uppercase tracking-wide">Pagamento</span>
                <select value={filterPayment} onChange={(e) => setFilterPayment(e.target.value)} className={selCls}>
                  <option value="">Todas</option>
                  {purchasePayments.map((pm) => <option key={pm} value={pm}>{pm}</option>)}
                </select>
              </label>
              {purchaseShips.length > 0 && (
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-text-light font-medium uppercase tracking-wide">Navio</span>
                  <select value={filterShip} onChange={(e) => setFilterShip(e.target.value)} className={`${selCls} max-w-[200px]`}>
                    <option value="">Todos</option>
                    {purchaseShips.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              )}
              {(filterMonth || filterDept || filterSupplier || filterPayment || filterShip) && (
                <button
                  type="button"
                  onClick={() => { setFilterMonth(""); setFilterDept(""); setFilterSupplier(""); setFilterPayment(""); setFilterShip(""); }}
                  className="text-xs text-text-light underline hover:text-text pb-2.5"
                >
                  Limpar filtros
                </button>
              )}

              <div className="flex-1" />

              <Button size="sm" variant="secondary" onClick={handleGenerateReport} disabled={generatingReport || filteredCount === 0}>
                {generatingReport ? "Gerando..." : "📊 Gerar Relatório (Excel)"}
              </Button>

              <div className="bg-primary/5 border border-primary/20 rounded-xl px-4 py-2.5 text-right">
                <p className="text-[11px] uppercase tracking-wide text-text-light">Total · {periodLabel}</p>
                <p className="text-lg font-bold text-primary">{formatCurrency(filteredTotal)}</p>
                <p className="text-[11px] text-text-light">{filteredCount} {filteredCount === 1 ? "compra" : "compras"}</p>
              </div>
            </div>
            {reportError && <p className="text-xs text-danger">⚠️ {reportError}</p>}
          </div>

          {/* Lista de compras do mês */}
          {filteredPurchases.length === 0 ? (
            <div className="text-center py-12 text-text-light">
              <span className="text-4xl block mb-3">🧾</span>
              <p className="font-medium">Nenhuma compra em {periodLabel}</p>
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
                      <th className="text-left font-medium px-3 py-2.5">Navio</th>
                      <th className="text-left font-medium px-3 py-2.5">Data</th>
                      <th className="text-right font-medium px-3 py-2.5">Unit.</th>
                      <th className="text-right font-medium px-3 py-2.5">Qtd</th>
                      <th className="text-right font-medium px-3 py-2.5">Total</th>
                      <th className="text-left font-medium px-3 py-2.5">Pagamento</th>
                      {canManagePurchases && <th className="px-3 py-2.5"></th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {filteredPurchases.map((p) => (
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
                              {p.code && <span className="text-[10px] font-mono text-text-light">{p.code}</span>}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          {p.department ? (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${DEPARTMENT_BADGE[p.department] || "bg-gray-100 text-gray-700"}`}>{departmentLabel(p.department)}</span>
                          ) : "—"}
                        </td>
                        <td className="px-3 py-2.5">{p.supplier || "—"}</td>
                        <td className="px-3 py-2.5">
                          {p.ship_name ? (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-sky-100 text-sky-700 font-medium whitespace-nowrap" title="Navio vinculado">🚢 {p.ship_name}</span>
                          ) : "—"}
                        </td>
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
                      <td className="px-3 py-2.5" colSpan={7}>Total</td>
                      <td className="px-3 py-2.5 text-right text-primary whitespace-nowrap">{formatCurrency(filteredTotal)}</td>
                      <td className="px-3 py-2.5" colSpan={canManagePurchases ? 2 : 1}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Cards (mobile) */}
              <div className="md:hidden space-y-3">
                {filteredPurchases.map((p) => (
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
                          {p.code && <span className="font-mono">{p.code}</span>}
                          {p.department && <span className={`px-1.5 py-0.5 rounded-full font-medium ${DEPARTMENT_BADGE[p.department] || "bg-gray-100 text-gray-700"}`}>{departmentLabel(p.department)}</span>}
                          {p.ship_name && <span className="px-1.5 py-0.5 rounded-full font-medium bg-sky-100 text-sky-700">🚢 {p.ship_name}</span>}
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
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="shrink-0">📞</span>
                          <span>{s.contact || "—"}</span>
                          {hasWhatsapp(s.contact) && (
                            <button
                              type="button"
                              onClick={() => setWhatsappTarget({ to: s.contact!, name: s.name, message: SUPPLIER_GREETING })}
                              className="ml-1 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 px-2 py-0.5 rounded-full transition"
                              title="Chamar no WhatsApp da Cargo"
                            >
                              <WhatsappIcon className="w-3.5 h-3.5" /> Chamar
                            </button>
                          )}
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
      <RequestFormModal open={showRequestForm} onClose={() => { setShowRequestForm(false); setEditRequest(null); }} onSave={handleSaveRequest} item={editRequest} suppliers={suppliers} saving={saving} onAskSupplier={setWhatsappTarget} />

      {/* Chamar fornecedor no WhatsApp (aba Fornecedores + Nova Solicitação) */}
      <WhatsappSupplierModal open={!!whatsappTarget} onClose={() => setWhatsappTarget(null)} target={whatsappTarget} />

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

      {/* Aprovar = concluir: registra a compra + lança no destino do Almoxarifado */}
      <AprovarModal
        open={!!concludeRequest}
        onClose={() => setConcludeRequest(null)}
        onConfirm={handleConcludeRequest}
        request={concludeRequest}
        suppliers={suppliers}
        saving={saving}
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
        ships={ships}
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

      {/* Armazenar no Almoxarifado (a partir de uma solicitação comprada) */}
      <ArmazenarEstoqueModal
        open={!!stockRequest}
        onClose={() => setStockRequest(null)}
        onConfirm={handleStoreInWarehouse}
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

// Campo de link do produto com auto-preenchimento (Open Graph / JSON-LD via
// /api/solicitacoes/link-preview). Compartilhado por Nova Solicitação e Nova
// Compra. O pai guarda o `link`; ao buscar, devolve os dados via onData(data,
// force) e o pai decide em quais campos aplicar.
function ProductLinkField({ link, onLinkChange, onData, open }: {
  link: string;
  onLinkChange: (v: string) => void;
  onData: (data: { name?: string; value?: number; supplier?: string; image?: string }, force: boolean) => void;
  open: boolean;
}) {
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const lastFetchedRef = useRef<string>("");
  const isUrl = (s: string) => /^https?:\/\/.+/i.test(s.trim());

  // Ao (re)abrir, marca o link atual como "já buscado" pra não auto-buscar um
  // link que já veio salvo (edição), e limpa o estado de busca.
  useEffect(() => {
    if (open) { lastFetchedRef.current = link.trim(); setFetching(false); setFetchError(null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Busca os dados do link no servidor. `force` sobrescreve campos já preenchidos;
  // sem force, o pai só preenche o que estiver vazio.
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
      onData({ name: data.name, value: data.value, supplier: data.supplier, image: data.image }, force);
      if (!data.name && data.value == null && !data.image) {
        setFetchError("Não achei dados nessa página. Preencha manualmente.");
      }
    } catch {
      setFetchError("Não consegui buscar os dados do link.");
    } finally {
      setFetching(false);
    }
  }, [onData]);

  // Auto-busca ao colar/digitar o link (debounce), só com o modal aberto.
  useEffect(() => {
    if (!open) return;
    const u = link.trim();
    if (!isUrl(u) || u === lastFetchedRef.current) return;
    const t = setTimeout(() => { fetchPreview(u, false); }, 700);
    return () => clearTimeout(t);
  }, [link, open, fetchPreview]);

  return (
    <div>
      <label className="block text-sm font-medium mb-1">Link do produto (opcional)</label>
      <div className="flex gap-2">
        <input type="url" value={link} onChange={(e) => onLinkChange(e.target.value)}
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
  );
}

function RequestFormModal({ open, onClose, onSave, item, suppliers, saving, onAskSupplier }: {
  open: boolean; onClose: () => void;
  onSave: (data: {
    toolName: string; quantity: number; reason: string; imageUrl: string | null;
    productUrl: string | null; estimatedValue: number | null; supplier: string | null;
    department: string; code: string | null;
  }) => void;
  item: ToolRequest | null;
  suppliers: Supplier[];
  saving: boolean;
  onAskSupplier: (target: WhatsappTarget) => void;
}) {
  const [toolName, setToolName] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [reason, setReason] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [value, setValue] = useState("");
  const [supplier, setSupplier] = useState("");
  // Destino sugerido no Almoxarifado — o gestor confirma/ajusta ao aprovar.
  const [dest, setDest] = useState<WarehouseDest>("ESTOQUE");
  // Código do item no Almoxarifado (opcional) — repõe aquele item exato ao abastecer.
  const [code, setCode] = useState("");

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
      setDest((item.department as WarehouseDest) || "ESTOQUE");
      setCode(item.code || "");
    } else {
      setToolName(""); setQuantity(1); setReason(""); setImageUrl(null);
      setLink(""); setValue(""); setSupplier(""); setDest("ESTOQUE"); setCode("");
    }
  }, [open, item]);

  // Aplica os dados puxados do link (sem sobrescrever o que o usuário já digitou,
  // exceto no "Buscar" manual com force=true).
  const applyPreview = useCallback((d: { name?: string; value?: number; supplier?: string; image?: string }, force: boolean) => {
    if (d.name) setToolName((p) => (force || !p.trim() ? d.name! : p));
    if (d.value != null) setValue((p) => (force || !p.trim() ? String(d.value).replace(".", ",") : p));
    if (d.supplier) setSupplier((p) => (force || !p.trim() ? d.supplier! : p));
    if (d.image) setImageUrl((p) => (force || !p ? d.image! : p));
  }, []);

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      toolName, quantity, reason, imageUrl,
      productUrl: link.trim() || null,
      estimatedValue: value.trim() ? parseDecimalBR(value) : null,
      supplier: supplier.trim() || null,
      department: dest,
      code: code.trim().toUpperCase() || null,
    });
  }

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Solicitação" : "Nova Solicitação"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <ProductLinkField link={link} onLinkChange={setLink} onData={applyPreview} open={open} />
        <div>
          <label className="block text-sm font-medium mb-1">Produto / Equipamento *</label>
          <input type="text" value={toolName} onChange={(e) => setToolName(e.target.value)} required
            placeholder="Ex: Furadeira, Chave inglesa, Luvas..." className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Destino no Almoxarifado</label>
          <select value={dest} onChange={(e) => { setDest(e.target.value as WarehouseDest); setCode(""); }} className={inputCls}>
            {WAREHOUSE_DESTINATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
          <p className="text-[10px] text-text-light mt-1">Sugestão de onde guardar — o gestor confirma ao aprovar.</p>
        </div>
        <CodeField dest={dest} team="EQUIPE_1" value={code} name={toolName} onChange={setCode} onResolveName={setToolName} open={open} />
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
        {/* Cotação no WhatsApp: aparece quando o fornecedor escolhido está
            cadastrado e tem telefone, e já há um produto digitado. */}
        {(() => {
          const matched = suppliers.find((s) => s.name === supplier);
          if (!matched || !hasWhatsapp(matched.contact) || !toolName.trim()) return null;
          return (
            <button
              type="button"
              onClick={() => onAskSupplier({
                to: matched.contact!,
                name: matched.name,
                message: supplierQuoteMessage({ toolName, quantity, productUrl: link }),
              })}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 px-3 py-2 rounded-lg transition"
            >
              <WhatsappIcon className="w-4 h-4" /> Pedir cotação a {matched.name} no WhatsApp
            </button>
          );
        })()}
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

// Destinos cujos itens têm "Código" no Almoxarifado (gerado por setor a partir do
// nome — buildCodeMap). Maquinário (cada unidade é um registro próprio), Rancho
// (card #46: só registra a compra, sem mexer no estoque), Escritório e Outros não
// têm código, então o campo não aparece pra eles.
const CODED_DESTS: WarehouseDest[] = ["ESTOQUE", "EPI", "UNIFORME", "FERRAMENTA", "ELETRICA", "MAQUINARIO"];

// Item cru do setor de destino (id + nome, + tamanho/estoque pro autocomplete).
// Base tanto do autocomplete de código quanto da geração automática (codeForName).
interface WarehouseItem { id: number; name: string; size: string | null; qty: number | null }

// Item do Almoxarifado já com o código derivado, pro autocomplete do CodeField.
// `size` só existe em EPI/Uniforme (é o que diferencia itens de mesmo nome, ex.:
// "Bota de borracha" em vários tamanhos); `qty` é o estoque atual. Maquinário não
// tem quantidade (cada unidade é um registro próprio), então vem sem qty.
interface WarehouseCode { code: string; name: string; size: string | null; qty: number | null }

// Carrega os itens do setor de destino (id+nome, +tamanho/estoque). Compartilhado
// pelo autocomplete (useWarehouseCodes) e pela geração automática de código nas
// ações (resolveWarehouseCode). Setores sem código devolvem lista vazia.
async function loadWarehouseItems(dest: WarehouseDest): Promise<WarehouseItem[]> {
  if (!CODED_DESTS.includes(dest)) return [];
  if (dest === "ESTOQUE") {
    const { data } = await db.from("stock_items").select("id, name, quantity").eq("team", STOCK_TEAM);
    return ((data as any[]) || []).map((i) => ({ id: i.id, name: i.name, size: null, qty: i.quantity }));
  }
  if (dest === "FERRAMENTA" || dest === "ELETRICA") {
    const { data } = await db.from("stock_items").select("id, name, quantity").eq("team", dest);
    return ((data as any[]) || []).map((i) => ({ id: i.id, name: i.name, size: null, qty: i.quantity }));
  }
  if (dest === "MAQUINARIO") {
    // Maquinário vive na tabela `tools` (empréstimo), não em stock_items — sem quantidade.
    const { data } = await db.from("tools").select("id, name").eq("asset_type", "MAQUINARIO");
    return ((data as any[]) || []).map((i) => ({ id: i.id, name: i.name, size: null, qty: null }));
  }
  // EPI / Uniforme — têm tamanho e estoque próprio (stock_qty).
  const { data } = await db.from(dest === "EPI" ? "epis" : "uniforms").select("id, name, size, stock_qty");
  return ((data as any[]) || []).map((i) => ({ id: i.id, name: i.name, size: i.size ?? null, qty: i.stock_qty }));
}

// Código do item pro setor de destino, a partir do nome: usa o código de um item de
// mesmo nome se já existir; senão gera o próximo código do prefixo (codeForName). É
// o que faz "gerar código pelo nome quando o Almoxarifado ainda não tem o
// equipamento". Setores sem código (Rancho/Escritório/Outros) devolvem null.
async function resolveWarehouseCode(dest: WarehouseDest, name: string): Promise<string | null> {
  if (!CODED_DESTS.includes(dest)) return null;
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  const items = await loadWarehouseItems(dest);
  return codeForName(items, (i) => i.id, (i) => i.name, trimmed);
}

// Rótulo do item no autocomplete de código: nome + tamanho + estoque atual. É o que
// torna a lista "informativa" — sem o tamanho, vários itens de mesmo nome (botas,
// luvas) apareciam idênticos e só o código os distinguia.
function warehouseCodeLabel(c: WarehouseCode): string {
  const parts = [c.name];
  if (c.size && c.size.trim()) parts.push(`Tam. ${c.size.trim()}`);
  if (c.qty != null) parts.push(`${formatQty(c.qty)} em estoque`);
  return parts.join(" · ");
}

// Carrega os itens do setor de destino e devolve tanto a lista crua (pra gerar a
// sugestão de código novo) quanto os códigos derivados (mesma regra da tabela do
// Almoxarifado) + tamanho e estoque pro autocomplete. Vazio enquanto carrega ou
// pra destinos sem código. `team` fica no dep só por reatividade (futuros setores
// por equipe); hoje os setores com código são todos globais.
function useWarehouseCodes(dest: WarehouseDest, team: string, open: boolean): { codes: WarehouseCode[]; items: WarehouseItem[] } {
  const [items, setItems] = useState<WarehouseItem[]>([]);
  useEffect(() => {
    if (!open || !CODED_DESTS.includes(dest)) { setItems([]); return; }
    let cancelled = false;
    (async () => {
      const loaded = await loadWarehouseItems(dest);
      if (!cancelled) setItems(loaded);
    })();
    return () => { cancelled = true; };
  }, [dest, team, open]);
  const map = buildCodeMap(items, (i) => i.id, (i) => i.name);
  const codes = items
    .map((i) => ({ code: map.get(i.id) || "", name: i.name, size: i.size, qty: i.qty }))
    .filter((x) => x.code)
    .sort((a, b) => a.code.localeCompare(b.code));
  return { codes, items };
}

// Campo "Código no Almoxarifado" (opcional) com autocomplete dos itens do destino
// escolhido. Escolher um código repõe EXATAMENTE aquele item ao abastecer (em vez de
// casar pelo nome) e preenche o nome com o do item, pra ficar consistente com a aba
// do Almoxarifado. Em branco = o sistema GERA o código pelo nome ao salvar (próximo
// do prefixo) — não precisa mais cadastrar o item antes no Almoxarifado.
function CodeField({ dest, team, value, name = "", onChange, onResolveName, open }: {
  dest: WarehouseDest; team: string; value: string;
  // Nome do produto digitado — base da sugestão de código novo quando em branco.
  name?: string;
  onChange: (v: string) => void;
  onResolveName?: (name: string) => void;
  open: boolean;
}) {
  const { codes, items } = useWarehouseCodes(dest, team, open);
  if (!CODED_DESTS.includes(dest)) return null;
  const listId = `wh-codes-${dest}`;
  const norm = (s: string) => s.trim().toUpperCase();
  const handleChange = (v: string) => {
    onChange(v);
    // Casou um código exato → preenche o nome com o do item (consistência).
    const hit = codes.find((c) => norm(c.code) === norm(v));
    if (hit && onResolveName) onResolveName(hit.name);
  };
  // Código que será gerado se o campo ficar em branco (mesma regra do Almoxarifado).
  const suggested = name.trim() ? codeForName(items, (i) => i.id, (i) => i.name, name) : "";
  const matched = value.trim() ? codes.find((c) => norm(c.code) === norm(value)) : undefined;
  return (
    <div>
      <label className="block text-sm font-medium mb-1">
        Código no Almoxarifado{" "}
        <span className="font-normal text-text-light">(opcional)</span>
      </label>
      <input type="text" list={listId} value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={suggested ? `Em branco = gera ${suggested}` : "Ex: AR01 — escolha o item no Almoxarifado"}
        className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" />
      <datalist id={listId}>
        {codes.map((c) => <option key={c.code} value={c.code} label={warehouseCodeLabel(c)} />)}
      </datalist>
      <p className="text-[10px] text-text-light mt-1">
        {matched
          ? <>Repõe <strong>{matched.name}</strong>{matched.qty != null ? ` · ${formatQty(matched.qty)} em estoque` : ""}.</>
          : value.trim()
            ? "Código novo — o item será criado no Almoxarifado."
            : suggested
              ? <>Em branco = gera o código automaticamente pelo nome: <strong>{suggested}</strong>.</>
              : "Em branco = gera um código automático pelo nome ao salvar."}
      </p>
    </div>
  );
}

// Seletor de destino no Almoxarifado + campos específicos de cada setor.
// Controlado (o pai guarda o DestSpec). Compartilhado por Nova Compra, Aprovar
// e Armazenar. `stocking=false` (ex.: edição de compra) mostra só o seletor,
// sem campos nem lançamento, pra não contar a quantidade duas vezes.
function WarehouseDestinationFields({ value, onChange, quantity, stocking = true }: {
  value: DestSpec; onChange: (v: DestSpec) => void; quantity?: number; stocking?: boolean;
}) {
  const known = WAREHOUSE_DESTINATIONS.some((d) => d.value === value.dest);
  // Trocar de destino reseta os campos específicos pra não vazar valor de um
  // setor pro outro (ex.: "Elétrica" do Estoque indo parar na categoria do Rancho).
  const setDest = (dest: WarehouseDest) =>
    onChange({ dest, category: dest === "RANCHO" ? "SUPRIMENTOS" : "", unit: "UN", team: "EQUIPE_1", size: "" });
  const selCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium mb-1">Destino no Almoxarifado</label>
        <select value={value.dest} onChange={(e) => setDest(e.target.value as WarehouseDest)} className={selCls}>
          {!known && value.dest && <option value={value.dest}>{value.dest} (legado)</option>}
          {WAREHOUSE_DESTINATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </div>

      {/* Rancho (card #46): só registra o gasto na aba de Compras — não lança no
          Almoxarifado nem usa código, então não mostramos Equipe/Categoria/Unidade. */}
      {stocking && value.dest === "RANCHO" && (
        <div className="rounded-lg border border-border bg-gray-50 p-3 text-[11px] text-text-light">
          🍽️ Compras de <strong>Rancho</strong> apenas registram o gasto nesta aba — não entram no
          estoque do Almoxarifado nem usam código.
        </div>
      )}

      {stocking && (value.dest === "EPI" || value.dest === "UNIFORME") && (
        <p className="text-xs text-emerald-700 bg-emerald-50/60 border border-emerald-200 rounded-lg p-3">
          👕 O tamanho já vem do <strong>código</strong> do item — a quantidade é somada naquele tamanho.
          Não precisa informar o tamanho aqui.
        </p>
      )}

      {stocking && value.dest === "MAQUINARIO" && (
        <p className="text-xs text-emerald-700 bg-emerald-50/60 border border-emerald-200 rounded-lg p-3">
          ⚙️ Cada unidade vira uma máquina em <strong>Maquinário</strong>{" "}
          (status <strong>Disponível</strong>){quantity ? ` — ${Math.min(50, Math.max(1, Math.round(quantity)))} unidade(s)` : ""}.
        </p>
      )}

      {stocking && !destStocks(value.dest) && (
        <p className="text-xs text-text-light bg-gray-50 border border-border rounded-lg p-3">
          {value.dest === "ESCRITORIO"
            ? "🏢 Compra de escritório — só registra a compra, não lança no Almoxarifado."
            : "Não lança no Almoxarifado — só registra a compra."}
        </p>
      )}

      {!stocking && (
        <p className="text-[11px] text-text-light">Editar não relança no Almoxarifado (evita contar a quantidade duas vezes).</p>
      )}
    </div>
  );
}

function PurchaseFormModal({ open, onClose, onSave, item, fromRequest, suppliers, ships, saving }: {
  open: boolean; onClose: () => void;
  onSave: (data: Partial<PurchaseOrder>, fromRequestId: string | null, stock?: DestSpec | null) => void;
  item: PurchaseOrder | null;
  fromRequest: ToolRequest | null;
  suppliers: Supplier[];
  ships: Ship[];
  saving: boolean;
}) {
  const [description, setDescription] = useState("");
  const [link, setLink] = useState("");
  const [supplier, setSupplier] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [unitValue, setUnitValue] = useState("");
  const [quantity, setQuantity] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // Destino no Almoxarifado (substitui o antigo "Departamento"). Em compras novas
  // o item é lançado no setor escolhido; ao editar, o destino vira só rótulo (não
  // relança, pra não contar duas vezes).
  const [destSpec, setDestSpec] = useState<DestSpec>({ ...DEFAULT_DEST_SPEC });
  // Código do item no Almoxarifado (opcional) — repõe aquele item exato ao abastecer.
  const [code, setCode] = useState("");
  // Navio vinculado (opcional) — guarda o id do navio escolhido na aba Navios.
  const [shipId, setShipId] = useState("");

  useEffect(() => {
    if (!open) return;
    const today = new Date();
    const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    if (item) {
      setDescription(item.description || "");
      setLink(item.product_url || "");
      // Edição: o destino salvo vira só rótulo (pode ser um valor legado da planilha).
      setDestSpec({ ...DEFAULT_DEST_SPEC, dest: (item.department as WarehouseDest) || "OUTROS" });
      setSupplier(item.supplier || "");
      setPurchaseDate((item.purchase_date || "").slice(0, 10) || todayISO);
      setUnitValue(numToInput(item.unit_value));
      setQuantity(numToInput(item.quantity) || "1");
      setPaymentMethod(item.payment_method || "");
      setNotes(item.notes || "");
      setImageUrl(item.image_url || null);
      setCode(item.code || "");
      setShipId(item.ship_id || "");
    } else if (fromRequest) {
      setDescription(fromRequest.tool_name || "");
      setLink(fromRequest.product_url || "");
      setDestSpec({ ...DEFAULT_DEST_SPEC, dest: (fromRequest.department as WarehouseDest) || "ESTOQUE" });
      setSupplier(fromRequest.supplier || "");
      setPurchaseDate(todayISO);
      setUnitValue(numToInput(parseDecimalBR(fromRequest.estimated_value)));
      setQuantity(numToInput(fromRequest.quantity) || "1");
      setPaymentMethod("");
      setNotes("");
      setImageUrl(fromRequest.image_url || null);
      setCode(fromRequest.code || "");
      setShipId("");
    } else {
      setDescription(""); setLink(""); setDestSpec({ ...DEFAULT_DEST_SPEC }); setSupplier(""); setPurchaseDate(todayISO);
      setUnitValue(""); setQuantity("1"); setPaymentMethod(""); setNotes(""); setImageUrl(null); setCode(""); setShipId("");
    }
  }, [item, fromRequest, open]);

  const unit = parseDecimalBR(unitValue);
  const qty = parseDecimalBR(quantity);
  const total = unit * qty;

  // Aplica os dados puxados do link (igual à Nova Solicitação): preenche descrição,
  // valor, fornecedor e foto sem sobrescrever o que já foi digitado (salvo "Buscar").
  const applyPreview = useCallback((d: { name?: string; value?: number; supplier?: string; image?: string }, force: boolean) => {
    if (d.name) setDescription((p) => (force || !p.trim() ? d.name! : p));
    if (d.value != null) setUnitValue((p) => (force || !p.trim() ? String(d.value).replace(".", ",") : p));
    if (d.supplier) setSupplier((p) => (force || !p.trim() ? d.supplier! : p));
    if (d.image) setImageUrl((p) => (force || !p ? d.image! : p));
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Navio: resolve o nome pelo id escolhido. Se o navio foi apagado (edição de
    // uma compra antiga), mantém o ship_name já salvo pra não perder o vínculo.
    const selectedShip = ships.find((s) => s.id === shipId);
    const shipName = selectedShip ? selectedShip.name : (shipId ? (item?.ship_name || null) : null);
    onSave({
      description,
      department: destSpec.dest || null,
      code: code.trim().toUpperCase() || null,
      supplier: supplier || null,
      purchase_date: purchaseDate || null,
      unit_value: unit,
      quantity: qty || 1,
      total_value: total,
      payment_method: paymentMethod || null,
      notes: notes || null,
      image_url: imageUrl,
      product_url: link.trim() || null,
      ship_id: shipId || null,
      ship_name: shipName,
    }, fromRequest?.id || null,
      // Só lança no Almoxarifado em compras novas (na edição vira só rótulo).
      !item ? destSpec : null);
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
        <ProductLinkField link={link} onLinkChange={setLink} onData={applyPreview} open={open} />
        <div>
          <label className="block text-sm font-medium mb-1">Descrição *</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} required
            placeholder="Ex: Fita silver tape, Água 1,5 L..." className={inputCls} />
        </div>
        <WarehouseDestinationFields value={destSpec} onChange={(v) => { if (v.dest !== destSpec.dest) setCode(""); setDestSpec(v); }} quantity={qty} stocking={!item} />
        {!item && <CodeField dest={destSpec.dest} team={destSpec.team} value={code} name={description} onChange={setCode} onResolveName={setDescription} open={open} />}
        <div>
          <label className="block text-sm font-medium mb-1">Fornecedor</label>
          <SupplierField value={supplier} onChange={setSupplier} suppliers={suppliers} className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">
            Navio <span className="text-text-light font-normal">(opcional)</span>
          </label>
          <select value={shipId} onChange={(e) => setShipId(e.target.value)} className={inputCls}>
            <option value="">— Sem navio</option>
            {ships.map((s) => <option key={s.id} value={s.id}>{shipSelectLabel(s)}</option>)}
            {/* Navio já vinculado mas que saiu da lista (apagado): preserva o vínculo. */}
            {shipId && item?.ship_name && !ships.some((s) => s.id === shipId) && (
              <option value={shipId}>{item.ship_name} (fora da lista)</option>
            )}
          </select>
          <p className="text-[10px] text-text-light mt-1">Vincula esta compra a um navio cadastrado na aba Navios.</p>
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
            placeholder="Ex: Crédito de 354,22, frete incluso, rancho M/V Atlântico..." className={`${inputCls} resize-none`} />
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

// Lança uma solicitação já comprada no Almoxarifado: o usuário escolhe o destino
// (Estoque/Rancho/EPI/Uniforme/Maquinário) e os campos do setor. Nome e quantidade
// vêm da própria solicitação. Usado pelo botão "📦 Armazenar" dos cards COMPRADO.
function ArmazenarEstoqueModal({ open, onClose, onConfirm, request, saving }: {
  open: boolean; onClose: () => void;
  onConfirm: (spec: DestSpec) => void;
  request: ToolRequest | null;
  saving: boolean;
}) {
  const [spec, setSpec] = useState<DestSpec>({ ...DEFAULT_DEST_SPEC });

  useEffect(() => { if (open) setSpec({ ...DEFAULT_DEST_SPEC }); }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Armazenar no Almoxarifado" maxWidth="max-w-md">
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(spec); }} className="space-y-4">
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm text-emerald-800">
          Lançar <strong>{request?.tool_name}</strong> (x{request?.quantity}) no Almoxarifado.
        </div>
        <WarehouseDestinationFields value={spec} onChange={setSpec} quantity={request?.quantity} />
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Lançando..." : "Lançar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// Aprovar e concluir uma solicitação: registra a compra no Controle de Compras e
// lança o item no destino escolhido do Almoxarifado, num passo só.
function AprovarModal({ open, onClose, onConfirm, request, suppliers, saving }: {
  open: boolean; onClose: () => void;
  onConfirm: (data: ApproveData) => void;
  request: ToolRequest | null;
  suppliers: Supplier[];
  saving: boolean;
}) {
  const [spec, setSpec] = useState<DestSpec>({ ...DEFAULT_DEST_SPEC });
  // Resumo editável da compra — pré-preenchido a partir da solicitação. O gestor
  // confere/ajusta antes de concluir; estes valores é que viram a compra.
  const [toolName, setToolName] = useState("");
  const [supplier, setSupplier] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [unitValue, setUnitValue] = useState("");
  const [quantity, setQuantity] = useState("1");
  // Código no Almoxarifado — vem da solicitação; em branco o sistema gera pelo nome.
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!open || !request) return;
    const today = new Date();
    const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    // Pré-preenche o destino com a sugestão da solicitação (campo department).
    setSpec({ ...DEFAULT_DEST_SPEC, dest: (request.department as WarehouseDest) || "ESTOQUE" });
    setToolName(request.tool_name || "");
    setSupplier(request.supplier || "");
    setPaymentMethod("");
    setPurchaseDate(todayISO);
    setUnitValue(numToInput(parseDecimalBR(request.estimated_value)));
    setQuantity(numToInput(request.quantity) || "1");
    setCode(request.code || "");
  }, [open, request]);

  const unit = parseDecimalBR(unitValue);
  const qty = parseDecimalBR(quantity) || 1;
  const total = unit * qty;
  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title="Aprovar e concluir" maxWidth="max-w-lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onConfirm({
            toolName,
            supplier: supplier || null,
            paymentMethod: paymentMethod || null,
            purchaseDate,
            unitValue: unit,
            quantity: qty,
            spec,
            code: code.trim().toUpperCase() || null,
          });
        }}
        className="space-y-4"
      >
        <p className="text-sm text-text-light">
          Confira e ajuste os dados abaixo. Ao concluir, a compra é registrada no Controle de Compras
          e o item é lançado no destino, automaticamente.
        </p>

        {/* Resumo da origem (não editável) — quem pediu, motivo e link. */}
        {request && (
          <div className="bg-gray-50 border border-border rounded-lg px-3 py-2 text-xs text-text-light flex flex-wrap gap-x-3 gap-y-1 items-center">
            <span>Solicitado por <strong className="text-text">{request.requested_by}</strong></span>
            {request.reason && <span>· {request.reason}</span>}
            {request.product_url && (
              <a href={request.product_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">🔗 Ver produto</a>
            )}
          </div>
        )}

        <div>
          <label className="block text-sm font-medium mb-1">Produto / Descrição *</label>
          <input type="text" value={toolName} onChange={(e) => setToolName(e.target.value)} required className={inputCls} />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Fornecedor</label>
          <SupplierField value={supplier} onChange={setSupplier} suppliers={suppliers} className={inputCls} />
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
            <input type="text" inputMode="decimal" value={unitValue} onChange={(e) => setUnitValue(e.target.value)} placeholder="0,00" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Quantidade</label>
            <input type="text" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="1" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Valor total</label>
            <div className="w-full px-3 py-2.5 border border-border rounded-lg text-sm bg-gray-50 font-semibold text-primary">
              {formatCurrency(total)}
            </div>
          </div>
        </div>

        <WarehouseDestinationFields value={spec} onChange={(v) => { if (v.dest !== spec.dest) setCode(""); setSpec(v); }} quantity={qty} />
        <CodeField dest={spec.dest} team={spec.team} value={code} name={toolName} onChange={setCode} onResolveName={setToolName} open={open} />

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Concluindo..." : "Aprovar e concluir"}</Button>
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

// Manda uma mensagem pré-pronta pro fornecedor pelo WhatsApp da Cargo (número já
// conectado via Evolution). A mensagem vem preenchida mas é editável; o envio
// passa por /api/whatsapp/send, então a resposta do fornecedor aparece na aba
// Conversas. Se o WhatsApp da empresa estiver fora do ar, ainda dá pra abrir no
// WhatsApp do próprio usuário (wa.me).
function WhatsappSupplierModal({ open, onClose, target }: {
  open: boolean; onClose: () => void; target: WhatsappTarget | null;
}) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentOk, setSentOk] = useState(false);
  // Estado da conexão do WhatsApp da empresa (badge no topo do modal).
  const [waState, setWaState] = useState<"checking" | "open" | "offline" | "unconfigured">("checking");

  useEffect(() => {
    if (!open || !target) return;
    setMessage(target.message);
    setError(null);
    setSentOk(false);
    setWaState("checking");
    let cancelled = false;
    fetch("/api/whatsapp/status")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.configured === false) { setWaState("unconfigured"); return; }
        setWaState(d?.status?.instance?.state === "open" ? "open" : "offline");
      })
      .catch(() => { if (!cancelled) setWaState("offline"); });
    return () => { cancelled = true; };
  }, [open, target]);

  if (!target) return null;

  const waLink = `https://wa.me/${waDigits(target.to)}?text=${encodeURIComponent(message)}`;
  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  async function handleSend() {
    if (!target) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: waDigits(target.to), text: message, label: target.name }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) throw new Error(data?.error || `Erro ${res.status}`);
      setSentOk(true);
      setTimeout(onClose, 1300);
    } catch (err) {
      setError((err as Error)?.message || "Falha ao enviar.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Chamar no WhatsApp">
      <div className="space-y-4">
        <div>
          <p className="text-sm text-text">Para <strong>{target.name}</strong></p>
          <p className="text-xs text-text-light">{target.to} · enviado pelo WhatsApp da Cargo</p>
        </div>

        {waState === "checking" && <p className="text-xs text-text-light">Verificando conexão do WhatsApp…</p>}
        {waState === "open" && <p className="text-xs text-emerald-600">🟢 WhatsApp da empresa conectado</p>}
        {waState === "offline" && (
          <p className="text-xs text-amber-600">🟡 WhatsApp da empresa desconectado — tente enviar mesmo assim ou abra no seu WhatsApp.</p>
        )}
        {waState === "unconfigured" && (
          <p className="text-xs text-amber-600">🟡 WhatsApp da empresa não configurado — use “Abrir no meu WhatsApp”.</p>
        )}

        <div>
          <label className="block text-sm font-medium mb-1">Mensagem</label>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={7}
            className={`${inputCls} resize-none`} />
        </div>

        {error && <div className="bg-red-50 border border-red-300 rounded-lg p-2.5 text-sm text-red-700">{error}</div>}
        {sentOk && (
          <div className="bg-emerald-50 border border-emerald-300 rounded-lg p-2.5 text-sm text-emerald-700">
            ✅ Mensagem enviada! A resposta do fornecedor aparece na aba Conversas.
          </div>
        )}

        <div className="flex flex-wrap gap-3 justify-end pt-2">
          <a href={waLink} target="_blank" rel="noopener noreferrer"
            className="px-4 py-2 text-sm font-medium text-text-light hover:text-text border border-border rounded-lg transition">
            Abrir no meu WhatsApp
          </a>
          <Button type="button" onClick={handleSend} disabled={sending || sentOk || !message.trim() || waState === "unconfigured"}>
            {sending ? "Enviando..." : "Enviar pelo WhatsApp da Cargo"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
