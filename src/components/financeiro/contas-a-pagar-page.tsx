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

  const [statusFilter, setStatusFilter] = useState<"ABERTAS" | "ALL" | PayableStatus>("ABERTAS");
  const [search, setSearch] = useState("");

  // Modal de criar/editar
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formFile, setFormFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingBoleto, setUploadingBoleto] = useState(false);
  const [importingOfx, setImportingOfx] = useState(false);
  // Mês de referência do controle ("ALL" = todos). Formato "YYYY-MM".
  const [monthFilter, setMonthFilter] = useState<string>("ALL");

  // Modal de detalhe
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [confirmTo, setConfirmTo] = useState<PayableStatus | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [transitioning, setTransitioning] = useState(false);
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
    setDetail((d) => (d && d.id === inv.id ? inv : d));
  }

  // ── Derivados: filtros e KPIs ─────────────────────────────────────────────

  // Mês de referência de um título: data de pagto (se pago) senão vencimento
  // senão criação. É por ele que o controle mensal agrupa (como a planilha).
  function refMonthOf(inv: Invoice): string {
    const d = inv.payment_date || inv.due_date || inv.created_at;
    return d ? d.slice(0, 7) : "";
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

  const filtered = useMemo(() => {
    return invoices.filter((inv) => {
      if (monthFilter !== "ALL" && refMonthOf(inv) !== monthFilter) return false;
      if (statusFilter === "ABERTAS" && !OPEN_STATUSES.includes(inv.status)) return false;
      if (statusFilter !== "ABERTAS" && statusFilter !== "ALL" && inv.status !== statusFilter) return false;
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
  }, [invoices, statusFilter, search, monthFilter]);

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
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormFile(null);
    setFormOpen(true);
  }

  function openEdit(inv: Invoice) {
    setEditingId(inv.id);
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
    setFormOpen(true);
  }

  async function handleBoletoUpload(file: File) {
    setUploadingBoleto(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/financeiro/boletos/upload", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao ler o boleto");
        return;
      }
      const p = data.parsed || {};
      const valor = p.amount != null ? `R$ ${Number(p.amount).toFixed(2)}` : "não detectado";
      const venc = p.dueDate ? p.dueDate.split("-").reverse().join("/") : "não detectado";
      if (data.status === "duplicate") {
        alert(`Boleto já estava cadastrado (${data.reason}).`);
      } else {
        alert(
          `Boleto lido!\nValor: ${valor}\nVencimento: ${venc}\nCNPJ: ${p.cnpj || "—"}\n` +
            (p.digitableLine ? "" : "\n⚠ Linha digitável não detectada no PDF — confira o valor manualmente.")
        );
      }
      await loadAll();
    } finally {
      setUploadingBoleto(false);
    }
  }

  async function handleOfxImport(file: File) {
    setImportingOfx(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/financeiro/contas/import-ofx", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao importar o extrato");
        return;
      }
      alert(
        `Extrato ${data.bank} importado: ${data.created} pagamento(s) novo(s), ${data.duplicates} já existiam.\n` +
          `(${data.skippedCredits} crédito(s) ignorado(s) — não são contas a pagar.)\n\n` +
          "Os títulos entraram como PAGOS. Complete vencimento/NF/tipo onde precisar."
      );
      await loadAll();
    } finally {
      setImportingOfx(false);
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
      const res = await fetch(editingId ? `/api/financeiro/contas/${editingId}` : "/api/financeiro/contas", {
        method: editingId ? "PATCH" : "POST",
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
      setFormOpen(false);
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

  const detailTransitions = detail && detail.status in PAYABLE_TRANSITIONS ? PAYABLE_TRANSITIONS[detail.status] : [];
  // Editar liberado em qualquer status menos cancelado — títulos vindos do OFX
  // trazem dados crus e precisam ser corrigíveis mesmo depois de pagos.
  const isEditableStatus = detail ? detail.status !== "CANCELADO" : false;

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
            Controle de vencimentos — importe o extrato ou o boleto, ou lance à mão
          </p>
        </div>
        {canEdit && (
          <div className="flex gap-2 flex-wrap">
            <label className={`inline-flex items-center ${importingOfx ? "opacity-50" : "cursor-pointer"}`}>
              <span className="bg-primary hover:bg-primary-dark text-white text-sm font-medium px-4 py-2.5 rounded-lg transition">
                {importingOfx ? "Importando..." : "Importar extrato (OFX)"}
              </span>
              <input
                type="file"
                accept=".ofx,application/x-ofx,application/octet-stream"
                className="hidden"
                disabled={importingOfx}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleOfxImport(f);
                  e.target.value = "";
                }}
              />
            </label>
            <label className={`inline-flex items-center ${uploadingBoleto ? "opacity-50" : "cursor-pointer"}`}>
              <span className="bg-gray-100 hover:bg-gray-200 text-text text-sm font-medium px-4 py-2.5 rounded-lg transition">
                {uploadingBoleto ? "Lendo boleto..." : "Importar boleto (PDF)"}
              </span>
              <input
                type="file"
                accept="application/pdf"
                className="hidden"
                disabled={uploadingBoleto}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleBoletoUpload(f);
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
          <option value="ABERTAS">Em aberto (recebido/aguardando/aprovado)</option>
          <option value="ALL">Todas</option>
          {(Object.keys(PAYABLE_STATUS_LABELS) as PayableStatus[]).map((s) => (
            <option key={s} value={s}>
              {PAYABLE_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
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
                    onClick={() => setDetail(inv)}
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

      {/* Modal criar/editar */}
      <Modal
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editingId ? "Editar título" : "Nova conta a pagar"}
        maxWidth="max-w-xl"
      >
        <div className="space-y-3">
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
              <input
                value={form.bank}
                onChange={(e) => setForm({ ...form, bank: e.target.value })}
                className={inputCls}
                placeholder="Itaú / Santander"
              />
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
          {!editingId && (
            <div>
              <label className="text-xs font-medium text-text-light">PDF do boleto (opcional)</label>
              <input
                type="file"
                accept="application/pdf"
                onChange={(e) => setFormFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-text-light file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-gray-100 file:text-text file:text-xs hover:file:bg-gray-200"
              />
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setFormOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? "Salvando..." : editingId ? "Salvar alterações" : "Criar título"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Modal de detalhe */}
      <Modal
        open={!!detail}
        onClose={() => {
          setDetail(null);
          setCancelOpen(false);
          setCancelReason("");
        }}
        title="Detalhe do título"
        maxWidth="max-w-3xl"
      >
        {detail && (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <p className="font-semibold text-text">{detail.description}</p>
                <p className="text-sm text-text-light">
                  {detail.suppliers?.name || detail.payee_name || "sem fornecedor"}
                  {detail.payee_document ? ` · ${detail.payee_document}` : ""}
                </p>
              </div>
              <StatusBadge status={detail.status} />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-xs text-text-light">Valor</p>
                <p className="font-bold text-text">{formatCurrency(Number(detail.amount))}</p>
              </div>
              <div>
                <p className="text-xs text-text-light">Vencimento</p>
                <p className="font-medium text-text">{fmtDateOnly(detail.due_date)}</p>
              </div>
              <div>
                <p className="text-xs text-text-light">Origem</p>
                <p className="font-medium text-text">{detail.origin === "EMAIL" ? "E-mail" : "Manual"}</p>
              </div>
              <div>
                <p className="text-xs text-text-light">Criado por</p>
                <p className="font-medium text-text">
                  {detail.created_by} · {fmtDateTime(detail.created_at)}
                </p>
              </div>
            </div>

            {detail.digitable_line && (
              <div className="text-xs text-text-light break-all">
                <span className="font-medium">Linha digitável:</span> {detail.digitable_line}
              </div>
            )}
            {detail.notes && <p className="text-sm text-text-light whitespace-pre-wrap">{detail.notes}</p>}

            {/* Trilha de auditoria */}
            <div className="bg-gray-50 border border-border rounded-lg p-3 text-xs text-text-light space-y-1">
              {detail.approved_by && (
                <p>
                  ✔ Aprovado por <span className="font-medium text-text">{detail.approved_by}</span> em{" "}
                  {fmtDateTime(detail.approved_at)}
                </p>
              )}
              {detail.paid_by && (
                <p>
                  💸 Pago por <span className="font-medium text-text">{detail.paid_by}</span> em{" "}
                  {fmtDateTime(detail.paid_at)}
                </p>
              )}
              {detail.cancelled_by && (
                <p>
                  ✖ Cancelado por <span className="font-medium text-text">{detail.cancelled_by}</span> em{" "}
                  {fmtDateTime(detail.cancelled_at)}
                  {detail.cancel_reason ? ` — "${detail.cancel_reason}"` : ""}
                </p>
              )}
              {!detail.approved_by && !detail.paid_by && !detail.cancelled_by && (
                <p>Sem aprovações/pagamentos registrados ainda.</p>
              )}
            </div>

            {/* Anexos */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold text-text">Anexos ({detail.attachments.length})</p>
                {canEdit && detail.status !== "CANCELADO" && (
                  <label className="text-xs text-primary cursor-pointer hover:underline">
                    {uploadingExtra ? "Enviando..." : "+ anexar PDF"}
                    <input
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      disabled={uploadingExtra}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleExtraUpload(detail, f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </div>
              {detail.attachments.length === 0 ? (
                <p className="text-xs text-text-light">Nenhum PDF anexado.</p>
              ) : (
                <div className="space-y-2">
                  <ul className="text-sm space-y-1">
                    {detail.attachments.map((a) => (
                      <li key={a.id} className="flex items-center gap-2">
                        <a
                          href={`/api/financeiro/anexos/${a.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline truncate"
                        >
                          📎 {a.filename}
                        </a>
                        <span className="text-xs text-text-light whitespace-nowrap">
                          por {a.created_by}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <iframe
                    src={`/api/financeiro/anexos/${detail.attachments[0].id}`}
                    className="w-full h-[420px] border border-border rounded-lg"
                    title="PDF do boleto"
                  />
                </div>
              )}
            </div>

            {/* Ações */}
            {canEdit && (
              <div className="flex gap-2 flex-wrap justify-end border-t border-border pt-4">
                {isEditableStatus && (
                  <Button variant="secondary" onClick={() => openEdit(detail)}>
                    Editar
                  </Button>
                )}
                {detailTransitions
                  .filter((t) => t !== "CANCELADO")
                  .map((t) => (
                    <Button
                      key={t}
                      variant={t === "PAGO" ? "success" : "primary"}
                      disabled={transitioning}
                      onClick={() =>
                        t === "AGUARDANDO_APROVACAO" ? doTransition(detail, t) : setConfirmTo(t)
                      }
                    >
                      {PAYABLE_ACTION_LABELS[t]}
                    </Button>
                  ))}
                {detailTransitions.includes("CANCELADO") && (
                  <Button variant="danger" disabled={transitioning} onClick={() => setCancelOpen((v) => !v)}>
                    Cancelar título
                  </Button>
                )}
              </div>
            )}

            {/* Cancelamento com motivo */}
            {cancelOpen && detail && (
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
                    onClick={() => doTransition(detail, "CANCELADO", cancelReason)}
                  >
                    Confirmar cancelamento
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Confirmação de aprovar/pagar */}
      <ConfirmDialog
        open={!!confirmTo && !!detail}
        onClose={() => setConfirmTo(null)}
        onConfirm={() => detail && confirmTo && doTransition(detail, confirmTo)}
        title={confirmTo ? PAYABLE_ACTION_LABELS[confirmTo] : ""}
        message={
          detail && confirmTo
            ? `${PAYABLE_ACTION_LABELS[confirmTo]}: "${detail.description}" — ${formatCurrency(Number(detail.amount))}?`
            : ""
        }
        confirmLabel={confirmTo ? PAYABLE_ACTION_LABELS[confirmTo] : "Confirmar"}
        variant="primary"
        loading={transitioning}
      />
    </div>
  );
}
