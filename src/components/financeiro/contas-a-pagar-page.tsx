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
import {
  PAYABLE_STATUS_LABELS,
  PAYABLE_ACTION_LABELS,
  PAYABLE_TRANSITIONS,
} from "@/lib/services/payable-status";
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

// ── Badges ───────────────────────────────────────────────────────────────────

const STATUS_BADGE: Record<PayableStatus, string> = {
  RECEBIDO: "bg-blue-100 text-blue-700",
  AGUARDANDO_APROVACAO: "bg-amber-100 text-amber-700",
  APROVADO: "bg-emerald-100 text-emerald-700",
  PAGO: "bg-emerald-600 text-white",
  CANCELADO: "bg-gray-200 text-gray-600",
};

function StatusBadge({ status }: { status: PayableStatus }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${STATUS_BADGE[status]}`}>
      {PAYABLE_STATUS_LABELS[status]}
    </span>
  );
}

const OPEN_STATUSES: PayableStatus[] = ["RECEBIDO", "AGUARDANDO_APROVACAO", "APROVADO"];

// Bancos padronizados no lançamento manual. Seletor fixo evita "Itaú" vs
// "itau" e mantém o filtro por banco consistente.
const BANK_OPTIONS = ["Itaú", "Santander", "Outro"];

const inputCls =
  "w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40";

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
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState<"ABERTAS" | "PAGO">("ABERTAS");
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
  const [confirmTo, setConfirmTo] = useState<PayableStatus | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [transitioning, setTransitioning] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [uploadingExtra, setUploadingExtra] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [invRes, supRes] = await Promise.all([
        fetch("/api/financeiro/contas").then((r) => r.json()),
        db.from("suppliers").select("id, name, cnpj").order("name"),
      ]);
      setInvoices((invRes.invoices as Invoice[]) || []);
      setSuppliers((supRes.data as Supplier[]) || []);
    } catch {
      alert("Erro ao carregar as contas a pagar");
    } finally {
      setLoading(false);
    }
  }, []);

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

  const filtered = useMemo(() => {
    return invoices.filter((inv) => {
      if (monthFilter !== "ALL" && refMonthOf(inv) !== monthFilter) return false;
      if (statusFilter === "ABERTAS" && !OPEN_STATUSES.includes(inv.status)) return false;
      if (statusFilter === "PAGO" && inv.status !== "PAGO") return false;
      if (supplierFilter !== "ALL" && supplierNameOf(inv) !== supplierFilter) return false;
      if (bankFilter !== "ALL" && inv.bank !== bankFilter) return false;
      if (search) {
        const blob = [
          inv.description,
          inv.payee_name,
          inv.payee_document,
          inv.suppliers?.name,
          inv.suppliers?.cnpj,
          inv.bank,
          inv.expense_type,
          inv.digitable_line,
        ]
          .filter(Boolean)
          .join(" ");
        if (!matchSearch(blob, search)) return false;
      }
      return true;
    });
  }, [invoices, statusFilter, search, monthFilter, supplierFilter, bankFilter]);

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
      if (inv.status === "PAGO") {
        pago += inv.paid_amount != null ? Number(inv.paid_amount) : amount;
      } else if (inv.status !== "CANCELADO") {
        faltaPagar += amount;
        if (inv.due_date && inv.due_date.slice(0, 10) < today) overdueCount++;
      }
    }
    return { faltaPagar, pago, total: faltaPagar + pago, overdueCount };
  }, [invoices, monthFilter]);

  // ── Ações ─────────────────────────────────────────────────────────────────

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormFile(null);
    setModalOpen(true);
  }

  function openInvoice(inv: Invoice) {
    setEditing(inv);
    setForm({
      description: inv.description,
      amount: String(Number(inv.amount)).replace(".", ","),
      due_date: inv.due_date?.slice(0, 10) || "",
      supplier_id: inv.suppliers ? String(inv.suppliers.id) : "",
      payee_name: inv.payee_name || "",
      payee_document: inv.payee_document || "",
      digitable_line: inv.digitable_line || "",
      bank: inv.bank || "",
      expense_type: inv.expense_type || "",
      paid_amount: inv.paid_amount != null ? String(Number(inv.paid_amount)).replace(".", ",") : "",
      payment_date: inv.payment_date?.slice(0, 10) || "",
      notes: inv.notes || "",
    });
    setFormFile(null);
    setModalOpen(true);
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
        amount: p.amount != null ? String(p.amount).replace(".", ",") : prev.amount,
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

  async function doTransition(inv: Invoice, to: PayableStatus, reason?: string) {
    setTransitioning(true);
    try {
      const res = await fetch(`/api/financeiro/contas/${inv.id}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro na transição de status");
        if (res.status === 409) loadAll();
        return;
      }
      upsertInvoice(data.invoice as Invoice);
    } finally {
      setTransitioning(false);
      setConfirmTo(null);
      setCancelOpen(false);
      setCancelReason("");
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

  const detailTransitions =
    editing && editing.status in PAYABLE_TRANSITIONS ? PAYABLE_TRANSITIONS[editing.status] : [];
  // Somente leitura: título cancelado, ou usuário sem permissão de edição.
  const readOnly = (!!editing && editing.status === "CANCELADO") || !canEdit;

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
                {importingPdf ? "Importando..." : "Import Boleto (PDF)"}
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
                <th className="px-3 py-3 font-medium">Fornecedor / Descrição</th>
                <th className="px-3 py-3 font-medium text-right">Valor</th>
                <th className="px-3 py-3 font-medium text-right">Pago</th>
                <th className="px-3 py-3 font-medium">Banco</th>
                <th className="px-3 py-3 font-medium">Tipo</th>
                <th className="px-3 py-3 font-medium">Status</th>
                <th className="px-3 py-3 font-medium text-center">PDF</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const overdue =
                  OPEN_STATUSES.includes(inv.status) &&
                  !!inv.due_date &&
                  inv.due_date.slice(0, 10) < todayStr();
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
                    <td className="px-3 py-3 text-text max-w-[300px] truncate">
                      {inv.suppliers?.name || inv.payee_name || inv.description}
                    </td>
                    <td className="px-3 py-3 text-right font-medium text-text whitespace-nowrap">
                      {formatCurrency(Number(inv.amount))}
                    </td>
                    <td className="px-3 py-3 text-right text-emerald-700 whitespace-nowrap">
                      {inv.paid_amount != null ? formatCurrency(Number(inv.paid_amount)) : ""}
                    </td>
                    <td className="px-3 py-3 text-text-light whitespace-nowrap">{inv.bank || "—"}</td>
                    <td className="px-3 py-3 text-text-light max-w-[120px] truncate">{inv.expense_type || "—"}</td>
                    <td className="px-3 py-3">
                      <StatusBadge status={inv.status} />
                    </td>
                    <td className="px-3 py-3 text-center text-text-light">
                      {inv.attachments.length > 0 ? `📎 ${inv.attachments.length}` : "—"}
                    </td>
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
        onClose={() => {
          setModalOpen(false);
          setCancelOpen(false);
          setCancelReason("");
        }}
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
                      : "Manual"}
                {"  ·  "}
                {editing.created_by} · {fmtDateTime(editing.created_at)}
              </p>
              <StatusBadge status={editing.status} />
            </div>
          )}

          {readOnly && editing && (
            <div className="bg-gray-50 border border-border rounded-lg p-2 text-xs text-text-light">
              {editing.status === "CANCELADO"
                ? "Título cancelado — somente leitura."
                : "Você não tem permissão para editar."}
            </div>
          )}

          {/* Formulário editável */}
          <fieldset disabled={readOnly} className="space-y-3 disabled:opacity-70">
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
                  className={inputCls}
                  placeholder="0,00"
                  inputMode="decimal"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-text-light">Vencimento</label>
                <input
                  type="date"
                  value={form.due_date}
                  onChange={(e) => setForm({ ...form, due_date: e.target.value })}
                  className={inputCls}
                />
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-text-light">Fornecedor (cadastro)</label>
              <select
                value={form.supplier_id}
                onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}
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
                <label className="text-xs font-medium text-text-light">Valor pago (R$)</label>
                <input
                  value={form.paid_amount}
                  onChange={(e) => setForm({ ...form, paid_amount: e.target.value })}
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
            <div>
              <label className="text-xs font-medium text-text-light">Observações</label>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                className={`${inputCls} min-h-[60px]`}
              />
            </div>
            {!editing && (
              <div>
                <label className="text-xs font-medium text-text-light">Import Boleto (PDF)</label>
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
                {canEdit && editing.status !== "CANCELADO" && (
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

          {/* Trilha de auditoria (só existente) */}
          {editing && (
            <div className="bg-gray-50 border border-border rounded-lg p-3 text-xs text-text-light space-y-1">
              {editing.approved_by && (
                <p>
                  ✔ Aprovado por <span className="font-medium text-text">{editing.approved_by}</span> em{" "}
                  {fmtDateTime(editing.approved_at)}
                </p>
              )}
              {editing.paid_by && (
                <p>
                  💸 Pago por <span className="font-medium text-text">{editing.paid_by}</span> em{" "}
                  {fmtDateTime(editing.paid_at)}
                </p>
              )}
              {editing.cancelled_by && (
                <p>
                  ✖ Cancelado por <span className="font-medium text-text">{editing.cancelled_by}</span> em{" "}
                  {fmtDateTime(editing.cancelled_at)}
                  {editing.cancel_reason ? ` — "${editing.cancel_reason}"` : ""}
                </p>
              )}
              {!editing.approved_by && !editing.paid_by && !editing.cancelled_by && (
                <p>Sem aprovações/pagamentos registrados ainda.</p>
              )}
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
                {saving ? "Salvando..." : editing ? "Salvar alterações" : "Criar título"}
              </Button>
            )}
            {canEdit &&
              editing &&
              detailTransitions
                .filter((t) => t !== "CANCELADO")
                .map((t) => (
                  <Button
                    key={t}
                    variant={t === "PAGO" ? "success" : "primary"}
                    disabled={transitioning}
                    onClick={() => (t === "AGUARDANDO_APROVACAO" ? doTransition(editing, t) : setConfirmTo(t))}
                  >
                    {PAYABLE_ACTION_LABELS[t]}
                  </Button>
                ))}
            {canEdit && editing && detailTransitions.includes("CANCELADO") && (
              <Button variant="danger" disabled={transitioning} onClick={() => setCancelOpen((v) => !v)}>
                Cancelar título
              </Button>
            )}
          </div>

          {/* Cancelamento com motivo */}
          {cancelOpen && editing && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-2">
              <label className="text-xs font-medium text-red-700">Motivo do cancelamento</label>
              <textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className={`${inputCls} min-h-[50px]`}
                placeholder="Ex.: boleto duplicado / compra desfeita"
              />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setCancelOpen(false)}>
                  Voltar
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  disabled={transitioning}
                  onClick={() => doTransition(editing, "CANCELADO", cancelReason)}
                >
                  Confirmar cancelamento
                </Button>
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* Confirmação de aprovar/pagar */}
      <ConfirmDialog
        open={!!confirmTo && !!editing}
        onClose={() => setConfirmTo(null)}
        onConfirm={() => editing && confirmTo && doTransition(editing, confirmTo)}
        title={confirmTo ? PAYABLE_ACTION_LABELS[confirmTo] : ""}
        message={
          editing && confirmTo
            ? `${PAYABLE_ACTION_LABELS[confirmTo]}: "${editing.description}" — ${formatCurrency(Number(editing.amount))}?`
            : ""
        }
        confirmLabel={confirmTo ? PAYABLE_ACTION_LABELS[confirmTo] : "Confirmar"}
        variant="primary"
        loading={transitioning}
      />

      {/* Confirmação de EXCLUSÃO (remove de vez, diferente de cancelar) */}
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
