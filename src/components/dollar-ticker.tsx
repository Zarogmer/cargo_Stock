"use client";

import { useCallback, useEffect, useState } from "react";

// Cotação do dólar — PTAX do Banco Central (API aberta Olinda). Antes vinha da
// AwesomeAPI (dólar comercial em tempo real), mas o cliente confere a cotação
// na página do BC — então o sistema mostra o MESMO número: o fechamento PTAX
// do último dia útil (sai ~13h10; antes disso vale o do dia anterior).
//
// Nasceu no Dashboard e virou componente próprio porque o Pagamento de Navios
// também mostra a cotação — os navios são cobrados em dólar, então o câmbio
// precisa estar à mão nas duas telas.
//
// 4 casas decimais: é assim que o BC publica a PTAX.
export interface DollarQuote {
  compra: string;
  venda: string;
  date: string; // dd/mm do dia útil da PTAX exibida
  pctChange: string; // variação da venda sobre a PTAX do dia útil anterior
}

const USD_DECIMALS = 4;
const REFRESH_MS = 5 * 60 * 1000;

// PTAX só existe em dia útil — pede os últimos 10 dias e usa as 2 mais
// recentes (atual + anterior, pra variação). Datas no formato MM-DD-YYYY.
function ptaxUrl(): string {
  const fmt = (d: Date) =>
    `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${d.getFullYear()}`;
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 10);
  return (
    "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/" +
    "CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)" +
    `?@dataInicial='${fmt(start)}'&@dataFinalCotacao='${fmt(end)}'` +
    "&$format=json&$select=cotacaoCompra,cotacaoVenda,dataHoraCotacao"
  );
}

interface PtaxRow {
  cotacaoCompra: number;
  cotacaoVenda: number;
  dataHoraCotacao: string; // "2026-09-02 13:02:37.601302"
}

export function useDollarQuote(): DollarQuote | null {
  const [dollar, setDollar] = useState<DollarQuote | null>(null);

  const fetchDollar = useCallback(async () => {
    try {
      const res = await fetch(ptaxUrl(), { cache: "no-store" });
      const data = await res.json();
      const rows: PtaxRow[] = (data.value ?? [])
        .slice()
        .sort((a: PtaxRow, b: PtaxRow) => a.dataHoraCotacao.localeCompare(b.dataHoraCotacao));
      const last = rows[rows.length - 1];
      if (!last) return;
      const prev = rows[rows.length - 2];
      const pct = prev
        ? ((last.cotacaoVenda - prev.cotacaoVenda) / prev.cotacaoVenda) * 100
        : 0;
      const day = last.dataHoraCotacao.slice(0, 10); // yyyy-mm-dd
      setDollar({
        compra: last.cotacaoCompra.toFixed(USD_DECIMALS),
        venda: last.cotacaoVenda.toFixed(USD_DECIMALS),
        date: `${day.slice(8, 10)}/${day.slice(5, 7)}`,
        pctChange: pct.toFixed(2),
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
        <span className={`${labelCls} font-semibold uppercase tracking-wider text-text-light`}>USD PTAX</span>
        {/* Venda em destaque: é a taxa usada pra converter a cobrança em dólar. */}
        <span
          className={`${valueCls} text-text tabular-nums`}
          title={`PTAX do Banco Central (${dollar.date}) — Compra R$ ${dollar.compra} · Venda R$ ${dollar.venda}`}
        >
          R$ {dollar.venda}
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
        {dollar.date} · Compra {dollar.compra}
      </span>
    </div>
  );
}
