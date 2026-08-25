"use client";

import { useCallback, useEffect, useState } from "react";

// Cotação do dólar (AwesomeAPI). Nasceu no Dashboard e virou componente próprio
// porque o Pagamento de Navios também mostra a cotação — os navios são cobrados
// em dólar, então o câmbio precisa estar à mão nas duas telas.
//
// 4 casas decimais: a cotação move na 3ª/4ª casa e arredondar pra 2 escondia a
// variação que interessa pra fechar o valor do navio (pedido do Guilherme).
export interface DollarQuote {
  bid: string;
  ask: string;
  high: string;
  low: string;
  pctChange: string;
  timestamp: string;
}

const USD_DECIMALS = 4;
const REFRESH_MS = 5 * 60 * 1000;

export function useDollarQuote(): DollarQuote | null {
  const [dollar, setDollar] = useState<DollarQuote | null>(null);

  const fetchDollar = useCallback(async () => {
    try {
      const res = await fetch("https://economia.awesomeapi.com.br/json/last/USD-BRL");
      const data = await res.json();
      const usd = data.USDBRL;
      setDollar({
        bid: parseFloat(usd.bid).toFixed(USD_DECIMALS),
        ask: parseFloat(usd.ask).toFixed(USD_DECIMALS),
        high: parseFloat(usd.high).toFixed(USD_DECIMALS),
        low: parseFloat(usd.low).toFixed(USD_DECIMALS),
        pctChange: usd.pctChange,
        timestamp: usd.create_date,
      });
    } catch {
      console.error("Failed to fetch dollar quote");
    }
  }, []);

  useEffect(() => {
    fetchDollar();
    const interval = setInterval(fetchDollar, REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchDollar]);

  return dollar;
}

// size "lg" = destaque (Dashboard e cabeçalho do Pagamento de Navios);
// "sm" = discreto, pra caber em barra de filtro.
export function DollarTicker({ dollar, size = "lg" }: { dollar: DollarQuote | null; size?: "lg" | "sm" }) {
  if (!dollar) {
    return (
      <div className="flex items-center gap-2 text-xs text-text-light">
        <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-pulse" />
        <span>Carregando cotação...</span>
      </div>
    );
  }
  const pct = parseFloat(dollar.pctChange);
  const positive = pct >= 0;
  const valueCls = size === "lg" ? "text-2xl font-bold" : "text-base font-semibold";
  const labelCls = size === "lg" ? "text-xs" : "text-[11px]";
  return (
    <div className="inline-flex items-baseline gap-3 self-start sm:self-end">
      <div className="flex items-baseline gap-1.5">
        <span className={`${labelCls} font-semibold uppercase tracking-wider text-text-light`}>USD</span>
        <span className={`${valueCls} text-text tabular-nums`} title={`Compra R$ ${dollar.bid} · Venda R$ ${dollar.ask}`}>
          R$ {dollar.bid}
        </span>
      </div>
      <span
        className={`inline-flex items-center gap-1 ${labelCls} font-medium tabular-nums ${
          positive ? "text-emerald-600" : "text-red-600"
        }`}
      >
        <span>{positive ? "▲" : "▼"}</span>
        {Math.abs(pct).toFixed(2)}%
      </span>
      <span className={`hidden md:inline ${labelCls} text-text-light tabular-nums`}>
        L {dollar.low} · H {dollar.high}
      </span>
    </div>
  );
}
