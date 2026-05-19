"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Employee } from "@/types/database";

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

export function FichaEpiSubTab({ employees }: { employees: Employee[] }) {
  const [employeeId, setEmployeeId] = useState<string>("");
  const [nome, setNome] = useState("");
  const [reg, setReg] = useState("");
  const [funcao, setFuncao] = useState("");
  const [setor, setSetor] = useState("");
  const [data, setData] = useState<string>(todayInput);

  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Active employees first, sorted by name.
  const sortedEmployees = useMemo(() => {
    return [...employees]
      .filter((e) => e.status !== "INATIVO")
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [employees]);

  function handlePickEmployee(idStr: string) {
    setEmployeeId(idStr);
    if (!idStr) {
      setNome("");
      setReg("");
      setFuncao("");
      setSetor("");
      return;
    }
    const e = employees.find((x) => String(x.id) === idStr);
    if (!e) return;
    setNome(e.name.toUpperCase());
    // Registration: prefer e_social code, fallback to id
    setReg(e.e_social || String(e.id));
    setFuncao((e.role || "").toUpperCase());
    setSetor((e.sector || "OPERACIONAL").toUpperCase());
  }

  async function handleGenerate() {
    setError(null);
    if (!nome.trim()) {
      setError("Selecione um funcionário ou informe o nome.");
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/documents/ficha-epi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: nome.trim(),
          reg: reg.trim(),
          funcao: funcao.trim(),
          setor: setor.trim(),
          data: fromInputDate(data),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Erro ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeName = nome.trim().replace(/[\\/:*?"<>|]+/g, "").trim() || "FUNCIONARIO";
      a.download = `Ficha EPI ${safeName}.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha ao gerar ficha.";
      setError(msg);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div>
          <h3 className="font-semibold text-text">Gerar Ficha de Entrega de EPI</h3>
          <p className="text-xs text-text-light mt-0.5">
            Selecione um colaborador; o sistema preenche nome, função e setor automaticamente.
            A lista de EPIs padrão já vem no template.
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
              placeholder="LUCAS NUNES DE BARROS"
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Registro</label>
            <input
              type="text"
              value={reg}
              onChange={(e) => setReg(e.target.value)}
              placeholder="ex.: 108"
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <p className="text-[10px] text-text-light mt-1">Vem do e-Social. Edite se necessário.</p>
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Função</label>
            <input
              type="text"
              value={funcao}
              onChange={(e) => setFuncao(e.target.value.toUpperCase())}
              placeholder="AUXILIAR OPERACIONAL"
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Setor</label>
            <input
              type="text"
              value={setor}
              onChange={(e) => setSetor(e.target.value.toUpperCase())}
              placeholder="OPERACIONAL"
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Data de abertura</label>
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
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700">
          ⚠️ {error}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={handleGenerate} disabled={generating || !nome.trim()}>
          {generating ? "Gerando..." : "Gerar Ficha EPI (.docx)"}
        </Button>
      </div>
    </div>
  );
}
