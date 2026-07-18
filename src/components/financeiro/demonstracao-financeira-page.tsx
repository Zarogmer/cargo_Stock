"use client";

// Demonstração Financeira — espelho da planilha oficial da diretoria
// ("Demonstração Financeira <ano> - CARGOSHIPS.xlsx", uma aba por mês, seções
// 6 a 12 em blocos lado a lado). A planilha continua sendo a fonte: esta tela é
// só leitura, e quem popula é scripts/import-demonstracao-financeira.ts.
//
// O mapa das seções (chave, rótulo, grupo) vem de @/lib/demonstracao-financeira,
// o mesmo que o importador usa — assim tela e import nunca divergem.

import { useCallback, useEffect, useMemo, useState } from "react";
import { db } from "@/lib/db";
import { formatCurrency, matchSearch } from "@/lib/utils";
import {
  STATEMENT_SECTIONS, STATEMENT_GROUPS, MONTH_LABELS,
} from "@/lib/demonstracao-financeira";

interface Entry {
  id: number;
  year: number;
  month: number;
  section: string;
  entry_date: string | null;
  description: string;
  value: string; // Prisma Decimal serializa como string
  source_row: number;
}

const ALL = "ALL";

// Tira a numeração do começo do rótulo, pra tela não mostrar "6.1", "10" nem
// "6)". O número segue existindo no dado (chave da seção); some só na exibição.
// Pega "6.1 ", "10 ", "6) ", "10-12) ".
function stripNum(label: string): string {
  return label.replace(/^\d+(?:[.-]\d+)?\)?\s+/, "");
}

export function DemonstracaoFinanceiraPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [year, setYear] = useState<number | null>(null);
  const [month, setMonth] = useState<string>(ALL);
  const [section, setSection] = useState<string>(ALL);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await db
        .from("financial_statement_entries")
        .select("id, year, month, section, entry_date, description, value, source_row")
        .order("month");
      if (error) throw new Error(error.message);
      setEntries((data as Entry[]) || []);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Anos que existem no banco (o import é por ano). O mais recente abre por padrão.
  const years = useMemo(() => {
    const set = new Set<number>();
    for (const e of entries) set.add(e.year);
    return [...set].sort((a, b) => b - a);
  }, [entries]);

  useEffect(() => {
    if (year === null && years.length > 0) setYear(years[0]);
  }, [years, year]);

  const filtered = useMemo(() => entries.filter((e) => {
    if (year !== null && e.year !== year) return false;
    if (month !== ALL && e.month !== Number(month)) return false;
    if (section !== ALL && e.section !== section) return false;
    if (search && !matchSearch(e.description, search)) return false;
    return true;
  }), [entries, year, month, section, search]);

  const total = useMemo(
    () => filtered.reduce((s, e) => s + Number(e.value), 0),
    [filtered],
  );

  // Agrupa por seção, na ordem da planilha, e joga fora as seções vazias sob os
  // filtros atuais (ex.: 8.1 Navio, que a diretoria ainda não usa).
  const bySection = useMemo(() => STATEMENT_SECTIONS.map((sec) => {
    const rows = filtered
      .filter((e) => e.section === sec.key)
      .sort((a, b) => {
        if (a.month !== b.month) return a.month - b.month;
        // Sem data vai pro fim do mês — é conta recorrente, não tem dia fixo.
        if (!a.entry_date && !b.entry_date) return a.source_row - b.source_row;
        if (!a.entry_date) return 1;
        if (!b.entry_date) return -1;
        return a.entry_date.localeCompare(b.entry_date);
      });
    return { sec, rows, total: rows.reduce((s, e) => s + Number(e.value), 0) };
  }).filter((g) => g.rows.length > 0), [filtered]);

  const filterActive = month !== ALL || section !== ALL || !!search;

  const selectCls = "text-sm border border-border rounded-lg px-3 py-2 bg-card text-text focus:outline-none focus:ring-2 focus:ring-primary/40";

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

  if (entries.length === 0) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
        Nenhum dado importado ainda. A planilha oficial é importada por{" "}
        <code className="text-xs">scripts/import-demonstracao-financeira.ts</code>.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={year ?? ""} onChange={(e) => setYear(Number(e.target.value))} className={selectCls}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>

        <select value={month} onChange={(e) => setMonth(e.target.value)} className={selectCls}>
          <option value={ALL}>Todos os meses</option>
          {MONTH_LABELS.map((label, i) => (
            <option key={label} value={i + 1}>{label}</option>
          ))}
        </select>

        {/* Seções agrupadas igual à planilha (6.x juntos, 9.x juntos...). */}
        <select value={section} onChange={(e) => setSection(e.target.value)} className={selectCls}>
          <option value={ALL}>Todas as seções</option>
          {STATEMENT_GROUPS.map((group) => (
            <optgroup key={group} label={stripNum(group)}>
              {STATEMENT_SECTIONS.filter((s) => s.group === group).map((s) => (
                <option key={s.key} value={s.key}>{s.shortLabel}</option>
              ))}
            </optgroup>
          ))}
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
      </div>

      {/* Total do que está filtrado */}
      <div className="bg-card border border-border rounded-xl px-5 py-3 flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-light">
          Total {filterActive ? "filtrado" : `de ${year}`}
        </span>
        <span className="text-xl font-semibold tabular-nums text-text">{formatCurrency(total)}</span>
      </div>

      {bySection.length === 0 ? (
        <p className="text-sm text-text-light py-8 text-center">Nenhum lançamento com esses filtros.</p>
      ) : (
        bySection.map(({ sec, rows, total: secTotal }) => (
          <SectionTable key={sec.key} label={stripNum(sec.label)} rows={rows} total={secTotal} showMonth={month === ALL} />
        ))
      )}
    </div>
  );
}

// Um bloco da planilha: cabeçalho com o nome da seção, linha de TOTAIS e os
// lançamentos. A coluna Mês só aparece quando o filtro está em "Todos os meses"
// — com um mês escolhido ela seria a mesma em toda linha.
function SectionTable({
  label, rows, total, showMonth,
}: {
  label: string;
  rows: Entry[];
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
            {rows.map((e) => (
              <tr key={e.id} className="hover:bg-gray-50/60 transition">
                {showMonth && <td className="px-5 py-2 text-text-light whitespace-nowrap">{MONTH_LABELS[e.month - 1]}</td>}
                <td className="px-5 py-2 text-text-light whitespace-nowrap tabular-nums">
                  {e.entry_date ? e.entry_date.slice(0, 10).split("-").reverse().join("/") : "—"}
                </td>
                <td className="px-5 py-2 text-text">{e.description}</td>
                {/* Valor negativo é estorno/crédito na planilha — sai em verde. */}
                <td className={`px-5 py-2 text-right tabular-nums whitespace-nowrap ${Number(e.value) < 0 ? "text-emerald-600" : "text-text"}`}>
                  {formatCurrency(Number(e.value))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
