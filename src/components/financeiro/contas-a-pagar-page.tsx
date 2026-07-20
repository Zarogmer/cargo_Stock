"use client";

// Contas a Pagar (fornecedores/boletos) — Fase 2 do módulo (docs/financeiro/).
// Lançamento manual, máquina de estados com auditoria, anexo do PDF do boleto.
// A captura automática por e-mail (Fase 5) cria títulos RECEBIDO nesta mesma
// tela; a conciliação bancária (Fases 3-4) marca PAGO a partir do extrato.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission, canAccessFinanceiroBanco } from "@/lib/rbac";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatCurrency, parseDecimalBR, matchSearch } from "@/lib/utils";
import { stripSectionNum } from "@/lib/demonstracao-financeira";
import { PAYMENT_METHODS } from "@/lib/payment-methods";
import { mergeSections, sectionShortLabel, type CustomSectionRow } from "@/lib/statement-sections";
import type { PayableStatus } from "@/types/financeiro";

// ── Tipos das respostas da API ───────────────────────────────────────────────

interface SupplierRef {
  id: number;
  name: string;
  cnpj: string | null;
}

interface AttachmentMeta {
  id: string;
  filename: string;
  created_at: string;
  created_by: string;
}

interface Invoice {
  id: string;
  description: string;
  amount: string; // Prisma Decimal serializa como string
  due_date: string | null;
  status: PayableStatus;
  origin: string;
  digitable_line: string | null;
  barcode: string | null;
  payee_name: string | null;
  payee_document: string | null;
  bank: string | null;
  expense_type: string | null;
  // Seção da Demonstração Financeira ("6.1".."12") — título com seção também
  // aparece na aba Demonstração Financeira, agrupado por seção.
  statement_section: string | null;
  // Forma de pagamento (PIX, DINHEIRO, BOLETO, FATURADO, cartão...) — herdada da
  // compra de origem ou escolhida à mão.
  payment_method: string | null;
  // Classificação p/ filtro: "MENSAL" (repete todo mês) ou "UNICA".
  recurrence: string;
  // Conta mensal que gerou este título (null = conta única).
  recurring_bill_id: number | null;
  paid_amount: string | null;
  payment_date: string | null;
  notes: string | null;
  approved_by: string | null;
  approved_at: string | null;
  paid_by: string | null;
  paid_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_by: string;
  created_at: string;
  suppliers: SupplierRef | null;
  attachments: AttachmentMeta[];
}

interface Supplier {
  id: number;
  name: string;
  cnpj: string | null;
}

// Conta mensal (recorrente) — o modelo que gera um título por mês. Vem de
// /api/financeiro/contas/recorrentes.
interface RecurringBillRow {
  id: number;
  description: string;
  amount: string; // Prisma Decimal serializa como string
  due_day: number;
  supplier_id: number | null;
  suppliers: { id: number; name: string } | null;
  payee_name: string | null;
  bank: string | null;
  expense_type: string | null;
  statement_section: string | null;
  notes: string | null;
  active: boolean;
  start_month: string;
  end_month: string | null;
  created_by: string;
}

// "2027-01" → "01/2027" (rótulo dos meses da conta mensal).
function fmtMonthKey(m: string): string {
  const [y, mo] = m.split("-");
  return `${mo}/${y}`;
}

// Mês seguinte ao atual, "YYYY-MM" — default do "Começa em" da conta mensal.
function nextMonthKey(): string {
  const d = new Date();
  const n = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
}

// ── Helpers de data (due_date é DATE puro — não passar por timezone) ────────

function fmtDateOnly(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function todayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysStr(days: number): string {
  const dt = new Date();
  dt.setDate(dt.getDate() + days);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

// Normaliza o que foi digitado no campo de valor pra sempre exibir 2 casas
// (1.234,50). Campo vazio continua vazio. Usado no onBlur dos valores (R$).
function formatAmountBR(value: string): string {
  const s = String(value).trim();
  if (s === "") return "";
  return parseDecimalBR(s).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ── Estado "pago" e badge ────────────────────────────────────────────────────
// Não há mais aprovação/cancelamento: um título é PAGO quando tem data de
// pagamento; senão está Em aberto (Vencido se passou do vencimento).

function isPaid(inv: { payment_date: string | null }): boolean {
  return !!inv.payment_date;
}

function PaidBadge({ inv }: { inv: Invoice }) {
  const paid = isPaid(inv);
  const overdue = !paid && !!inv.due_date && inv.due_date.slice(0, 10) < todayStr();
  const cls = paid
    ? "bg-emerald-600 text-white"
    : overdue
      ? "bg-red-100 text-red-700"
      : "bg-blue-100 text-blue-700";
  const label = paid ? "Pago" : overdue ? "Vencido" : "Em aberto";
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${cls}`}>{label}</span>
  );
}

// Bancos padronizados no lançamento manual. Seletor fixo evita "Itaú" vs
// "itau" e mantém o filtro por banco consistente.
const BANK_OPTIONS = ["Itaú", "Santander", "Outro"];

const inputCls =
  "w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40";

// Meses inclusivos entre duas chaves "YYYY-MM": 2026-09 a 2026-12 = 4.
function monthCountInclusive(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return by * 12 + bm - (ay * 12 + am) + 1;
}

// ── Formulário (criar/editar) ───────────────────────────────────────────────

interface FormState {
  description: string;
  amount: string;
  due_date: string;
  supplier_id: string;
  payee_name: string;
  payee_document: string;
  digitable_line: string;
  bank: string;
  expense_type: string;
  payment_method: string;
  recurrence: "MENSAL" | "UNICA";
  statement_section: string;
  paid_amount: string;
  payment_date: string;
  notes: string;
}

const EMPTY_FORM: FormState = {
  description: "",
  amount: "",
  due_date: "",
  supplier_id: "",
  payee_name: "",
  payee_document: "",
  digitable_line: "",
  bank: "",
  expense_type: "",
  payment_method: "",
  recurrence: "UNICA",
  statement_section: "",
  paid_amount: "",
  payment_date: "",
  notes: "",
};

export function ContasAPagarPage() {
  const { profile } = useAuth();
  const role = profile?.role || "FINANCEIRO";
  const canView = canAccessFinanceiroBanco(role);
  const canEdit =
    canView && (hasPermission(role, "FINANCEIRO_MOD", "edit") || hasPermission(role, "FINANCEIRO_MOD", "create"));

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [customSections, setCustomSections] = useState<CustomSectionRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Seções fixas (planilha) + personalizadas (banco) — pro seletor e os rótulos.
  const merged = useMemo(() => mergeSections(customSections), [customSections]);

  const [statusFilter, setStatusFilter] = useState<"ABERTAS" | "PAGO" | "TODAS">("ABERTAS");
  const [search, setSearch] = useState("");

  // Modal único (detalhe + edição na mesma tela).
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Invoice | null>(null); // null = novo título
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formFile, setFormFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [importingPdf, setImportingPdf] = useState(false); // botão do header (lote)
  const [analyzing, setAnalyzing] = useState(false); // leitura no modal
  // Mês de referência do controle ("ALL" = todos). Formato "YYYY-MM".
  const [monthFilter, setMonthFilter] = useState<string>("ALL");
  const [supplierFilter, setSupplierFilter] = useState<string>("ALL");
  const [bankFilter, setBankFilter] = useState<string>("ALL");
  // Filtro por seção da Demonstração Financeira ("NONE" = títulos sem seção).
  const [sectionFilter, setSectionFilter] = useState<string>("ALL");
  // Filtro única x mensal (recorrente).
  const [recurrenceFilter, setRecurrenceFilter] = useState<"ALL" | "MENSAL" | "UNICA">("ALL");
  // Filtro por forma de pagamento ("ALL" = todas).
  const [paymentFilter, setPaymentFilter] = useState<string>("ALL");

  // "Conta única" x "Conta mensal" no modal de criação + campos da recorrência.
  const [billKind, setBillKind] = useState<"UNICA" | "MENSAL">("UNICA");
  const [recDueDay, setRecDueDay] = useState("");
  const [recStartMonth, setRecStartMonth] = useState(nextMonthKey());
  const [recEndMonth, setRecEndMonth] = useState("");

  // Gerenciador "Contas mensais" (listar/pausar/apagar recorrências).
  const [billsOpen, setBillsOpen] = useState(false);
  const [bills, setBills] = useState<RecurringBillRow[]>([]);
  const [billsLoading, setBillsLoading] = useState(false);
  const [togglingBillId, setTogglingBillId] = useState<number | null>(null);
  const [deleteBill, setDeleteBill] = useState<RecurringBillRow | null>(null);
  const [togglingPaid, setTogglingPaid] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Exclusão direto da linha da tabela, sem passar pelo modal de edição.
  const [deleteRow, setDeleteRow] = useState<Invoice | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [uploadingExtra, setUploadingExtra] = useState(false);

  // Cadastro rápido de fornecedor dentro do modal de "Nova conta".
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierCnpj, setNewSupplierCnpj] = useState("");
  const [creatingSupplier, setCreatingSupplier] = useState(false);

  // Lança sozinho, ao abrir a tela, toda compra do Controle de Compras que
  // ainda não virou título. O lançamento na hora da compra é best-effort (uma
  // falha de rede não desfaz a compra), então sem isto uma compra podia ficar
  // órfã pra sempre — foi o que aconteceu com uma de R$ 10.298. Idempotente: o
  // endpoint ignora quem já tem título, e cartão nunca entra (a fatura vira um
  // boleto à parte). Silencioso: é manutenção, não ação do usuário.
  const reconcileCompras = useCallback(async () => {
    try {
      const res = await fetch("/api/financeiro/contas/from-compras");
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      const ids = ((data.purchases as Array<{ id: string }>) || []).map((p) => p.id);
      if (ids.length === 0) return;
      await fetch("/api/financeiro/contas/from-compras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchase_ids: ids }),
      });
    } catch {
      /* silencioso — a tela carrega igual, só não reconcilia desta vez */
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      // Antes de listar, para os títulos novos já aparecerem nesta carga.
      await reconcileCompras();
      const [invRes, supRes, secRes] = await Promise.all([
        fetch("/api/financeiro/contas").then((r) => r.json()),
        db.from("suppliers").select("id, name, cnpj").order("name"),
        fetch("/api/financeiro/statement-sections").then((r) => r.json()).catch(() => ({})),
      ]);
      setInvoices((invRes.invoices as Invoice[]) || []);
      setSuppliers((supRes.data as Supplier[]) || []);
      setCustomSections((secRes.sections as CustomSectionRow[]) || []);
    } catch {
      alert("Erro ao carregar as contas a pagar");
    } finally {
      setLoading(false);
    }
  }, [reconcileCompras]);

  useEffect(() => {
    if (canView) loadAll();
  }, [canView, loadAll]);

  // Substitui/insere um título na lista e no detalhe aberto (pós-ação).
  function upsertInvoice(inv: Invoice) {
    setInvoices((prev) => {
      const idx = prev.findIndex((i) => i.id === inv.id);
      if (idx === -1) return [inv, ...prev];
      const next = [...prev];
      next[idx] = inv;
      return next;
    });
    setEditing((d) => (d && d.id === inv.id ? inv : d));
  }

  // ── Derivados: filtros e KPIs ─────────────────────────────────────────────

  // Mês de referência de um título: data de pagto (se pago) senão vencimento
  // senão criação. É por ele que o controle mensal agrupa (como a planilha).
  function refMonthOf(inv: Invoice): string {
    const d = inv.payment_date || inv.due_date || inv.created_at;
    return d ? d.slice(0, 7) : "";
  }

  // Nome de fornecedor exibido (cadastro > favorecido do boleto).
  function supplierNameOf(inv: Invoice): string {
    return inv.suppliers?.name || inv.payee_name || "(sem fornecedor)";
  }

  // Meses presentes (pro seletor).
  const months = useMemo(() => {
    const set = new Set<string>();
    for (const inv of invoices) {
      const m = refMonthOf(inv);
      if (m) set.add(m);
    }
    return [...set].sort().reverse();
  }, [invoices]);

  // Fornecedores presentes (pro filtro).
  const supplierOptions = useMemo(() => {
    const set = new Set<string>();
    for (const inv of invoices) set.add(supplierNameOf(inv));
    return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [invoices]);

  // Bancos presentes (pro filtro Itaú/Santander).
  const bankOptions = useMemo(() => {
    const set = new Set<string>();
    for (const inv of invoices) if (inv.bank) set.add(inv.bank);
    return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [invoices]);

  // Seções presentes nos títulos (pro filtro), na ordem mesclada.
  const sectionOptions = useMemo(() => {
    const present = new Set(invoices.map((i) => i.statement_section).filter(Boolean) as string[]);
    return merged.sections.filter((s) => present.has(s.key));
  }, [invoices, merged]);

  // Formas de pagamento presentes (pro filtro), na ordem canônica.
  const paymentOptions = useMemo(() => {
    const present = new Set(invoices.map((i) => i.payment_method).filter(Boolean) as string[]);
    return PAYMENT_METHODS.filter((m) => present.has(m));
  }, [invoices]);

  const filtered = useMemo(() => {
    return invoices.filter((inv) => {
      if (monthFilter !== "ALL" && refMonthOf(inv) !== monthFilter) return false;
      if (statusFilter === "ABERTAS" && isPaid(inv)) return false;
      if (statusFilter === "PAGO" && !isPaid(inv)) return false;
      if (supplierFilter !== "ALL" && supplierNameOf(inv) !== supplierFilter) return false;
      if (bankFilter !== "ALL" && inv.bank !== bankFilter) return false;
      if (sectionFilter === "NONE" && inv.statement_section) return false;
      if (sectionFilter !== "ALL" && sectionFilter !== "NONE" && inv.statement_section !== sectionFilter) return false;
      // Mensal = etiqueta recurrence OU título vindo de conta mensal (recurring_bill_id).
      const isMensal = inv.recurrence === "MENSAL" || inv.recurring_bill_id != null;
      if (recurrenceFilter === "MENSAL" && !isMensal) return false;
      if (recurrenceFilter === "UNICA" && isMensal) return false;
      if (paymentFilter !== "ALL" && (inv.payment_method || "") !== paymentFilter) return false;
      if (search) {
        const blob = [
          inv.description,
          inv.payee_name,
          inv.payee_document,
          inv.suppliers?.name,
          inv.suppliers?.cnpj,
          inv.bank,
          inv.expense_type,
          sectionShortLabel(inv.statement_section, merged.byKey),
          inv.payment_method,
          inv.digitable_line,
        ]
          .filter(Boolean)
          .join(" ");
        if (!matchSearch(blob, search)) return false;
      }
      return true;
    });
  }, [invoices, statusFilter, search, monthFilter, supplierFilter, bankFilter, sectionFilter, recurrenceFilter, paymentFilter, merged]);

  // RESUMO do mês selecionado (ou de tudo), no espírito da aba RESUMO da
  // planilha: Falta pagar / Pago / Despesas (total) + contagem de vencidas.
  const resumo = useMemo(() => {
    const today = todayStr();
    const scope = invoices.filter((inv) => monthFilter === "ALL" || refMonthOf(inv) === monthFilter);
    let faltaPagar = 0;
    let pago = 0;
    let overdueCount = 0;
    for (const inv of scope) {
      const amount = Number(inv.amount) || 0;
      if (isPaid(inv)) {
        pago += inv.paid_amount != null ? Number(inv.paid_amount) : amount;
      } else {
        faltaPagar += amount;
        if (inv.due_date && inv.due_date.slice(0, 10) < today) overdueCount++;
      }
    }
    return { faltaPagar, pago, total: faltaPagar + pago, overdueCount };
  }, [invoices, monthFilter]);

  // ── Ações ─────────────────────────────────────────────────────────────────

  function resetNewSupplier() {
    setShowNewSupplier(false);
    setNewSupplierName("");
    setNewSupplierCnpj("");
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormFile(null);
    resetNewSupplier();
    setBillKind("UNICA");
    setRecDueDay("");
    setRecStartMonth(nextMonthKey());
    setRecEndMonth("");
    setModalOpen(true);
  }

  // ── Contas mensais (recorrências) ─────────────────────────────────────────

  async function openBills() {
    setBillsOpen(true);
    setBillsLoading(true);
    try {
      const res = await fetch("/api/financeiro/contas/recorrentes");
      const data = await res.json().catch(() => ({}));
      setBills((data.bills as RecurringBillRow[]) || []);
    } finally {
      setBillsLoading(false);
    }
  }

  // Liga/desliga a recorrência — pausada não gera meses novos; ao reativar, o
  // servidor já completa o mês atual/próximo se faltar.
  async function toggleBill(bill: RecurringBillRow, active: boolean) {
    setTogglingBillId(bill.id);
    try {
      const res = await fetch(`/api/financeiro/contas/recorrentes/${bill.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao atualizar a conta mensal");
        return;
      }
      setBills((prev) => prev.map((b) => (b.id === bill.id ? (data.bill as RecurringBillRow) : b)));
      if (active) await loadAll(); // pode ter materializado título novo
    } finally {
      setTogglingBillId(null);
    }
  }

  async function handleDeleteBill(bill: RecurringBillRow) {
    try {
      const res = await fetch(`/api/financeiro/contas/recorrentes/${bill.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao apagar a conta mensal");
        return;
      }
      setBills((prev) => prev.filter((b) => b.id !== bill.id));
    } finally {
      setDeleteBill(null);
    }
  }

  function openInvoice(inv: Invoice) {
    setEditing(inv);
    setForm({
      description: inv.description,
      amount: formatAmountBR(String(Number(inv.amount))),
      due_date: inv.due_date?.slice(0, 10) || "",
      supplier_id: inv.suppliers ? String(inv.suppliers.id) : "",
      // Título com fornecedor vinculado mas favorecido/CNPJ vazios (ex.: veio do
      // Controle de Compras) já abre com os dados do cadastro preenchidos.
      payee_name: inv.payee_name || inv.suppliers?.name || "",
      payee_document: inv.payee_document || inv.suppliers?.cnpj || "",
      digitable_line: inv.digitable_line || "",
      bank: inv.bank || "",
      expense_type: inv.expense_type || "",
      payment_method: inv.payment_method || "",
      recurrence: inv.recurrence === "MENSAL" || inv.recurring_bill_id != null ? "MENSAL" : "UNICA",
      statement_section: inv.statement_section || "",
      paid_amount: inv.paid_amount != null ? formatAmountBR(String(Number(inv.paid_amount))) : "",
      payment_date: inv.payment_date?.slice(0, 10) || "",
      notes: inv.notes || "",
    });
    setFormFile(null);
    resetNewSupplier();
    setModalOpen(true);
  }

  // Cadastra um fornecedor sem sair do modal e já vincula ao título.
  async function handleCreateSupplier() {
    const name = newSupplierName.trim();
    if (!name) return alert("Informe o nome do fornecedor");
    setCreatingSupplier(true);
    try {
      const actor = profile?.full_name || "Sistema";
      const cnpj = newSupplierCnpj.replace(/\D/g, "") || null;
      const { data, error } = await db.from("suppliers").insert({
        name,
        cnpj,
        created_by: actor,
        updated_by: actor,
      });
      if (error || !data) {
        const dup = /unique|constraint|P2002/i.test(error?.message || "") || error?.code === "P2002";
        alert(dup ? "Já existe um fornecedor com esse CNPJ." : error?.message || "Erro ao cadastrar fornecedor");
        return;
      }
      const created = data as unknown as Supplier;
      setSuppliers((prev) =>
        [...prev, { id: created.id, name: created.name, cnpj: created.cnpj }].sort((a, b) =>
          a.name.localeCompare(b.name, "pt-BR")
        )
      );
      setForm((f) => ({
        ...f,
        supplier_id: String(created.id),
        payee_name: created.name,
        payee_document: created.cnpj || f.payee_document,
      }));
      resetNewSupplier();
    } finally {
      setCreatingSupplier(false);
    }
  }

  // Import em LOTE pelo header: lê 1..N PDFs (boleto ou nota fiscal) e cria os
  // títulos com o arquivo anexado e os campos extraídos.
  async function handlePdfImport(files: FileList) {
    setImportingPdf(true);
    try {
      const fd = new FormData();
      Array.from(files).forEach((f) => fd.append("file", f));
      const res = await fetch("/api/financeiro/contas/importar-pdf", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao importar os PDFs");
        return;
      }
      alert(
        `Importação concluída:\n` +
          `• ${data.created} título(s) criado(s)\n` +
          `• ${data.duplicates} já existiam\n` +
          (data.ocr ? `• ${data.ocr} lido(s) por OCR (scan) — conferir os dados\n` : "") +
          `• ${data.scanned} escaneado(s)/ilegível(is) — anexados, preencher à mão\n` +
          `• ${data.errors} com erro\n\n` +
          `${data.needsAmount} sem valor detectado — confira e complete o valor.`
      );
      await loadAll();
    } finally {
      setImportingPdf(false);
    }
  }

  // Leitura no modal de "Nova conta": lê um PDF e pré-preenche os campos.
  async function handleAnalyzePdf(file: File) {
    setAnalyzing(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/financeiro/contas/analisar-pdf", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao ler o PDF");
        return;
      }
      const p = data.parsed;
      setForm((prev) => ({
        ...prev,
        description: p.description || prev.description,
        amount: p.amount != null ? formatAmountBR(String(p.amount)) : prev.amount,
        due_date: p.due_date || prev.due_date,
        payee_name: p.payee_name || prev.payee_name,
        payee_document: p.payee_document || prev.payee_document,
        digitable_line: p.digitable_line || prev.digitable_line,
        supplier_id: p.supplier_id ? String(p.supplier_id) : prev.supplier_id,
        notes: p.notes || prev.notes,
      }));
      setFormFile(file); // anexa junto ao criar
      if (p.scanned) {
        alert("Este PDF parece escaneado (sem texto legível). Preencha os campos à mão — o arquivo será anexado ao criar.");
      } else if (p.ocr) {
        alert("PDF escaneado lido por OCR — confira os campos antes de criar (dígitos podem sair trocados).");
      } else if (p.amount == null) {
        alert("Li o documento, mas não consegui o valor com segurança. Confira e preencha o valor.");
      }
    } finally {
      setAnalyzing(false);
    }
  }

  async function uploadAttachment(invoiceId: string, file: File): Promise<boolean> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`/api/financeiro/contas/${invoiceId}/anexos`, { method: "POST", body: fd });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Erro ao anexar o PDF");
      return false;
    }
    return true;
  }

  async function handleSave() {
    const amount = parseDecimalBR(form.amount);
    if (!form.description.trim()) return alert("Informe a descrição");
    if (amount <= 0) return alert("Informe um valor válido");

    // Conta mensal: cria a recorrência (o servidor já materializa o título do
    // mês, se o "começa em" permitir) em vez de um título avulso.
    if (!editing && billKind === "MENSAL") {
      const dueDay = Number(recDueDay);
      if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return alert("Informe o dia do vencimento (1 a 31)");
      if (!/^\d{4}-\d{2}$/.test(recStartMonth)) return alert("Informe o mês em que a conta começa");
      if (recEndMonth && recEndMonth < recStartMonth) return alert("O mês final vem antes do início");
      setSaving(true);
      try {
        const res = await fetch("/api/financeiro/contas/recorrentes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description: form.description,
            amount,
            due_day: dueDay,
            start_month: recStartMonth,
            end_month: recEndMonth || null,
            supplier_id: form.supplier_id ? Number(form.supplier_id) : null,
            payee_name: form.payee_name || null,
            bank: form.bank || null,
            expense_type: form.expense_type || null,
            statement_section: form.statement_section || null,
            notes: form.notes || null,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          alert(data.error || "Erro ao criar a conta mensal");
          return;
        }
        setModalOpen(false);
        await loadAll();
      } finally {
        setSaving(false);
      }
      return;
    }

    setSaving(true);
    try {
      const payload = {
        description: form.description,
        amount,
        due_date: form.due_date || null,
        supplier_id: form.supplier_id ? Number(form.supplier_id) : null,
        payee_name: form.payee_name || null,
        payee_document: form.payee_document || null,
        digitable_line: form.digitable_line || null,
        bank: form.bank || null,
        expense_type: form.expense_type || null,
        payment_method: form.payment_method || null,
        recurrence: form.recurrence,
        statement_section: form.statement_section || null,
        paid_amount: form.paid_amount ? parseDecimalBR(form.paid_amount) : null,
        payment_date: form.payment_date || null,
        notes: form.notes || null,
      };
      const res = await fetch(editing ? `/api/financeiro/contas/${editing.id}` : "/api/financeiro/contas", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao salvar o título");
        return;
      }
      let inv = data.invoice as Invoice;
      if (formFile) {
        const ok = await uploadAttachment(inv.id, formFile);
        if (ok) {
          const ref = await fetch(`/api/financeiro/contas/${inv.id}`).then((r) => r.json());
          if (ref.invoice) inv = ref.invoice as Invoice;
        }
      }
      upsertInvoice(inv);
      setModalOpen(false);
    } finally {
      setSaving(false);
    }
  }

  // Marca/desmarca pago (dirigido pela data de pagamento — sem aprovação).
  async function setPaid(inv: Invoice, paid: boolean) {
    setTogglingPaid(true);
    try {
      const body = paid
        ? {
            payment_date: todayStr(),
            paid_amount: inv.paid_amount != null ? Number(inv.paid_amount) : Number(inv.amount),
          }
        : { payment_date: null };
      const res = await fetch(`/api/financeiro/contas/${inv.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao atualizar o pagamento");
        return;
      }
      upsertInvoice(data.invoice as Invoice);
    } finally {
      setTogglingPaid(false);
    }
  }

  // Exclui o título de vez (não é o mesmo que "Cancelar"). Some da lista.
  async function handleDelete(inv: Invoice) {
    setDeleting(true);
    try {
      const res = await fetch(`/api/financeiro/contas/${inv.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao excluir o título");
        return;
      }
      setInvoices((prev) => prev.filter((i) => i.id !== inv.id));
      setDeleteOpen(false);
      setDeleteRow(null);
      setModalOpen(false);
      setEditing(null);
    } finally {
      setDeleting(false);
    }
  }

  async function handleExtraUpload(inv: Invoice, file: File) {
    setUploadingExtra(true);
    try {
      const ok = await uploadAttachment(inv.id, file);
      if (ok) {
        const ref = await fetch(`/api/financeiro/contas/${inv.id}`).then((r) => r.json());
        if (ref.invoice) upsertInvoice(ref.invoice as Invoice);
      }
    } finally {
      setUploadingExtra(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (!canView) {
    return (
      <div className="max-w-7xl mx-auto">
        <p className="text-text-light">Você não tem acesso a este módulo.</p>
      </div>
    );
  }

  // Sem aprovação/cancelamento: edição liberada sempre que pode editar.
  const readOnly = !canEdit;

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-baseline gap-2 flex-wrap">
            <h1 className="text-2xl font-bold text-text">Financeiro 💰</h1>
            <span className="text-text-light">›</span>
            <span className="text-lg font-semibold text-text-light">Contas a Pagar</span>
          </div>
          <p className="text-text-light text-sm mt-0.5">
            Controle de vencimentos — lançamento manual (dinheiro, pix, boletos, outros bancos)
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2 flex-wrap">
            <label className={`inline-flex items-center ${importingPdf ? "opacity-50" : "cursor-pointer"}`}>
              <span className="bg-primary hover:bg-primary-dark text-white text-sm font-medium px-4 py-2.5 rounded-lg transition">
                {importingPdf ? "Importando..." : "Import NF (PDF)"}
              </span>
              <input
                type="file"
                accept="application/pdf"
                multiple
                className="hidden"
                disabled={importingPdf}
                onChange={(e) => {
                  const fs = e.target.files;
                  if (fs && fs.length) handlePdfImport(fs);
                  e.target.value = "";
                }}
              />
            </label>
            <Button onClick={openCreate}>+ Nova conta</Button>
          </div>
        )}
      </div>

      {/* RESUMO (do mês selecionado, no espírito da aba RESUMO da planilha) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-xs text-text-light">Falta pagar {monthFilter !== "ALL" ? "(mês)" : ""}</p>
          <p className="text-xl font-bold text-amber-600">{formatCurrency(resumo.faltaPagar)}</p>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-xs text-text-light">Pago {monthFilter !== "ALL" ? "(mês)" : ""}</p>
          <p className="text-xl font-bold text-emerald-600">{formatCurrency(resumo.pago)}</p>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-xs text-text-light">Despesas {monthFilter !== "ALL" ? "do mês" : "(total)"}</p>
          <p className="text-xl font-bold text-text">{formatCurrency(resumo.total)}</p>
        </div>
        <div className="bg-card border border-border rounded-xl p-4">
          <p className="text-xs text-text-light">Vencidas</p>
          <p className={`text-xl font-bold ${resumo.overdueCount > 0 ? "text-red-600" : "text-text"}`}>
            {resumo.overdueCount}
          </p>
          <p className="text-xs text-text-light">título(s) em atraso</p>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex gap-3 flex-wrap items-center">
        <select
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          className="text-sm border border-border rounded-lg px-3 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="ALL">Todos os meses</option>
          {months.map((m) => {
            const [y, mo] = m.split("-");
            return (
              <option key={m} value={m}>
                {mo}/{y}
              </option>
            );
          })}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          className="text-sm border border-border rounded-lg px-3 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="ABERTAS">Em aberto</option>
          <option value="PAGO">Pago</option>
          <option value="TODAS">Todas</option>
        </select>
        <select
          value={supplierFilter}
          onChange={(e) => setSupplierFilter(e.target.value)}
          className="text-sm border border-border rounded-lg px-3 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40 max-w-[240px]"
        >
          <option value="ALL">Todos os fornecedores</option>
          {supplierOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {bankOptions.length > 0 && (
          <select
            value={bankFilter}
            onChange={(e) => setBankFilter(e.target.value)}
            className="text-sm border border-border rounded-lg px-3 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="ALL">Todos os bancos</option>
            {bankOptions.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        )}
        {sectionOptions.length > 0 && (
          <select
            value={sectionFilter}
            onChange={(e) => setSectionFilter(e.target.value)}
            className="text-sm border border-border rounded-lg px-3 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40 max-w-[220px]"
          >
            <option value="ALL">Todas as seções</option>
            <option value="NONE">Sem seção</option>
            {sectionOptions.map((s) => (
              <option key={s.key} value={s.key}>
                {s.shortLabel}
              </option>
            ))}
          </select>
        )}
        <select
          value={recurrenceFilter}
          onChange={(e) => setRecurrenceFilter(e.target.value as typeof recurrenceFilter)}
          className="text-sm border border-border rounded-lg px-3 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="ALL">Únicas e mensais</option>
          <option value="MENSAL">🔁 Só mensais</option>
          <option value="UNICA">Só únicas</option>
        </select>
        {/* Gerenciar as RECORRÊNCIAS (pausar/apagar a regra que gera o título
            todo mês) — coisa diferente de filtrar os títulos já gerados. Fica
            aqui, colado no filtro de mensais, em vez de ocupar a barra de cima. */}
        {recurrenceFilter === "MENSAL" && canEdit && (
          <button
            onClick={openBills}
            className="text-sm text-primary hover:underline whitespace-nowrap"
          >
            gerenciar recorrências
          </button>
        )}
        {paymentOptions.length > 0 && (
          <select
            value={paymentFilter}
            onChange={(e) => setPaymentFilter(e.target.value)}
            className="text-sm border border-border rounded-lg px-3 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="ALL">Toda forma de pagamento</option>
            {paymentOptions.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        )}
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por descrição, fornecedor, CNPJ, banco..."
          className="flex-1 min-w-[220px] text-sm border border-border rounded-lg px-3 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>

      {/* Tabela */}
      <div className="bg-card border border-border rounded-xl overflow-x-auto">
        {loading ? (
          <p className="p-8 text-center text-text-light text-sm">Carregando...</p>
        ) : filtered.length === 0 ? (
          <p className="p-8 text-center text-text-light text-sm">Nenhum título encontrado.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-text-light">
                <th className="px-3 py-3 font-medium">Vencimento</th>
                <th className="px-3 py-3 font-medium">Pagto</th>
                <th className="px-3 py-3 font-medium">Descrição / Fornecedor</th>
                <th className="px-3 py-3 font-medium text-right">Valor</th>
                <th className="px-3 py-3 font-medium text-right">Pago</th>
                <th className="px-3 py-3 font-medium">Banco</th>
                <th className="px-3 py-3 font-medium">Tipo</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium text-center">PDF</th>
                {canEdit && <th className="px-2 py-3 font-medium text-center w-10"></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const overdue =
                  !isPaid(inv) && !!inv.due_date && inv.due_date.slice(0, 10) < todayStr();
                return (
                  <tr
                    key={inv.id}
                    onClick={() => openInvoice(inv)}
                    className="border-b border-border last:border-0 hover:bg-gray-50 cursor-pointer"
                  >
                    <td className={`px-3 py-3 whitespace-nowrap ${overdue ? "text-red-600 font-semibold" : "text-text"}`}>
                      {fmtDateOnly(inv.due_date)}
                      {overdue && " ⚠"}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-text-light">{fmtDateOnly(inv.payment_date)}</td>
                    <td className="px-3 py-3 text-text max-w-[300px]">
                      <span className="block truncate">
                        {(inv.recurring_bill_id != null || inv.recurrence === "MENSAL") && (
                          <span title={inv.recurring_bill_id != null ? "Conta mensal (gerada automaticamente)" : "Marcada como conta mensal"}>🔁 </span>
                        )}
                        {inv.description}
                      </span>
                      {(() => {
                        // Fornecedor embaixo da descrição — some só quando repetiria
                        // o mesmo texto (título antigo criado com descrição = fornecedor).
                        const sup = inv.suppliers?.name || inv.payee_name;
                        return sup && sup.trim().toLowerCase() !== inv.description.trim().toLowerCase() ? (
                          <span className="block truncate text-xs text-text-light">{sup}</span>
                        ) : null;
                      })()}
                    </td>
                    <td className="px-3 py-3 text-right font-medium text-text whitespace-nowrap">
                      {formatCurrency(Number(inv.amount))}
                    </td>
                    <td className="px-3 py-3 text-right text-emerald-700 whitespace-nowrap">
                      {inv.paid_amount != null ? formatCurrency(Number(inv.paid_amount)) : ""}
                    </td>
                    <td className="px-3 py-3 text-text-light whitespace-nowrap">{inv.bank || "—"}</td>
                    <td className="px-3 py-3 text-text-light max-w-[160px]">
                      <span className="block truncate">
                        {inv.expense_type || sectionShortLabel(inv.statement_section, merged.byKey) || "—"}
                      </span>
                      {inv.payment_method && (
                        <span className="mt-0.5 inline-block text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 whitespace-nowrap">
                          {inv.payment_method}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <PaidBadge inv={inv} />
                    </td>
                    <td className="px-3 py-3 text-center text-text-light">
                      {inv.attachments.length > 0 ? `📎 ${inv.attachments.length}` : "—"}
                    </td>
                    {canEdit && (
                      <td className="px-2 py-3 text-center">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setDeleteRow(inv); }}
                          className="p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50 rounded transition"
                          title="Excluir título"
                        >
                          🗑️
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Modal único: detalhe + edição na mesma tela */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Título — detalhe e edição" : "Nova conta a pagar"}
        maxWidth="max-w-3xl"
      >
        <div className="space-y-4">
          {/* Status/origem (só título existente) */}
          {editing && (
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <p className="text-sm text-text-light">
                <span className="font-medium text-text">Origem:</span>{" "}
                {editing.origin === "EMAIL"
                  ? "E-mail"
                  : editing.origin === "EXTRATO"
                    ? "Extrato (OFX)"
                    : editing.origin === "BOLETO_PDF"
                      ? "Boleto (PDF)"
                      : editing.origin === "COMPRA"
                        ? "Controle de Compras"
                        : editing.origin === "DEMONSTRACAO"
                          ? "Demonstração Financeira (planilha)"
                          : "Manual"}
                {"  ·  "}
                {editing.created_by} · {fmtDateTime(editing.created_at)}
              </p>
              <PaidBadge inv={editing} />
            </div>
          )}

          {readOnly && editing && (
            <div className="bg-gray-50 border border-border rounded-lg p-2 text-xs text-text-light">
              Você não tem permissão para editar.
            </div>
          )}

          {/* Formulário editável */}
          <fieldset disabled={readOnly} className="space-y-3 disabled:opacity-70">
            {/* Conta única x mensal: a mensal vira uma recorrência que gera um
                título por mês sozinha (pensa 2027 — ninguém digita de novo). */}
            {!editing && (
              <div>
                <label className="text-xs font-medium text-text-light">Recorrência</label>
                <div className="flex gap-2 mt-1">
                  {([["UNICA", "Conta única"], ["MENSAL", "🔁 Conta mensal"]] as const).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setBillKind(k)}
                      className={`text-sm px-3 py-1.5 rounded-lg border transition ${
                        billKind === k
                          ? "border-primary bg-primary/10 text-primary font-medium"
                          : "border-border text-text-light hover:text-text"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {billKind === "MENSAL" && (
                  <p className="text-[11px] text-text-light mt-1">
                    Gera um título por mês automaticamente (mês atual e o próximo), até você pausar em “gerenciar recorrências” (filtro “🔁 Só mensais”).
                  </p>
                )}
              </div>
            )}
            <div>
              <label className="text-xs font-medium text-text-light">Descrição *</label>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className={inputCls}
                placeholder="Ex.: Boleto químicos — pedido 123"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-text-light">Valor (R$) *</label>
                <input
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  onBlur={(e) => setForm((f) => ({ ...f, amount: formatAmountBR(e.target.value) }))}
                  className={inputCls}
                  placeholder="0,00"
                  inputMode="decimal"
                />
              </div>
              {!editing && billKind === "MENSAL" ? (
                <div>
                  <label className="text-xs font-medium text-text-light">Vence todo dia *</label>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={recDueDay}
                    onChange={(e) => setRecDueDay(e.target.value)}
                    className={inputCls}
                    placeholder="Ex.: 10"
                  />
                </div>
              ) : (
                <div>
                  <label className="text-xs font-medium text-text-light">Vencimento</label>
                  <input
                    type="date"
                    value={form.due_date}
                    onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                    className={inputCls}
                  />
                </div>
              )}
            </div>
            {!editing && billKind === "MENSAL" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-text-light">Começa em *</label>
                  <input
                    type="month"
                    value={recStartMonth}
                    onChange={(e) => setRecStartMonth(e.target.value)}
                    className={inputCls}
                  />
                  <p className="text-[11px] text-text-light mt-1">
                    Comece no primeiro mês que ainda NÃO está lançado (os meses já lançados à mão continuam valendo).
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium text-text-light">Termina em <span className="font-normal">(opcional)</span></label>
                  <input
                    type="month"
                    value={recEndMonth}
                    onChange={(e) => setRecEndMonth(e.target.value)}
                    className={inputCls}
                  />
                  {/* Com término preenchido, mostra na hora quantas parcelas dá. */}
                  {(() => {
                    if (!/^\d{4}-\d{2}$/.test(recEndMonth) || !/^\d{4}-\d{2}$/.test(recStartMonth)) {
                      return <p className="text-[11px] text-text-light mt-1">Em branco, a conta continua até você pausar.</p>;
                    }
                    const n = monthCountInclusive(recStartMonth, recEndMonth);
                    if (n < 1) return <p className="text-[11px] text-red-600 mt-1">O mês final vem antes do início.</p>;
                    const val = parseDecimalBR(form.amount);
                    return (
                      <p className="text-[11px] font-semibold text-primary mt-1">
                        → {n} parcela{n > 1 ? "s" : ""} ({fmtMonthKey(recStartMonth)} a {fmtMonthKey(recEndMonth)})
                        {val > 0 ? ` · ${n} × ${formatCurrency(val)} = ${formatCurrency(n * val)}` : ""}
                      </p>
                    );
                  })()}
                </div>
              </div>
            )}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-text-light">Fornecedor (cadastro)</label>
                {!readOnly && (
                  <button
                    type="button"
                    onClick={() => setShowNewSupplier((v) => !v)}
                    className="text-xs text-primary hover:underline"
                  >
                    {showNewSupplier ? "cancelar" : "+ novo fornecedor"}
                  </button>
                )}
              </div>
              <select
                value={form.supplier_id}
                onChange={(e) => {
                  const sid = e.target.value;
                  const sup = suppliers.find((s) => String(s.id) === sid);
                  // Escolheu fornecedor do cadastro → favorecido e CNPJ vêm de lá
                  // na hora (CNPJ só se o cadastro tiver; senão preserva o digitado).
                  setForm((f) => ({
                    ...f,
                    supplier_id: sid,
                    ...(sup
                      ? { payee_name: sup.name, payee_document: sup.cnpj || f.payee_document }
                      : {}),
                  }));
                }}
                className={inputCls}
              >
                <option value="">— sem vínculo —</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.cnpj ? ` (${s.cnpj})` : ""}
                  </option>
                ))}
              </select>
              {showNewSupplier && !readOnly && (
                <div className="mt-2 border border-border rounded-lg p-3 bg-gray-50 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-xs font-medium text-text-light">Nome *</label>
                      <input
                        value={newSupplierName}
                        onChange={(e) => setNewSupplierName(e.target.value)}
                        className={inputCls}
                        placeholder="Nome do fornecedor"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-text-light">CNPJ/CPF</label>
                      <input
                        value={newSupplierCnpj}
                        onChange={(e) => setNewSupplierCnpj(e.target.value)}
                        className={inputCls}
                        placeholder="só números (opcional)"
                        inputMode="numeric"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button size="sm" onClick={handleCreateSupplier} disabled={creatingSupplier}>
                      {creatingSupplier ? "Salvando..." : "Salvar fornecedor"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-text-light">Favorecido (como no boleto)</label>
                <input
                  value={form.payee_name}
                  onChange={(e) => setForm({ ...form, payee_name: e.target.value })}
                  className={inputCls}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-text-light">CNPJ/CPF do favorecido</label>
                <input
                  value={form.payee_document}
                  onChange={(e) => setForm({ ...form, payee_document: e.target.value })}
                  className={inputCls}
                  placeholder="só números"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-text-light">Banco</label>
                <select
                  value={form.bank}
                  onChange={(e) => setForm({ ...form, bank: e.target.value })}
                  className={inputCls}
                >
                  <option value="">— banco —</option>
                  {BANK_OPTIONS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                  {form.bank && !BANK_OPTIONS.includes(form.bank) && (
                    <option value={form.bank}>{form.bank}</option>
                  )}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-text-light">Tipo de despesa</label>
                <input
                  value={form.expense_type}
                  onChange={(e) => setForm({ ...form, expense_type: e.target.value })}
                  className={inputCls}
                  placeholder="ex.: Rancho, Combustível..."
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-text-light">Forma de pagamento</label>
                <select
                  value={form.payment_method}
                  onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
                  className={inputCls}
                >
                  <option value="">— não informado —</option>
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  {form.payment_method && !(PAYMENT_METHODS as readonly string[]).includes(form.payment_method) && (
                    <option value={form.payment_method}>{form.payment_method}</option>
                  )}
                </select>
              </div>
              {/* Recorrência se decide na criação (abas no topo do "Nova conta")
                  e não muda depois: a conta ou nasceu única ou nasceu mensal.
                  Na edição fica só a etiqueta, sem select. */}
              {editing && (
                <div>
                  <label className="text-xs font-medium text-text-light">Recorrência</label>
                  <div
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-gray-50 text-text-light"
                    title={editing.recurring_bill_id ? "Título gerado por uma conta mensal" : "Definida na criação da conta"}
                  >
                    {form.recurrence === "MENSAL" ? "🔁 Conta mensal (repete)" : "Conta única"}
                  </div>
                </div>
              )}
            </div>
            {/* Seção da Demonstração Financeira: com seção, o título também
                aparece na aba Demonstração, agrupado por seção. */}
            <div>
              <label className="text-xs font-medium text-text-light">Seção na Demonstração Financeira</label>
              <select
                value={form.statement_section}
                onChange={(e) => setForm({ ...form, statement_section: e.target.value })}
                className={inputCls}
              >
                <option value="">— sem seção (não aparece na Demonstração)</option>
                {merged.groups.map((group) => {
                  const secs = merged.sections.filter((s) => s.group === group);
                  if (secs.length === 0) return null;
                  return (
                    <optgroup key={group} label={stripSectionNum(group)}>
                      {secs.map((s) => (
                        <option key={s.key} value={s.key}>{s.shortLabel}</option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            </div>
            {/* Pagamento/linha digitável não fazem sentido no modelo da conta
                mensal — valem por título, depois que cada mês é gerado. */}
            {(editing || billKind === "UNICA") && (<>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-text-light">Valor pago (R$)</label>
                <input
                  value={form.paid_amount}
                  onChange={(e) => setForm({ ...form, paid_amount: e.target.value })}
                  onBlur={(e) => setForm((f) => ({ ...f, paid_amount: formatAmountBR(e.target.value) }))}
                  className={inputCls}
                  placeholder="se diferente do valor"
                  inputMode="decimal"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-text-light">Data de pagamento</label>
                <input
                  type="date"
                  value={form.payment_date}
                  onChange={(e) => setForm({ ...form, payment_date: e.target.value })}
                  className={inputCls}
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-text-light">Linha digitável (se boleto)</label>
              <input
                value={form.digitable_line}
                onChange={(e) => setForm({ ...form, digitable_line: e.target.value })}
                className={inputCls}
                placeholder="47 ou 48 dígitos"
              />
            </div>
            </>)}
            <div>
              <label className="text-xs font-medium text-text-light">Observações</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className={`${inputCls} min-h-[60px]`}
              />
            </div>
            {!editing && billKind === "UNICA" && (
              <div>
                <label className="text-xs font-medium text-text-light">Import NF (PDF)</label>
                <label className={`mt-1 block ${analyzing ? "opacity-50" : "cursor-pointer"}`}>
                  <span className="inline-block bg-gray-100 hover:bg-gray-200 text-text text-xs font-medium px-3 py-1.5 rounded-lg">
                    {analyzing ? "Lendo..." : formFile ? `📎 ${formFile.name}` : "Escolher PDF e ler os dados"}
                  </span>
                  <input
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    disabled={analyzing}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleAnalyzePdf(f);
                      e.target.value = "";
                    }}
                  />
                </label>
                <p className="text-[11px] text-text-light mt-1">
                  Lê boleto ou nota fiscal (fornecedor, número, valor) e preenche os campos. Revise antes de criar.
                </p>
              </div>
            )}
          </fieldset>

          {/* Anexos + preview (só título existente) */}
          {editing && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold text-text">Anexos ({editing.attachments.length})</p>
                {canEdit && (
                  <label className="text-xs text-primary cursor-pointer hover:underline">
                    {uploadingExtra ? "Enviando..." : "+ anexar PDF"}
                    <input
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      disabled={uploadingExtra}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleExtraUpload(editing, f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </div>
              {editing.attachments.length === 0 ? (
                <p className="text-xs text-text-light">Nenhum PDF anexado.</p>
              ) : (
                <div className="space-y-2">
                  <ul className="text-sm space-y-1">
                    {editing.attachments.map((a) => (
                      <li key={a.id} className="flex items-center gap-2">
                        <a
                          href={`/api/financeiro/anexos/${a.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline truncate"
                        >
                          📎 {a.filename}
                        </a>
                        <span className="text-xs text-text-light whitespace-nowrap">por {a.created_by}</span>
                      </li>
                    ))}
                  </ul>
                  <iframe
                    src={`/api/financeiro/anexos/${editing.attachments[0].id}`}
                    className="w-full h-[420px] border border-border rounded-lg"
                    title="PDF do boleto"
                  />
                </div>
              )}
            </div>
          )}

          {/* Pagamento (só existente e pago) */}
          {editing && isPaid(editing) && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-800">
              💸 Pago em {fmtDateOnly(editing.payment_date)}
              {editing.paid_amount != null ? ` — ${formatCurrency(Number(editing.paid_amount))}` : ""}
            </div>
          )}

          {/* Ações */}
          <div className="flex gap-2 flex-wrap justify-end border-t border-border pt-4">
            {canEdit && editing && (
              <Button variant="danger" className="mr-auto" disabled={deleting} onClick={() => setDeleteOpen(true)}>
                Excluir
              </Button>
            )}
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Fechar
            </Button>
            {canEdit && !readOnly && (
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Salvando..." : editing ? "Salvar alterações" : billKind === "MENSAL" ? "Criar conta mensal" : "Adicionar"}
              </Button>
            )}
            {canEdit && editing && !isPaid(editing) && (
              <Button variant="success" disabled={togglingPaid} onClick={() => setPaid(editing, true)}>
                {togglingPaid ? "..." : "Marcar como pago"}
              </Button>
            )}
            {canEdit && editing && isPaid(editing) && (
              <Button variant="secondary" disabled={togglingPaid} onClick={() => setPaid(editing, false)}>
                {togglingPaid ? "..." : "Reabrir (não pago)"}
              </Button>
            )}
          </div>
        </div>
      </Modal>

      {/* Contas mensais (recorrências): listar, pausar/reativar e apagar */}
      <Modal open={billsOpen} onClose={() => setBillsOpen(false)} title="🔁 Contas mensais" maxWidth="max-w-2xl">
        <div className="space-y-3">
          <p className="text-sm text-text-light">
            Cada conta daqui gera um título por mês automaticamente (mês atual e o próximo), já aprovado, vencendo no dia
            escolhido. Pausar ou apagar só para de gerar meses novos — os títulos já lançados ficam.
          </p>
          {billsLoading ? (
            <p className="p-6 text-center text-text-light text-sm">Carregando...</p>
          ) : bills.length === 0 ? (
            <p className="p-6 text-center text-text-light text-sm">
              Nenhuma conta mensal ainda — crie em “+ Nova conta” escolhendo “🔁 Conta mensal”.
            </p>
          ) : (
            <div className="space-y-2">
              {bills.map((b) => (
                <div
                  key={b.id}
                  className={`border border-border rounded-lg px-4 py-3 flex items-start justify-between gap-3 ${
                    b.active ? "" : "opacity-60 bg-gray-50"
                  }`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-text">
                      {b.description}{" "}
                      <span className="font-normal text-text-light">· {formatCurrency(Number(b.amount))}/mês</span>
                    </p>
                    <p className="text-[11px] text-text-light mt-0.5">
                      vence dia {b.due_day} · desde {fmtMonthKey(b.start_month)}
                      {b.end_month ? ` até ${fmtMonthKey(b.end_month)}` : ""}
                      {b.suppliers?.name ? ` · ${b.suppliers.name}` : ""}
                      {b.statement_section
                        ? ` · ${sectionShortLabel(b.statement_section, merged.byKey) || b.statement_section}`
                        : ""}
                    </p>
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-3 shrink-0">
                      <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none whitespace-nowrap">
                        <input
                          type="checkbox"
                          checked={b.active}
                          disabled={togglingBillId === b.id}
                          onChange={(e) => toggleBill(b, e.target.checked)}
                          className="w-4 h-4 accent-primary"
                        />
                        {b.active ? "Ativa" : "Pausada"}
                      </label>
                      <button onClick={() => setDeleteBill(b)} className="text-[11px] text-red-500 hover:text-red-700">
                        apagar
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteBill}
        onClose={() => setDeleteBill(null)}
        onConfirm={() => deleteBill && handleDeleteBill(deleteBill)}
        title="Apagar conta mensal"
        message={
          deleteBill
            ? `Apagar "${deleteBill.description}"? Para de gerar meses novos — os títulos já lançados continuam no Contas a Pagar.`
            : ""
        }
        confirmLabel="Apagar"
        variant="danger"
      />

      {/* Confirmação de EXCLUSÃO pela lixeira da linha (sem abrir o modal) */}
      <ConfirmDialog
        open={!!deleteRow}
        onClose={() => setDeleteRow(null)}
        onConfirm={() => deleteRow && handleDelete(deleteRow)}
        title="Excluir título"
        message={
          deleteRow
            ? `Excluir de vez "${deleteRow.description}"? Essa ação não pode ser desfeita e apaga também os anexos.`
            : ""
        }
        confirmLabel="Excluir"
        variant="danger"
        loading={deleting}
      />

      {/* Confirmação de EXCLUSÃO */}
      <ConfirmDialog
        open={deleteOpen && !!editing}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => editing && handleDelete(editing)}
        title="Excluir título"
        message={
          editing
            ? `Excluir de vez "${editing.description}"? Essa ação não pode ser desfeita e apaga também os anexos.`
            : ""
        }
        confirmLabel="Excluir"
        variant="danger"
        loading={deleting}
      />
    </div>
  );
}
