"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { printPdfBlob } from "@/lib/print";
import type { Employee } from "@/types/database";

const EXAM_TYPES = [
  "ADMISSIONAL",
  "DEMISSIONAL",
  "PERIÓDICO",
  "RETORNO AO TRABALHO",
  "MUDANÇA DE FUNÇÃO",
] as const;

type ExamType = (typeof EXAM_TYPES)[number];

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromInputDate(s: string): string {
  if (!s) return "";
  const [y, m, d] = s.split("-");
  if (!y || !m || !d) return "";
  return `${d}/${m}/${y}`;
}

function formatCpf(s: string): string {
  const digits = s.replace(/\D/g, "").slice(0, 11);
  if (digits.length !== 11) return s;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

export function AvisoMedicoSubTab({ employees }: { employees: Employee[] }) {
  const [employeeId, setEmployeeId] = useState<string>("");
  const [nome, setNome] = useState("");
  const [cpf, setCpf] = useState("");
  const [matricula, setMatricula] = useState("");
  // Aviso Médico always carries "Auxiliar Operacional" — the clinic's standard
  // form for the operational team, regardless of the colaborador's internal
  // role. Field stays editable for one-off overrides.
  const [funcao, setFuncao] = useState("Auxiliar Operacional");
  const [data, setData] = useState<string>(todayInput);
  const [tipoExame, setTipoExame] = useState<ExamType>("ADMISSIONAL");

  const [generating, setGenerating] = useState<"docx" | "pdf" | "print" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sortedEmployees = useMemo(() => {
    return [...employees]
      .filter((e) => e.status !== "INATIVO")
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [employees]);

  function handlePickEmployee(idStr: string) {
    setEmployeeId(idStr);
    if (!idStr) {
      setNome("");
      setCpf("");
      setMatricula("");
      return;
    }
    const e = employees.find((x) => String(x.id) === idStr);
    if (!e) return;
    setNome(e.name.toUpperCase());
    setCpf(e.cpf || "");
    setMatricula(e.e_social || "");
    // Função stays as "Auxiliar Operacional" — don't overwrite from e.role.
  }

  async function handleGenerate(action: "docx" | "pdf" | "print") {
    setError(null);
    if (!nome.trim()) {
      setError("Selecione um funcionário ou informe o nome.");
      return;
    }
    const format = action === "docx" ? "docx" : "pdf";
    setGenerating(action);
    try {
      const res = await fetch(`/api/documents/aviso-medico?format=${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: nome.trim(),
          cpf: cpf.trim(),
          matricula: matricula.trim(),
          funcao: funcao.trim(),
          data: fromInputDate(data),
          tipoExame,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const main = body.error || `Erro ${res.status}`;
        throw new Error(body.detail ? `${main}\n\nDetalhe tecnico: ${body.detail}` : main);
      }
      const blob = await res.blob();
      if (action === "print") {
        printPdfBlob(blob);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const safeName = nome.trim().replace(/[\\/:*?"<>|]+/g, "").trim() || "FUNCIONARIO";
        a.download = `Aviso Medico ${safeName}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha ao gerar aviso.";
      setError(msg);
    } finally {
      setGenerating(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div>
          <h3 className="font-semibold text-text">Gerar Aviso Médico — Encaminhamento p/ Exame Ocupacional</h3>
          <p className="text-xs text-text-light mt-0.5">
            Selecione o colaborador; o sistema preenche nome, CPF, e-Social e função.
            Defina o tipo de exame e a data de comparecimento.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="md:col-span-2">
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Colaborador</label>
            <select
              value={employeeId}
              onChange={(e) => handlePickEmployee(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
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
              placeholder="RICHARD XAVIER DOS SANTOS"
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
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
              className="mt-1 w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Nº Matrícula (e-Social)</label>
            <input
              type="text"
              value={matricula}
              onChange={(e) => setMatricula(e.target.value)}
              placeholder="—"
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Função</label>
            <input
              type="text"
              value={funcao}
              onChange={(e) => setFuncao(e.target.value)}
              placeholder="Auxiliar Operacional"
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Tipo de exame</label>
            <select
              value={tipoExame}
              onChange={(e) => setTipoExame(e.target.value as ExamType)}
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              {EXAM_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Data do comparecimento</label>
            <input
              type="date"
              value={data}
              onChange={(e) => setData(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 whitespace-pre-line">
          ⚠️ {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button
          variant="primary"
          onClick={() => handleGenerate("docx")}
          disabled={!!generating || !nome.trim()}
        >
          {generating === "docx" ? "Gerando..." : "Gerar Word (.docx)"}
        </Button>
        <Button
          variant="danger"
          onClick={() => handleGenerate("pdf")}
          disabled={!!generating || !nome.trim()}
        >
          {generating === "pdf" ? "Gerando..." : "Gerar PDF (.pdf)"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => handleGenerate("print")}
          disabled={!!generating || !nome.trim()}
        >
          {generating === "print" ? "Imprimindo..." : "🖨️ Imprimir"}
        </Button>
      </div>
    </div>
  );
}
