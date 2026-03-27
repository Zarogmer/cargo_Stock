"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase-browser";
import { hasPermission } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs } from "@/components/ui/tabs";
import type { MissionStandardItem, StockItem } from "@/types/database";

interface MissionRow {
  category: string;
  item_name: string;
  required_qty: number;
  current_qty: number;
  missing: number;
}

export default function EmbarquePage() {
  const { profile } = useAuth();
  const supabase = createClient();
  const [missionItems, setMissionItems] = useState<MissionStandardItem[]>([]);
  const [stockItems, setStockItems] = useState<StockItem[]>([]);
  const [embarks, setEmbarks] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmEmbark, setConfirmEmbark] = useState<string | null>(null);
  const [embarking, setEmbarking] = useState(false);

  const role = profile?.role || "RH";
  const canEmbarcar = hasPermission(role, "EMBARQUE", "embarcar");

  const loadData = useCallback(async () => {
    setLoading(true);
    const [missionRes, stockRes] = await Promise.all([
      supabase
        .from("mission_standard_items")
        .select("*")
        .order("display_order", { ascending: true }),
      supabase.from("stock_items").select("*"),
    ]);

    const missions = missionRes.data || [];
    const stock = stockRes.data || [];

    setMissionItems(missions);
    setStockItems(stock);

    const uniqueEmbarks = [...new Set(missions.map((m) => m.embark_name))];
    setEmbarks(uniqueEmbarks);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function getMissionRows(embarkName: string): MissionRow[] {
    const embarkMissions = missionItems.filter(
      (m) => m.embark_name === embarkName
    );
    return embarkMissions.map((m) => {
      const stockItem = stockItems.find(
        (s) => s.name.toLowerCase().trim() === m.name.toLowerCase().trim()
      );
      const currentQty = stockItem?.quantity || 0;
      return {
        category: m.category,
        item_name: m.name,
        required_qty: m.required_qty,
        current_qty: currentQty,
        missing: Math.max(0, m.required_qty - currentQty),
      };
    });
  }

  async function handleEmbarcar(embarkName: string) {
    setEmbarking(true);
    const actor = profile?.full_name || "Sistema";
    const rows = getMissionRows(embarkName);

    for (const row of rows) {
      const stockItem = stockItems.find(
        (s) => s.name.toLowerCase().trim() === row.item_name.toLowerCase().trim()
      );
      if (stockItem && stockItem.quantity > 0) {
        const consumed = Math.min(stockItem.quantity, row.required_qty);

        await supabase.from("stock_movements").insert({
          stock_item_id: stockItem.id,
          movement_type: "BAIXA",
          quantity: consumed,
          movement_date: new Date().toISOString().split("T")[0],
          notes: `Embarque: ${embarkName}`,
          created_by: actor,
        } as any);

        await supabase
          .from("stock_items")
          .update({ quantity: stockItem.quantity - consumed, updated_by: actor } as any)
          .eq("id", stockItem.id);
      }
    }

    setEmbarking(false);
    setConfirmEmbark(null);
    loadData();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <svg className="animate-spin h-8 w-8 text-primary" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  if (embarks.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-text">Embarque</h1>
        <div className="bg-card rounded-xl shadow-sm border border-border p-8 text-center text-text-light">
          Nenhuma missão cadastrada. Adicione itens na tabela
          &quot;mission_standard_items&quot; no Supabase.
        </div>
      </div>
    );
  }

  const tabs = embarks.map((embark) => {
    const rows = getMissionRows(embark);
    const totalMissing = rows.reduce((sum, r) => sum + r.missing, 0);

    return {
      key: embark,
      label: embark,
      content: (
        <div className="space-y-4">
          {/* Summary */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-center gap-4">
              <span
                className={`text-sm font-medium px-3 py-1 rounded-full ${
                  totalMissing === 0
                    ? "bg-green-100 text-green-700"
                    : "bg-red-100 text-red-700"
                }`}
              >
                {totalMissing === 0
                  ? "Completo"
                  : `${totalMissing} itens faltando`}
              </span>
            </div>
            {canEmbarcar && (
              <Button
                variant="warning"
                onClick={() => setConfirmEmbark(embark)}
              >
                Embarcar
              </Button>
            )}
          </div>

          {/* Table */}
          <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-border">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-text-light uppercase">
                      Categoria
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-text-light uppercase">
                      Item
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">
                      Necessário
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">
                      Atual
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-semibold text-text-light uppercase">
                      Faltando
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row, i) => (
                    <tr
                      key={i}
                      className={`hover:bg-gray-50 ${
                        row.missing > 0 ? "bg-red-50/50" : ""
                      }`}
                    >
                      <td className="px-4 py-3 text-text-light">
                        {row.category}
                      </td>
                      <td className="px-4 py-3 font-medium">{row.item_name}</td>
                      <td className="px-4 py-3 text-center">
                        {row.required_qty}
                      </td>
                      <td className="px-4 py-3 text-center font-semibold">
                        {row.current_qty}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {row.missing > 0 ? (
                          <span className="text-danger font-bold">
                            {row.missing}
                          </span>
                        ) : (
                          <span className="text-success">✓</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ),
    };
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-text">Embarque</h1>
      <Tabs tabs={tabs} />

      <ConfirmDialog
        open={!!confirmEmbark}
        onClose={() => setConfirmEmbark(null)}
        onConfirm={() => confirmEmbark && handleEmbarcar(confirmEmbark)}
        title="Confirmar Embarque"
        message={`Deseja confirmar o embarque "${confirmEmbark}"? Todos os itens disponíveis serão consumidos do estoque.`}
        confirmLabel="Embarcar"
        variant="warning"
        loading={embarking}
      />
    </div>
  );
}
