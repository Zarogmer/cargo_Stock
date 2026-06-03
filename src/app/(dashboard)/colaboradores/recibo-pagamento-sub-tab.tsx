"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
}

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const OTHER = "__outro__";

export function ReciboPagamentoSubTab({ employees }: { employees: Employee[] }) {
  const [employeeId, setEmployeeId] = useState<string>("");
  const [nome, setNome] = useState("");
  const [cpf, setCpf] = useState("");
  const [data, setData] = useState<string>(todayInput);
  const [valor, setValor] = useState("");
  const [navio, setNavio] = useState("");
  const [navioTyping, setNavioTyping] = useState(false);
  const [tipo, setTipo] = useState<"COSTADO" | "EMBARQUE">("COSTADO");

  const [ships, setShips] = useState<Ship[]>([]);
  const [generating, setGenerating] = useState<"docx" | "pdf" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Navios cadastrados pro dropdown (com opção de digitar um avulso).
  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await db.from("ships").select("id, name").order("name");
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

  const shipKnown = ships.some((s) => s.name === navio);
  const valorNum = parseDecimalBR(valor);
  const extensoPreview = valorNum > 0 ? valorPorExtenso(valorNum) : "";
  const periodoPreview = formatPeriodoAnterior(data);
  const dataPreview = formatDataExtenso(data);

  function handlePickEmployee(idStr: string) {
    setEmployeeId(idStr);
    if (!idStr) {
      setNome("");
      setCpf("");
      return;
    }
    const e = employees.find((x) => String(x.id) === idStr);
    if (!e) return;
    setNome(e.name.toUpperCase());
    setCpf(e.cpf || "");
  }

  async function handleGenerate(format: "docx" | "pdf") {
    setError(null);
    if (!nome.trim()) {
      setError("Selecione um funcionário ou informe o nome.");
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
    setGenerating(format);
    try {
      const res = await fetch(`/api/documents/recibo-pagamento?format=${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: nome.trim(),
          cpf: cpf.trim(),
          valor: valorNum,
          data,
          navio: navio.trim(),
          tipo,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const main = body.error || `Erro ${res.status}`;
        throw new Error(body.detail ? `${main}\n\nDetalhe tecnico: ${body.detail}` : main);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeName = nome.trim().replace(/[\\/:*?"<>|]+/g, "").trim() || "FUNCIONARIO";
      a.download = `Recibo de Pagamento ${safeName}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha ao gerar recibo.";
      setError(msg);
    } finally {
      setGenerating(null);
    }
  }

  const fieldCls =
    "mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30";

  return (
    <div className="space-y-5">
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div>
          <h3 className="font-semibold text-text">Gerar Recibo de Pagamento</h3>
          <p className="text-xs text-text-light mt-0.5">
            Escolha o colaborador, a data, o navio (Costado ou Embarque) e o valor. Nome, CPF,
            valor por extenso e o período do serviço são preenchidos automaticamente.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Colaborador</label>
            <select value={employeeId} onChange={(e) => handlePickEmployee(e.target.value)} className={fieldCls}>
              <option value="">— Selecionar colaborador —</option>
              {sortedEmployees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} {e.role ? `— ${e.role}` : ""}
                </option>
              ))}
            </select>
          </div>

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
              inputMode="decimal"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              placeholder="0,00"
              className={fieldCls}
            />
            {extensoPreview && (
              <p className="text-[11px] text-text-light mt-1">
                Por extenso: <strong>{extensoPreview}</strong>
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
                  if (e.target.value === OTHER) { setNavio(""); setNavioTyping(true); }
                  else setNavio(e.target.value);
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
            <select value={tipo} onChange={(e) => setTipo(e.target.value as "COSTADO" | "EMBARQUE")} className={fieldCls}>
              <option value="COSTADO">Costado</option>
              <option value="EMBARQUE">Embarque</option>
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 whitespace-pre-line">
          ⚠️ {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="primary" onClick={() => handleGenerate("docx")} disabled={!!generating || !nome.trim()}>
          {generating === "docx" ? "Gerando..." : "Gerar Word (.docx)"}
        </Button>
        <Button variant="danger" onClick={() => handleGenerate("pdf")} disabled={!!generating || !nome.trim()}>
          {generating === "pdf" ? "Gerando..." : "Gerar PDF (.pdf)"}
        </Button>
      </div>
    </div>
  );
}
