"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatDate } from "@/lib/utils";
import type { StockItem } from "@/types/database";

interface Ship {
  id: string;
  name: string;
  arrival_date: string | null;
  departure_date: string | null;
  port: string | null;
  status: string;
  assigned_team: string | null;
}

export function EscalacaoEstoquePage() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const role = profile?.role || "RH";
  const canEmbarcar = hasPermission(role, "EMBARQUE", "embarcar");

  const [ships, setShips] = useState<Ship[]>([]);
  const [selectedShip, setSelectedShip] = useState<string>("");
  const [selectedTeam, setSelectedTeam] = useState<"EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3">("EQUIPE_1");
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmEmbark, setConfirmEmbark] = useState(false);
  const [embarking, setEmbarking] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [shipsRes, stockRes] = await Promise.all([
        db.from("ships").select("*").in("status", ["AGENDADO", "EM_OPERACAO"]).order("arrival_date"),
        db.from("stock_items").select("*").order("name"),
      ]);
      setShips((shipsRes.data as Ship[]) || []);
      setStockItems(stockRes.data || []);
    } catch (err) {
      console.error("Load error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData, pathname]);

  useEffect(() => {
    if (ships.length > 0 && !selectedShip) {
      setSelectedShip(ships[0].id);
      if (ships[0].assigned_team) {
        setSelectedTeam(ships[0].assigned_team as "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3");
      }
    }
  }, [ships, selectedShip]);

  const currentShip = ships.find((s) => s.id === selectedShip);

  const teamItems = stockItems
    .filter((i) => (i as any).team === selectedTeam)
    .filter((i) => (i as any).default_quantity > 0);

  const totalDefault = teamItems.reduce((s, i) => s + ((i as any).default_quantity || 0), 0);
  const totalCurrent = teamItems.reduce((s, i) => s + Math.min(i.quantity, (i as any).default_quantity || 0), 0);
  const pct = totalDefault > 0 ? Math.round((totalCurrent / totalDefault) * 100) : 0;
  const allReady = totalCurrent >= totalDefault && totalDefault > 0;

  const itemsWithStatus = teamItems.map((item) => {
    const def = (item as any).default_quantity || 0;
    const current = item.quantity;
    const falta = Math.max(0, def - current);
    const ready = current >= def;
    return { ...item, default_quantity: def, falta, ready };
  });

  const readyCount = itemsWithStatus.filter((i) => i.ready).length;
  const missingCount = itemsWithStatus.filter((i) => !i.ready).length;

  async function handleEmbarcar() {
    if (!currentShip) return;
    setEmbarking(true);
    const actor = profile?.full_name || "Sistema";

    for (const item of itemsWithStatus) {
      if (item.quantity <= 0) continue;
      const toConsume = Math.min(item.quantity, item.default_quantity);
      await db.from("stock_movements").insert({
        stock_item_id: item.id,
        movement_type: "BAIXA",
        quantity: toConsume,
        movement_date: new Date().toISOString().split("T")[0],
        notes: `Embarque: ${currentShip.name} (${selectedTeam})`,
        created_by: actor,
      } as any);
      await db.from("stock_items").update({
        quantity: item.quantity - toConsume,
        updated_by: actor,
      } as any).eq("id", item.id);
    }

    if (currentShip.status === "AGENDADO") {
      await db.from("ships").update({ status: "EM_OPERACAO" } as any).eq("id", selectedShip);
    }

    setEmbarking(false);
    setConfirmEmbark(false);
    loadData();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-2">
          <span className="text-4xl animate-bounce">📦</span>
          <span className="text-sm text-text-light animate-pulse">Carregando rancho...</span>
        </div>
      </div>
    );
  }

  if (ships.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-text">Rancho para Embarque 📦</h1>
        <div className="bg-card rounded-xl shadow-sm border border-border p-8 text-center text-text-light">
          <span className="text-4xl block mb-3">🚢</span>
          <p className="font-medium text-text mb-1">Nenhum navio agendado ou em operação</p>
          <p className="text-sm">Cadastre navios na aba <strong>Navios</strong> para preparar embarques.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-text">Rancho para Embarque 📦</h1>

      <ShipSelector
        ships={ships}
        selectedShip={selectedShip}
        onSelect={setSelectedShip}
      />

      <div className="space-y-4">
        <div className="flex flex-wrap gap-2 items-end justify-between">
          <div className="flex gap-2 items-center">
            <span className="text-xs text-text-light font-semibold uppercase tracking-wider">Equipe (rancho):</span>
            <select
              value={selectedTeam}
              onChange={(e) => setSelectedTeam(e.target.value as any)}
              className="px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
            >
              <option value="EQUIPE_1">Equipe 1</option>
              <option value="EQUIPE_2">Equipe 2</option>
              <option value="EQUIPE_3">Equipe 3</option>
            </select>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className={`text-sm font-bold px-3 py-1.5 rounded-full ${
              allReady ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
            }`}>
              {pct}% pronto
            </span>
            <span className="text-xs text-text-light">
              {readyCount} prontos · {missingCount} com falta · {totalCurrent}/{totalDefault} itens
            </span>
            {canEmbarcar && teamItems.length > 0 && (
              <Button size="sm" variant="warning" onClick={() => setConfirmEmbark(true)}>
                ⚓ Embarcar
              </Button>
            )}
          </div>
        </div>

        <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-border">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-light uppercase">Item</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Categoria</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Padrão</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Em Rancho</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {itemsWithStatus.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-text-light">
                      <span className="text-3xl block mb-2">📦</span>
                      Nenhum item com quantidade padrão definida
                    </td>
                  </tr>
                ) : (
                  itemsWithStatus.map((item) => (
                    <tr key={item.id} className={`hover:bg-gray-50 ${!item.ready ? "bg-red-50/40" : ""}`}>
                      <td className="px-4 py-3 font-medium">{item.name}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                          {item.category === "CARNE" ? "Carne" : item.category === "FEIRA" ? "Feira" : "Suprimentos"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-center text-text-light">{item.default_quantity}</td>
                      <td className={`px-4 py-3 text-center font-bold ${!item.ready ? "text-danger" : "text-success"}`}>
                        {item.quantity}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {item.ready ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">✓ Pronto</span>
                        ) : (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">Falta {item.falta}</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmEmbark}
        onClose={() => setConfirmEmbark(false)}
        onConfirm={handleEmbarcar}
        title="Confirmar Embarque"
        message={`Embarcar ${selectedTeam} no navio "${currentShip?.name}"? As quantidades padrão serão retiradas do rancho desta equipe.`}
        confirmLabel="⚓ Confirmar Embarque"
        variant="warning"
        loading={embarking}
      />
    </div>
  );
}

function ShipSelector({
  ships, selectedShip, onSelect,
}: {
  ships: Ship[];
  selectedShip: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const current = ships.find((s) => s.id === selectedShip);
  const filtered = ships.filter((s) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.port || "").toLowerCase().includes(q);
  });

  function statusBadge(status: string) {
    return status === "AGENDADO"
      ? { cls: "bg-blue-100 text-blue-700", label: "Agendado", icon: "📅" }
      : status === "EM_OPERACAO"
        ? { cls: "bg-amber-100 text-amber-700", label: "Em Operação", icon: "⚓" }
        : { cls: "bg-gray-100 text-gray-700", label: status, icon: "🚢" };
  }

  return (
    <div ref={ref} className="relative">
      <label className="block text-xs font-semibold text-text-light uppercase tracking-wider mb-1.5">
        🚢 Navio
      </label>

      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full bg-card border border-border rounded-xl p-4 text-left hover:border-primary hover:shadow-md transition flex items-center gap-3 group"
      >
        {current ? (
          <>
            <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center text-2xl shrink-0">
              {statusBadge(current.status).icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="font-bold text-text text-base truncate">{current.name}</h3>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${statusBadge(current.status).cls}`}>
                  {statusBadge(current.status).label}
                </span>
              </div>
              <div className="flex flex-wrap gap-3 mt-1 text-xs text-text-light">
                {current.port && (
                  <span className="flex items-center gap-1">📍 {current.port}</span>
                )}
                {current.arrival_date && (
                  <span className="flex items-center gap-1">
                    🛬 <span className="text-text font-medium">{formatDate(current.arrival_date)}</span>
                  </span>
                )}
                {current.departure_date && (
                  <span className="flex items-center gap-1">
                    🛫 <span className="text-text font-medium">{formatDate(current.departure_date)}</span>
                  </span>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 text-text-light text-sm">Selecione um navio...</div>
        )}
        <svg className={`w-5 h-5 text-text-light transition shrink-0 ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 mt-2 w-full bg-card border border-border rounded-xl shadow-xl overflow-hidden">
          <div className="p-2 border-b border-border bg-gray-50">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍 Buscar navio ou porto..."
              autoFocus
              className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:ring-2 focus:ring-primary outline-none bg-white"
            />
          </div>
          <div className="max-h-80 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-text-light">
                Nenhum navio encontrado
              </div>
            ) : (
              filtered.map((s) => {
                const isCurrent = s.id === selectedShip;
                const sb = statusBadge(s.status);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => { onSelect(s.id); setOpen(false); setSearch(""); }}
                    className={`w-full text-left px-3 py-3 hover:bg-blue-50 transition flex items-center gap-3 border-b border-border last:border-0 ${
                      isCurrent ? "bg-primary/5" : ""
                    }`}
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xl shrink-0 ${
                      isCurrent ? "bg-primary text-white" : "bg-gray-100"
                    }`}>
                      {sb.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm truncate">{s.name}</p>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold uppercase ${sb.cls}`}>
                          {sb.label}
                        </span>
                        {isCurrent && (
                          <span className="text-[10px] text-primary font-bold">✓ Selecionado</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 mt-0.5 text-[11px] text-text-light">
                        {s.port && <span>📍 {s.port}</span>}
                        {s.arrival_date && <span>🛬 {formatDate(s.arrival_date)}</span>}
                        {s.departure_date && <span>🛫 {formatDate(s.departure_date)}</span>}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
          <div className="px-3 py-2 bg-gray-50 border-t border-border text-[10px] text-text-light text-center">
            {ships.length} navio(s) disponível(eis) (Agendado / Em Operação)
          </div>
        </div>
      )}
    </div>
  );
}
