"use client";

import { useMemo } from "react";
import { CARGA_DIARIA_MIN, COSTADO_DIARIA_MIN, JornadaFilter, WorkedMap, computeFolha, fmtHHMM, periodoLabel } from "@/lib/folha-ponto";

// Prévia em tela da Folha de Ponto. Usa exatamente a mesma lógica (computeFolha)
// do arquivo gerado, então o que aparece aqui é o que sai no Excel/PDF.

const CARGA_LABELS = ["SEGUNDA", "TERÇA", "QUARTA", "QUINTA", "SEXTA", "SÁBADO", "DOMINGO", "FERIADOS"];

function ddmm(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

export function FolhaPontoPreview({
  name,
  empId,
  worked,
  startIso,
  endIso,
  jornada,
  shipName,
}: {
  name: string;
  empId: number;
  worked: WorkedMap;
  startIso: string;
  endIso: string;
  jornada: JornadaFilter;
  shipName?: string | null;
}) {
  const folha = useMemo(() => computeFolha(empId, worked, startIso, endIso, jornada), [empId, worked, startIso, endIso, jornada]);
  // Tabela lateral CARGA HORÁRIA: por dia da semana, ou legenda dos dois tipos em AMBAS.
  const cargaRows: [string, string][] = jornada === "AMBAS"
    ? [["EMBARQUE", fmtHHMM(CARGA_DIARIA_MIN)], ["COSTADO", fmtHHMM(COSTADO_DIARIA_MIN)]]
    : CARGA_LABELS.map((l) => [l, fmtHHMM(jornada === "COSTADO" ? COSTADO_DIARIA_MIN : CARGA_DIARIA_MIN)]);

  const cell = "border border-gray-300 px-1.5 py-0.5 text-center whitespace-nowrap";
  const dash = <span className="text-gray-300">–</span>;
  const dur = (min: number | undefined, color: string) =>
    min ? <span className={color}>{fmtHHMM(min)}</span> : dash;

  return (
    <div className="border border-border rounded-xl bg-white p-4 overflow-x-auto">
      <div className="min-w-[820px]">
        {/* Cabeçalho */}
        <div className="flex justify-between items-start gap-4 mb-2">
          <div className="flex-1">
            <div className="text-center text-lg font-bold text-[#1F3864] tracking-wide">CARGO SHIPS CLEANING</div>
            <div className="text-center text-[11px] font-semibold text-gray-500 uppercase">
              Folha de Ponto · {periodoLabel(startIso, endIso)}
              {shipName ? ` · Navio ${shipName}` : ""}
            </div>
            <div className="text-xs mt-2">
              <span className="font-semibold text-gray-600">Funcionário:</span>{" "}
              <span className="font-bold text-[#1F3864]">{name.toUpperCase()}</span>
            </div>
          </div>
          {/* Carga horária */}
          <table className="text-[10px] border-collapse shrink-0">
            <thead>
              <tr>
                <th colSpan={2} className="border border-gray-300 bg-gray-200 px-2 py-0.5 font-bold">
                  CARGA HORÁRIA
                </th>
              </tr>
            </thead>
            <tbody>
              {cargaRows.map(([l, v]) => (
                <tr key={l}>
                  <td className="border border-gray-300 px-2 py-0.5 font-semibold">{l}</td>
                  <td className="border border-gray-300 px-2 py-0.5 text-center bg-[#FFF2CC] font-semibold">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Grade */}
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="bg-gray-200 text-[#1F3864]">
              <th colSpan={6} className="border border-gray-300 px-1 py-0.5" />
              <th colSpan={5} className="border border-gray-300 px-1 py-0.5 font-bold">H.E. / Atrasos / A.N</th>
              <th colSpan={2} className="border border-gray-300 px-1 py-0.5 font-bold">Distrib. H.E. p/ Faixa</th>
            </tr>
            <tr className="bg-gray-100 text-[#1F3864]">
              {["Data", "Dia Semana", "Entrada", "Saída", "Entrada", "Saída", "H. Diária", "Atrasos", "Abona", "Horas Extras", "A.N.", "1ª Faixa", "2ª Faixa"].map((h, i) => (
                <th key={i} className="border border-gray-300 px-1.5 py-1 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {folha.rows.map((r) => {
              const hl = r.highlight ? "bg-[#9DC3E6] font-semibold" : "";
              const yellow = "bg-[#FFF8E1]";
              return (
                <tr key={r.iso}>
                  <td className={`${cell} ${hl}`}>{ddmm(r.iso)}</td>
                  <td className={`${cell} ${hl}`}>{r.dayName}</td>
                  <td className={`${cell} ${yellow}`}>{r.worked && r.times ? fmtHHMM(r.times.entrada1) : ""}</td>
                  <td className={`${cell} ${yellow}`}>{r.worked && r.times ? fmtHHMM(r.times.saida1) : ""}</td>
                  <td className={`${cell} ${yellow}`}>{r.worked && r.times?.entrada2 != null ? fmtHHMM(r.times.entrada2) : ""}</td>
                  <td className={`${cell} ${yellow}`}>{r.worked && r.times?.saida2 != null ? fmtHHMM(r.times.saida2) : ""}</td>
                  <td className={cell}>{r.worked && r.totals ? <span className="text-[#1F7A4D] font-semibold">{fmtHHMM(r.totals.hDiaria)}</span> : dash}</td>
                  <td className={cell}>{r.worked && r.totals ? dur(r.totals.atraso, "text-[#C00000]") : dash}</td>
                  <td className={cell}>{dash}</td>
                  <td className={cell}>{r.worked && r.totals ? dur(r.totals.he, "text-[#0070C0]") : dash}</td>
                  <td className={cell}>{dash}</td>
                  <td className={cell}>{r.worked && r.totals ? dur(r.totals.faixa1, "text-[#0070C0]") : dash}</td>
                  <td className={cell}>{r.worked && r.totals ? dur(r.totals.faixa2, "text-[#0070C0]") : dash}</td>
                </tr>
              );
            })}
            {/* TOTAIS */}
            <tr className="bg-gray-200 font-bold">
              <td colSpan={3} className="border border-gray-300 px-1.5 py-1 text-center">TOTAIS</td>
              <td colSpan={2} className="border border-gray-300 px-1.5 py-1 text-center text-[11px]">Faltas / Suspensão</td>
              <td className="border border-gray-300 px-1.5 py-1 text-center">{dash}</td>
              <td className="border border-gray-300 px-1.5 py-1 text-center text-[#1F7A4D]">{folha.totals.hDiaria ? fmtHHMM(folha.totals.hDiaria) : dash}</td>
              <td className="border border-gray-300 px-1.5 py-1 text-center text-[#C00000]">{folha.totals.atraso ? fmtHHMM(folha.totals.atraso) : dash}</td>
              <td className="border border-gray-300 px-1.5 py-1 text-center">{dash}</td>
              <td className="border border-gray-300 px-1.5 py-1 text-center text-[#0070C0]">{folha.totals.he ? fmtHHMM(folha.totals.he) : dash}</td>
              <td className="border border-gray-300 px-1.5 py-1 text-center">{dash}</td>
              <td className="border border-gray-300 px-1.5 py-1 text-center text-[#0070C0]">{folha.totals.faixa1 ? fmtHHMM(folha.totals.faixa1) : dash}</td>
              <td className="border border-gray-300 px-1.5 py-1 text-center text-[#0070C0]">{folha.totals.faixa2 ? fmtHHMM(folha.totals.faixa2) : dash}</td>
            </tr>
          </tbody>
        </table>
        <p className="text-[10px] text-gray-400 mt-2">
          Prévia idêntica ao arquivo gerado. Dias em azul = domingo/feriado. Mostrando{" "}
          <strong>
            {jornada === "AMBAS"
              ? "Embarque (7h20) e Costado (6h, só o 1º turno)"
              : jornada === "COSTADO"
                ? "apenas os dias de Costado (6h, só o 1º turno)"
                : "apenas os dias de Embarque (7h20, 09:00–17:20)"}
          </strong>
          {shipName ? <> — só o navio <strong>{shipName}</strong></> : null}.
        </p>
      </div>
    </div>
  );
}
