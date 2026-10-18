"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { COMPRAS_ROLES, PRODUTOS_ROLES, FORNECEDORES_ROLES } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs } from "@/components/ui/tabs";
import { PlusIcon, EditIcon, TrashIcon, WhatsappIcon } from "@/components/icons";
import { formatCurrency, formatQty, parseDecimalBR, buildCodeMap, codeForName } from "@/lib/utils";
import { ImagePicker } from "@/components/ui/image-picker";
// "Escanear" do Controle de Compras: câmera + IA lê nota/cupom/boleto e
// preenche os itens (src/components/compras/escanear-compra-modal.tsx).
import { EscanearCompraModal, type ScannedPurchaseDraft } from "@/components/compras/escanear-compra-modal";

interface PurchaseOrder {
  id: string;
  description: string;
  department: string | null;
  code: string | null;
  // Equipe pra qual a compra foi feita (EQUIPE_1/2/4) — aloca no Almoxarifado.
  team: string | null;
  supplier: string | null;
  purchase_date: string | null;
  unit_value: number;
  quantity: number;
  total_value: number;
  payment_method: string | null;
  // Legado: prazo único do FATURADO (segue preenchido com a 1ª parcela).
  payment_term_days: number | null;
  // Parcelas do FATURADO: prazo em dias de cada pagamento (ex.: [28, 35, 42]).
  // O total é dividido igualmente e cada parcela vira um título no Contas a Pagar.
  payment_terms: number[] | null;
  card_id: number | null;
  notes: string | null;
  digitable_line: string | null;
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

// Cartão de crédito (aba Contas bancárias da Conciliação) — pro seletor "qual
// cartão foi usado" no Nova Compra. Traz o banco junto pra rotular.
interface CardOption {
  id: number;
  last4: string;
  closing_day: number;
  label: string | null;
  bank_account_id: number;
  bank_accounts?: { bank: string; nickname: string } | null;
}

// Rótulo do cartão no seletor: "final 8403 · fecha dia 12 (Itaú)".
function cardLabel(c: CardOption): string {
  const bank = c.bank_accounts?.bank
    ? c.bank_accounts.bank === "ITAU"
      ? "Itaú"
      : c.bank_accounts.bank === "SANTANDER"
        ? "Santander"
        : c.bank_accounts.bank
    : "";
  const base = c.label?.trim() || `final ${c.last4}`;
  return `${base} · fecha dia ${c.closing_day}${bank ? ` (${bank})` : ""}`;
}

// Conta bancária (Financeiro › Conciliação) — só o que o "cadastrar cartão" do
// Nova Compra precisa pra vincular o cartão novo a uma conta.
interface BankAccountOption {
  id: number;
  nickname: string;
  bank: string;
  active?: boolean;
}

// Dados do formulário inline de "cadastrar novo cartão" do Nova Compra.
interface NewCardInput {
  bank_account_id: number;
  last4: string;
  closing_day: number;
  label: string | null;
}

// Rótulo da forma de pagamento na listagem: FATURADO mostra os VENCIMENTOS das
// parcelas ("FATURADO 12/11, 12/12") pra enxergar o parcelamento sem abrir a
// compra. No banco fica gravado em dias; aqui vira data (compra + dias), que é
// como a fatura da nota mostra. Sem data da compra, cai nos dias mesmo.
function paymentLabel(p: PurchaseOrder): string | null {
  if (!p.payment_method) return null;
  if (p.payment_method === "FATURADO") {
    const terms = p.payment_terms?.length ? p.payment_terms : p.payment_term_days ? [p.payment_term_days] : [];
    if (terms.length > 0) {
      const base = (p.purchase_date || "").slice(0, 10);
      if (!base) return `FATURADO ${terms.join("/")} dias`;
      const dues = terms.map((d) => addDaysISO(base, d).slice(5).split("-").reverse().join("/"));
      return `FATURADO ${dues.join(", ")}`;
    }
  }
  return p.payment_method;
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
  // Só dígitos; único no banco. É a chave que vincula o fornecedor no Contas a
  // Pagar (boleto por e-mail e extrato casam por aqui).
  cnpj: string | null;
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
type WarehouseDest = "ESTOQUE" | "RANCHO" | "EPI" | "UNIFORME" | "MAQUINARIO" | "FERRAMENTA" | "ELETRICA" | "FLUIDOS" | "ESCRITORIO" | "OUTROS" | "NENHUM";

const WAREHOUSE_DESTINATIONS: { value: WarehouseDest; label: string }[] = [
  { value: "ESTOQUE", label: "📦 Utensílios" },
  { value: "RANCHO", label: "🍽️ Rancho (alimentos)" },
  { value: "EPI", label: "⛑️ EPI" },
  { value: "UNIFORME", label: "👕 Uniforme" },
  { value: "MAQUINARIO", label: "⚙️ Maquinário" },
  { value: "FERRAMENTA", label: "🔧 Ferramenta" },
  { value: "ELETRICA", label: "⚡ Elétrica" },
  { value: "FLUIDOS", label: "🛢️ Fluídos" },
  { value: "ESCRITORIO", label: "🏢 Escritório (só registra a compra)" },
  { value: "OUTROS", label: "— Outros (não lançar no estoque)" },
];

// Destinos que NÃO mexem no Almoxarifado — só registram a compra/solicitação (não
// há setor de estoque pra eles). Escritório é o caso típico. Rancho (card #46)
// também entra aqui: a compra de comida só soma o gasto na aba de Compras, sem
// virar item de estoque nem usar código.
const STOCKLESS_DESTS: WarehouseDest[] = ["RANCHO", "ESCRITORIO", "OUTROS", "NENHUM"];
function destStocks(dest: WarehouseDest): boolean {
  return !STOCKLESS_DESTS.includes(dest);
}

// Rótulo curto pro badge na tabela de Controle de Compras.
const DEST_SHORT_LABEL: Record<string, string> = {
  ESTOQUE: "Utensílios", RANCHO: "Rancho", EPI: "EPI",
  UNIFORME: "Uniforme", MAQUINARIO: "Maquinário", FERRAMENTA: "Ferramenta", ELETRICA: "Elétrica", FLUIDOS: "Fluídos", ESCRITORIO: "Escritório", OUTROS: "Outros", NENHUM: "Sem destino",
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
interface DestSpec { dest: WarehouseDest; category: string; unit: string; team: string; size: string; crewTeam: string }
const DEFAULT_DEST_SPEC: DestSpec = { dest: "ESTOQUE", category: "", unit: "UN", team: "EQUIPE_1", size: "", crewTeam: "" };

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
  FLUIDOS: "bg-cyan-100 text-cyan-700",
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

// Grava o preço da compra como valor unitário do item no Almoxarifado, pra o
// custo de material do navio (Pagamento de Navios) parar de sair R$ 0,00.
// Passa pelo servidor porque `unit_value` é coluna sensível — o /api/db apaga o
// campo de quem não é gestão, e quem lança compra (RH/Estágio) não é.
// Best-effort: o abastecimento já aconteceu; falhar aqui não desfaz nada.
async function saveUnitValue(table: "stock_items" | "epis" | "uniforms", id: number | undefined, unitValue: number | undefined) {
  if (!id || !unitValue || unitValue <= 0) return;
  try {
    await fetch("/api/almoxarifado/preco", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ table, id, unit_value: unitValue }),
    });
  } catch { /* preço é complemento — não quebra a compra */ }
}

// --- WhatsApp pro fornecedor ---------------------------------------------
// Alvo da mensagem: o contato bruto do fornecedor (ex.: "13 3229-9350"), o nome
// e a mensagem pré-pronta (editável no modal). Compartilhado pela aba
// Fornecedores ("Chamar") e pelo Nova Solicitação ("Pedir cotação").
interface WhatsappTarget { to: string; name: string; message: string; imageUrl?: string | null }

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

export default function SolicitacoesPage() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") || "compras";
  const role = profile?.role || "RH";

  const [productLinks, setProductLinks] = useState<ProductLink[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [purchases, setPurchases] = useState<PurchaseOrder[]>([]);
  const [ships, setShips] = useState<Ship[]>([]);
  const [cards, setCards] = useState<CardOption[]>([]);
  // Contas bancárias ativas — pro "cadastrar novo cartão" do Nova Compra.
  const [bankAccounts, setBankAccounts] = useState<BankAccountOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [showLinkForm, setShowLinkForm] = useState(false);
  const [editLink, setEditLink] = useState<ProductLink | null>(null);
  const [deleteLink, setDeleteLink] = useState<ProductLink | null>(null);

  // Imagem em tela cheia (lightbox)
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Controle de Compras
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [editPurchase, setEditPurchase] = useState<PurchaseOrder | null>(null);
  // "Escanear" (câmera + IA): foto da nota/cupom/boleto vira compra(s).
  // "Importar PDF" abre o mesmo fluxo já com o arquivo (pula a câmera).
  const [scanOpen, setScanOpen] = useState(false);
  const [scanFiles, setScanFiles] = useState<File[] | null>(null);
  const [deletePurchase, setDeletePurchase] = useState<PurchaseOrder | null>(null);
  const now = new Date();
  // Filtros do Controle de Compras — também alimentam o relatório em Excel.
  const [filterYear, setFilterYear] = useState(String(now.getFullYear()));
  const [filterMonth, setFilterMonth] = useState(String(now.getMonth() + 1)); // "1".."12" | "" = ano inteiro
  const [filterDept, setFilterDept] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterPayment, setFilterPayment] = useState("");
  const [filterShip, setFilterShip] = useState("");
  const [filterTeam, setFilterTeam] = useState("");
  const [generatingReport, setGeneratingReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);

  // Fornecedores
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [editSupplier, setEditSupplier] = useState<Supplier | null>(null);
  const [deleteSupplier, setDeleteSupplier] = useState<Supplier | null>(null);
  const [supplierSearch, setSupplierSearch] = useState("");
  // Chamar o fornecedor no WhatsApp da Cargo (mensagem pré-pronta e editável).
  // Aberto pela aba Fornecedores.
  const [whatsappTarget, setWhatsappTarget] = useState<WhatsappTarget | null>(null);

  const canManageLinks = ["GESTOR", "EXECUTIVO", "COMERCIAL", "TECNOLOGIA", "ESTAGIO", "FINANCEIRO"].includes(role);
  // Gerir compras (Nova/editar compra, Escanear) é dos papéis que veem a aba
  // Controle de Compras (COMPRAS_ROLES) — a lista é a fonte única.
  // 2026-09: Manutenção entrou na lista, então também registra/gere compras.
  const canManagePurchases = COMPRAS_ROLES.includes(role);

  const [dbError, setDbError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      const [linksRes, suppRes, purchRes, shipsRes, cardsRes, banksRes] = await Promise.all([
        db.from("product_links").select("*").order("category").order("name"),
        db.from("suppliers").select("*").order("name"),
        db.from("purchase_orders").select("*").order("purchase_date", { ascending: false }).order("created_at", { ascending: false }),
        // Navios pro seletor de "Navio" do Nova Compra (mais recentes primeiro).
        db.from("ships").select("id, name, status, port, arrival_date").order("created_at", { ascending: false }),
        // Cartões (com o banco) pro seletor "qual cartão" do Nova Compra.
        db.from("cards").select("*, bank_accounts(bank, nickname)").order("last4"),
        // Contas bancárias pro "cadastrar novo cartão" (só id/apelido/banco).
        db.from("bank_accounts").select("id, nickname, bank, active").order("nickname"),
      ]);

      const errors: string[] = [];
      if (linksRes.error) errors.push(`product_links: ${linksRes.error.code} ${linksRes.error.message}`);
      if (suppRes.error) errors.push(`suppliers: ${suppRes.error.code} ${suppRes.error.message}`);
      if (purchRes.error) errors.push(`purchase_orders: ${purchRes.error.code} ${purchRes.error.message}`);
      if (shipsRes.error) errors.push(`ships: ${shipsRes.error.code} ${shipsRes.error.message}`);
      // Cartões/contas: falha aqui não bloqueia a tela (recurso opcional do Nova Compra).
      if (cardsRes.error) console.warn("cards:", cardsRes.error);
      if (banksRes.error) console.warn("bank_accounts:", banksRes.error);
      if (errors.length > 0) {
        console.error("DB errors:", errors);
        setDbError(errors.join(" | "));
      }

      setProductLinks((linksRes.data as ProductLink[]) || []);
      setSuppliers((suppRes.data as Supplier[]) || []);
      setPurchases((purchRes.data as PurchaseOrder[]) || []);
      setShips((shipsRes.data as Ship[]) || []);
      setCards((cardsRes.data as CardOption[]) || []);
      setBankAccounts(((banksRes.data as BankAccountOption[]) || []).filter((a) => a.active !== false));
    } catch (err) {
      console.error("loadAll error:", err);
      setDbError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll, pathname]);

  // Lança um item no Estoque de materiais do galpão (stock_items, team=GALPAO) —
  // a mesma tabela da aba Almoxarifado › Estoque. Se já existe um material com o
  // mesmo nome, soma a quantidade (reposição); senão cria um material novo com a
  // categoria escolhida. Também registra um movimento de ENTRADA pro histórico.
  // É a "ponte" entre Solicitações de compra e o Estoque.
  const storeInStock = useCallback(async (opts: { name: string; quantity: number; category: string; code?: string | null; team?: string; unitValue?: number }) => {
    const actor = profile?.full_name || "Sistema";
    const name = (opts.name || "").trim();
    const qty = opts.quantity > 0 ? opts.quantity : 1;
    const category = (opts.category || "").trim() || "Outros";
    // Sentinela do inventário: GALPAO (Estoque) por padrão, ou FERRAMENTA/ELETRICA/FLUIDOS.
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
        // Compra NÃO decide lista de embarque: item novo nasce com padrão 0 —
        // quem define o "leva" é o usuário (kit oficial/extras na tela de
        // Embarque). Pedido de 2026-08-01.
        default_quantity: 0,
        category: "OUTROS",
        team,
        min_quantity: 0,
        updated_by: actor,
      } as any);
      if (error) throw new Error(error.message);
      stockItemId = (inserted as any)?.id;
    }

    // Preço da compra vira o valor unitário do item (custo de reposição atual).
    await saveUnitValue("stock_items", stockItemId, opts.unitValue);

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

    return { created, name, category, quantity: qty, stockItemId };
  }, [profile]);

  // Aloca uma quantidade recém-comprada direto pra uma equipe (material_team_
  // allocations): a compra sai do Disponível e entra na equipe. Upsert por
  // (stock_item_id, team). Best-effort — o item já foi reposto no estoque.
  const allocateToTeam = useCallback(async (stockItemId: number, team: string, qty: number) => {
    const actor = profile?.full_name || "Sistema";
    if (!stockItemId || !team || qty <= 0) return;
    const { data } = await db.from("material_team_allocations")
      .select("id, quantity").eq("stock_item_id", stockItemId).eq("team", team);
    const existing = (data as { id: number; quantity: number }[] | null)?.[0];
    if (existing) {
      await db.from("material_team_allocations").update({
        quantity: Math.round((Number(existing.quantity || 0) + qty) * 1000) / 1000, updated_by: actor,
      } as any).eq("id", existing.id);
    } else {
      await db.from("material_team_allocations").insert({
        stock_item_id: stockItemId, team, quantity: qty, updated_by: actor,
      } as any);
    }
  }, [profile]);

  // Ponte genérica Compras/Solicitações → Almoxarifado INTEIRO. Lança o item no
  // setor escolhido (`dest`), com casamento por nome onde faz sentido (repõe a
  // quantidade em vez de duplicar). Maquinário não tem quantidade: cada unidade
  // comprada vira uma máquina (status Disponível). Devolve um resumo pro toast.
  const storeInWarehouse = useCallback(async (
    dest: WarehouseDest,
    opts: { name: string; quantity: number; category?: string; unit?: string; team?: string; size?: string; code?: string | null; crewTeam?: string; unitValue?: number },
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
      const r = await storeInStock({ name, quantity: qty, category: opts.category || "Outros", code: opts.code, unitValue: opts.unitValue });
      if (opts.crewTeam && r.stockItemId) await allocateToTeam(r.stockItemId, opts.crewTeam, qty);
      return { created: r.created, where: `Estoque${r.category ? ` · ${r.category}` : ""}${opts.crewTeam ? ` → ${teamLbl(opts.crewTeam)}` : ""}`, quantity: r.quantity };
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
        // default_quantity 0: comida nova comprada entra no rancho da equipe,
        // mas NÃO entra sozinha na lista de embarque — o padrão quem define é
        // o usuário (pedido de 2026-08-01).
        const { data: ins, error: e } = await db.from("stock_items").insert({
          name, category, unit, quantity: qty, default_quantity: 0, team, min_quantity: 0, updated_by: actor,
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
      let itemId: number | undefined;
      if (existing) {
        created = false;
        itemId = existing.id;
        const { error: e } = await db.from(table).update({
          stock_qty: Number(existing.stock_qty || 0) + addQty, updated_by: actor,
        } as any).eq("id", existing.id);
        if (e) throw new Error(e.message);
      } else {
        created = true;
        const { data: ins, error: e } = await db.from(table).insert({
          name, size, stock_qty: addQty, min_quantity: 0, updated_by: actor,
        } as any);
        if (e) throw new Error(e.message);
        itemId = (ins as any)?.id;
      }
      await saveUnitValue(table === "epis" ? "epis" : "uniforms", itemId, opts.unitValue);
      return { created, where: dest === "EPI" ? "EPI" : "Uniforme", quantity: addQty };
    }

    // Ferramenta / Elétrica / Fluídos / Maquinário — inventário com quantidade
    // (stock_items com o team sentinela do setor; a tabela `tools` ficou sem
    // uso). Mesma ponte do Estoque: casa por código/nome e SOMA a quantidade
    // (reposição) em vez de duplicar — é o que faz o código único evitar
    // repetição mesmo quando a compra vem com nome diferente.
    if (dest === "FERRAMENTA" || dest === "ELETRICA" || dest === "FLUIDOS" || dest === "MAQUINARIO") {
      const r = await storeInStock({ name, quantity: qty, category: opts.category || "Outros", code: opts.code, team: dest, unitValue: opts.unitValue });
      if (opts.crewTeam && r.stockItemId) await allocateToTeam(r.stockItemId, opts.crewTeam, qty);
      const label = dest === "FERRAMENTA" ? "Ferramenta" : dest === "ELETRICA" ? "Elétrica" : dest === "FLUIDOS" ? "Fluídos" : "Maquinário";
      return { created: r.created, where: `${label}${r.category && r.category !== "Outros" ? ` · ${r.category}` : ""}${opts.crewTeam ? ` → ${teamLbl(opts.crewTeam)}` : ""}`, quantity: r.quantity };
    }

    throw new Error(`Destino inválido: ${dest}`);
  }, [profile, storeInStock, allocateToTeam]);

  // Cadastra um cartão de crédito direto do Nova Compra (nem todo mundo tem
  // acesso ao Financeiro › Contas bancárias). Devolve o cartão já com o banco
  // resolvido pro rótulo e entra na lista local sem recarregar tudo.
  const handleCreateCard = useCallback(async (input: NewCardInput): Promise<CardOption> => {
    const actor = profile?.full_name || "Sistema";
    const { data, error } = await db.from("cards").insert({ ...input, created_by: actor } as any);
    if (error) throw new Error(error.message);
    const created = data as unknown as { id: number };
    const acct = bankAccounts.find((a) => a.id === input.bank_account_id);
    const card: CardOption = {
      id: created.id,
      last4: input.last4,
      closing_day: input.closing_day,
      label: input.label,
      bank_account_id: input.bank_account_id,
      bank_accounts: acct ? { bank: acct.bank, nickname: acct.nickname } : null,
    };
    setCards((prev) => [...prev, card].sort((a, b) => a.last4.localeCompare(b.last4)));
    return card;
  }, [profile, bankAccounts]);

  async function handleSavePurchase(
    data: Partial<PurchaseOrder>,
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
        const { data: createdPurchase, error } = await db.from("purchase_orders").insert({
          ...data,
          code,
          created_by: actor,
        } as any);
        if (error) throw error;
        // TODA compra nova é lançada automaticamente no Contas a Pagar —
        // inclusive cartão (o gestor lança, o Financeiro confere lá; a nota do
        // título leva o final/fechamento do cartão pra casar com a fatura).
        // FATURADO parcelado vira um título por parcela (vencimento = data +
        // dias); o resto vence na data da compra. Falha aqui é não-fatal: a
        // compra já foi salva.
        const newId = (createdPurchase as unknown as { id?: string } | null)?.id;
        if (newId) {
          const nParcelas = data.payment_method === "FATURADO"
            ? data.payment_terms?.length || (data.payment_term_days ? 1 : 0)
            : 0;
          try {
            const r = await fetch("/api/financeiro/contas/from-compras", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ purchase_ids: [newId] }),
            });
            if (r.ok) {
              setSaveOk(
                nParcelas > 1
                  ? `💳 Compra faturada lançada no Contas a Pagar em ${nParcelas} parcelas com os vencimentos calculados.`
                  : nParcelas === 1
                    ? "💳 Compra faturada lançada no Contas a Pagar com o vencimento calculado."
                    : "🧾 Compra lançada no Contas a Pagar.",
              );
            } else setSaveError("Compra salva, mas falhou ao lançar no Contas a Pagar — será lançada sozinha ao abrir a tela.");
          } catch {
            setSaveError("Compra salva, mas falhou ao lançar no Contas a Pagar — será lançada sozinha ao abrir a tela.");
          }
        }
        // Lança no destino escolhido do Almoxarifado, se houver. Falha aqui é
        // não-fatal: a compra já foi salva, só avisamos.
        if (stock && destStocks(stock.dest)) {
          try {
            const r = await storeInWarehouse(stock.dest, {
              name: data.description || "",
              quantity: Number(data.quantity) || 1,
              category: stock.category, unit: stock.unit, team: stock.team, size: stock.size,
              crewTeam: stock.crewTeam,
              code,
              // Valor unit. da compra vira o valor unitário do item no Almoxarifado.
              unitValue: Number(data.unit_value) || 0,
            });
            // Anexa ao toast anterior (ex.: o do lançamento no Contas a Pagar).
            setSaveOk((prev) =>
              `${prev ? `${prev} · ` : ""}📦 ${r.created ? "Criado" : "Reposto"}: "${data.description}" (+${formatQty(r.quantity)}) em ${r.where}.`,
            );
          } catch (stockErr: any) {
            setSaveError(`Compra salva, mas falhou ao lançar no Almoxarifado: ${stockErr?.message || String(stockErr)}`);
          }
        }
      }
      setShowPurchaseForm(false);
      setEditPurchase(null);
      loadAll();
    } catch (err: any) {
      console.error("Erro ao salvar compra:", err);
      setSaveError(`Erro ao salvar compra: ${err?.message || String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  // Salva o que o Escanear (IA) leu e o usuário conferiu: uma compra por item,
  // todas com o mesmo cabeçalho (fornecedor, data, pagamento, parcelas, navio).
  // Dois ou mais itens ganham um batch_id comum — o Contas a Pagar lança UM
  // título (ou um por parcela) com a soma, não um por item. Itens com destino
  // de estoque entram no Almoxarifado como no Nova Compra. Erro sobe pro modal
  // mostrar (ele fica aberto); sucesso fecha e mostra o resumo.
  async function handleSaveScanned(draft: ScannedPurchaseDraft) {
    const actor = profile?.full_name || "Sistema";
    const ship = draft.shipId ? ships.find((s) => s.id === draft.shipId) : null;
    const terms = draft.paymentMethod === "FATURADO"
      ? draft.dueDates
          .map((iso) => daysBetweenISO(draft.purchaseDate, iso))
          .filter((n): n is number => n != null && n >= 0)
      : [];
    const batchId = draft.items.length > 1 ? crypto.randomUUID() : null;
    const ids: string[] = [];
    const stockMsgs: string[] = [];
    const stockErrs: string[] = [];
    setSaveError(null);
    setSaveOk(null);
    for (const it of draft.items) {
      const dest = (it.dest || "OUTROS") as WarehouseDest;
      const code = destStocks(dest) ? await resolveWarehouseCode(dest, it.description) : null;
      const { data: created, error } = await db.from("purchase_orders").insert({
        description: it.description,
        department: dest === "NENHUM" ? null : dest,
        code,
        supplier: draft.supplier,
        purchase_date: draft.purchaseDate || null,
        unit_value: it.unitValue,
        quantity: it.quantity,
        total_value: Math.round(it.unitValue * it.quantity * 100) / 100,
        payment_method: draft.paymentMethod,
        payment_terms: terms,
        payment_term_days: terms[0] ?? null,
        notes: draft.notes,
        digitable_line: draft.digitableLine,
        ship_id: ship?.id || null,
        ship_name: ship?.name || null,
        batch_id: batchId,
        created_by: actor,
      } as any);
      if (error) {
        if (ids.length > 0) loadAll();
        throw new Error(`Erro ao salvar "${it.description}": ${error.message}${ids.length ? ` (${ids.length} item(ns) anterior(es) já salvos)` : ""}`);
      }
      const id = (created as unknown as { id?: string } | null)?.id;
      if (id) ids.push(id);
      if (destStocks(dest)) {
        try {
          const r = await storeInWarehouse(dest, {
            name: it.description, quantity: it.quantity, code, unitValue: it.unitValue,
          });
          stockMsgs.push(`${r.created ? "criado" : "reposto"} "${it.description}" em ${r.where}`);
        } catch (err: any) {
          stockErrs.push(`"${it.description}": ${err?.message || String(err)}`);
        }
      }
    }
    let contasMsg = "";
    if (ids.length > 0) {
      try {
        const r = await fetch("/api/financeiro/contas/from-compras", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ purchase_ids: ids }),
        });
        contasMsg = r.ok
          ? " 🧾 Lançado no Contas a Pagar."
          : " ⚠️ Falhou ao lançar no Contas a Pagar — será lançado sozinho ao abrir a tela.";
      } catch {
        contasMsg = " ⚠️ Falhou ao lançar no Contas a Pagar — será lançado sozinho ao abrir a tela.";
      }
    }
    setScanOpen(false);
    setScanFiles(null);
    setSaveOk(
      `✅ ${ids.length === 1 ? "Compra registrada" : `${ids.length} compras registradas`} pelo Escanear.${contasMsg}` +
      (stockMsgs.length ? ` 📦 Almoxarifado: ${stockMsgs.join("; ")}.` : ""),
    );
    if (stockErrs.length) setSaveError(`Compras salvas, mas falhou ao lançar no Almoxarifado: ${stockErrs.join("; ")}`);
    // Abre o mês da compra pra ela aparecer na lista.
    const [y, m] = (draft.purchaseDate || "").split("-");
    if (y && m) { setFilterYear(y); setFilterMonth(String(Number(m))); }
    loadAll();
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
      const dup = /unique|constraint|P2002/i.test(err?.message || "") || err?.code === "P2002";
      setSaveError(dup ? "Já existe um fornecedor com esse CNPJ/CPF." : `Erro ao salvar fornecedor: ${err?.message || String(err)}`);
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
    const qDigits = q.replace(/\D/g, "");
    return (s.name?.toLowerCase().includes(q)) || (s.category?.toLowerCase().includes(q)) || (s.contact?.toLowerCase().includes(q)) || (qDigits.length > 0 && (s.cnpj || "").includes(qDigits));
  });

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
    if (filterTeam && (p.team || "") !== filterTeam) return false;
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
  // Equipes presentes nas compras (pra montar o filtro). Rótulo via MATERIAL_CREW_TEAMS.
  const purchaseTeams = Array.from(new Set(purchases.map((p) => p.team).filter(Boolean) as string[])).sort();
  const teamLabel = (t: string) => MATERIAL_CREW_TEAMS.find((x) => x.value === t)?.label || t;
  const selCls = "w-full sm:w-auto px-3 py-2 border border-border rounded-lg text-sm bg-card focus:ring-2 focus:ring-primary outline-none";

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
      key: "compras",
      label: "Controle de Compras",
      content: (
        <div className="space-y-5">
          <div className="flex flex-wrap justify-between items-center gap-3">
            <p className="text-sm text-text-light">Registro das compras realizadas, por mês — inspirado na planilha oficial de compras</p>
            {canManagePurchases && (
              // Escanear: abre a câmera e a IA lê nota/cupom/boleto (itens,
              // valores, fornecedor) — substitui o leitor de código de barras e
              // o Importar PDF.
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <Button size="sm" variant="secondary" className="flex-1 sm:flex-none" onClick={() => { setScanFiles(null); setScanOpen(true); }}>
                  📷 Escanear
                </Button>
                {/* Importar PDF: a IA lê o PDF da NF/boleto (ou foto da galeria)
                    e abre a mesma conferência do Escanear, já preenchida. */}
                <label className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 font-medium rounded-lg transition bg-gray-100 hover:bg-gray-200 text-text px-3 py-1.5 text-xs cursor-pointer whitespace-nowrap">
                  📄 Importar PDF
                  <input
                    type="file"
                    accept="application/pdf,image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      e.target.value = "";
                      if (files.length === 0) return;
                      setScanFiles(files);
                      setScanOpen(true);
                    }}
                  />
                </label>
                <Button size="sm" className="flex-1 sm:flex-none" onClick={() => { setEditPurchase(null); setShowPurchaseForm(true); }}>
                  <PlusIcon className="w-4 h-4" />Nova Compra
                </Button>
              </div>
            )}
          </div>

          {/* Filtros + total + relatório. No celular: grade de 2 colunas (os
              selects lado a lado sem quebrar torto) e total/relatório em
              largura cheia; do sm pra cima volta a ser uma linha só. */}
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3">
              <label className="flex flex-col gap-1 text-xs min-w-0">
                <span className="text-text-light font-medium uppercase tracking-wide">Ano</span>
                <select value={filterYear} onChange={(e) => setFilterYear(e.target.value)} className={selCls}>
                  {purchaseYears.map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs min-w-0">
                <span className="text-text-light font-medium uppercase tracking-wide">Mês</span>
                <select value={filterMonth} onChange={(e) => setFilterMonth(e.target.value)} className={selCls}>
                  <option value="">Ano inteiro</option>
                  {MONTH_NAMES.map((nm, i) => <option key={i} value={String(i + 1)}>{nm}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs min-w-0">
                <span className="text-text-light font-medium uppercase tracking-wide">Destino</span>
                <select value={filterDept} onChange={(e) => setFilterDept(e.target.value)} className={selCls}>
                  <option value="">Todos</option>
                  {purchaseDepts.map((d) => <option key={d} value={d}>{departmentLabel(d)}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs min-w-0">
                <span className="text-text-light font-medium uppercase tracking-wide">Fornecedor</span>
                <select value={filterSupplier} onChange={(e) => setFilterSupplier(e.target.value)} className={`${selCls} max-w-[200px]`}>
                  <option value="">Todos</option>
                  {purchaseSuppliers.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs min-w-0">
                <span className="text-text-light font-medium uppercase tracking-wide">Pagamento</span>
                <select value={filterPayment} onChange={(e) => setFilterPayment(e.target.value)} className={selCls}>
                  <option value="">Todas</option>
                  {purchasePayments.map((pm) => <option key={pm} value={pm}>{pm}</option>)}
                </select>
              </label>
              {purchaseShips.length > 0 && (
                <label className="flex flex-col gap-1 text-xs min-w-0">
                  <span className="text-text-light font-medium uppercase tracking-wide">Navio</span>
                  <select value={filterShip} onChange={(e) => setFilterShip(e.target.value)} className={`${selCls} max-w-[200px]`}>
                    <option value="">Todos</option>
                    {purchaseShips.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </label>
              )}
              {purchaseTeams.length > 0 && (
                <label className="flex flex-col gap-1 text-xs min-w-0">
                  <span className="text-text-light font-medium uppercase tracking-wide">Equipe</span>
                  <select value={filterTeam} onChange={(e) => setFilterTeam(e.target.value)} className={`${selCls} max-w-[200px]`}>
                    <option value="">Todas</option>
                    {purchaseTeams.map((t) => <option key={t} value={t}>{teamLabel(t)}</option>)}
                  </select>
                </label>
              )}
              {(filterMonth || filterDept || filterSupplier || filterPayment || filterShip || filterTeam) && (
                <button
                  type="button"
                  onClick={() => { setFilterMonth(""); setFilterDept(""); setFilterSupplier(""); setFilterPayment(""); setFilterShip(""); setFilterTeam(""); }}
                  className="col-span-2 text-left text-xs text-text-light underline hover:text-text sm:pb-2.5"
                >
                  Limpar filtros
                </button>
              )}

              <div className="hidden sm:block flex-1" />

              <Button size="sm" variant="secondary" className="col-span-2 sm:col-auto order-last sm:order-none" onClick={handleGenerateReport} disabled={generatingReport || filteredCount === 0}>
                {generatingReport ? "Gerando..." : "📊 Gerar Relatório (Excel)"}
              </Button>

              <div className="col-span-2 sm:col-auto bg-primary/5 border border-primary/20 rounded-xl px-4 py-2.5 flex items-center justify-between gap-3 sm:block sm:text-right">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-text-light">Total · {periodLabel}</p>
                  <p className="text-[11px] text-text-light sm:hidden">{filteredCount} {filteredCount === 1 ? "compra" : "compras"}</p>
                </div>
                <p className="text-lg font-bold text-primary whitespace-nowrap">{formatCurrency(filteredTotal)}</p>
                <p className="hidden sm:block text-[11px] text-text-light">{filteredCount} {filteredCount === 1 ? "compra" : "compras"}</p>
              </div>
            </div>
            {reportError && <p className="text-xs text-danger">⚠️ {reportError}</p>}
          </div>

          {/* Lista de compras do mês */}
          {filteredPurchases.length === 0 ? (
            <div className="text-center py-12 text-text-light">
              <span className="text-4xl block mb-3">🧾</span>
              <p className="font-medium">Nenhuma compra em {periodLabel}</p>
              <p className="text-xs mt-1">Use &quot;📷 Escanear&quot; (foto da nota/cupom/boleto), &quot;📄 Importar PDF&quot; ou &quot;Nova Compra&quot; para registrar</p>
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
                        <td className="px-3 py-2.5 whitespace-nowrap">{paymentLabel(p) || "—"}</td>
                        {canManagePurchases && (
                          <td className="px-3 py-2.5">
                            <div className="flex gap-0.5 justify-end">
                              <button onClick={() => { setEditPurchase(p); setShowPurchaseForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded" title="Editar"><EditIcon /></button>
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
                  <div
                    key={p.id}
                    onClick={canManagePurchases ? (e) => {
                      // Tocar no card = editar (a foto e os botões têm ação própria).
                      if ((e.target as HTMLElement).closest("button, a")) return;
                      setEditPurchase(p); setShowPurchaseForm(true);
                    } : undefined}
                    className={`bg-card border border-border rounded-xl p-3 ${canManagePurchases ? "active:bg-gray-50 cursor-pointer" : ""}`}
                  >
                    <div className="flex items-start gap-3">
                      {p.image_url && (
                        <button type="button" onClick={() => setLightboxImage(p.image_url)} className="shrink-0">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={p.image_url} alt="" className="w-12 h-12 rounded-lg object-cover border border-border" />
                        </button>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-medium text-text line-clamp-2 break-words min-w-0">{p.description}</p>
                          <span className="font-semibold text-primary whitespace-nowrap">{formatCurrency(p.total_value || 0)}</span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-xs text-text-light items-center">
                          {p.code && <span className="font-mono">{p.code}</span>}
                          {p.department && <span className={`px-1.5 py-0.5 rounded-full font-medium ${DEPARTMENT_BADGE[p.department] || "bg-gray-100 text-gray-700"}`}>{departmentLabel(p.department)}</span>}
                          {p.ship_name && <span className="px-1.5 py-0.5 rounded-full font-medium bg-sky-100 text-sky-700">🚢 {p.ship_name}</span>}
                          {p.supplier && <span>{p.supplier}</span>}
                          <span>{formatPurchaseDate(p.purchase_date)}</span>
                          <span>{formatQty(p.quantity)} × {formatCurrency(p.unit_value || 0)}</span>
                          {p.payment_method && <span>{paymentLabel(p)}</span>}
                        </div>
                        {p.notes && <p className="text-xs text-text-light mt-1 line-clamp-2 break-words">{p.notes}</p>}
                      </div>
                    </div>
                    {canManagePurchases && (
                      <div className="flex gap-1 justify-end mt-2 pt-2 border-t border-border">
                        <button onClick={() => { setEditPurchase(p); setShowPurchaseForm(true); }} className="p-2.5 text-primary hover:bg-blue-50 rounded-lg" aria-label="Editar"><EditIcon /></button>
                        <button onClick={() => setDeletePurchase(p)} className="p-2.5 text-danger hover:bg-red-50 rounded-lg" aria-label="Excluir"><TrashIcon /></button>
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
                        {s.cnpj && (
                          <div className="flex items-center gap-2">
                            <span className="shrink-0">🧾</span>
                            <span>CNPJ/CPF: {s.cnpj}</span>
                          </div>
                        )}
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
    .filter((t) => t.key !== "produtos" || PRODUTOS_ROLES.includes(role))
    // "Controle de Compras" só pros papéis de gestão (mesma regra do menu em
    // rbac.ts). Manutenção não vê a aba nem acessando ?tab=compras direto —
    // o effectiveTab abaixo cai pra primeira aba disponível (Solicitações).
    .filter((t) => t.key !== "compras" || COMPRAS_ROLES.includes(role))
    // "Fornecedores" segue a mesma regra do menu: Manutenção fica de fora.
    .filter((t) => t.key !== "fornecedores" || FORNECEDORES_ROLES.includes(role));

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

      {/* Product Link Form Modal */}
      <LinkFormModal open={showLinkForm} onClose={() => { setShowLinkForm(false); setEditLink(null); setSaveError(null); }} onSave={handleSaveLink} item={editLink} saving={saving} error={saveError} />

      {/* Chamar fornecedor no WhatsApp da Cargo — aba Fornecedores. */}
      <WhatsappSupplierModal open={!!whatsappTarget} onClose={() => setWhatsappTarget(null)} target={whatsappTarget} />

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
      <SupplierFormModal
        open={showSupplierForm}
        onClose={() => { setShowSupplierForm(false); setEditSupplier(null); }}
        onSave={handleSaveSupplier}
        item={editSupplier}
        saving={saving}
        categories={Array.from(new Set([...SUPPLIER_CATEGORIES, ...suppliers.map((s) => (s.category || "").trim().toUpperCase()).filter(Boolean)]))}
      />

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
        onClose={() => { setShowPurchaseForm(false); setEditPurchase(null); }}
        onSave={handleSavePurchase}
        item={editPurchase}
        suppliers={suppliers}
        ships={ships}
        cards={cards}
        bankAccounts={bankAccounts}
        onCreateCard={handleCreateCard}
        saving={saving}
      />

      {/* Escanear (câmera + IA) — montado só quando abre, pra câmera desligar
          ao fechar. */}
      {scanOpen && (
        <EscanearCompraModal
          open
          onClose={() => { setScanOpen(false); setScanFiles(null); }}
          onSave={handleSaveScanned}
          initialFiles={scanFiles}
          suppliers={suppliers.map((s) => s.name)}
          ships={ships.map((s) => ({ id: s.id, label: shipSelectLabel(s) }))}
          destinations={WAREHOUSE_DESTINATIONS}
          paymentMethods={PAYMENT_METHODS}
        />
      )}

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
          className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-safe-4"
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
// /api/solicitacoes/link-preview). Usado pela Nova
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

// Converte número do banco para o texto do input em pt-BR (vírgula decimal).
function numToInput(n: number | null | undefined): string {
  if (n == null || n === 0) return "";
  return String(n).replace(".", ",");
}

// Destinos cujos itens têm "Código" no Almoxarifado (gerado por setor a partir do
// nome — buildCodeMap). Maquinário (cada unidade é um registro próprio), Rancho
// (card #46: só registra a compra, sem mexer no estoque), Escritório e Outros não
// têm código, então o campo não aparece pra eles.
const CODED_DESTS: WarehouseDest[] = ["ESTOQUE", "EPI", "UNIFORME", "FERRAMENTA", "ELETRICA", "FLUIDOS", "MAQUINARIO"];

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
  // Ferramenta/Elétrica/Fluídos/Maquinário são inventário em stock_items com o
  // team sentinela do setor (a tabela `tools` de empréstimo ficou sem uso). O
  // Maquinário do Almoxarifado é stock_items team=MAQUINARIO — ler daqui faz os
  // itens aparecerem no autocomplete e a compra repor o item certo.
  if (dest === "FERRAMENTA" || dest === "ELETRICA" || dest === "FLUIDOS" || dest === "MAQUINARIO") {
    const { data } = await db.from("stock_items").select("id, name, quantity").eq("team", dest);
    return ((data as any[]) || []).map((i) => ({ id: i.id, name: i.name, size: null, qty: i.quantity }));
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
function CodeField({ dest, team, value, name = "", onChange, onResolveName, open, required = false, auto = false }: {
  dest: WarehouseDest; team: string; value: string;
  // Nome do produto digitado — base da sugestão de código novo quando em branco.
  name?: string;
  onChange: (v: string) => void;
  onResolveName?: (name: string) => void;
  open: boolean;
  // required: quando um destino de estoque foi escolhido, o código passa a ser
  // obrigatório (usado no Controle de Compras).
  required?: boolean;
  // auto: código SÓ-LEITURA, sempre gerado pelo nome (Descrição). O usuário não
  // digita nem escolhe — usado no Controle de Compras.
  auto?: boolean;
}) {
  const { codes, items } = useWarehouseCodes(dest, team, open);
  const norm = (s: string) => s.trim().toUpperCase();
  // Código gerado pelo nome (mesma regra do Almoxarifado — codeForName).
  const suggested = name.trim() ? codeForName(items, (i) => i.id, (i) => i.name, name) : "";
  // Modo auto: mantém o valor do formulário sempre igual ao código gerado, pra o
  // save e a validação usarem o código automático mesmo sem o usuário digitar.
  useEffect(() => {
    if (auto && suggested !== value) onChange(suggested);
  }, [auto, suggested, value, onChange]);
  if (!CODED_DESTS.includes(dest)) return null;

  if (auto) {
    const matchedAuto = suggested ? codes.find((c) => norm(c.code) === norm(suggested)) : undefined;
    return (
      <div>
        <label className="block text-sm font-medium mb-1">
          Código no Almoxarifado{" "}
          {required
            ? <span className="text-danger">*</span>
            : <span className="font-normal text-text-light">(opcional)</span>}
        </label>
        <div className="w-full px-3 py-2.5 border border-border rounded-lg text-sm bg-gray-50 flex items-center gap-2">
          {suggested
            ? <span className="font-mono font-bold text-primary">{suggested}</span>
            : <span className="text-text-light italic">preencha a descrição acima</span>}
          <span className="text-[10px] text-text-light ml-auto">🔒 gerado pelo nome</span>
        </div>
        <p className="text-[10px] text-text-light mt-1">
          {matchedAuto
            ? <>Repõe <strong>{matchedAuto.name}</strong>{matchedAuto.qty != null ? ` · ${formatQty(matchedAuto.qty)} em estoque` : ""}.</>
            : suggested
              ? "Código novo — o item será criado no Almoxarifado. Vem da descrição; não dá pra editar."
              : "O código é gerado automaticamente pela descrição da compra."}
        </p>
      </div>
    );
  }

  const listId = `wh-codes-${dest}`;
  const handleChange = (v: string) => {
    onChange(v);
    // Casou um código exato → preenche o nome com o do item (consistência).
    const hit = codes.find((c) => norm(c.code) === norm(v));
    if (hit && onResolveName) onResolveName(hit.name);
  };
  const matched = value.trim() ? codes.find((c) => norm(c.code) === norm(value)) : undefined;
  return (
    <div>
      <label className="block text-sm font-medium mb-1">
        Código no Almoxarifado{" "}
        {required
          ? <span className="text-danger">*</span>
          : <span className="font-normal text-text-light">(opcional)</span>}
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
            : required
              ? "Obrigatório com destino selecionado — escolha um item ou digite um código novo."
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
// Destinos de material que suportam alocação por equipe (material_team_allocations).
const TEAM_ALLOC_DESTS: WarehouseDest[] = ["ESTOQUE", "FERRAMENTA", "ELETRICA", "FLUIDOS", "MAQUINARIO"];
// Equipes pra onde a compra de material pode ir direto (fora a "Disponível").
const MATERIAL_CREW_TEAMS = [
  { value: "EQUIPE_1", label: "Equipe 1" },
  { value: "EQUIPE_2", label: "Equipe 2" },
  { value: "EQUIPE_4", label: "Equipe Turbo" },
];

function WarehouseDestinationFields({ value, onChange, quantity, stocking = true }: {
  value: DestSpec; onChange: (v: DestSpec) => void; quantity?: number; stocking?: boolean;
}) {
  // "NENHUM" saiu do seletor (ambíguo com "Outros") — compras antigas sem destino
  // caem no fallback de legado abaixo.
  const known = WAREHOUSE_DESTINATIONS.some((d) => d.value === value.dest);
  // Trocar de destino reseta os campos específicos pra não vazar valor de um
  // setor pro outro (ex.: "Elétrica" do Estoque indo parar na categoria do Rancho).
  const setDest = (dest: WarehouseDest) =>
    onChange({ dest, category: dest === "RANCHO" ? "SUPRIMENTOS" : "", unit: "UN", team: "EQUIPE_1", size: "", crewTeam: "" });
  const selCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-sm font-medium mb-1">Destino no Almoxarifado</label>
        <select value={value.dest} onChange={(e) => setDest(e.target.value as WarehouseDest)} className={selCls}>
          {!known && value.dest && <option value={value.dest}>{DEST_SHORT_LABEL[value.dest] || value.dest} (legado)</option>}
          {WAREHOUSE_DESTINATIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </div>

      {/* Equipe (opcional): pra qual equipe a compra vai. Em branco fica no
          Disponível; escolhendo, a quantidade é alocada direto pra ela. */}
      {stocking && TEAM_ALLOC_DESTS.includes(value.dest) && (
        <div>
          <label className="block text-sm font-medium mb-1">
            Equipe <span className="font-normal text-text-light">(opcional)</span>
          </label>
          <select value={value.crewTeam} onChange={(e) => onChange({ ...value, crewTeam: e.target.value })} className={selCls}>
            <option value="">— Disponível (sem equipe)</option>
            {MATERIAL_CREW_TEAMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <p className="text-[11px] text-text-light mt-1">
            {value.crewTeam
              ? "A quantidade comprada vai direto pra esta equipe no Almoxarifado (sai do Disponível)."
              : "Em branco, a compra entra no Disponível (galpão)."}
          </p>
        </div>
      )}

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
          ⚙️ A quantidade é somada em <strong>Maquinário</strong> (Almoxarifado): pelo código, repõe o
          item existente; sem código/casamento, cria um novo.
        </p>
      )}

      {stocking && value.dest !== "NENHUM" && !destStocks(value.dest) && (
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

// ── Datas puras (sem fuso) das parcelas do FATURADO ─────────────────────────
// A tela pede o VENCIMENTO (é o que vem na fatura da NF); o banco guarda DIAS.
// Estas duas fazem a ponte. Tudo em UTC pra não escorregar um dia por fuso.

// Data da compra + N dias → "YYYY-MM-DD".
function addDaysISO(baseISO: string, days: number): string {
  const [y, m, d] = baseISO.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Quantos dias da compra até o vencimento (null quando alguma data é inválida).
function daysBetweenISO(baseISO: string, targetISO: string): number | null {
  const [by, bm, bd] = baseISO.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = targetISO.slice(0, 10).split("-").map(Number);
  if (!by || !bm || !bd || !ty || !tm || !td) return null;
  const diff = (Date.UTC(ty, tm - 1, td) - Date.UTC(by, bm - 1, bd)) / 86_400_000;
  return Number.isFinite(diff) ? Math.round(diff) : null;
}

// "YYYY-MM-DD" → "DD/MM/YYYY" (só pra mostrar).
function fmtISODate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : "";
}

function PurchaseFormModal({ open, onClose, onSave, item, suppliers, ships, cards, bankAccounts, onCreateCard, saving }: {
  open: boolean; onClose: () => void;
  onSave: (data: Partial<PurchaseOrder>, stock?: DestSpec | null) => void;
  item: PurchaseOrder | null;
  suppliers: Supplier[];
  ships: Ship[];
  cards: CardOption[];
  bankAccounts: BankAccountOption[];
  onCreateCard: (input: NewCardInput) => Promise<CardOption>;
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
  // Linha digitável do boleto — campo próprio (antes ia dentro da Observação).
  const [digitableLine, setDigitableLine] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // Destino no Almoxarifado (substitui o antigo "Departamento"). Em compras novas
  // o item é lançado no setor escolhido; ao editar, o destino vira só rótulo (não
  // relança, pra não contar duas vezes).
  const [destSpec, setDestSpec] = useState<DestSpec>({ ...DEFAULT_DEST_SPEC });
  // Código do item no Almoxarifado (opcional) — repõe aquele item exato ao abastecer.
  const [code, setCode] = useState("");
  // Navio vinculado (opcional) — guarda o id do navio escolhido na aba Navios.
  const [shipId, setShipId] = useState("");
  // Parcelas do FATURADO e cartão usado (só CARTÃO DE CRÉDITO). O faturado
  // costuma dividir o total em 2-4 pagamentos.
  //
  // Aqui a parcela é a DATA DE VENCIMENTO (ISO "YYYY-MM-DD"), porque é isso que
  // vem impresso na fatura da NF ("001 12/11/2025", "002 12/12/2025"...). No
  // banco continua gravado em DIAS (payment_terms), convertido na hora de
  // salvar — o Contas a Pagar segue montando o vencimento como
  // data da compra + dias, sem mudar nada.
  const [paymentDueDates, setPaymentDueDates] = useState<string[]>([""]);
  const [cardId, setCardId] = useState("");
  // Cadastrar cartão novo direto daqui (nem todo mundo acessa o Financeiro).
  const [showNewCard, setShowNewCard] = useState(false);
  const [newCardBankId, setNewCardBankId] = useState("");
  const [newCardLast4, setNewCardLast4] = useState("");
  const [newCardClosing, setNewCardClosing] = useState("");
  const [newCardLabel, setNewCardLabel] = useState("");
  const [savingCard, setSavingCard] = useState(false);

  useEffect(() => {
    if (!open) return;
    const today = new Date();
    const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    // Formulário de cartão novo sempre começa fechado/limpo.
    setShowNewCard(false); setNewCardBankId(""); setNewCardLast4(""); setNewCardClosing(""); setNewCardLabel("");
    if (item) {
      setDescription(item.description || "");
      setLink(item.product_url || "");
      // Edição: o destino salvo vira só rótulo (pode ser um valor legado da planilha).
      // Compra antiga sem destino cai em "Outros" (o "Sem destino" saiu do seletor).
      setDestSpec({ ...DEFAULT_DEST_SPEC, dest: (item.department as WarehouseDest) || "OUTROS" });
      setSupplier(item.supplier || "");
      setPurchaseDate((item.purchase_date || "").slice(0, 10) || todayISO);
      setUnitValue(numToInput(item.unit_value));
      setQuantity(numToInput(item.quantity) || "1");
      setPaymentMethod(item.payment_method || "");
      setNotes(item.notes || "");
      setDigitableLine(item.digitable_line || "");
      setImageUrl(item.image_url || null);
      setCode(item.code || "");
      setShipId(item.ship_id || "");
      // Parcelas salvas (novo) ou o prazo único legado como parcela 1. O banco
      // guarda dias — a tela mostra o vencimento (compra + dias).
      const itemBase = (item.purchase_date || "").slice(0, 10) || todayISO;
      const savedDays = item.payment_terms?.length
        ? item.payment_terms
        : item.payment_term_days != null
          ? [item.payment_term_days]
          : [];
      setPaymentDueDates(
        savedDays.length > 0 ? savedDays.map((d) => addDaysISO(itemBase, d)) : [""],
      );
      setCardId(item.card_id != null ? String(item.card_id) : "");
    } else {
      setDescription(""); setLink(""); setDestSpec({ ...DEFAULT_DEST_SPEC, dest: "OUTROS" }); setSupplier(""); setPurchaseDate(todayISO);
      setUnitValue(""); setQuantity("1"); setPaymentMethod(""); setNotes(""); setDigitableLine(""); setImageUrl(null); setCode(""); setShipId("");
      setPaymentDueDates([""]); setCardId("");
    }
  }, [item, open]);

  const unit = parseDecimalBR(unitValue);
  const qty = parseDecimalBR(quantity);
  const total = unit * qty;

  // Parcelas válidas do FATURADO, convertidas pra DIAS (formato do banco) a
  // partir do vencimento digitado. Vencimento em branco, inválido ou anterior à
  // data da compra fica de fora. O total é dividido em partes iguais por
  // centavos; a última parcela absorve a sobra do arredondamento.
  const validTerms = paymentDueDates
    .map((iso) => (iso.trim() && purchaseDate ? daysBetweenISO(purchaseDate, iso) : null))
    .filter((n): n is number => n != null && n >= 0);
  const parcelValue = (index: number): number => {
    const n = validTerms.length;
    if (n === 0) return 0;
    const totalCents = Math.round(total * 100);
    const baseCents = Math.floor(totalCents / n);
    return (index === n - 1 ? totalCents - baseCents * (n - 1) : baseCents) / 100;
  };

  // Aplica os dados puxados do link (igual à Nova Solicitação): preenche descrição,
  // valor, fornecedor e foto sem sobrescrever o que já foi digitado (salvo "Buscar").
  const applyPreview = useCallback((d: { name?: string; value?: number; supplier?: string; image?: string }, force: boolean) => {
    if (d.name) setDescription((p) => (force || !p.trim() ? d.name! : p));
    if (d.value != null) setUnitValue((p) => (force || !p.trim() ? String(d.value).replace(".", ",") : p));
    if (d.supplier) setSupplier((p) => (force || !p.trim() ? d.supplier! : p));
    if (d.image) setImageUrl((p) => (force || !p ? d.image! : p));
  }, []);

  // Cadastra o cartão novo (via pai, que insere e atualiza a lista) e já o
  // seleciona como "cartão usado" desta compra.
  async function handleSaveNewCard() {
    const last4 = newCardLast4.replace(/\D/g, "");
    const closing = Number(newCardClosing);
    if (!newCardBankId) { alert("Escolha a conta bancária do cartão."); return; }
    if (last4.length !== 4) { alert("Informe os 4 últimos dígitos do cartão."); return; }
    if (!Number.isInteger(closing) || closing < 1 || closing > 31) { alert("Dia de fechamento deve ser entre 1 e 31."); return; }
    setSavingCard(true);
    try {
      const created = await onCreateCard({
        bank_account_id: Number(newCardBankId),
        last4,
        closing_day: closing,
        label: newCardLabel.trim() || null,
      });
      setCardId(String(created.id));
      setShowNewCard(false);
      setNewCardBankId(""); setNewCardLast4(""); setNewCardClosing(""); setNewCardLabel("");
    } catch (err: any) {
      alert(`Erro ao cadastrar o cartão: ${err?.message || String(err)}`);
    } finally {
      setSavingCard(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Destino é opcional; mas se um destino de estoque foi escolhido (só em compra
    // nova, que é quando lançamos no Almoxarifado), o código passa a ser obrigatório.
    if (!item && CODED_DESTS.includes(destSpec.dest) && !code.trim()) {
      alert("Escolha o código no Almoxarifado para o destino selecionado (ou troque o destino pra “Outros”).");
      return;
    }
    // Navio: resolve o nome pelo id escolhido. Se o navio foi apagado (edição de
    // uma compra antiga), mantém o ship_name já salvo pra não perder o vínculo.
    const selectedShip = ships.find((s) => s.id === shipId);
    const shipName = selectedShip ? selectedShip.name : (shipId ? (item?.ship_name || null) : null);
    onSave({
      description,
      department: destSpec.dest && destSpec.dest !== "NENHUM" ? destSpec.dest : null,
      code: code.trim().toUpperCase() || null,
      team: destSpec.crewTeam || null,
      supplier: supplier || null,
      purchase_date: purchaseDate || null,
      unit_value: unit,
      quantity: qty || 1,
      total_value: total,
      payment_method: paymentMethod || null,
      // Parcelas só fazem sentido no FATURADO; cartão só no CARTÃO DE CRÉDITO.
      // payment_term_days segue com a 1ª parcela por compatibilidade (legado).
      payment_terms: paymentMethod === "FATURADO" ? validTerms : [],
      payment_term_days: paymentMethod === "FATURADO" && validTerms.length > 0 ? validTerms[0] : null,
      card_id: paymentMethod === "CARTÃO DE CRÉDITO" && cardId ? Number(cardId) : null,
      notes: notes || null,
      digitable_line: digitableLine.trim() || null,
      image_url: imageUrl,
      product_url: link.trim() || null,
      ship_id: shipId || null,
      ship_name: shipName,
    },
      // Só lança no Almoxarifado em compras novas (na edição vira só rótulo).
      !item ? destSpec : null);
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";
  const title = item ? "Editar Compra" : "Nova Compra";

  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="max-w-3xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <ProductLinkField link={link} onLinkChange={setLink} onData={applyPreview} open={open} />
        <div>
          <label className="block text-sm font-medium mb-1">Descrição *</label>
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} required
            placeholder="Ex: Fita silver tape, Água 1,5 L..." className={inputCls} />
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

        {/* FATURADO: parcelas pela DATA DE VENCIMENTO — é assim que vem na
            fatura da NF ("001 12/11/2025, 002 12/12/2025..."). Cada parcela
            vira um título no Contas a Pagar, com o total dividido igualmente. */}
        {paymentMethod === "FATURADO" && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
            <label className="block text-sm font-medium">Parcelas — vencimento *</label>
            {paymentDueDates.map((iso, i) => {
              const days = iso.trim() && purchaseDate ? daysBetweenISO(purchaseDate, iso) : null;
              const valid = days != null && days >= 0;
              // Índice desta parcela entre as válidas (pro valor certo).
              const validIdx = paymentDueDates
                .slice(0, i)
                .filter((x) => {
                  const d = x.trim() && purchaseDate ? daysBetweenISO(purchaseDate, x) : null;
                  return d != null && d >= 0;
                }).length;
              return (
                <div key={i} className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1">
                  <span className="text-xs text-text-light w-16 shrink-0">Parcela {i + 1}</span>
                  <input
                    type="date"
                    value={iso}
                    min={purchaseDate || undefined}
                    onChange={(e) => setPaymentDueDates((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                    className={`${inputCls} flex-1 min-w-0 sm:flex-none sm:!w-44`}
                  />
                  <span className="order-last sm:order-none basis-full sm:basis-auto pl-[4.5rem] sm:pl-0 text-xs text-text-light flex-1 min-w-0 truncate">
                    {valid
                      ? `${days} dia${days === 1 ? "" : "s"} · ${formatCurrency(parcelValue(validIdx))}`
                      : iso.trim()
                        ? "vencimento antes da data da compra"
                        : "escolha a data"}
                  </span>
                  {paymentDueDates.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setPaymentDueDates((prev) => prev.filter((_, j) => j !== i))}
                      className="p-1 text-danger hover:bg-red-50 rounded shrink-0"
                      title="Remover parcela"
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
            <button
              type="button"
              onClick={() =>
                setPaymentDueDates((prev) => {
                  // Parcela nova cai 30 dias depois da última preenchida — é o
                  // ritmo das faturas (30/60/90/120). Sem nenhuma preenchida,
                  // parte da data da compra.
                  const last = [...prev].reverse().find((x) => x.trim());
                  const base = last || purchaseDate;
                  return [...prev, base ? addDaysISO(base, 30) : ""];
                })
              }
              className="text-xs font-medium text-primary hover:underline"
            >
              + Adicionar parcela
            </button>
            <p className="text-[11px] text-text-light">
              Digite o vencimento de cada parcela (o mesmo que vem na fatura da nota). Cada uma vira um
              título no Contas a Pagar nessa data, com o valor total dividido igualmente.
              {purchaseDate ? ` Contado a partir da compra em ${fmtISODate(purchaseDate)}.` : ""}
            </p>
          </div>
        )}

        {/* CARTÃO DE CRÉDITO: qual cartão foi usado (pra saber o fechamento).
            Dá pra cadastrar um cartão novo aqui mesmo — nem todo mundo tem
            acesso ao Financeiro › Contas bancárias. */}
        {paymentMethod === "CARTÃO DE CRÉDITO" && (
          <div>
            <label className="block text-sm font-medium mb-1">Cartão usado</label>
            <select value={cardId} onChange={(e) => setCardId(e.target.value)} className={inputCls}>
              <option value="">— Selecionar cartão</option>
              {cards.map((c) => <option key={c.id} value={c.id}>{cardLabel(c)}</option>)}
              {/* Cartão já vinculado mas que saiu da lista: preserva o vínculo. */}
              {cardId && !cards.some((c) => String(c.id) === cardId) && (
                <option value={cardId}>cartão #{cardId} (fora da lista)</option>
              )}
            </select>
            {!showNewCard && (
              <button
                type="button"
                onClick={() => setShowNewCard(true)}
                className="text-xs font-medium text-primary hover:underline mt-1.5"
              >
                + Cadastrar novo cartão
              </button>
            )}
            {showNewCard && (
              <div className="mt-2 border border-border rounded-lg p-3 bg-gray-50 space-y-2">
                <p className="text-xs font-semibold">Novo cartão</p>
                <div>
                  <label className="block text-xs font-medium mb-1">Conta bancária *</label>
                  <select value={newCardBankId} onChange={(e) => setNewCardBankId(e.target.value)} className={inputCls}>
                    <option value="">— Selecionar conta</option>
                    {bankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.nickname}{a.bank === "ITAU" ? " (Itaú)" : a.bank === "SANTANDER" ? " (Santander)" : ""}
                      </option>
                    ))}
                  </select>
                  {bankAccounts.length === 0 && (
                    <p className="text-[10px] text-danger mt-1">
                      Nenhuma conta bancária cadastrada — peça ao Financeiro pra criar em Conciliação › Contas bancárias.
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">4 últimos dígitos *</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={4}
                      value={newCardLast4}
                      onChange={(e) => setNewCardLast4(e.target.value.replace(/\D/g, ""))}
                      placeholder="Ex.: 8403"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Fatura fecha dia *</label>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={newCardClosing}
                      onChange={(e) => setNewCardClosing(e.target.value)}
                      placeholder="Ex.: 12"
                      className={inputCls}
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Apelido <span className="text-text-light font-normal">(opcional)</span></label>
                  <input
                    type="text"
                    value={newCardLabel}
                    onChange={(e) => setNewCardLabel(e.target.value)}
                    placeholder="Ex.: Itaú corporativo"
                    className={inputCls}
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => setShowNewCard(false)}
                    className="text-xs font-medium px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveNewCard}
                    disabled={savingCard || bankAccounts.length === 0}
                    className="text-xs font-medium px-3 py-1.5 rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {savingCard ? "Salvando..." : "Salvar cartão"}
                  </button>
                </div>
              </div>
            )}
            <p className="text-[10px] text-text-light mt-1">
              A fatura do cartão é lançada como um boleto à parte no Contas a Pagar.
            </p>
          </div>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4">
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
          <div className="col-span-2 sm:col-span-1">
            <label className="block text-sm font-medium mb-1">Valor total</label>
            <div className="w-full px-3 py-2.5 border border-border rounded-lg text-sm bg-gray-50 font-semibold text-primary">
              {formatCurrency(total)}
            </div>
          </div>
        </div>
        {/* ── Opcionais no fim: destino no Almoxarifado, navio, observação, foto ── */}
        <div className="pt-3 border-t border-border">
          <p className="text-[11px] font-semibold text-text-light uppercase tracking-wide">Opcional</p>
        </div>
        <WarehouseDestinationFields value={destSpec} onChange={(v) => { if (v.dest !== destSpec.dest) setCode(""); setDestSpec(v); }} quantity={qty} stocking={!item} />
        {!item && <CodeField dest={destSpec.dest} team={destSpec.team} value={code} name={description} onChange={setCode} onResolveName={setDescription} open={open} required={CODED_DESTS.includes(destSpec.dest)} auto />}
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
        <div>
          <label className="block text-sm font-medium mb-1">
            Linha digitável <span className="text-text-light font-normal">(boleto)</span>
          </label>
          <input
            type="text"
            inputMode="numeric"
            value={digitableLine}
            onChange={(e) => setDigitableLine(e.target.value)}
            placeholder="Preenchida ao escanear o boleto ou importar a NF"
            className={`${inputCls} font-mono`}
          />
          <p className="text-[10px] text-text-light mt-1">Código de barras do boleto — usado pra pagar/conferir. Preenche sozinho ao escanear ou importar NF.</p>
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

function SupplierFormModal({ open, onClose, onSave, item, saving, categories }: {
  open: boolean; onClose: () => void;
  onSave: (data: Partial<Supplier>) => void;
  item: Supplier | null; saving: boolean;
  // Fixas + as já usadas nos fornecedores (categoria criada continua aparecendo).
  categories: string[];
}) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [cnpj, setCnpj] = useState("");
  const [address, setAddress] = useState("");
  const [category, setCategory] = useState("");
  // "➕ Criar nova categoria..." no select troca pro input de texto livre.
  const [newCategory, setNewCategory] = useState(false);
  const [website, setWebsite] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (item) {
      setName(item.name); setContact(item.contact || ""); setAddress(item.address || "");
      setCategory(item.category || ""); setWebsite(item.website || ""); setNotes(item.notes || "");
      setCnpj(item.cnpj || "");
    } else {
      setName(""); setContact(""); setAddress(""); setCategory(""); setWebsite(""); setNotes("");
      setCnpj("");
    }
    setNewCategory(false);
  }, [item, open]);

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Fornecedor" : "Novo Fornecedor"}>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name, contact: contact || null, address: address || null, category: category.trim().toUpperCase() || null, website: website || null, notes: notes || null, cnpj: cnpj.replace(/\D/g, "") || null }); }} className="space-y-4">
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
            <label className="block text-sm font-medium mb-1">CNPJ/CPF</label>
            <input type="text" value={cnpj} onChange={(e) => setCnpj(e.target.value)} placeholder="só números" inputMode="numeric" className={inputCls} />
            <p className="text-[10px] text-text-light mt-1">Vincula o fornecedor no Contas a Pagar (favorecido/boleto).</p>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Categoria</label>
          <select
            value={newCategory ? "__nova__" : category}
            onChange={(e) => {
              if (e.target.value === "__nova__") { setNewCategory(true); setCategory(""); }
              else { setNewCategory(false); setCategory(e.target.value); }
            }}
            className={inputCls}
          >
            <option value="">Selecionar...</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value="__nova__">➕ Criar nova categoria...</option>
          </select>
          {newCategory && (
            <input
              autoFocus
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value.toUpperCase())}
              placeholder="NOME DA NOVA CATEGORIA"
              className={`${inputCls} mt-2`}
            />
          )}
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
        body: JSON.stringify({ to: waDigits(target.to), text: message, label: target.name, imageUrl: target.imageUrl ?? null }),
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

        {target.imageUrl && (
          <div>
            <p className="text-sm font-medium mb-1">Foto do produto</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={target.imageUrl} alt="Produto" className="max-h-40 rounded-lg border border-border object-contain" />
            <p className="text-[10px] text-text-light mt-1">A foto vai junto com a mensagem.</p>
          </div>
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
