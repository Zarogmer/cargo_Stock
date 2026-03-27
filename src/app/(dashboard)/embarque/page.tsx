"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase-browser";
import { hasPermission } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatDate } from "@/lib/utils";
import { PlusIcon } from "@/components/icons";
import type { StockItem, Employee } from "@/types/database";

interface Ship {
  id: string;
  name: string;
  arrival_date: string | null;
  departure_date: string | null;
  port: string | null;
  status: string;
  notes: string | null;
}

interface EmbarqueItem {
  id: string;
  ship_id: string;
  stock_item_id: number;
  item_name: string;
  required_qty: number;
  consumed: boolean;
  created_by: string;
  created_at: string;
}

export default function EmbarquePage() {
  const { profile } = useAuth();
  const supabaseRef = useRef(createClient());
  const supabase = supabaseRef.current;
  const role = profile?.role || "RH";
  const canEmbarcar = hasPermission(role, "EMBARQUE", "embarcar");

  const [ships, setShips] = useState<Ship[]>([]);
  const [selectedShip, setSelectedShip] = useState<string>("");
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [embarqueItems, setEmbarqueItems] = useState<EmbarqueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddItem, setShowAddItem] = useState(false);
  const [confirmEmbark, setConfirmEmbark] = useState(false);
  const [embarking, setEmbarking] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [shipsRes, stockRes, empRes] = await Promise.all([
        supabase.from("ships").select("*").in("status", ["AGENDADO", "EM_OPERACAO"]).order("arrival_date"),
        supabase.from("stock_items").select("*").order("name"),
        supabase.from("employees").select("*").order("name"),
      ]);
      setShips((shipsRes.data as Ship[]) || []);
      setStockItems(stockRes.data || []);
      setEmployees(empRes.data || []);
    } catch (err) {
      console.error("Load error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load embarque items for selected ship
  const loadEmbarqueItems = useCallback(async (shipId: string) => {
    if (!shipId) { setEmbarqueItems([]); return; }
    const { data } = await supabase.from("embarque_items").select("*").eq("ship_id", shipId).order("created_at");
    setEmbarqueItems((data as EmbarqueItem[]) || []);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { if (selectedShip) loadEmbarqueItems(selectedShip); }, [selectedShip, loadEmbarqueItems]);

  // Auto-select first ship
  useEffect(() => {
    if (ships.length > 0 && !selectedShip) {
      setSelectedShip(ships[0].id);
    }
  }, [ships, selectedShip]);

  const currentShip = ships.find((s) => s.id === selectedShip);

  // Get team members assigned to ship
  const shipTeam = employees.filter((e) => {
    if (!currentShip) return false;
    return e.team === "EQUIPE_1" || e.team === "EQUIPE_2";
  });

  async function handleAddItem(stockItemId: number, qty: number) {
    setSaving(true);
    const stockItem = stockItems.find((s) => s.id === stockItemId);
    await supabase.from("embarque_items").insert({
      ship_id: selectedShip,
      stock_item_id: stockItemId,
      item_name: stockItem?.name || "—",
      required_qty: qty,
      consumed: false,
      created_by: profile?.full_name || "Sistema",
    } as any);
    setSaving(false);
    setShowAddItem(false);
    loadEmbarqueItems(selectedShip);
  }

  async function handleRemoveItem(itemId: string) {
    await supabase.from("embarque_items").delete().eq("id", itemId);
    loadEmbarqueItems(selectedShip);
  }

  async function handleEmbarcar() {
    setEmbarking(true);
    const actor = profile?.full_name || "Sistema";

    for (const item of embarqueItems.filter((i) => !i.consumed)) {
      const stockItem = stockItems.find((s) => s.id === item.stock_item_id);
      if (stockItem && stockItem.quantity > 0) {
        const consumed = Math.min(stockItem.quantity, item.required_qty);

        await supabase.from("stock_movements").insert({
          stock_item_id: stockItem.id,
          movement_type: "BAIXA",
          quantity: consumed,
          movement_date: new Date().toISOString().split("T")[0],
          notes: `Embarque: ${currentShip?.name || "—"}`,
          created_by: actor,
        } as any);

        await supabase.from("stock_items").update({
          quantity: stockItem.quantity - consumed,
          updated_by: actor,
        } as any).eq("id", stockItem.id);

        await supabase.from("embarque_items").update({ consumed: true } as any).eq("id", item.id);
      }
    }

    // Update ship status to EM_OPERACAO
    if (currentShip?.status === "AGENDADO") {
      await supabase.from("ships").update({ status: "EM_OPERACAO" } as any).eq("id", selectedShip);
    }

    setEmbarking(false);
    setConfirmEmbark(false);
    loadData();
    loadEmbarqueItems(selectedShip);
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
          <p className="text-sm">Cadastre navios na aba <strong>Navios</strong> com status &quot;Agendado&quot; ou &quot;Em Operação&quot; para preparar embarques.</p>
        </div>
      </div>
    );
  }

  const totalItems = embarqueItems.length;
  const consumedItems = embarqueItems.filter((i) => i.consumed).length;
  const pendingItems = totalItems - consumedItems;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text">Embarque</h1>
      </div>

      {/* Ship selector */}
      <div className="bg-card rounded-xl shadow-sm border border-border p-4">
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center">
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

          {currentShip && (
            <div className="flex gap-4 text-sm">
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

      {/* Summary + Actions */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium px-3 py-1 rounded-full ${
            pendingItems === 0 && totalItems > 0 ? "bg-green-100 text-green-700" :
            totalItems === 0 ? "bg-gray-100 text-gray-600" :
            "bg-amber-100 text-amber-700"
          }`}>
            {totalItems === 0 ? "Nenhum item" : pendingItems === 0 ? "Todos embarcados" : `${pendingItems} itens pendentes`}
          </span>
          <span className="text-xs text-text-light">{consumedItems}/{totalItems} embarcados</span>
        </div>
        <div className="flex gap-2">
          {canEmbarcar && (
            <>
              <Button size="sm" onClick={() => setShowAddItem(true)}>
                <PlusIcon className="w-4 h-4" />Adicionar Item
              </Button>
              {pendingItems > 0 && (
                <Button size="sm" variant="warning" onClick={() => setConfirmEmbark(true)}>
                  ⚓ Confirmar Embarque
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Items table */}
      <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-border">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-text-light uppercase">Item</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Necessário</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Em Estoque</th>
                <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">Status</th>
                {canEmbarcar && <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase w-16"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {embarqueItems.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-text-light">
                    <span className="text-3xl block mb-2">📦</span>
                    Nenhum item adicionado ao embarque
                  </td>
                </tr>
              ) : (
                embarqueItems.map((item) => {
                  const stockItem = stockItems.find((s) => s.id === item.stock_item_id);
                  const currentQty = stockItem?.quantity || 0;
                  const missing = item.consumed ? 0 : Math.max(0, item.required_qty - currentQty);
                  return (
                    <tr key={item.id} className={`hover:bg-gray-50 ${item.consumed ? "opacity-50" : missing > 0 ? "bg-red-50/50" : ""}`}>
                      <td className="px-4 py-3 font-medium">{item.item_name}</td>
                      <td className="px-4 py-3 text-center">{item.required_qty}</td>
                      <td className="px-4 py-3 text-center font-semibold">{item.consumed ? "—" : currentQty}</td>
                      <td className="px-4 py-3 text-center">
                        {item.consumed ? (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">Embarcado</span>
                        ) : missing > 0 ? (
                          <span className="text-danger font-bold text-xs">Faltam {missing}</span>
                        ) : (
                          <span className="text-success text-xs">✓ Pronto</span>
                        )}
                      </td>
                      {canEmbarcar && (
                        <td className="px-4 py-3 text-center">
                          {!item.consumed && (
                            <button onClick={() => handleRemoveItem(item.id)} className="text-xs text-red-500 hover:text-red-700">✕</button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Team assigned */}
      {shipTeam.length > 0 && (
        <div className="bg-card rounded-xl shadow-sm border border-border p-4">
          <h3 className="font-semibold text-text text-sm mb-3">Equipe Disponível</h3>
          <div className="flex flex-wrap gap-2">
            {shipTeam.map((e) => (
              <span key={e.id} className={`text-xs px-3 py-1.5 rounded-full font-medium ${
                e.team === "EQUIPE_1" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
              }`}>
                {e.name} ({e.team === "EQUIPE_1" ? "E1" : "E2"})
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Add Item Modal */}
      <AddItemModal
        open={showAddItem}
        onClose={() => setShowAddItem(false)}
        stockItems={stockItems}
        onAdd={handleAddItem}
        saving={saving}
      />

      {/* Confirm Embarque */}
      <ConfirmDialog
        open={confirmEmbark}
        onClose={() => setConfirmEmbark(false)}
        onConfirm={handleEmbarcar}
        title="Confirmar Embarque"
        message={`Deseja confirmar o embarque para "${currentShip?.name}"? Os ${pendingItems} itens pendentes serão consumidos do estoque.`}
        confirmLabel="⚓ Embarcar"
        variant="warning"
        loading={embarking}
      />
    </div>
  );
}

function AddItemModal({ open, onClose, stockItems, onAdd, saving }: {
  open: boolean; onClose: () => void; stockItems: StockItem[]; onAdd: (id: number, qty: number) => void; saving: boolean;
}) {
  const [selectedItem, setSelectedItem] = useState<number>(0);
  const [qty, setQty] = useState(1);
  const [search, setSearch] = useState("");

  useEffect(() => { setSelectedItem(0); setQty(1); setSearch(""); }, [open]);

  const filtered = stockItems.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Modal open={open} onClose={onClose} title="Adicionar Item ao Embarque">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Buscar produto</label>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar no estoque..."
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
          />
        </div>

        <div className="max-h-48 overflow-y-auto border border-border rounded-lg divide-y divide-border">
          {filtered.length === 0 ? (
            <p className="p-3 text-sm text-text-light text-center">Nenhum item encontrado</p>
          ) : (
            filtered.map((s) => (
              <button
                key={s.id}
                onClick={() => setSelectedItem(s.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 text-sm hover:bg-blue-50 transition ${
                  selectedItem === s.id ? "bg-blue-50 border-l-2 border-primary" : ""
                }`}
              >
                <span className="font-medium">{s.name}</span>
                <span className="text-text-light text-xs">Qtd: {s.quantity}</span>
              </button>
            ))
          )}
        </div>

        {selectedItem > 0 && (
          <div>
            <label className="block text-sm font-medium mb-1">Quantidade</label>
            <input
              type="number"
              value={qty}
              onChange={(e) => setQty(Number(e.target.value))}
              min={1}
              className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
            />
          </div>
        )}

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => onAdd(selectedItem, qty)} disabled={saving || selectedItem === 0}>
            {saving ? "Adicionando..." : "Adicionar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
