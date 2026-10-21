"use client";

import type { DuplicateCheckInput, DuplicateMatch } from "@/lib/services/purchase-duplicates";
import { formatCurrency } from "@/lib/utils";

// Aviso "Esta compra já foi colocada no sistema" — usado no Nova Compra e na
// revisão do Escanear. Lista os lançamentos parecidos (quem lançou, quando,
// valor, NF) e só libera o salvar depois que a pessoa marca que conferiu e
// NÃO é a mesma compra. Falha na consulta nunca trava o cadastro (devolve []).

export async function checkPurchaseDuplicates(input: DuplicateCheckInput, signal?: AbortSignal): Promise<DuplicateMatch[]> {
  try {
    const r = await fetch("/api/compras/duplicatas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    if (!r.ok) return [];
    const b = await r.json().catch(() => ({}));
    return Array.isArray(b?.duplicates) ? (b.duplicates as DuplicateMatch[]) : [];
  } catch {
    return [];
  }
}

// Ids dos lançamentos, pra saber se a lista mudou (novo aviso = nova conferência).
export function duplicateIds(list: DuplicateMatch[]): string {
  return list.map((d) => d.id).sort().join("|");
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function DuplicateWarning({
  duplicates,
  acknowledged,
  onAcknowledge,
}: {
  duplicates: DuplicateMatch[];
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
}) {
  if (duplicates.length === 0) return null;
  const exact = duplicates.some((d) => d.level === "exata");
  const tone = exact
    ? "bg-red-50 border-red-300 text-red-900"
    : "bg-amber-50 border-amber-300 text-amber-900";
  return (
    <div role="alert" className={`border-2 rounded-xl px-3 py-2.5 space-y-2 ${tone}`}>
      <p className="text-sm font-bold leading-snug">
        {exact ? "🚫 Esta compra já foi colocada no sistema" : "⚠️ Parece que esta compra já foi colocada no sistema"}
      </p>
      <ul className="space-y-1.5">
        {duplicates.map((d) => (
          <li key={d.id} className="text-xs leading-snug">
            <span className="font-semibold">{d.description}</span>
            {d.supplier && <> · {d.supplier}</>}
            {d.purchase_date && <> · {fmtDate(d.purchase_date)}</>}
            <> · <span className="font-semibold">{formatCurrency(d.total_value)}</span></>
            {d.nf_number && <> · NF {d.nf_number}</>}
            <span className="block opacity-80">
              Lançada por {d.created_by} em {fmtDateTime(d.created_at)} — {d.reason}.
            </span>
          </li>
        ))}
      </ul>
      <label className="flex items-start gap-2 text-xs cursor-pointer select-none pt-1 border-t border-current/20">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => onAcknowledge(e.target.checked)}
          className="mt-0.5 w-4 h-4 shrink-0 accent-current"
        />
        <span>
          Conferi e <strong>não é a mesma compra</strong> — quero salvar mesmo assim.
        </span>
      </label>
    </div>
  );
}
