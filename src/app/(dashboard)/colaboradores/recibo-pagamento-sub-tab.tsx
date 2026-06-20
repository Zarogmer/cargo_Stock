"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { printPdfBlob } from "@/lib/print";
import { PdfPreview } from "./pdf-preview";
import { db } from "@/lib/db";
import { parseDecimalBR } from "@/lib/utils";
import {
  valorPorExtenso,
  formatDataExtenso,
  formatPeriodoAnterior,
  formatCpf,
} from "@/lib/recibo";
import type { Employee } from "@/types/database";

interface Ship {
  id: string;
  name: string;
  holds_count: number | null;
}

interface Recipient {
  nome: string;
  cpf: string;
}

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const OTHER = "__outro__";

// Extrai o nome do arquivo do header Content-Disposition (filename*=UTF-8''...),
// com fallback montado no cliente.
function filenameFromResponse(res: Response, count: number, format: "docx" | "pdf", fallbackNome: string): string {
  const cd = res.headers.get("Content-Disposition") || "";
  const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (m) {
    try { return decodeURIComponent(m[1]); } catch { /* usa fallback */ }
  }
  if (count > 1) return `Recibos de Pagamento (${count}).zip`;
  const safe = fallbackNome.replace(/[\\/:*?"<>|]+/g, "").trim() || "FUNCIONARIO";
  return `Recibo de Pagamento ${safe}.${format}`;
}

export function ReciboPagamentoSubTab({ employees }: { employees: Employee[] }) {
  // Seleção de colaboradores (checkbox). 0 = avulso (nome/CPF manuais), 1 = recibo
  // único (nome/CPF preenchidos e editáveis), >1 = lote num .zip (um recibo cada).
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [empSearch, setEmpSearch] = useState("");
  const [nome, setNome] = useState("");
  const [cpf, setCpf] = useState("");
  const [data, setData] = useState<string>(todayInput);
  const [valor, setValor] = useState("");
  const [navio, setNavio] = useState("");
  const [navioTyping, setNavioTyping] = useState(false);
  const [tipo, setTipo] = useState<"COSTADO" | "POROES">("COSTADO");
  const [poroes, setPoroes] = useState(1);

  const [ships, setShips] = useState<Ship[]>([]);
  const [generating, setGenerating] = useState<"docx" | "pdf" | "print" | "preview" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);

  // Navios cadastrados pro dropdown (com opção de digitar um avulso).
  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await db.from("ships").select("id, name, holds_count").order("name");
      if (!active) return;
      if (!error && data) setShips(data as Ship[]);
    })();
    return () => {
      active = false;
    };
  }, []);

  const sortedEmployees = useMemo(() => {
    return [...employees]
      .filter((e) => e.status !== "INATIVO")
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [employees]);

  const filteredEmployees = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    if (!q) return sortedEmployees;
    const qDigits = q.replace(/\D/g, "");
    return sortedEmployees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        (qDigits ? (e.cpf || "").replace(/\D/g, "").includes(qDigits) : false)
    );
  }, [sortedEmployees, empSearch]);

  const selectedCount = selectedIds.size;
  const isLote = selectedCount > 1;
  const isAvulso = selectedCount === 0;

  // Quando exatamente 1 colaborador está marcado, espelha nome/CPF nos campos
  // (editáveis, p/ ajuste pontual). Com vários, esses campos somem e usamos o cadastro.
  useEffect(() => {
    if (selectedIds.size === 1) {
      const id = [...selectedIds][0];
      const e = employees.find((x) => x.id === id);
      if (e) {
        setNome((e.name || "").toUpperCase());
        setCpf(e.cpf || "");
      }
    }
  }, [selectedIds, employees]);

  const navioShip = ships.find((s) => s.name === navio) || null;
  const shipKnown = !!navioShip;
  const valorNum = parseDecimalBR(valor);
  const extensoPreview = valorNum > 0 ? valorPorExtenso(valorNum) : "";
  const periodoPreview = formatPeriodoAnterior(data);
  const dataPreview = formatDataExtenso(data);
  // Texto que vai no documento no campo {TIPO}: "Costado" ou "N porões".
  const tipoDoc = tipo === "POROES" ? `${poroes} ${poroes === 1 ? "porão" : "porões"}` : "Costado";

  // Máscara de centavos (igual à anterior): "1000" -> "10,00".
  function handleValorChange(raw: string) {
    const digits = raw.replace(/\D/g, "");
    if (!digits) {
      setValor("");
      return;
    }
    const cents = parseInt(digits, 10);
    setValor(
      (cents / 100).toLocaleString("pt-BR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  function toggleEmployee(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  // Lista final de destinatários: vários (do cadastro) ou um (campos nome/CPF).
  function buildRecipients(): Recipient[] {
    if (selectedIds.size > 1) {
      const byId = new Map(employees.map((e) => [e.id, e] as const));
      return [...selectedIds]
        .map((id) => byId.get(id))
        .filter((e): e is Employee => !!e)
        .map((e) => ({ nome: (e.name || "").toUpperCase(), cpf: e.cpf || "" }));
    }
    return [{ nome: nome.trim(), cpf: cpf.trim() }];
  }

  async function handleGenerate(action: "docx" | "pdf" | "print" | "preview") {
    setError(null);
    const recipients = buildRecipients();
    if (recipients.length === 0 || recipients.some((r) => !r.nome)) {
      setError("Selecione colaboradores ou informe o nome no documento.");
      return;
    }
    if (!(valorNum > 0)) {
      setError("Informe um valor válido (maior que zero).");
      return;
    }
    if (!navio.trim()) {
      setError("Selecione ou informe o navio.");
      return;
    }
    const format = action === "docx" ? "docx" : "pdf";
    setGenerating(action);
    try {
      const res = await fetch(`/api/documents/recibo-pagamento?format=${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipients,
          valor: valorNum,
          data,
          navio: navio.trim(),
          tipo: tipoDoc,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        const main = b.error || `Erro ${res.status}`;
        throw new Error(b.detail ? `${main}\n\nDetalhe tecnico: ${b.detail}` : main);
      }
      const blob = await res.blob();
      if (action === "preview") {
        setPreviewBlob(blob);
      } else if (action === "print") {
        printPdfBlob(blob);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filenameFromResponse(res, recipients.length, format, recipients[0]?.nome || "");
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha ao gerar recibo.";
      setError(msg);
    } finally {
      setGenerating(null);
    }
  }

  const fieldCls =
    "mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30";

  const canGenerate = !generating && (isAvulso ? !!nome.trim() : true);

  return (
    <div className="space-y-5">
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div>
          <h3 className="font-semibold text-text">Gerar Recibo de Pagamento</h3>
          <p className="text-xs text-text-light mt-0.5">
            Marque um ou vários colaboradores (vários geram um <strong>.zip</strong> com um recibo
            cada — mesmo valor, muda colaborador/CPF). A data, o navio, o valor e o tipo são iguais
            para todos.
          </p>
        </div>

        {/* Seleção de colaboradores (checkbox + busca) */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">
              Colaboradores
            </label>
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={clearSelection}
                className="text-[11px] font-medium text-primary hover:underline"
              >
                Limpar seleção ({selectedCount})
              </button>
            )}
          </div>
          <input
            type="text"
            value={empSearch}
            onChange={(e) => setEmpSearch(e.target.value)}
            placeholder="Buscar por nome ou CPF…"
            className={fieldCls}
          />
          <div className="mt-1 max-h-48 overflow-y-auto border border-border rounded-lg divide-y divide-border">
            {filteredEmployees.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-light">Nenhum colaborador encontrado.</p>
            ) : (
              filteredEmployees.map((e) => (
                <label
                  key={e.id}
                  className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(e.id)}
                    onChange={() => toggleEmployee(e.id)}
                    className="rounded border-border"
                  />
                  <span className="text-sm text-text">{e.name}</span>
                  {e.role && <span className="text-xs text-text-light">— {e.role}</span>}
                </label>
              ))
            )}
          </div>
          <p className="text-[11px] text-text-light mt-1">
            {isAvulso
              ? "Nenhum selecionado — preencha o nome/CPF abaixo (avulso)."
              : isLote
                ? `${selectedCount} colaboradores selecionados — gera um .zip com um recibo para cada.`
                : "1 colaborador — nome/CPF preenchidos abaixo (pode ajustar)."}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Nome/CPF só no recibo único ou avulso (no lote, vêm do cadastro) */}
          {selectedCount <= 1 && (
            <>
              <div>
                <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Nome no documento</label>
                <input
                  type="text"
                  value={nome}
                  onChange={(e) => setNome(e.target.value.toUpperCase())}
                  placeholder="ADINAELSON FERREIRA DE SOUZA"
                  className={fieldCls}
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-text-light uppercase tracking-wider">CPF</label>
                <input
                  type="text"
                  value={cpf}
                  onChange={(e) => setCpf(e.target.value)}
                  onBlur={() => setCpf((v) => formatCpf(v))}
                  placeholder="000.000.000-00"
                  className={`${fieldCls} font-mono`}
                />
              </div>
            </>
          )}

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Data</label>
            <input type="date" value={data} onChange={(e) => setData(e.target.value)} className={fieldCls} />
            {periodoPreview && (
              <p className="text-[11px] text-text-light mt-1">
                Período do serviço: <strong>{periodoPreview}</strong> · Assinatura: {dataPreview}
              </p>
            )}
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Valor (R$)</label>
            <input
              type="text"
              inputMode="numeric"
              value={valor}
              onChange={(e) => handleValorChange(e.target.value)}
              placeholder="0,00"
              className={fieldCls}
            />
            {extensoPreview && (
              <p className="text-[11px] text-text-light mt-1">
                Por extenso: <strong>{extensoPreview}</strong>
                {isLote ? " · aplicado a todos" : ""}
              </p>
            )}
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Navio</label>
            {navioTyping ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={navio}
                  onChange={(e) => setNavio(e.target.value)}
                  autoFocus
                  placeholder="Nome do navio"
                  className={`${fieldCls} flex-1`}
                />
                <button
                  type="button"
                  onClick={() => { setNavioTyping(false); setNavio(""); }}
                  className="mt-1 px-3 text-sm font-medium text-text-light hover:text-text border border-border rounded-lg whitespace-nowrap"
                >
                  Lista
                </button>
              </div>
            ) : (
              <select
                value={navio}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === OTHER) { setNavio(""); setNavioTyping(true); return; }
                  setNavio(v);
                  // Puxa a quantidade de porões do navio (qtd cadastrada no navio).
                  const ship = ships.find((s) => s.name === v);
                  if (ship && ship.holds_count && ship.holds_count > 0) setPoroes(ship.holds_count);
                }}
                className={fieldCls}
              >
                <option value="">— Selecionar navio —</option>
                {navio && !shipKnown && <option value={navio}>{navio}</option>}
                {ships.map((s) => (
                  <option key={s.id} value={s.name}>{s.name}</option>
                ))}
                <option value={OTHER}>➕ Outro (digitar)…</option>
              </select>
            )}
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Tipo</label>
            <select value={tipo} onChange={(e) => setTipo(e.target.value as "COSTADO" | "POROES")} className={fieldCls}>
              <option value="COSTADO">Costado</option>
              <option value="POROES">Porões (informar quantidade)</option>
            </select>
            {tipo === "POROES" && (
              <div className="mt-2">
                <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Quantidade de porões</label>
                <select value={poroes} onChange={(e) => setPoroes(Number(e.target.value))} className={fieldCls}>
                  {Array.from(new Set([1, 2, 3, 4, 5, 6, 7, poroes]))
                    .filter((n) => n >= 1)
                    .sort((a, b) => a - b)
                    .map((n) => (
                      <option key={n} value={n}>{n} {n === 1 ? "porão" : "porões"}</option>
                    ))}
                </select>
                {navioShip?.holds_count ? (
                  <p className="text-[11px] text-text-light mt-1">Puxado do navio ({navioShip.holds_count} {navioShip.holds_count === 1 ? "porão" : "porões"}). Ajuste se necessário.</p>
                ) : navioShip ? (
                  <p className="text-[11px] text-amber-700 mt-1">Este navio não tem porões cadastrados — informe a quantidade ou cadastre em Navios.</p>
                ) : null}
                <p className="text-[11px] text-text-light mt-1">
                  No recibo sai: <strong>{tipoDoc}</strong>
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 whitespace-pre-line">
          ⚠️ {error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => handleGenerate("preview")}
          disabled={!canGenerate || isLote}
          className="mr-auto"
          title={isLote ? "Visualização disponível para 1 recibo (lotes geram .zip)" : undefined}
        >
          {generating === "preview" ? "Gerando..." : "👁️ Pré-visualizar"}
        </Button>
        <Button variant="primary" onClick={() => handleGenerate("docx")} disabled={!canGenerate}>
          {generating === "docx" ? "Gerando..." : isLote ? "Gerar lote Word (.zip)" : "Gerar Word (.docx)"}
        </Button>
        <Button variant="danger" onClick={() => handleGenerate("pdf")} disabled={!canGenerate}>
          {generating === "pdf" ? "Gerando..." : isLote ? "Gerar lote PDF (.zip)" : "Gerar PDF (.pdf)"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => handleGenerate("print")}
          disabled={!canGenerate || isLote}
          title={isLote ? "Impressão disponível para 1 recibo (lotes geram .zip)" : undefined}
        >
          {generating === "print" ? "Imprimindo..." : "🖨️ Imprimir"}
        </Button>
      </div>

      <PdfPreview blob={previewBlob} loading={generating === "preview"} onClose={() => setPreviewBlob(null)} />
    </div>
  );
}
