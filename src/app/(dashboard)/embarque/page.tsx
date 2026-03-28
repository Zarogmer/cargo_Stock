"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase-browser";
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

export default function EmbarquePage() {
  const { profile } = useAuth();
  const supabaseRef = useRef(createClient());
  const supabase = supabaseRef.current;
  const role = profile?.role || "RH";
  const canEmbarcar = hasPermission(role, "EMBARQUE", "embarcar");

  const [ships, setShips] = useState<Ship[]>([]);
  const [selectedShip, setSelectedShip] = useState<string>("");
  const [selectedTeam, setSelectedTeam] = useState<"EQUIPE_1" | "EQUIPE_2">("EQUIPE_1");
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmEmbark, setConfirmEmbark] = useState(false);
  const [embarking, setEmbarking] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [shipsRes, stockRes] = await Promise.all([
        supabase.from("ships").select("*").in("status", ["AGENDADO", "EM_OPERACAO"]).order("arrival_date"),
        supabase.from("stock_items").select("*").order("name"),
      ]);
      setShips((shipsRes.data as Ship[]) || []);
      setStockItems(stockRes.data || []);
    } catch (err) {
      console.error("Load error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    if (ships.length > 0 && !selectedShip) {
      setSelectedShip(ships[0].id);
      if (ships[0].assigned_team) {
        setSelectedTeam(ships[0].assigned_team as "EQUIPE_1" | "EQUIPE_2");
      }
    }
  }, [ships, selectedShip]);

  const currentShip = ships.find((s) => s.id === selectedShip);

  // Filter stock items by selected team
  const teamItems = stockItems
    .filter((i) => (i as any).team === selectedTeam)
    .filter((i) => (i as any).default_quantity > 0);

  // Calculate readiness
  const totalDefault = teamItems.reduce((s, i) => s + ((i as any).default_quantity || 0), 0);
  const totalCurrent = teamItems.reduce((s, i) => s + Math.min(i.quantity, (i as any).default_quantity || 0), 0);
  const pct = totalDefault > 0 ? Math.round((totalCurrent / totalDefault) * 100) : 0;
  const allReady = totalCurrent >= totalDefault && totalDefault > 0;

  // Items with status
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

      // Create stock movement (BAIXA)
      await supabase.from("stock_movements").insert({
        stock_item_id: item.id,
        movement_type: "BAIXA",
        quantity: toConsume,
        movement_date: new Date().toISOString().split("T")[0],
        notes: `Embarque: ${currentShip.name} (${selectedTeam === "EQUIPE_1" ? "Equipe 1" : "Equipe 2"})`,
        created_by: actor,
      } as any);

      // Update stock quantity
      await supabase.from("stock_items").update({
        quantity: item.quantity - toConsume,
        updated_by: actor,
      } as any).eq("id", item.id);
    }

    // Update ship status
    if (currentShip.status === "AGENDADO") {
      await supabase.from("ships").update({ status: "EM_OPERACAO" } as any).eq("id", selectedShip);
    }

    setEmbarking(false);
    setConfirmEmbark(false);
    loadData();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-2">
          <span className="text-4xl animate-bounce">🚢</span>
          <span className="text-sm text-text-light animate-pulse">Carregando embarque...</span>
        </div>
      </div>
    );
  }

  if (ships.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-text">Embarque</h1>
        <div className="bg-card rounded-xl shadow-sm border border-border p-8 text-center text-text-light">
          <span className="text-4xl block mb-3">🚢</span>
          <p className="font-medium text-text mb-1">Nenhum navio agendado ou em operação</p>
          <p className="text-sm">Cadastre navios na aba <strong>Navios</strong> para preparar embarques.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-text">Embarque</h1>

      {/* Ship selector + Team selector */}
      <div className="bg-card rounded-xl shadow-sm border border-border p-4">
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="flex-1">
            <label className="block text-xs font-semibold text-text-light uppercase tracking-wider mb-1">Navio</label>
            <select
              value={selectedShip}
              onChange={(e) => setSelectedShip(e.target.value)}
              className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
            >
              {ships.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {s.port || "Sem porto"} ({s.status === "AGENDADO" ? "Agendado" : "Em Operação"})
                </option>
              ))}
            </select>
          </div>

          <div className="w-full sm:w-48">
            <label className="block text-xs font-semibold text-text-light uppercase tracking-wider mb-1">Equipe</label>
            <select
              value={selectedTeam}
              onChange={(e) => setSelectedTeam(e.target.value as "EQUIPE_1" | "EQUIPE_2")}
              className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
            >
              <option value="EQUIPE_1">Equipe 1</option>
              <option value="EQUIPE_2">Equipe 2</option>
            </select>
          </div>

          {currentShip && (
            <div className="flex gap-4 items-end text-sm">
              {currentShip.arrival_date && (
                <div>
                  <span className="text-text-light text-xs">Chegada:</span>
                  <p className="font-medium">{formatDate(currentShip.arrival_date)}</p>
                </div>
              )}
              {currentShip.departure_date && (
                <div>
                  <span className="text-text-light text-xs">Saída:</span>
                  <p className="font-medium">{formatDate(currentShip.departure_date)}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Summary bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <span className={`text-sm font-bold px-3 py-1.5 rounded-full ${
            allReady ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
          }`}>
            {pct}% pronto
          </span>
          <span className="text-xs text-text-light">
            {readyCount} prontos · {missingCount} com falta · {totalCurrent}/{totalDefault} itens
          </span>
        </div>
        {canEmbarcar && teamItems.length > 0 && (
          <Button size="sm" variant="warning" onClick={() => setConfirmEmbark(true)}>
            ⚓ Embarcar {selectedTeam === "EQUIPE_1" ? "Equipe 1" : "Equipe 2"}
          </Button>
        )}
      </div>

      {/* Stock items table */}
      <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-text-light uppercase">Item</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Categoria</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Padrão</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Em Estoque</th>
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

      {/* Confirm Embarque */}
      <ConfirmDialog
        open={confirmEmbark}
        onClose={() => setConfirmEmbark(false)}
        onConfirm={handleEmbarcar}
        title="Confirmar Embarque"
        message={`Embarcar ${selectedTeam === "EQUIPE_1" ? "Equipe 1" : "Equipe 2"} no navio "${currentShip?.name}"? As quantidades padrão serão retiradas do estoque desta equipe.`}
        confirmLabel="⚓ Confirmar Embarque"
        variant="warning"
        loading={embarking}
      />
    </div>
  );
}
