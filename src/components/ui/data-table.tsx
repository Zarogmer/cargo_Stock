"use client";

import { SearchIcon } from "@/components/icons";

interface Column<T> {
  key: string;
  label: string;
  render?: (item: T) => React.ReactNode;
  className?: string;
  hideOnMobile?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  emptyMessage?: string;
  onRowClick?: (item: T) => void;
  actions?: React.ReactNode;
  keyExtractor: (item: T) => string | number;
  // Quando true, abaixo de `md` a tabela vira uma lista de cards empilhados
  // (título + pares rótulo:valor + ações), bem mais legível no celular.
  // Opt-in pra não alterar telas que dependem do layout de tabela.
  mobileCards?: boolean;
}

export function DataTable<T>({
  columns,
  data,
  loading = false,
  searchValue,
  onSearchChange,
  searchPlaceholder = "Buscar...",
  emptyMessage = "Nenhum registro encontrado",
  onRowClick,
  actions,
  keyExtractor,
  mobileCards = false,
}: DataTableProps<T>) {
  // Divide as colunas para o layout de cards: a 1ª vira título, a coluna de
  // ações (key "actions" ou rótulo vazio) vai pro rodapé, o resto são pares.
  const actionsCol = columns.find((c) => c.key === "actions" || c.label.trim() === "");
  const titleCol = columns.find((c) => c !== actionsCol) ?? columns[0];
  const bodyCols = columns.filter((c) => c !== actionsCol && c !== titleCol);
  const cell = (col: Column<T>, item: T) =>
    col.render ? col.render(item) : String((item as Record<string, unknown>)[col.key] ?? "");
  return (
    <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
      {/* Toolbar */}
      {(onSearchChange || actions) && (
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 p-4 border-b border-border">
          {onSearchChange && (
            <div className="relative flex-1">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-light" />
              <input
                type="text"
                value={searchValue}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder={searchPlaceholder}
                className="w-full pl-10 pr-4 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
              />
            </div>
          )}
          {actions && (
            <div className="flex items-center gap-2 flex-wrap">{actions}</div>
          )}
        </div>
      )}

      {/* Mobile cards (opt-in via `mobileCards`) */}
      {mobileCards && (
        <div className="md:hidden divide-y divide-border">
          {loading ? (
            <div className="px-4 py-12 text-center text-text-light text-sm">Carregando...</div>
          ) : data.length === 0 ? (
            <div className="px-4 py-12 text-center text-text-light text-sm">{emptyMessage}</div>
          ) : (
            data.map((item) => (
              <div
                key={keyExtractor(item)}
                onClick={() => onRowClick?.(item)}
                className={`p-4 ${onRowClick ? "cursor-pointer active:bg-gray-50" : ""}`}
              >
                <div className="font-medium text-text">{cell(titleCol, item)}</div>
                {bodyCols.length > 0 && (
                  <dl className="mt-2 space-y-1">
                    {bodyCols.map((col) => (
                      <div key={col.key} className="flex items-baseline justify-between gap-3 text-xs">
                        <dt className="text-text-light shrink-0">{col.label}</dt>
                        <dd className="text-right text-text min-w-0 break-words">{cell(col, item)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {actionsCol && (
                  <div className="mt-3 flex justify-end">{actionsCol.render?.(item)}</div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Table */}
      <div className={`overflow-x-auto ${mobileCards ? "hidden md:block" : ""}`}>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-border">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-4 py-3 text-left text-xs font-semibold text-text-light uppercase tracking-wider ${
                    col.hideOnMobile ? "hidden md:table-cell" : ""
                  } ${col.className || ""}`}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-12 text-center text-text-light"
                >
                  <svg
                    className="animate-spin h-6 w-6 mx-auto mb-2 text-primary"
                    viewBox="0 0 24 24"
                    fill="none"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Carregando...
                </td>
              </tr>
            ) : data.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-12 text-center text-text-light"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              data.map((item) => (
                <tr
                  key={keyExtractor(item)}
                  onClick={() => onRowClick?.(item)}
                  className={`hover:bg-gray-50 transition ${
                    onRowClick ? "cursor-pointer" : ""
                  }`}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-4 py-3 ${
                        col.hideOnMobile ? "hidden md:table-cell" : ""
                      } ${col.className || ""}`}
                    >
                      {col.render
                        ? col.render(item)
                        : String((item as Record<string, unknown>)[col.key] ?? "")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
