"use client";

// Detalhamento do colaborador — o modal que abre ao clicar numa linha do
// Controle de Funcionários (e agora também nos cards do Painel Financeiro).
// Mostra: resumo, composição do pagamento (Ganho/Folha/Desc. Geral/Adiant./
// Líquido), breakdown Embarque × Costado com os navios feitos e o histórico
// completo de alocações do período. Extraído de financeiro/page.tsx pra ser
// fonte única; os números vêm de computeEmployeeStats (@/lib/employee-stats).

import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import type { EmployeeStats } from "@/lib/employee-stats";
import type { Employee } from "@/types/database";

function brl(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const v = typeof n === "number" ? n : parseFloat(String(n));
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function EmployeeDetailDrawer({
  employee, stat, periodLabel, onClose,
}: {
  employee: Employee | null;
  stat: EmployeeStats | null;
  periodLabel: string;
  onClose: () => void;
}) {
  if (!employee || !stat) return null;

  const totalShips = stat.embarque.ships.size + stat.costado.ships.size;

  return (
    <Modal open={!!employee} onClose={onClose} title={`Detalhamento · ${employee.name}`} maxWidth="max-w-3xl">
      <div className="space-y-4">
        {/* Cabeçalho */}
        <div className="bg-gray-50 border border-border rounded-xl p-4">
          <div className="flex items-start gap-3">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
              <span className="text-lg font-bold text-primary">{employee.name.charAt(0).toUpperCase()}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-base font-bold text-text">{employee.name}</p>
              <p className="text-xs text-text-light">
                {employee.role || <span className="italic">sem função</span>}
                {employee.team && ` · ${employee.team}`}
                {employee.sector && ` · ${employee.sector}`}
              </p>
              <p className="text-[10px] text-text-light mt-1">
                Status: <strong>{employee.status || "—"}</strong>
                {employee.phone && <> · Tel: <span className="font-mono">{employee.phone}</span></>}
                {employee.admission_date && <> · Admissão: {new Date(employee.admission_date).toLocaleDateString("pt-BR")}</>}
              </p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-[10px] uppercase tracking-wider text-text-light font-semibold">Ganho em {periodLabel}</p>
              <p className="text-xl font-bold text-emerald-700">{brl(stat.totalEarnings)}</p>
              <p className="text-[10px] text-text-light">{totalShips} navio{totalShips === 1 ? "" : "s"}</p>
            </div>
          </div>
        </div>

        {/* Composição do pagamento — mesma leitura da Folha de Pagamento */}
        <div className="bg-emerald-50/60 border border-emerald-200 rounded-xl p-3">
          <p className="text-xs font-bold text-emerald-900 mb-2">💰 Composição do pagamento em {periodLabel}</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5 text-xs">
            <p>Ganho (MV1): <strong className="text-emerald-800">{brl(stat.totalEarnings)}</strong></p>
            <p title="PAGTO NA FOLHA — valor lançado no pagamento pela contabilidade">
              Valor da folha: <strong className="text-purple-700">{brl(stat.folha)}</strong>
            </p>
            <p title="Material perdido rateado pela equipe do navio">
              Desc. Geral: <strong className="text-red-700">{stat.descGeral > 0 ? `- ${brl(stat.descGeral)}` : "—"}</strong>
            </p>
            <p title="Vales descontados nos navios deste período">
              Adiantamentos: <strong className="text-amber-700">{stat.adiant > 0 ? `- ${brl(stat.adiant)}` : "—"}</strong>
            </p>
            <p>Líquido: <strong className="text-emerald-800">{brl(stat.liquido)}</strong></p>
          </div>
          {stat.valeBalance > 0 && (
            <p className="text-[10px] text-amber-800 mt-2 pt-2 border-t border-emerald-200">
              ⚠️ Saldo devedor de vales: <strong>{brl(stat.valeBalance)}</strong> (total em aberto, independe do período)
            </p>
          )}
        </div>

        {/* Breakdown Embarque vs Costado */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-blue-50/60 border border-blue-200 rounded-xl p-3">
            <p className="text-xs font-bold text-blue-900 mb-2">🚢 Embarque</p>
            <div className="space-y-1 text-xs">
              <p>Navios: <strong>{stat.embarque.ships.size}</strong></p>
              <p>Porões: <strong>{stat.embarque.poroes}</strong></p>
              <p>Alocações: <strong>{stat.embarque.allocations}</strong></p>
              <p className="text-emerald-700 pt-1 border-t border-blue-200 mt-1">
                Ganho: <strong>{brl(stat.embarque.earnings)}</strong>
              </p>
              <p className="text-purple-700">Folha: <strong>{brl(stat.embarque.folha)}</strong></p>
            </div>
            {stat.embarque.ships.size > 0 && (
              <div className="mt-2 pt-2 border-t border-blue-200">
                <p className="text-[10px] uppercase tracking-wider text-blue-800 font-semibold mb-1">Navios feitos</p>
                <div className="flex flex-wrap gap-1">
                  {Array.from(stat.embarque.ships).sort().map((n) => (
                    <span key={n} className="text-[10px] px-1.5 py-0.5 bg-white border border-blue-200 rounded text-blue-900">
                      {n}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="bg-indigo-50/60 border border-indigo-200 rounded-xl p-3">
            <p className="text-xs font-bold text-indigo-900 mb-2">⚓ Costado</p>
            <div className="space-y-1 text-xs">
              <p>Navios: <strong>{stat.costado.ships.size}</strong></p>
              <p>Turnos: <strong>{stat.costado.turnos}</strong> ({stat.costado.turnos * 6}h)</p>
              <p>
                ☀️ Diurnos: <strong>{stat.costado.diurnos}</strong>{" · "}
                🌙 Noturnos: <strong>{stat.costado.noturnos}</strong>
              </p>
              <p>Alocações: <strong>{stat.costado.allocations}</strong></p>
              <p className="text-emerald-700 pt-1 border-t border-indigo-200 mt-1">
                Ganho: <strong>{brl(stat.costado.earnings)}</strong>
              </p>
              <p className="text-purple-700">Folha: <strong>{brl(stat.costado.folha)}</strong></p>
            </div>
            {stat.costado.ships.size > 0 && (
              <div className="mt-2 pt-2 border-t border-indigo-200">
                <p className="text-[10px] uppercase tracking-wider text-indigo-800 font-semibold mb-1">Navios feitos</p>
                <div className="flex flex-wrap gap-1">
                  {Array.from(stat.costado.ships).sort().map((n) => (
                    <span key={n} className="text-[10px] px-1.5 py-0.5 bg-white border border-indigo-200 rounded text-indigo-900">
                      {n}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Histórico completo */}
        <div>
          <h3 className="text-xs font-bold text-text-light uppercase tracking-wider mb-2">📋 Histórico no período</h3>
          {stat.history.length === 0 ? (
            <p className="text-xs text-text-light italic text-center py-6 bg-gray-50 rounded-lg border border-border">
              Sem registros nesse período.
            </p>
          ) : (
            <div className="border border-border rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 border-b border-border">
                  <tr>
                    <th className="px-2 py-1.5 text-left text-[10px] font-semibold text-text-light uppercase">Data</th>
                    <th className="px-2 py-1.5 text-left text-[10px] font-semibold text-text-light uppercase">Navio</th>
                    <th className="px-2 py-1.5 text-left text-[10px] font-semibold text-text-light uppercase">Função</th>
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold text-text-light uppercase">Tipo</th>
                    <th className="px-2 py-1.5 text-center text-[10px] font-semibold text-text-light uppercase">Detalhe</th>
                    <th className="px-2 py-1.5 text-right text-[10px] font-semibold text-text-light uppercase">Ganho</th>
                  </tr>
                </thead>
                <tbody>
                  {stat.history.map((h, idx) => (
                    <tr key={`${h.jobId}-${idx}`} className="border-b border-border last:border-0">
                      <td className="px-2 py-1.5 text-text-light whitespace-nowrap">
                        {h.date ? new Date(h.date).toLocaleDateString("pt-BR") : "—"}
                      </td>
                      <td className="px-2 py-1.5 font-medium text-text">{h.shipName || h.jobName}</td>
                      <td className="px-2 py-1.5 text-text-light">{h.functionName || "—"}</td>
                      <td className="px-2 py-1.5 text-center">
                        <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full ${
                          h.kind === "EMBARQUE" ? "bg-blue-100 text-blue-800" : "bg-indigo-100 text-indigo-800"
                        }`}>
                          {h.kind === "EMBARQUE" ? "🚢" : "⚓"} {h.kind}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-center text-text-light whitespace-nowrap">
                        {h.kind === "EMBARQUE" ? (
                          h.poroes ? <>{h.poroes} {h.poroes === 1 ? "porão" : "porões"}</> : "—"
                        ) : (
                          <>
                            {h.period && (
                              <span className={`text-[9px] font-semibold ${
                                ["19-01", "01-07"].includes(h.period) ? "text-indigo-700" : "text-amber-700"
                              }`}>
                                {["19-01", "01-07"].includes(h.period) ? "🌙" : "☀️"} {h.period}
                              </span>
                            )}
                            {h.quantity > 1 && <> · {h.quantity}×</>}
                          </>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right font-semibold text-emerald-700 whitespace-nowrap">
                        {brl(h.earnings)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 border-t-2 border-border">
                  <tr>
                    <td colSpan={5} className="px-2 py-2 text-right text-[10px] font-bold text-text-light uppercase">Total</td>
                    <td className="px-2 py-2 text-right text-sm font-bold text-emerald-800">{brl(stat.totalEarnings)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        <div className="flex justify-between items-center pt-2 gap-2">
          <a href={`/colaboradores`} className="text-xs text-primary hover:underline">
            Abrir ficha em RH › Colaboradores →
          </a>
          <Button variant="secondary" onClick={onClose}>Fechar</Button>
        </div>
      </div>
    </Modal>
  );
}
