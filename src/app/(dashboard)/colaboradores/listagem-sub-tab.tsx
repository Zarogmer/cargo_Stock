"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { printPdfBlob, shareOrDownloadBlob } from "@/lib/print";
import { Modal } from "@/components/ui/modal";
import { PdfPreview } from "./pdf-preview";
import { isDocEligibleEmployee } from "@/lib/utils";
import type { Employee } from "@/types/database";

type Variant = "SANTOS" | "FORA";

// Listagem de Embarque: o usuário só escolhe os colaboradores e o porto. A
// coluna de identificação muda conforme o porto — Santos usa ISPS CODE (exigência
// dos terminais de Santos); fora de Santos usa RG. CPF e nascimento vêm da aba
// Colaboradores.
export function ListagemSubTab({ employees }: { employees: Employee[] }) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [empSearch, setEmpSearch] = useState("");
  const [variant, setVariant] = useState<Variant>("SANTOS");

  const [generating, setGenerating] = useState<"docx" | "pdf" | "print" | "preview" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [cpfOpen, setCpfOpen] = useState(false);
  const [cpfCopied, setCpfCopied] = useState(false);

  // Só quem embarca: ativos do operacional. Administrativo (RH, financeiro…)
  // não vai na listagem de embarque. Sem setor definido é tratado como
  // operacional para não sumir com quem esqueceram de categorizar. Demitidos e
  // inativos na escalação ficam de fora (isDocEligibleEmployee).
  const sortedEmployees = useMemo(() => {
    return [...employees]
      .filter((e) => isDocEligibleEmployee(e) && e.sector !== "ADMINISTRATIVO")
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [employees]);

  const filteredEmployees = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    if (!q) return sortedEmployees;
    const qDigits = q.replace(/\D/g, "");
    return sortedEmployees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        (qDigits ? (e.cpf || "").replace(/\D/g, "").includes(qDigits) : false),
    );
  }, [sortedEmployees, empSearch]);

  const selectedCount = selectedIds.size;

  // Coluna de identificação em falta para algum selecionado (alerta suave).
  const missingCount = useMemo(() => {
    let n = 0;
    for (const id of selectedIds) {
      const e = employees.find((x) => x.id === id);
      if (!e) continue;
      const v = variant === "SANTOS" ? e.isps_code : e.rg;
      if (!v || !v.trim()) n++;
    }
    return n;
  }, [selectedIds, employees, variant]);

  // Lista de CPF: só dígitos, separados por ";" (formato que os terminais pedem
  // pra liberar o acesso), na mesma ordem alfabética da lista.
  const cpfList = useMemo(() => {
    const cpfs: string[] = [];
    const withoutCpf: string[] = [];
    for (const e of sortedEmployees) {
      if (!selectedIds.has(e.id)) continue;
      const digits = (e.cpf || "").replace(/\D/g, "");
      if (digits) cpfs.push(digits);
      else withoutCpf.push(e.name);
    }
    return { text: cpfs.join(";"), count: cpfs.length, withoutCpf };
  }, [sortedEmployees, selectedIds]);

  async function copyCpfList() {
    try {
      await navigator.clipboard.writeText(cpfList.text);
      setCpfCopied(true);
      setTimeout(() => setCpfCopied(false), 2000);
    } catch {
      setError("Não foi possível copiar. Selecione o texto e copie manualmente.");
    }
  }

  // wa.me sem número abre a tela de "enviar para" (contatos e grupos).
  function sendCpfListToWhats() {
    window.open(`https://wa.me/?text=${encodeURIComponent(cpfList.text)}`, "_blank", "noopener");
  }

  function toggleEmployee(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const e of filteredEmployees) next.add(e.id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function handleGenerate(action: "docx" | "pdf" | "print" | "preview") {
    setError(null);
    const ids = [...selectedIds];
    if (ids.length === 0) {
      setError("Selecione ao menos um colaborador.");
      return;
    }
    const format = action === "docx" ? "docx" : "pdf";
    setGenerating(action);
    try {
      const res = await fetch(`/api/documents/listagem?format=${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeIds: ids, variant }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        const main = b.error || `Erro ${res.status}`;
        throw new Error(b.detail ? `${main}\n\nDetalhe técnico: ${b.detail}` : main);
      }
      const blob = await res.blob();
      if (action === "preview") {
        setPreviewBlob(blob);
      } else if (action === "print") {
        printPdfBlob(blob);
      } else {
        const variantLabel = variant === "SANTOS" ? "Santos" : "Fora de Santos";
        // No celular compartilha só o arquivo (sem link blob:); no desktop baixa.
        await shareOrDownloadBlob(blob, `Listagem de Embarque - ${variantLabel}.${format}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha ao gerar a listagem.";
      setError(msg);
    } finally {
      setGenerating(null);
    }
  }

  const fieldCls =
    "mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30";
  const canGenerate = !generating && selectedCount > 0;
  const idLabel = variant === "SANTOS" ? "ISPS CODE" : "RG";

  return (
    <div className="space-y-5">
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div>
          <h3 className="font-semibold text-text">Gerar Listagem de Embarque</h3>
          <p className="text-xs text-text-light mt-0.5">
            Escolha apenas os colaboradores; nome, CPF, {idLabel.toLowerCase()} e data de nascimento vêm da
            aba <strong>Colaboradores</strong>. Em <strong>Santos</strong> a listagem usa o{" "}
            <strong>ISPS CODE</strong>; <strong>fora de Santos</strong>, o <strong>RG</strong>.
          </p>
        </div>

        {/* Porto — decide a coluna de identificação */}
        <div>
          <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Porto</label>
          <div className="mt-1 inline-flex rounded-lg border border-border overflow-hidden">
            {([["SANTOS", "Santos"], ["FORA", "Viagem"]] as const).map(([val, label]) => (
              <button
                key={val}
                type="button"
                onClick={() => setVariant(val)}
                aria-pressed={variant === val}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  variant === val ? "bg-primary text-white" : "bg-card text-text hover:bg-gray-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Seleção de colaboradores */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">
              Colaboradores
            </label>
            <div className="flex items-center gap-3">
              {filteredEmployees.length > 0 && (
                <button
                  type="button"
                  onClick={selectAllFiltered}
                  className="text-[11px] font-medium text-primary hover:underline"
                >
                  Selecionar todos ({filteredEmployees.length})
                </button>
              )}
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
          </div>
          <input
            type="text"
            value={empSearch}
            onChange={(e) => setEmpSearch(e.target.value)}
            placeholder="Buscar por nome ou CPF…"
            className={fieldCls}
          />
          <div className="mt-1 max-h-72 overflow-y-auto border border-border rounded-lg divide-y divide-border">
            {filteredEmployees.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-light">Nenhum colaborador encontrado.</p>
            ) : (
              filteredEmployees.map((e) => {
                const checked = selectedIds.has(e.id);
                const idVal = variant === "SANTOS" ? e.isps_code : e.rg;
                const missing = !idVal || !idVal.trim();
                return (
                  <label
                    key={e.id}
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleEmployee(e.id)}
                      className="rounded border-border"
                    />
                    <span className="text-sm text-text flex-1">{e.name}</span>
                    {e.role && <span className="text-xs text-text-light">— {e.role}</span>}
                    {checked && missing && (
                      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                        sem {idLabel}
                      </span>
                    )}
                  </label>
                );
              })
            )}
          </div>
          <p className="text-[11px] text-text-light mt-1">
            {selectedCount === 0
              ? "Marque um ou mais colaboradores."
              : `${selectedCount} selecionado${selectedCount === 1 ? "" : "s"}.`}
            {selectedCount > 0 && missingCount > 0 && (
              <span className="text-amber-700">
                {" "}
                {missingCount} sem {idLabel} cadastrado — a coluna sai em branco para esse(s).
              </span>
            )}
          </p>
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
          disabled={!canGenerate}
          className="mr-auto"
        >
          {generating === "preview" ? "Gerando..." : "👁️ Pré-visualizar"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            setError(null);
            setCpfCopied(false);
            setCpfOpen(true);
          }}
          disabled={!canGenerate}
        >
          📋 Lista de CPF
        </Button>
        <Button variant="primary" onClick={() => handleGenerate("docx")} disabled={!canGenerate}>
          {generating === "docx" ? "Gerando..." : "Gerar Word (.docx)"}
        </Button>
        <Button variant="danger" onClick={() => handleGenerate("pdf")} disabled={!canGenerate}>
          {generating === "pdf" ? "Gerando..." : "Gerar PDF (.pdf)"}
        </Button>
        <Button variant="secondary" onClick={() => handleGenerate("print")} disabled={!canGenerate}>
          {generating === "print" ? "Imprimindo..." : "🖨️ Imprimir"}
        </Button>
      </div>

      <PdfPreview blob={previewBlob} loading={generating === "preview"} onClose={() => setPreviewBlob(null)} />

      <Modal open={cpfOpen} onClose={() => setCpfOpen(false)} title="Lista de CPF">
        <div className="space-y-3">
          <p className="text-xs text-text-light">
            {cpfList.count} CPF{cpfList.count === 1 ? "" : "s"} dos colaboradores selecionados, separados por
            ponto e vírgula.
          </p>
          <textarea
            readOnly
            value={cpfList.text}
            onFocus={(e) => e.currentTarget.select()}
            rows={5}
            className="w-full px-3 py-2 text-sm font-mono border border-border rounded-lg bg-gray-50 break-all focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          {cpfList.withoutCpf.length > 0 && (
            <p className="text-[11px] text-amber-700">
              Sem CPF cadastrado (fora da lista): {cpfList.withoutCpf.join(", ")}.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setCpfOpen(false)}>
              Fechar
            </Button>
            <Button variant="secondary" onClick={copyCpfList} disabled={!cpfList.text}>
              {cpfCopied ? "✅ Copiado!" : "📋 Copiar"}
            </Button>
            <Button variant="success" onClick={sendCpfListToWhats} disabled={!cpfList.text}>
              💬 Enviar no WhatsApp
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
