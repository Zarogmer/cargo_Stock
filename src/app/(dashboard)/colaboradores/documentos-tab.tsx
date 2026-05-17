"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { SearchIcon, PlusIcon, TrashIcon } from "@/components/icons";
import type { Employee } from "@/types/database";

interface Ship {
  id: string;
  name: string;
  arrival_date: string | null;
  departure_date: string | null;
  port: string | null;
  status: string;
  assigned_team: string | null;
}

interface SelectedEmployee {
  id: number | null; // null if added by free text
  name: string;
  cpf: string;
}

function toDdmmyyyy(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function fromInputDate(s: string): string {
  if (!s) return "";
  const [y, m, d] = s.split("-");
  if (!y || !m || !d) return "";
  return `${d}/${m}/${y}`;
}

function toInputDate(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

export function DocumentosTab({ employees }: { employees: Employee[] }) {
  const [ships, setShips] = useState<Ship[]>([]);
  const [loadingShips, setLoadingShips] = useState(true);

  const [shipId, setShipId] = useState<string>("");
  const [shipName, setShipName] = useState<string>("");
  const [docNumber, setDocNumber] = useState<string>("");
  const [documentDate, setDocumentDate] = useState<string>(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [periodStart, setPeriodStart] = useState<string>("");
  const [periodEnd, setPeriodEnd] = useState<string>("");
  const [motivo, setMotivo] = useState<string>("Utilização do Material de EPI's");

  const [picked, setPicked] = useState<SelectedEmployee[]>([]);
  const [search, setSearch] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingShips(true);
      try {
        const { data } = await db
          .from("ships")
          .select("id, name, arrival_date, departure_date, port, status, assigned_team")
          .order("arrival_date", { ascending: false });
        if (!cancelled) setShips((data as Ship[]) || []);
      } finally {
        if (!cancelled) setLoadingShips(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // When the user picks a ship, prefill name/period and seed the worker list
  // from the assigned team.
  const handlePickShip = useCallback(
    (id: string) => {
      setShipId(id);
      const s = ships.find((x) => x.id === id);
      if (!s) return;
      setShipName(s.name);
      if (s.arrival_date) setPeriodStart(toInputDate(s.arrival_date));
      if (s.departure_date) setPeriodEnd(toInputDate(s.departure_date));
      if (s.assigned_team) {
        const teamMembers = employees
          .filter((e) => e.team === s.assigned_team && e.status !== "INATIVO")
          .map<SelectedEmployee>((e) => ({ id: e.id, name: e.name, cpf: e.cpf || "" }));
        setPicked(teamMembers);
      }
    },
    [ships, employees]
  );

  // Employees available to add (not already picked, matching search)
  const availableEmployees = useMemo(() => {
    const pickedIds = new Set(picked.map((p) => p.id).filter((i): i is number => i !== null));
    const q = search.trim().toLowerCase();
    return employees
      .filter((e) => !pickedIds.has(e.id))
      .filter((e) => {
        if (!q) return true;
        return (
          e.name.toLowerCase().includes(q) ||
          (e.cpf || "").includes(q) ||
          (e.role || "").toLowerCase().includes(q)
        );
      })
      .slice(0, 30);
  }, [employees, picked, search]);

  function addEmployee(emp: Employee) {
    setPicked((prev) => [...prev, { id: emp.id, name: emp.name, cpf: emp.cpf || "" }]);
  }

  function removeAt(idx: number) {
    setPicked((prev) => prev.filter((_, i) => i !== idx));
  }

  function updatePicked(idx: number, patch: Partial<SelectedEmployee>) {
    setPicked((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
  }

  async function handleGenerate() {
    setError(null);
    if (!shipName.trim()) {
      setError("Selecione um navio ou informe o nome.");
      return;
    }
    if (picked.length === 0) {
      setError("Adicione pelo menos um funcionário.");
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/documents/dds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shipName: shipName.trim(),
          shipNumber: docNumber.trim(),
          documentDate: fromInputDate(documentDate),
          periodStart: fromInputDate(periodStart),
          periodEnd: fromInputDate(periodEnd),
          motivo: motivo.trim(),
          employees: picked.map((p) => ({ name: p.name, cpf: p.cpf })),
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
      a.download = `DDS ${shipName.trim().toUpperCase()}.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha ao gerar DDS.";
      setError(msg);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div>
          <h3 className="font-semibold text-text">📄 Gerar DDS — Declaração de Entrega de EPI's</h3>
          <p className="text-xs text-text-light mt-0.5">
            Selecione o navio e a equipe; o sistema preenche nome, período e CPFs automaticamente.
            Você pode editar antes de gerar o Word.
          </p>
        </div>

        {/* Ship picker + identifiers */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Navio</label>
            <select
              value={shipId}
              onChange={(e) => handlePickShip(e.target.value)}
              disabled={loadingShips}
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">{loadingShips ? "Carregando..." : "— Selecionar navio —"}</option>
              {ships.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.arrival_date ? ` — ${toDdmmyyyy(s.arrival_date)}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Nome no documento</label>
            <input
              type="text"
              value={shipName}
              onChange={(e) => setShipName(e.target.value)}
              placeholder="MV BARROW ISLAND"
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Nº do documento</label>
            <input
              type="text"
              value={docNumber}
              onChange={(e) => setDocNumber(e.target.value)}
              placeholder="ex.: 7"
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Data do documento</label>
            <input
              type="date"
              value={documentDate}
              onChange={(e) => setDocumentDate(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Período — início</label>
            <input
              type="date"
              value={periodStart}
              onChange={(e) => setPeriodStart(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Período — fim</label>
            <input
              type="date"
              value={periodEnd}
              onChange={(e) => setPeriodEnd(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div className="md:col-span-2">
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Motivo</label>
            <input
              type="text"
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              className="mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>
      </div>

      {/* Picked employees */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h3 className="font-semibold text-text">Funcionários no documento</h3>
            <p className="text-xs text-text-light">{picked.length} selecionado(s)</p>
          </div>
        </div>

        {picked.length === 0 ? (
          <div className="text-sm text-text-light italic py-6 text-center">
            Nenhum funcionário selecionado. Escolha um navio para carregar a equipe ou adicione abaixo.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wider text-text-light">
                <tr>
                  <th className="px-3 py-2 text-left">Nome</th>
                  <th className="px-3 py-2 text-left w-44">CPF</th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody>
                {picked.map((p, idx) => (
                  <tr key={`${p.id ?? "free"}-${idx}`} className="border-t border-border">
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={p.name}
                        onChange={(e) => updatePicked(idx, { name: e.target.value })}
                        className="w-full px-2 py-1 text-sm border border-transparent hover:border-border focus:border-primary rounded bg-transparent focus:bg-card focus:outline-none"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={p.cpf}
                        onChange={(e) => updatePicked(idx, { cpf: e.target.value })}
                        placeholder="—"
                        className="w-full px-2 py-1 text-sm font-mono border border-transparent hover:border-border focus:border-primary rounded bg-transparent focus:bg-card focus:outline-none"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => removeAt(idx)}
                        className="p-1.5 text-danger hover:bg-red-50 rounded"
                        title="Remover"
                      >
                        <TrashIcon />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add employees */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-3">
        <h3 className="font-semibold text-text">Adicionar funcionários</h3>
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-light" />
          <input
            type="text"
            placeholder="Buscar por nome, CPF ou função..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        {availableEmployees.length === 0 ? (
          <p className="text-sm text-text-light italic">Nenhum funcionário disponível.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-72 overflow-y-auto">
            {availableEmployees.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => addEmployee(e)}
                className="flex items-center justify-between gap-2 px-3 py-2 text-left text-sm border border-border rounded-lg hover:border-primary hover:bg-primary/5 transition"
              >
                <span className="min-w-0">
                  <span className="block font-medium truncate">{e.name}</span>
                  <span className="block text-xs text-text-light font-mono truncate">{e.cpf || "sem CPF"}</span>
                </span>
                <PlusIcon className="w-4 h-4 text-primary shrink-0" />
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700">
          ⚠️ {error}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={handleGenerate} disabled={generating || picked.length === 0}>
          {generating ? "Gerando..." : "📄 Gerar DDS (.docx)"}
        </Button>
      </div>
    </div>
  );
}
