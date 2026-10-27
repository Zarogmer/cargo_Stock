"use client";

import { formatCurrency, parseDecimalBR } from "@/lib/utils";
import { STOCK_UNITS, unitShort } from "@/lib/stock-units";

// "Cada caixa tem __ dúzias": conteúdo da embalagem e a conta por unidade de
// dentro — é o que evita ler "1 CX de ovos a R$ 250" como um ovo a R$ 250. Sem
// conteúdo, o Almoxarifado recebe a quantidade em embalagens. Usado no
// Escanear (por item) e no Nova Compra; só aparece com unidade de embalagem
// (isPackUnit).
export function PackContentFields({ unit, packQty, packUnit, quantity, unitValue, inputCls, onChange, className = "" }: {
  unit: string;
  packQty: string;
  packUnit: string;
  quantity: string;
  unitValue: string;
  inputCls: string;
  onChange: (patch: { packQty?: string; packUnit?: string }) => void;
  className?: string;
}) {
  const pack = unitShort(unit);
  const inner = unitShort(packUnit) || "un";
  const n = parseDecimalBR(packQty);
  const qty = parseDecimalBR(quantity) || 1;
  const price = parseDecimalBR(unitValue);
  const fmtN = (v: number) => (Math.round(v * 1000) / 1000).toLocaleString("pt-BR");
  return (
    <div className={`rounded-lg px-3 py-2 space-y-1.5 ${n > 0 ? "bg-sky-50 border border-sky-200" : "bg-amber-50 border border-amber-200"} ${className}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>Cada {pack} tem</span>
        <input
          type="text"
          inputMode="decimal"
          value={packQty}
          onChange={(e) => onChange({ packQty: e.target.value })}
          placeholder="?"
          className={`${inputCls} !w-20 !py-1.5`}
          aria-label={`Quantidade dentro de cada ${pack}`}
        />
        <select value={packUnit} onChange={(e) => onChange({ packUnit: e.target.value })} className={`${inputCls} !w-auto !py-1.5`} aria-label="Unidade de dentro da embalagem">
          {STOCK_UNITS.filter((u) => u.value !== unit).map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
        </select>
      </div>
      {n > 0 ? (
        <p className="text-xs text-sky-800">
          = {fmtN(qty * n)} {inner} no total · {formatCurrency(price / n)} por {inner}
        </p>
      ) : (
        <p className="text-xs text-amber-800">
          ⚠️ O valor é de {pack} inteiro(a), não de uma unidade. Diga quanto vem dentro pra não confundir o preço — sem isso o estoque recebe {fmtN(qty)} {pack}.
        </p>
      )}
    </div>
  );
}
