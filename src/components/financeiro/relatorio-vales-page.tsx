"use client";

// Relatório de Vales — adiantamento ao funcionário e o saldo a descontar.
// Espelha o "Relatório de Vales <ano>.xlsx" da diretoria: cada linha é um
// funcionário com TOTAL ADIANTADO e TOTAL A DESCONTAR (o saldo em aberto).
//
// O vale nasce aqui. O desconto acontece no navio (Financeiro › Pagamento de
// Navios), escolhendo qual vale abater — o saldo desta tela baixa sozinho, e
// nunca dá pra descontar mais do que a pessoa pegou. Ver @/lib/vales.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { db } from "@/lib/db";
import { formatCurrency, parseDecimalBR, matchSearch } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  type Advance, type AdvanceDiscount,
  balanceOf, discountedOf, employeeAdvanced, employeeBalance,
} from "@/lib/vales";

interface EmployeeLite {
  id: number;
  name: string;
  status: string | null;
  escala_unavailable?: boolean | null;
}

interface JobLite {
  id: string;
  name: string;
}

export function RelatorioValesPage({
  canEdit, profileName,
}: {
  canEdit: boolean;
  profileName: string;
}) {
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [discounts, setDiscounts] = useState<AdvanceDiscount[]>([]);
  const [jobs, setJobs] = useState<JobLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  // Por padrão mostra só quem deve — é pra isso que a tela existe. O RH que
  // quiser ver a lista inteira desmarca.
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [empRes, advRes, discRes, jobRes] = await Promise.all([
        db.from("employees").select("id, name, status, escala_unavailable").neq("status", "INATIVO").order("name"),
        db.from("employee_advances").select("*").order("advance_date", { ascending: false }),
        db.from("advance_discounts").select("*"),
        db.from("jobs").select("id, name"),
      ]);
      if (empRes.error) throw new Error(empRes.error.message);
      if (advRes.error) throw new Error(advRes.error.message);
      setEmployees((empRes.data as EmployeeLite[]) || []);
      setAdvances((advRes.data as Advance[]) || []);
      setDiscounts((discRes.data as AdvanceDiscount[]) || []);
      setJobs((jobRes.data as JobLite[]) || []);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const jobName = useCallback(
    (id: string) => jobs.find((j) => j.id === id)?.name || "(navio removido)",
    [jobs],
  );

  // Uma linha por funcionário que tem algum vale, igual à planilha.
  const rows = useMemo(() => {
    const withAdvances = employees.filter((e) => advances.some((a) => a.employee_id === e.id));
    return withAdvances
      .map((e) => ({
        employee: e,
        advanced: employeeAdvanced(e.id, advances),
        balance: employeeBalance(e.id, advances, discounts),
      }))
      .filter((r) => (onlyOpen ? r.balance > 0 : true))
      .filter((r) => (search ? matchSearch(r.employee.name, search) : true))
      .sort((a, b) => b.balance - a.balance || a.employee.name.localeCompare(b.employee.name));
  }, [employees, advances, discounts, onlyOpen, search]);

  const totalBalance = useMemo(() => rows.reduce((s, r) => s + r.balance, 0), [rows]);
  const totalAdvanced = useMemo(() => rows.reduce((s, r) => s + r.advanced, 0), [rows]);

  async function handleSave(data: { employee_id: number; advance_date: string; amount: number; origin: string; notes: string | null }) {
    setSaveError(null);
    const { error } = await db.from("employee_advances").insert({
      ...data,
      created_by: profileName,
    });
    if (error) {
      setSaveError(error.message);
      return;
    }
    setShowForm(false);
    load();
  }

  async function handleDelete(id: number) {
    // Vale já descontado não some: apagar deixaria o desconto do navio órfão e o
    // saldo do funcionário erraria. Tem que estornar o desconto no navio antes.
    const used = discountedOf(id, discounts);
    if (used > 0) {
      setSaveError(`Este vale já teve ${formatCurrency(used)} descontado num navio. Remova o desconto no navio antes de apagar o vale.`);
      setDeleteId(null);
      return;
    }
    const { error } = await db.from("employee_advances").delete().eq("id", id);
    if (error) setSaveError(error.message);
    setDeleteId(null);
    load();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <span className="text-sm text-text-light animate-pulse">Carregando vales...</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
        Erro ao carregar: {loadError}
      </div>
    );
  }

  const inputCls = "text-sm border border-border rounded-lg px-3 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40";

  return (
    <div className="space-y-4">
      {saveError && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 flex items-start justify-between gap-3">
          <span>{saveError}</span>
          <button onClick={() => setSaveError(null)} className="text-red-400 hover:text-red-600 shrink-0">✕</button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Buscar colaborador..."
          className={`${inputCls} flex-1 min-w-[200px]`}
        />
        <label className="flex items-center gap-2 text-sm cursor-pointer whitespace-nowrap">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} className="w-4 h-4 accent-primary" />
          Só quem tem saldo a descontar
        </label>
        {canEdit && <Button onClick={() => { setSaveError(null); setShowForm(true); }}>+ Novo Vale</Button>}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="bg-card border border-border rounded-xl px-5 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-light">Total adiantado</p>
          <p className="text-xl font-semibold tabular-nums text-text mt-1">{formatCurrency(totalAdvanced)}</p>
        </div>
        <div className="bg-card border border-amber-200 rounded-xl px-5 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">Total a descontar</p>
          <p className="text-xl font-semibold tabular-nums text-amber-700 mt-1">{formatCurrency(totalBalance)}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-text-light py-8 text-center">
          {advances.length === 0
            ? "Nenhum vale lançado ainda."
            : onlyOpen
              ? "Ninguém com saldo a descontar."
              : "Nenhum colaborador encontrado."}
        </p>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider text-text-light border-b border-border">
                  <th className="px-5 py-2 font-semibold">Colaborador</th>
                  <th className="px-5 py-2 font-semibold text-right w-40">Total adiantado</th>
                  <th className="px-5 py-2 font-semibold text-right w-40">Total a descontar</th>
                  <th className="px-5 py-2 w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map(({ employee, advanced, balance }) => (
                  <Fragment key={employee.id}>
                    <tr
                      onClick={() => setExpanded(expanded === employee.id ? null : employee.id)}
                      className="hover:bg-gray-50/60 transition cursor-pointer"
                    >
                      <td className="px-5 py-2.5 font-medium text-text">{employee.name}</td>
                      <td className="px-5 py-2.5 text-right tabular-nums text-text-light">{formatCurrency(advanced)}</td>
                      <td className={`px-5 py-2.5 text-right tabular-nums font-semibold ${balance > 0 ? "text-amber-700" : "text-emerald-600"}`}>
                        {formatCurrency(balance)}
                      </td>
                      <td className="px-5 py-2.5 text-text-light text-xs">{expanded === employee.id ? "▲" : "▼"}</td>
                    </tr>
                    {expanded === employee.id && (
                      <tr>
                        <td colSpan={4} className="px-5 py-3 bg-gray-50/60">
                          <AdvanceDetail
                            advances={advances.filter((a) => a.employee_id === employee.id)}
                            discounts={discounts}
                            jobName={jobName}
                            canEdit={canEdit}
                            onDelete={(id) => setDeleteId(id)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showForm && (
        <ValeFormModal
          open={showForm}
          onClose={() => setShowForm(false)}
          onSave={handleSave}
          employees={employees}
        />
      )}

      <ConfirmDialog
        open={deleteId !== null}
        title="Apagar vale?"
        message="O vale some do saldo do colaborador. Só dá pra apagar vale que ainda não foi descontado em navio."
        onConfirm={() => { if (deleteId !== null) handleDelete(deleteId); }}
        onClose={() => setDeleteId(null)}
      />
    </div>
  );
}

// Os vales de um colaborador, cada um com quanto já voltou e em qual navio —
// as colunas ADIANTAMENTO e DESCONTAR-NAVIO da planilha, lado a lado.
function AdvanceDetail({
  advances, discounts, jobName, canEdit, onDelete,
}: {
  advances: Advance[];
  discounts: AdvanceDiscount[];
  jobName: (id: string) => string;
  canEdit: boolean;
  onDelete: (id: number) => void;
}) {
  return (
    <div className="space-y-2">
      {advances.map((a) => {
        const used = discountedOf(a.id, discounts);
        const balance = balanceOf(a, discounts);
        const rows = discounts.filter((d) => d.advance_id === a.id);
        return (
          <div key={a.id} className="bg-card border border-border rounded-lg px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">
                  {formatCurrency(Number(a.amount))}{" "}
                  <span className="font-normal text-text-light">· {a.origin}</span>
                </p>
                <p className="text-[11px] text-text-light mt-0.5">
                  {a.advance_date.slice(0, 10).split("-").reverse().join("/")} · lançado por {a.created_by}
                  {a.notes ? ` · ${a.notes}` : ""}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className={`text-sm font-semibold tabular-nums ${balance > 0 ? "text-amber-700" : "text-emerald-600"}`}>
                  {balance > 0 ? `${formatCurrency(balance)} em aberto` : "Quitado"}
                </p>
                {canEdit && used === 0 && (
                  <button onClick={() => onDelete(a.id)} className="text-[11px] text-red-500 hover:text-red-700 mt-0.5">
                    apagar
                  </button>
                )}
              </div>
            </div>
            {rows.length > 0 && (
              <ul className="mt-2 pt-2 border-t border-border space-y-1">
                {rows.map((d) => (
                  <li key={d.id} className="text-[11px] text-text-light flex items-center justify-between gap-2">
                    <span className="truncate">🚢 {jobName(d.job_id)}</span>
                    <span className="tabular-nums whitespace-nowrap">− {formatCurrency(Number(d.amount))}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ValeFormModal({
  open, onClose, onSave, employees,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (data: { employee_id: number; advance_date: string; amount: number; origin: string; notes: string | null }) => void;
  employees: EmployeeLite[];
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [origin, setOrigin] = useState("");
  const [notes, setNotes] = useState("");

  const value = parseDecimalBR(amount);
  const valid = !!employeeId && !!date && value > 0 && !!origin.trim();

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title="Novo Vale (adiantamento)" maxWidth="max-w-lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          onSave({
            employee_id: Number(employeeId),
            advance_date: date,
            amount: value,
            origin: origin.trim(),
            notes: notes.trim() || null,
          });
        }}
        className="space-y-4"
      >
        <div>
          <label className="block text-sm font-medium mb-1">Colaborador</label>
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} className={inputCls}>
            <option value="">Selecione...</option>
            {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium mb-1">Data</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Valor (R$)</label>
            <input
              type="text" value={amount} onChange={(e) => setAmount(e.target.value)}
              placeholder="Ex: 1000,00" className={inputCls}
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Origem</label>
          <input
            type="text" value={origin} onChange={(e) => setOrigin(e.target.value)}
            placeholder="Ex: Pegou com a Rose, Folha 04/07/2026, Pix Francisco" className={inputCls}
          />
          <p className="text-[11px] text-text-light mt-1">De onde saiu o dinheiro — é o cabeçalho da coluna na planilha de Vales.</p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Observação (opcional)</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${inputCls} resize-none`} />
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-800">
          O desconto é feito depois, na aba <strong>Pagamento de Navios</strong>: abra o navio e escolha este vale na coluna Adiant. do colaborador.
        </div>

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={!valid}>Salvar Vale</Button>
        </div>
      </form>
    </Modal>
  );
}
