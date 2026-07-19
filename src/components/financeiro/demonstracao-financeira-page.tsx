"use client";

// Demonstração Financeira — visão por seções (6 a 12, como na planilha da
// diretoria) dos títulos do Contas a Pagar que têm seção definida
// (payable_invoices.statement_section). O Contas a Pagar mostra TUDO; aqui
// entra só o que foi classificado numa seção — e dá pra lançar conta nova
// daqui mesmo (vira um título normal, já com a seção).
//
// O histórico da planilha oficial foi migrado pra títulos PAGOS pelo script
// scripts/sync-demonstracao-contas.ts; o mapa das seções (chave, rótulo,
// grupo) segue vindo de @/lib/demonstracao-financeira.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { formatCurrency, parseDecimalBR, matchSearch } from "@/lib/utils";
import { MONTH_LABELS, stripSectionNum as stripNum } from "@/lib/demonstracao-financeira";
import { mergeSections, customKeyId, type CustomSectionRow, type MergedSection, type SectionOverrideRow } from "@/lib/statement-sections";

// Só os campos do título que esta tela usa (a API devolve o resto junto).
interface InvoiceRow {
  id: string;
  description: string;
  amount: string; // Prisma Decimal serializa como string
  due_date: string | null;
  payment_date: string | null;
  statement_section: string | null;
  created_at: string;
}

// Linha já resolvida pra exibição/agrupamento.
interface Row {
  id: string;
  section: string;
  /** Data exibida: pagamento > vencimento. */
  date: string | null;
  /** Mês de referência YYYY-MM (pagamento > vencimento > criação). */
  refMonth: string;
  description: string;
  value: number;
  paid: boolean;
}

const ALL = "ALL";

function todayISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function DemonstracaoFinanceiraPage() {
  const { profile } = useAuth();
  const role = profile?.role || "FINANCEIRO";
  const canEdit =
    hasPermission(role, "FINANCEIRO_MOD", "create") || hasPermission(role, "FINANCEIRO_MOD", "edit");

  const [rows, setRows] = useState<Row[]>([]);
  const [customSections, setCustomSections] = useState<CustomSectionRow[]>([]);
  const [overrides, setOverrides] = useState<SectionOverrideRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Seções fixas (planilha, com rótulos renomeados) + personalizadas (banco).
  const merged = useMemo(() => mergeSections(customSections, overrides), [customSections, overrides]);

  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<string>(ALL);
  const [section, setSection] = useState<string>(ALL);
  const [search, setSearch] = useState("");

  // Modal de "Nova conta" (cria um título no Contas a Pagar já com a seção).
  const [modalOpen, setModalOpen] = useState(false);
  const [formSection, setFormSection] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formAmount, setFormAmount] = useState("");
  const [formDate, setFormDate] = useState(todayISO());
  const [formPaid, setFormPaid] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [res, secRes] = await Promise.all([
        fetch("/api/financeiro/contas"),
        fetch("/api/financeiro/statement-sections"),
      ]);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const secData = await secRes.json().catch(() => ({}));
      setCustomSections((secData.sections as CustomSectionRow[]) || []);
      setOverrides((secData.overrides as SectionOverrideRow[]) || []);
      const invoices = (data.invoices as InvoiceRow[]) || [];
      setRows(
        invoices
          .filter((inv) => inv.statement_section)
          .map((inv) => {
            const date = inv.payment_date || inv.due_date;
            const ref = (date || inv.created_at).slice(0, 7);
            return {
              id: inv.id,
              section: inv.statement_section!,
              date: date ? date.slice(0, 10) : null,
              refMonth: ref,
              description: inv.description,
              value: Number(inv.amount),
              paid: !!inv.payment_date,
            };
          }),
      );
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Anos presentes. O mais recente abre por padrão.
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const r of rows) set.add(Number(r.refMonth.slice(0, 4)));
    return [...set].sort((a, b) => b - a);
  }, [rows]);

  useEffect(() => {
    if (year === null && years.length > 0) setYear(years[0]);
  }, [years, year]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (year !== null && Number(r.refMonth.slice(0, 4)) !== year) return false;
    if (month !== ALL && Number(r.refMonth.slice(5, 7)) !== Number(month)) return false;
    if (section !== ALL && r.section !== section) return false;
    if (search && !matchSearch(r.description, search)) return false;
    return true;
  }), [rows, year, month, section, search]);

  const total = useMemo(
    () => filtered.reduce((s, r) => s + r.value, 0),
    [filtered],
  );

  // Agrupa por seção (fixas + custom), na ordem mesclada, e joga fora as vazias
  // sob os filtros atuais.
  const bySection = useMemo(() => merged.sections.map((sec) => {
    const secRows = filtered
      .filter((r) => r.section === sec.key)
      .sort((a, b) => {
        if (a.refMonth !== b.refMonth) return a.refMonth.localeCompare(b.refMonth);
        if (!a.date && !b.date) return a.description.localeCompare(b.description, "pt-BR");
        if (!a.date) return 1;
        if (!b.date) return -1;
        return a.date.localeCompare(b.date);
      });
    return { sec, rows: secRows, total: secRows.reduce((s, r) => s + r.value, 0) };
  }).filter((g) => g.rows.length > 0), [filtered, merged]);

  const filterActive = month !== ALL || section !== ALL || !!search;

  // Optgroups (grupo → subseções) da lista mesclada, pros seletores de seção.
  const sectionOptgroups = merged.groups.map((group) => {
    const secs = merged.sections.filter((s) => s.group === group);
    if (secs.length === 0) return null;
    return (
      <optgroup key={group} label={stripNum(group)}>
        {secs.map((s) => (
          <option key={s.key} value={s.key}>{s.shortLabel}</option>
        ))}
      </optgroup>
    );
  });

  // Modal de gerenciar seções personalizadas.
  const [sectionsModalOpen, setSectionsModalOpen] = useState(false);

  function openCreate() {
    setFormSection(section !== ALL ? section : "");
    setFormDescription("");
    setFormAmount("");
    setFormDate(todayISO());
    setFormPaid(true);
    setModalOpen(true);
  }

  // Cria o título via API do Contas a Pagar (mesmo fluxo do "Nova conta" de lá)
  // e, se "já paga", marca o pagamento na sequência — igual ao botão de lá.
  async function handleSave() {
    const amount = parseDecimalBR(formAmount);
    if (!formSection) return alert("Escolha a seção da demonstração.");
    if (!formDescription.trim()) return alert("Informe a descrição.");
    if (amount <= 0) return alert("Informe um valor válido.");
    setSaving(true);
    try {
      const res = await fetch("/api/financeiro/contas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: formDescription.trim(),
          amount,
          due_date: formDate || null,
          statement_section: formSection,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Erro ao lançar a conta");
        return;
      }
      if (formPaid && data.invoice?.id) {
        const pay = await fetch(`/api/financeiro/contas/${data.invoice.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ payment_date: formDate || todayISO(), paid_amount: amount }),
        });
        if (!pay.ok) alert("Conta lançada, mas falhou ao marcar como paga — ajuste no Contas a Pagar.");
      }
      setModalOpen(false);
      await load();
    } finally {
      setSaving(false);
    }
  }

  const selectCls = "text-sm border border-border rounded-lg px-3 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40";
  const inputCls = "mt-1 w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40";

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <span className="text-sm text-text-light animate-pulse">Carregando demonstração...</span>
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

  return (
    <div className="space-y-4">
      {/* Filtros + Nova conta */}
      <div className="flex flex-wrap items-center gap-2">
        {years.length > 0 && (
          <select value={year ?? ""} onChange={(e) => setYear(Number(e.target.value))} className={selectCls}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        )}

        <select value={month} onChange={(e) => setMonth(e.target.value)} className={selectCls}>
          <option value={ALL}>Todos os meses</option>
          {MONTH_LABELS.map((label, i) => (
            <option key={label} value={i + 1}>{label}</option>
          ))}
        </select>

        {/* Seções agrupadas igual à planilha (6.x juntos, 9.x juntos...) +
            as personalizadas do usuário. */}
        <select value={section} onChange={(e) => setSection(e.target.value)} className={selectCls}>
          <option value={ALL}>Todas as seções</option>
          {sectionOptgroups}
        </select>

        <input
          type="text" value={search} onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Buscar na descrição..."
          className={`${selectCls} flex-1 min-w-[200px]`}
        />

        {filterActive && (
          <button
            onClick={() => { setMonth(ALL); setSection(ALL); setSearch(""); }}
            className="text-xs font-medium text-primary hover:text-primary-dark whitespace-nowrap"
          >
            Limpar filtros
          </button>
        )}

        {canEdit && (
          <Button variant="secondary" onClick={() => setSectionsModalOpen(true)}>⚙️ Seções</Button>
        )}
        {canEdit && <Button onClick={openCreate}>+ Nova conta</Button>}
      </div>

      <p className="text-[11px] text-text-light">
        As contas daqui são títulos do Contas a Pagar com seção definida — o Contas a Pagar mostra tudo; esta aba organiza por seção.
      </p>

      {/* Total do que está filtrado */}
      <div className="bg-card border border-border rounded-xl px-5 py-3 flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-light">
          Total {filterActive ? "filtrado" : year !== null ? `de ${year}` : ""}
        </span>
        <span className="text-xl font-semibold tabular-nums text-text">{formatCurrency(total)}</span>
      </div>

      {rows.length === 0 ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          Nenhuma conta com seção ainda. Lance por aqui em &quot;+ Nova conta&quot; ou defina a seção de um título no Contas a Pagar.
        </div>
      ) : bySection.length === 0 ? (
        <p className="text-sm text-text-light py-8 text-center">Nenhum lançamento com esses filtros.</p>
      ) : (
        bySection.map(({ sec, rows: secRows, total: secTotal }) => (
          <SectionTable key={sec.key} label={stripNum(sec.label)} rows={secRows} total={secTotal} showMonth={month === ALL} />
        ))
      )}

      {/* Nova conta — cria um título no Contas a Pagar já com a seção */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Nova conta na Demonstração" maxWidth="max-w-lg">
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-text-light">Seção *</label>
            <select value={formSection} onChange={(e) => setFormSection(e.target.value)} className={inputCls}>
              <option value="">— Selecionar seção</option>
              {sectionOptgroups}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-text-light">Descrição *</label>
            <input
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              className={inputCls}
              placeholder="Ex.: CPFL, Aluguel, Sabesp..."
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-text-light">Valor (R$) *</label>
              <input
                value={formAmount}
                onChange={(e) => setFormAmount(e.target.value)}
                className={inputCls}
                placeholder="0,00"
                inputMode="decimal"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-text-light">Data</label>
              <input type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} className={inputCls} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={formPaid} onChange={(e) => setFormPaid(e.target.checked)} />
            Já foi paga (marca o pagamento na data acima)
          </label>
          <p className="text-[11px] text-text-light">
            A conta vira um título no Contas a Pagar com esta seção — aparece lá e aqui.
          </p>
          <div className="flex gap-2 justify-end pt-1">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? "Salvando..." : "Lançar conta"}</Button>
          </div>
        </div>
      </Modal>

      {/* Gerenciar seções/subseções (renomear fixas e personalizadas) */}
      <SectionsManager
        open={sectionsModalOpen}
        onClose={() => setSectionsModalOpen(false)}
        allSections={merged.sections}
        groups={merged.groups}
        onChanged={load}
      />
    </div>
  );
}

// Modal de seções: cria subseções (num grupo oficial ou novo), renomeia
// QUALQUER seção — fixa da planilha (via override de rótulo) ou personalizada —
// e remove as personalizadas. Renomear uma fixa só troca o rótulo exibido; a
// chave gravada nos títulos não muda.
function SectionsManager({
  open, onClose, allSections, groups, onChanged,
}: {
  open: boolean;
  onClose: () => void;
  allSections: MergedSection[];
  groups: string[];
  onChanged: () => void | Promise<void>;
}) {
  const NEW_GROUP = "__new__";
  const [label, setLabel] = useState("");
  const [groupChoice, setGroupChoice] = useState(groups[0] || "");
  const [newGroup, setNewGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Edição inline chaveada pela chave da seção ("6.1", "c3"...).
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");

  const inputCls = "w-full border border-border rounded-lg px-3 py-2 text-sm bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40";

  async function handleAdd() {
    const group = groupChoice === NEW_GROUP ? newGroup.trim() : groupChoice;
    if (!label.trim()) { setErr("Informe o nome da subseção."); return; }
    if (!group) { setErr("Escolha ou crie um grupo."); return; }
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/financeiro/statement-sections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label.trim(), group_label: group }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(data.error || "Erro ao criar a seção."); return; }
      setLabel(""); setNewGroup("");
      if (groupChoice === NEW_GROUP) setGroupChoice(group);
      await onChanged();
    } finally { setBusy(false); }
  }

  // Renomeia a seção. Personalizada → PATCH pelo id; fixa → override de rótulo.
  async function handleRename(sec: MergedSection) {
    const name = editLabel.trim();
    if (!name) return;
    setBusy(true); setErr(null);
    try {
      const id = customKeyId(sec.key);
      const res = id !== null
        ? await fetch(`/api/financeiro/statement-sections/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label: name }),
          })
        : await fetch("/api/financeiro/statement-sections/overrides", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ section_key: sec.key, label: name }),
          });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setErr(d.error || "Erro ao renomear."); return; }
      setEditKey(null); setEditLabel("");
      await onChanged();
    } finally { setBusy(false); }
  }

  // Volta uma seção fixa renomeada ao rótulo original da planilha.
  async function handleReset(sec: MergedSection) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/financeiro/statement-sections/overrides?section_key=${encodeURIComponent(sec.key)}`, { method: "DELETE" });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setErr(d.error || "Erro ao restaurar."); return; }
      await onChanged();
    } finally { setBusy(false); }
  }

  async function handleDelete(sec: MergedSection) {
    const id = customKeyId(sec.key);
    if (id === null) return;
    if (!confirm(`Remover a subseção "${sec.shortLabel}"? Se houver títulos nela, ela só some das listas (o histórico fica).`)) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/financeiro/statement-sections/${id}`, { method: "DELETE" });
      if (!res.ok) { const d = await res.json().catch(() => ({})); setErr(d.error || "Erro ao remover."); return; }
      await onChanged();
    } finally { setBusy(false); }
  }

  // Todas as seções (fixas + custom) agrupadas, na ordem do seletor.
  const byGroup = groups
    .map((g) => ({ group: g, items: allSections.filter((s) => s.group === g) }))
    .filter((g) => g.items.length > 0);

  return (
    <Modal open={open} onClose={onClose} title="Seções da Demonstração" maxWidth="max-w-lg">
      <div className="space-y-4">
        <p className="text-[11px] text-text-light">
          Renomeie qualquer seção — as oficiais da planilha (só troca o rótulo exibido, o histórico
          fica) ou as suas. Também dá pra criar subseções extras num grupo que já existe ou num grupo
          novo. Tudo aparece no filtro e no seletor dos títulos.
        </p>

        {/* Adicionar */}
        <div className="border border-border rounded-xl p-3 space-y-2">
          <p className="text-sm font-semibold text-text">Nova subseção</p>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Nome da subseção (ex.: Marketing Digital)"
            className={inputCls}
          />
          <select value={groupChoice} onChange={(e) => setGroupChoice(e.target.value)} className={inputCls}>
            {groups.map((g) => <option key={g} value={g}>{stripNum(g)}</option>)}
            <option value={NEW_GROUP}>+ Novo grupo…</option>
          </select>
          {groupChoice === NEW_GROUP && (
            <input
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              placeholder="Nome do novo grupo (ex.: Marketing)"
              className={inputCls}
            />
          )}
          {err && <p className="text-xs text-danger">{err}</p>}
          <div className="flex justify-end">
            <Button onClick={handleAdd} disabled={busy}>{busy ? "Salvando..." : "Adicionar"}</Button>
          </div>
        </div>

        {/* Lista de todas as seções, por grupo */}
        <div className="space-y-3">
          {byGroup.map(({ group, items }) => (
            <div key={group}>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-text-light mb-1">{stripNum(group)}</p>
              <ul className="space-y-1">
                {items.map((s) => (
                  <li key={s.key} className="flex items-center gap-2 text-sm">
                    {editKey === s.key ? (
                      <>
                        <input
                          value={editLabel}
                          onChange={(e) => setEditLabel(e.target.value)}
                          className={`${inputCls} flex-1`}
                          autoFocus
                        />
                        <button onClick={() => handleRename(s)} disabled={busy} className="text-xs text-primary hover:underline">Salvar</button>
                        <button onClick={() => { setEditKey(null); setEditLabel(""); }} className="text-xs text-text-light hover:underline">Cancelar</button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 text-text">
                          {stripNum(s.label)}
                          {!s.custom && <span className="ml-1.5 text-[10px] text-text-light">fixa</span>}
                        </span>
                        <button onClick={() => { setEditKey(s.key); setEditLabel(s.shortLabel); }} className="text-xs text-primary hover:underline">Renomear</button>
                        {!s.custom && s.overridden && (
                          <button onClick={() => handleReset(s)} disabled={busy} className="text-xs text-text-light hover:underline">Restaurar</button>
                        )}
                        {s.custom && (
                          <button onClick={() => handleDelete(s)} disabled={busy} className="text-xs text-danger hover:underline">Remover</button>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="text-[10px] text-text-light">
          {allSections.length} seções no total ({allSections.filter((s) => s.custom).length} personalizadas
          {allSections.filter((s) => s.overridden).length > 0 && `, ${allSections.filter((s) => s.overridden).length} renomeadas`}).
        </p>

        <div className="flex justify-end border-t border-border pt-3">
          <Button variant="secondary" onClick={onClose}>Fechar</Button>
        </div>
      </div>
    </Modal>
  );
}

// Um bloco da planilha: cabeçalho com o nome da seção, total e os lançamentos.
// A coluna Mês só aparece quando o filtro está em "Todos os meses".
function SectionTable({
  label, rows, total, showMonth,
}: {
  label: string;
  rows: Row[];
  total: number;
  showMonth: boolean;
}) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3 bg-gray-50/80 border-b border-border flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-text">{label}</h3>
        <span className="text-sm font-semibold tabular-nums text-text whitespace-nowrap">
          {formatCurrency(total)}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-text-light border-b border-border">
              {showMonth && <th className="px-5 py-2 font-semibold w-28">Mês</th>}
              <th className="px-5 py-2 font-semibold w-28">Data</th>
              <th className="px-5 py-2 font-semibold">Descrição</th>
              <th className="px-5 py-2 font-semibold text-right w-36">Valor</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50/60 transition">
                {showMonth && (
                  <td className="px-5 py-2 text-text-light whitespace-nowrap">
                    {MONTH_LABELS[Number(r.refMonth.slice(5, 7)) - 1]}
                  </td>
                )}
                <td className="px-5 py-2 text-text-light whitespace-nowrap tabular-nums">
                  {r.date ? r.date.split("-").reverse().join("/") : "—"}
                </td>
                <td className="px-5 py-2 text-text">
                  {r.description}
                  {!r.paid && (
                    <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 align-middle">
                      em aberto
                    </span>
                  )}
                </td>
                {/* Valor negativo é estorno/crédito — sai em verde. */}
                <td className={`px-5 py-2 text-right tabular-nums whitespace-nowrap ${r.value < 0 ? "text-emerald-600" : "text-text"}`}>
                  {formatCurrency(r.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
