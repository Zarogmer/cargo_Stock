"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { printPdfBlob, shareOrDownloadBlob } from "@/lib/print";
import { PdfPreview } from "./pdf-preview";
import { db } from "@/lib/db";
import type { Employee } from "@/types/database";

// Documento "AUTORIZAÇÃO PARA ACESSO À BARRA": emitido por navio. O usuário
// escolhe navio/bandeira/IMO, período, agência (reusa clientes dos navios),
// meio de transporte e gate (cadastráveis), a equipe (define a lista fixa de
// equipamentos, vinda do kit de embarque) e os colaboradores (viram a tabela
// NOME/CPF/RG/NASCIMENTO/ISPSCODE).

interface Ship {
  id: string;
  name: string;
  client_name: string | null;
}

interface KitRow {
  team: string;
  quantity: number;
  stock_items: { id: number; name: string } | null;
}

const TEAMS: { key: string; label: string }[] = [
  { key: "EQUIPE_4", label: "Equipe Turbo" },
  { key: "EQUIPE_1", label: "Equipe 1" },
  { key: "EQUIPE_2", label: "Equipe 2" },
];

function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// "1988-07-19" → "19/07/1988" (sem passar por Date pra não escorregar fuso).
function brDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec((iso || "").slice(0, 10));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const fieldCls =
  "mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30";

export function PeticaoSubTab({ employees }: { employees: Employee[] }) {
  const [ships, setShips] = useState<Ship[]>([]);
  const [kit, setKit] = useState<KitRow[]>([]);
  const [gates, setGates] = useState<string[]>([]);
  const [transportes, setTransportes] = useState<string[]>([]);

  // Form
  const [data, setData] = useState<string>(todayInput);
  const [navioName, setNavioName] = useState("");
  const [bandeira, setBandeira] = useState("");
  const [imo, setImo] = useState("");
  const [periodoIni, setPeriodoIni] = useState("");
  const [periodoFim, setPeriodoFim] = useState("");
  const [agencia, setAgencia] = useState("");
  const [selTransportes, setSelTransportes] = useState<Set<string>>(new Set());
  const [gate, setGate] = useState("");
  const [motivo, setMotivo] = useState("Realização de Limpeza de Porões.");
  const [team, setTeam] = useState("EQUIPE_4");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [empSearch, setEmpSearch] = useState("");

  const [generating, setGenerating] = useState<"docx" | "pdf" | "print" | "preview" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const [shipsRes, kitRes] = await Promise.all([
        db.from("ships").select("id, name, client_name").order("name"),
        db.from("embark_kit_items").select("team, quantity, stock_items(id, name)"),
      ]);
      if (!active) return;
      if (shipsRes.data) setShips(shipsRes.data as Ship[]);
      if (kitRes.data) setKit(kitRes.data as unknown as KitRow[]);
    })();
    loadOptions();
    return () => {
      active = false;
    };
  }, []);

  async function loadOptions() {
    try {
      const res = await fetch("/api/peticao/options");
      if (res.ok) {
        const b = await res.json();
        setGates(Array.isArray(b.gates) ? b.gates : []);
        setTransportes(Array.isArray(b.transportes) ? b.transportes : []);
      }
    } catch {
      /* silencioso */
    }
  }

  // Agências = clientes distintos já usados nos navios (o usuário disse que são
  // "as mesmas do navio"). Pode digitar uma nova (vira texto livre no documento).
  const agencyOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of ships) {
      const c = (s.client_name || "").trim();
      if (c) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [ships]);

  const sortedEmployees = useMemo(
    () =>
      [...employees]
        .filter((e) => e.status !== "INATIVO")
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [employees]
  );

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

  // Equipamentos = kit de embarque da equipe escolhida (fixo, só leitura).
  const equipamentos = useMemo(() => {
    return kit
      .filter((k) => k.team === team && k.stock_items)
      .map((k) => ({ name: k.stock_items!.name, qty: k.quantity }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .map((row, i) => ({ item: pad2(i + 1), qtd: pad2(Math.round(row.qty)), desc: row.name }));
  }, [kit, team]);

  const selectedCount = selectedIds.size;

  function toggleEmployee(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleTransporte(name: string) {
    setSelTransportes((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function addOption(kind: "gate" | "transporte", name: string) {
    const clean = name.trim();
    if (!clean) return;
    try {
      const res = await fetch("/api/peticao/options", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, name: clean }),
      });
      if (!res.ok) return;
      const b = await res.json();
      const list: string[] = Array.isArray(b.list) ? b.list : [];
      if (kind === "gate") {
        setGates(list);
        setGate(clean);
      } else {
        setTransportes(list);
        setSelTransportes((prev) => new Set(prev).add(clean));
      }
    } catch {
      /* silencioso */
    }
  }

  async function removeOption(kind: "gate" | "transporte", name: string) {
    try {
      const res = await fetch(
        `/api/peticao/options?kind=${kind}&name=${encodeURIComponent(name)}`,
        { method: "DELETE" }
      );
      if (!res.ok) return;
      const b = await res.json();
      const list: string[] = Array.isArray(b.list) ? b.list : [];
      if (kind === "gate") {
        setGates(list);
        if (gate === name) setGate("");
      } else {
        setTransportes(list);
        setSelTransportes((prev) => {
          const next = new Set(prev);
          next.delete(name);
          return next;
        });
      }
    } catch {
      /* silencioso */
    }
  }

  // Monta "NOME / BANDEIRA / IMO" ignorando pedaços vazios.
  const navioLine = [navioName.trim(), bandeira.trim(), imo.trim()].filter(Boolean).join(" / ");
  const periodoLine =
    periodoIni && periodoFim
      ? `${brDate(periodoIni)} a ${brDate(periodoFim)}`
      : periodoIni
        ? brDate(periodoIni)
        : "";
  const transporteLine = Array.from(selTransportes).join(" / ");

  async function handleGenerate(action: "docx" | "pdf" | "print" | "preview") {
    setError(null);
    if (selectedIds.size === 0) {
      setError("Selecione ao menos um colaborador.");
      return;
    }
    if (!navioName.trim()) {
      setError("Informe o nome do navio.");
      return;
    }
    const byId = new Map(employees.map((e) => [e.id, e] as const));
    const emps = [...selectedIds]
      .map((id) => byId.get(id))
      .filter((e): e is Employee => !!e)
      .map((e) => ({
        nome: (e.name || "").toUpperCase(),
        cpf: e.cpf || "",
        rg: e.rg || "",
        nasc: brDate(e.birth_date),
        isps: e.isps_code || "",
      }));

    const format = action === "docx" ? "docx" : "pdf";
    setGenerating(action);
    try {
      const res = await fetch(`/api/documents/peticao?format=${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: brDate(data),
          navio: navioLine,
          periodo: periodoLine,
          agencia: agencia.trim(),
          transporte: transporteLine,
          gate: gate.trim(),
          motivo: motivo.trim(),
          employees: emps,
          equipamentos,
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        const main = b.error || `Erro ${res.status}`;
        throw new Error(b.detail ? `${main}\n\nDetalhe tecnico: ${b.detail}` : main);
      }
      const blob = await res.blob();
      if (action === "preview") setPreviewBlob(blob);
      else if (action === "print") printPdfBlob(blob);
      else {
        const shipLabel = (navioName.trim() || "NAVIO").replace(/[\\/:*?"<>|]+/g, "");
        await shareOrDownloadBlob(blob, `Autorizacao de Acesso a Barra - ${shipLabel}.${format}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao gerar a petição.");
    } finally {
      setGenerating(null);
    }
  }

  const busy = generating !== null;

  return (
    <div className="space-y-5">
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div>
          <h3 className="font-semibold text-text">Autorização para Acesso à Barra (Petição)</h3>
          <p className="text-xs text-text-light mt-0.5">
            Documento emitido por navio. Escolha os dados do serviço e marque os colaboradores —
            a lista de equipamentos vem fixa do kit de embarque da equipe.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Data */}
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Data</label>
            <input type="date" value={data} onChange={(e) => setData(e.target.value)} className={fieldCls} />
          </div>

          {/* Equipe (define equipamentos) */}
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Equipe (equipamentos)</label>
            <select value={team} onChange={(e) => setTeam(e.target.value)} className={fieldCls}>
              {TEAMS.map((t) => (
                <option key={t.key} value={t.key}>{t.label}</option>
              ))}
            </select>
          </div>

          {/* Navio */}
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Navio</label>
            <input
              type="text"
              list="peticao-navios"
              value={navioName}
              onChange={(e) => setNavioName(e.target.value.toUpperCase())}
              placeholder="Nome do navio"
              className={fieldCls}
            />
            <datalist id="peticao-navios">
              {ships.map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
          </div>

          {/* Bandeira + IMO */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Bandeira</label>
              <input type="text" value={bandeira} onChange={(e) => setBandeira(e.target.value.toUpperCase())} placeholder="ILHAS MARSHALL" className={fieldCls} />
            </div>
            <div>
              <label className="text-xs font-semibold text-text-light uppercase tracking-wider">IMO</label>
              <input type="text" value={imo} onChange={(e) => setImo(e.target.value)} placeholder="9875056" className={fieldCls} />
            </div>
          </div>

          {/* Período */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Período — de</label>
              <input type="date" value={periodoIni} onChange={(e) => setPeriodoIni(e.target.value)} className={fieldCls} />
            </div>
            <div>
              <label className="text-xs font-semibold text-text-light uppercase tracking-wider">até</label>
              <input type="date" value={periodoFim} onChange={(e) => setPeriodoFim(e.target.value)} className={fieldCls} />
            </div>
          </div>

          {/* Agência */}
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Agência</label>
            <input
              type="text"
              list="peticao-agencias"
              value={agencia}
              onChange={(e) => setAgencia(e.target.value)}
              placeholder="Selecione ou digite a agência"
              className={fieldCls}
            />
            <datalist id="peticao-agencias">
              {agencyOptions.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>

          {/* Motivo */}
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Motivo</label>
            <input type="text" value={motivo} onChange={(e) => setMotivo(e.target.value)} className={fieldCls} />
          </div>
        </div>

        {/* Gate (cadastrável) — aplicado aos 4 locais de embarque/desembarque */}
        <OptionsManager
          label="Gate (Local de Embarque/Desembarque)"
          hint="Aplicado aos 4 locais (prestadores e equipamentos)."
          options={gates}
          multi={false}
          selectedSingle={gate}
          onPickSingle={setGate}
          onAdd={(name) => addOption("gate", name)}
          onRemove={(name) => removeOption("gate", name)}
          addPlaceholder="Ex.: GATES 19 / 44"
        />

        {/* Meio de Transporte (cadastrável, múltiplo) */}
        <OptionsManager
          label="Meio de Transporte"
          hint="Marque um ou vários — saem separados por “ / ”."
          options={transportes}
          multi
          selectedMulti={selTransportes}
          onToggleMulti={toggleTransporte}
          onAdd={(name) => addOption("transporte", name)}
          onRemove={(name) => removeOption("transporte", name)}
          addPlaceholder="Ex.: Major I"
        />

        {/* Colaboradores */}
        <div>
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Colaboradores</label>
            {selectedCount > 0 && (
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
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
          <div className="mt-1 max-h-56 overflow-y-auto border border-border rounded-lg divide-y divide-border">
            {filteredEmployees.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-light">Nenhum colaborador encontrado.</p>
            ) : (
              filteredEmployees.map((e) => (
                <label key={e.id} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(e.id)}
                    onChange={() => toggleEmployee(e.id)}
                    className="rounded border-border"
                  />
                  <span className="text-sm text-text">{e.name}</span>
                  {!e.isps_code && <span className="text-[10px] text-amber-600">(sem ISPS)</span>}
                </label>
              ))
            )}
          </div>
          <p className="text-[11px] text-text-light mt-1">
            {selectedCount} selecionado{selectedCount === 1 ? "" : "s"} — saem na tabela NOME / CPF / RG / NASCIMENTO / ISPSCODE.
          </p>
        </div>

        {/* Prévia dos equipamentos (fixo do kit da equipe) */}
        <div>
          <label className="text-xs font-semibold text-text-light uppercase tracking-wider">
            Equipamentos e Materiais — {TEAMS.find((t) => t.key === team)?.label} ({equipamentos.length})
          </label>
          {equipamentos.length === 0 ? (
            <p className="text-[11px] text-amber-700 mt-1">
              Esta equipe não tem kit de embarque cadastrado. Monte o kit em Controle › Embarque/Retorno.
            </p>
          ) : (
            <div className="mt-1 max-h-40 overflow-y-auto border border-border rounded-lg text-xs">
              <table className="w-full">
                <tbody>
                  {equipamentos.map((q) => (
                    <tr key={q.item} className="border-b border-border last:border-0">
                      <td className="px-2 py-1 text-text-light w-10">{q.item}</td>
                      <td className="px-2 py-1 text-text-light w-12">{q.qtd}</td>
                      <td className="px-2 py-1 text-text">{q.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 whitespace-pre-line">
          ⚠️ {error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="secondary" onClick={() => handleGenerate("preview")} disabled={busy} className="mr-auto">
          {generating === "preview" ? "Gerando..." : "👁️ Pré-visualizar"}
        </Button>
        <Button variant="primary" onClick={() => handleGenerate("docx")} disabled={busy}>
          {generating === "docx" ? "Gerando..." : "Gerar Word (.docx)"}
        </Button>
        <Button variant="danger" onClick={() => handleGenerate("pdf")} disabled={busy}>
          {generating === "pdf" ? "Gerando..." : "Gerar PDF (.pdf)"}
        </Button>
        <Button variant="secondary" onClick={() => handleGenerate("print")} disabled={busy}>
          {generating === "print" ? "Imprimindo..." : "🖨️ Imprimir"}
        </Button>
      </div>

      <PdfPreview blob={previewBlob} loading={generating === "preview"} onClose={() => setPreviewBlob(null)} />
    </div>
  );
}

// ─── Lista cadastrável (Gate único / Transportes múltiplos) ───────────────────
function OptionsManager({
  label,
  hint,
  options,
  multi,
  selectedSingle,
  onPickSingle,
  selectedMulti,
  onToggleMulti,
  onAdd,
  onRemove,
  addPlaceholder,
}: {
  label: string;
  hint?: string;
  options: string[];
  multi: boolean;
  selectedSingle?: string;
  onPickSingle?: (v: string) => void;
  selectedMulti?: Set<string>;
  onToggleMulti?: (v: string) => void;
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  addPlaceholder?: string;
}) {
  const [novo, setNovo] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function submitAdd() {
    const v = novo.trim();
    if (!v) return;
    onAdd(v);
    setNovo("");
    inputRef.current?.focus();
  }

  return (
    <div>
      <label className="text-xs font-semibold text-text-light uppercase tracking-wider">{label}</label>
      {hint && <p className="text-[11px] text-text-light">{hint}</p>}
      <div className="mt-1 flex flex-wrap gap-1.5">
        {options.length === 0 && (
          <span className="text-[11px] text-text-light py-1">Nada cadastrado — adicione abaixo.</span>
        )}
        {options.map((opt) => {
          const active = multi ? !!selectedMulti?.has(opt) : selectedSingle === opt;
          return (
            <span
              key={opt}
              className={`inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-xs border transition ${
                active
                  ? "bg-primary text-white border-primary"
                  : "bg-card text-text border-border hover:border-primary/50"
              }`}
            >
              <button
                type="button"
                onClick={() => (multi ? onToggleMulti?.(opt) : onPickSingle?.(active ? "" : opt))}
                className="font-medium"
              >
                {opt}
              </button>
              <button
                type="button"
                title="Remover do cadastro"
                onClick={() => onRemove(opt)}
                className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${
                  active ? "hover:bg-white/25" : "text-text-light hover:bg-gray-200"
                }`}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
      <div className="mt-1.5 flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={novo}
          onChange={(e) => setNovo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submitAdd();
            }
          }}
          placeholder={addPlaceholder || "Adicionar…"}
          className="flex-1 px-3 py-1.5 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <button
          type="button"
          onClick={submitAdd}
          className="px-3 py-1.5 text-sm font-medium text-primary border border-primary/40 rounded-lg hover:bg-primary/5 whitespace-nowrap"
        >
          + Cadastrar
        </button>
      </div>
    </div>
  );
}
