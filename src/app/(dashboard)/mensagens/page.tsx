"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { formatPhone, matchSearch } from "@/lib/utils";

interface StatusResponse {
  configured?: boolean;
  status?: { instance?: { state?: string } };
  error?: string;
}

interface EmployeeLite {
  id: number;
  name: string;
  phone: string | null;
  team: string | null;
  status: string | null;
}

type Mode = "colaboradores" | "manual";

interface SendResult {
  name: string;
  phone: string;
  ok: boolean;
  error?: string;
}

export default function MensagensPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  const [mode, setMode] = useState<Mode>("colaboradores");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Manual mode
  const [manualTo, setManualTo] = useState("");

  // Colaboradores mode
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [loadingEmps, setLoadingEmps] = useState(true);
  const [empSearch, setEmpSearch] = useState("");
  const [empTeam, setEmpTeam] = useState<string>("Todos");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch("/api/whatsapp/status");
      const body = await res.json();
      setStatus(body);
    } catch (err) {
      setStatus({ error: (err as Error).message });
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  const loadEmployees = useCallback(async () => {
    setLoadingEmps(true);
    try {
      const res = await db
        .from("employees")
        .select("id, name, phone, team, status")
        .order("name");
      const data = (res.data || []) as EmployeeLite[];
      // Only employees with a phone number make sense for WhatsApp
      setEmployees(data.filter((e) => !!e.phone?.trim() && e.status === "ATIVO"));
    } catch (err) {
      console.error("Erro ao carregar colaboradores:", err);
    } finally {
      setLoadingEmps(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    loadEmployees();
    const interval = setInterval(loadStatus, 10000);
    return () => clearInterval(interval);
  }, [loadStatus, loadEmployees]);

  const teams = useMemo(() => {
    const set = new Set<string>();
    employees.forEach((e) => { if (e.team) set.add(e.team); });
    return ["Todos", ...Array.from(set).sort()];
  }, [employees]);

  const filteredEmployees = useMemo(() => {
    return employees.filter((e) => {
      if (empTeam !== "Todos" && e.team !== empTeam) return false;
      if (empSearch && !matchSearch(e.name, empSearch)) return false;
      return true;
    });
  }, [employees, empSearch, empTeam]);

  function toggleEmployee(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filteredEmployees.forEach((e) => next.add(e.id));
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  const selectedCount = selectedIds.size;

  async function sendOne(to: string, name: string): Promise<SendResult> {
    try {
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, text }),
      });
      const body = await res.json();
      if (res.ok) return { name, phone: to, ok: true };
      return { name, phone: to, ok: false, error: body.error || `HTTP ${res.status}` };
    } catch (err) {
      return { name, phone: to, ok: false, error: (err as Error).message };
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setResults(null);

    const targets: { name: string; phone: string }[] = [];
    if (mode === "manual") {
      if (!manualTo.trim()) {
        setMessage({ kind: "err", text: "Informe um número." });
        return;
      }
      targets.push({ name: "Manual", phone: manualTo.trim() });
    } else {
      const selected = employees.filter((e) => selectedIds.has(e.id));
      if (selected.length === 0) {
        setMessage({ kind: "err", text: "Selecione ao menos um colaborador." });
        return;
      }
      for (const emp of selected) {
        if (emp.phone) targets.push({ name: emp.name, phone: emp.phone });
      }
    }

    if (!text.trim()) {
      setMessage({ kind: "err", text: "Escreva a mensagem antes de enviar." });
      return;
    }

    setSending(true);
    setProgress({ done: 0, total: targets.length });
    const all: SendResult[] = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const r = await sendOne(t.phone, t.name);
      all.push(r);
      setProgress({ done: i + 1, total: targets.length });
      // small pause between sends to be gentle with WhatsApp
      if (i < targets.length - 1) await new Promise((res) => setTimeout(res, 800));
    }
    setResults(all);
    setSending(false);
    setProgress(null);

    const ok = all.filter((r) => r.ok).length;
    const fail = all.length - ok;
    if (fail === 0) {
      setMessage({ kind: "ok", text: `Enviado para ${ok} ${ok === 1 ? "destinatário" : "destinatários"}.` });
      setText("");
    } else if (ok === 0) {
      setMessage({ kind: "err", text: `Falhou em todos os ${fail} envios. Veja os detalhes abaixo.` });
    } else {
      setMessage({ kind: "err", text: `Enviado: ${ok} | Falhou: ${fail}. Veja detalhes abaixo.` });
    }
  }

  const stateRaw = status?.status?.instance?.state;
  const isConnected = stateRaw === "open";
  const isConfigured = status?.configured !== false;
  const canSend = isConnected && !sending;

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-text">Mensagens 📨</h1>
      <p className="text-sm text-text-light">
        Envie mensagens de WhatsApp pelo número da empresa, individualmente ou em massa para colaboradores.
      </p>

      {/* Status banner */}
      {loadingStatus ? (
        <div className="bg-gray-50 border border-border rounded-lg px-3 py-2 text-sm text-text-light">
          Verificando conexão...
        </div>
      ) : !isConfigured ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900">
          WhatsApp não configurado no servidor — avise a equipe de tecnologia.
        </div>
      ) : !isConnected ? (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-900">
          WhatsApp desconectado — peça pra equipe de tecnologia reconectar antes de enviar.
        </div>
      ) : (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm text-emerald-900 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          WhatsApp conectado e pronto pra enviar.
        </div>
      )}

      {message && (
        <div className={`rounded-lg px-3 py-2 text-sm border ${
          message.kind === "ok"
            ? "bg-emerald-50 border-emerald-200 text-emerald-900"
            : "bg-red-50 border-red-200 text-red-900"
        }`}>
          {message.text}
        </div>
      )}

      <section className="bg-card rounded-2xl border border-border p-6 space-y-4">
        {/* Mode toggle */}
        <div className="flex gap-2 border-b border-border pb-3">
          <button
            type="button"
            onClick={() => setMode("colaboradores")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              mode === "colaboradores"
                ? "bg-primary text-white"
                : "bg-gray-100 text-text-light hover:bg-gray-200"
            }`}
            disabled={sending}
          >
            Para colaboradores
          </button>
          <button
            type="button"
            onClick={() => setMode("manual")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              mode === "manual"
                ? "bg-primary text-white"
                : "bg-gray-100 text-text-light hover:bg-gray-200"
            }`}
            disabled={sending}
          >
            Número direto
          </button>
        </div>

        <form onSubmit={handleSend} className="space-y-4">
          {mode === "manual" ? (
            <div>
              <label className="block text-sm font-medium mb-1">
                Número (com DDD, sem +55)
              </label>
              <input
                type="text"
                value={manualTo}
                onChange={(e) => setManualTo(e.target.value)}
                placeholder="13988309100"
                disabled={!canSend}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none disabled:bg-gray-50 disabled:text-gray-500"
              />
              <p className="text-xs text-text-light mt-1">
                O +55 do Brasil é adicionado automaticamente.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <label className="block text-sm font-medium">
                  Colaboradores ({selectedCount} selecionado{selectedCount === 1 ? "" : "s"})
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={selectAllFiltered}
                    disabled={sending || filteredEmployees.length === 0}
                    className="text-xs text-primary hover:underline disabled:opacity-50"
                  >
                    Selecionar todos ({filteredEmployees.length})
                  </button>
                  <span className="text-xs text-text-light">|</span>
                  <button
                    type="button"
                    onClick={clearSelection}
                    disabled={sending || selectedCount === 0}
                    className="text-xs text-primary hover:underline disabled:opacity-50"
                  >
                    Limpar seleção
                  </button>
                </div>
              </div>
              <div className="flex gap-2 flex-wrap">
                <input
                  type="text"
                  value={empSearch}
                  onChange={(e) => setEmpSearch(e.target.value)}
                  placeholder="🔍 Buscar por nome..."
                  disabled={sending}
                  className="flex-1 min-w-[200px] px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                />
                <select
                  value={empTeam}
                  onChange={(e) => setEmpTeam(e.target.value)}
                  disabled={sending}
                  className="px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                >
                  {teams.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="border border-border rounded-lg max-h-64 overflow-y-auto">
                {loadingEmps ? (
                  <p className="text-sm text-text-light p-3">Carregando colaboradores...</p>
                ) : filteredEmployees.length === 0 ? (
                  <p className="text-sm text-text-light p-3">
                    Nenhum colaborador ativo com telefone encontrado.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {filteredEmployees.map((emp) => {
                      const checked = selectedIds.has(emp.id);
                      return (
                        <li key={emp.id}>
                          <label className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleEmployee(emp.id)}
                              disabled={sending}
                              className="w-4 h-4"
                            />
                            <span className="flex-1 text-sm">{emp.name}</span>
                            <span className="text-xs text-text-light font-mono">
                              {formatPhone(emp.phone || "")}
                            </span>
                            {emp.team && (
                              <span className="text-[10px] uppercase bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                                {emp.team}
                              </span>
                            )}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1">Mensagem</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              disabled={!canSend}
              placeholder="Escreva a mensagem aqui..."
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>

          {progress && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm text-blue-900">
              Enviando {progress.done}/{progress.total}...
              <div className="w-full h-1.5 bg-blue-100 rounded-full mt-1.5 overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setText(""); setManualTo(""); clearSelection(); setMessage(null); setResults(null); }}
              disabled={sending}
            >
              Limpar
            </Button>
            <Button type="submit" disabled={!canSend}>
              {sending
                ? "Enviando..."
                : mode === "colaboradores"
                  ? `Enviar para ${selectedCount} colaborador${selectedCount === 1 ? "" : "es"}`
                  : "Enviar"}
            </Button>
          </div>
        </form>
      </section>

      {/* Per-recipient results */}
      {results && results.length > 0 && (
        <section className="bg-card rounded-2xl border border-border p-6">
          <h3 className="text-sm font-semibold mb-3">Resultado do envio</h3>
          <ul className="divide-y divide-border text-sm">
            {results.map((r, idx) => (
              <li key={idx} className="flex items-center gap-2 py-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${r.ok ? "bg-emerald-500" : "bg-red-500"}`} />
                <span className="flex-1">{r.name}</span>
                <span className="text-xs text-text-light font-mono">{formatPhone(r.phone)}</span>
                {!r.ok && (
                  <span className="text-xs text-red-700 max-w-xs truncate" title={r.error}>
                    {r.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
