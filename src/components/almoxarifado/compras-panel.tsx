"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";

// Aba "Compras": lista de reposição dos 3 inventários (Estoque, EPI, Uniforme).
// Lê de /api/almoxarifado/compras (fonte única: getPurchaseList). Itens abaixo
// do mínimo, com quanto comprar pra repor.
interface PurchaseItem {
  kind: "ESTOQUE" | "EPI" | "UNIFORME";
  id: number;
  name: string;
  detail: string | null;
  current: number;
  min: number;
  buy: number;
  unit: string;
}

const GROUP_META: Record<PurchaseItem["kind"], { label: string; icon: string }> = {
  ESTOQUE: { label: "Estoque", icon: "🧰" },
  EPI: { label: "EPI", icon: "⛑️" },
  UNIFORME: { label: "Uniforme", icon: "👕" },
};

const fmt = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

export function ComprasPanel() {
  const pathname = usePathname();
  const [items, setItems] = useState<PurchaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/almoxarifado/compras");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setItems((body.items || []) as PurchaseItem[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, pathname]);

  const groups = (["ESTOQUE", "EPI", "UNIFORME"] as const)
    .map((k) => ({ kind: k, items: items.filter((i) => i.kind === k) }))
    .filter((g) => g.items.length > 0);

  function copyList() {
    const lines: string[] = ["🛒 Lista de compras", ""];
    for (const g of groups) {
      lines.push(`${GROUP_META[g.kind].label}`);
      for (const i of g.items) {
        const det = i.detail ? ` (${i.detail})` : "";
        lines.push(`• ${i.name}${det} — comprar ${fmt.format(i.buy)} ${i.unit}`);
      }
      lines.push("");
    }
    navigator.clipboard.writeText(lines.join("\n").trim()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  if (loading) return <p className="text-sm text-text-light">Carregando lista de compras...</p>;

  if (error) {
    return (
      <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700">
        ⚠️ Erro ao carregar: {error}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="bg-card border border-border rounded-2xl p-10 text-center">
        <p className="text-4xl mb-2">✅</p>
        <p className="text-sm font-medium text-text">Tudo dentro do mínimo</p>
        <p className="text-xs text-text-light mt-1">
          Nenhum item de Estoque, EPI ou Uniforme está abaixo da quantidade mínima.
          Defina a &quot;Qtd Mínima&quot; nos itens pra acompanhar reposição aqui.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-text-light">
          <strong className="text-text">{items.length}</strong> {items.length === 1 ? "item" : "itens"} pra comprar
          (abaixo do mínimo)
        </p>
        <Button size="sm" variant="secondary" onClick={copyList}>
          {copied ? "Copiado ✓" : "Copiar lista"}
        </Button>
      </div>

      {groups.map((g) => (
        <div key={g.kind} className="bg-card border border-border rounded-2xl overflow-hidden">
          <div className="px-4 py-2.5 bg-gray-50 border-b border-border flex items-center justify-between">
            <span className="text-sm font-semibold text-text">{GROUP_META[g.kind].icon} {GROUP_META[g.kind].label}</span>
            <span className="text-xs text-text-light">{g.items.length} {g.items.length === 1 ? "item" : "itens"}</span>
          </div>
          <ul className="divide-y divide-border">
            {g.items.map((i) => (
              <li key={`${i.kind}-${i.id}`} className="flex items-center gap-3 px-4 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text truncate">
                    {i.name}
                    {i.detail && <span className="text-text-light font-normal"> ({i.detail})</span>}
                  </p>
                  <p className="text-xs text-text-light">
                    Tem {fmt.format(i.current)} · mínimo {fmt.format(i.min)} {i.unit}
                  </p>
                </div>
                <span className="shrink-0 inline-flex items-center px-2.5 py-1 rounded-lg text-sm font-semibold bg-red-50 text-red-700 border border-red-200">
                  comprar {fmt.format(i.buy)} {i.unit}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
