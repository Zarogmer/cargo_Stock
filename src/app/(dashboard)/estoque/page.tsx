"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase-browser";
import { hasPermission } from "@/lib/rbac";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import {
  formatDate,
  formatDateTime,
  matchSearch,
} from "@/lib/utils";
import type { StockItem } from "@/types/database";

const STOCK_CATEGORIES = [
  { value: "SUPRIMENTOS", label: "Suprimentos" },
  { value: "CARNE", label: "Carne" },
  { value: "FEIRA", label: "Feira" },
];

export default function EstoquePage() {
  const { profile } = useAuth();
  const supabase = createClient();
  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("TODOS");
  const [activeTeam, setActiveTeam] = useState<"EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3">("EQUIPE_1");
  const [editItem, setEditItem] = useState<StockItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showBaixa, setShowBaixa] = useState(false);
  const [baixaItem, setBaixaItem] = useState<StockItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<StockItem | null>(null);
  const [saving, setSaving] = useState(false);

  const role = profile?.role || "RH";
  const canCreate = hasPermission(role, "ESTOQUE", "create");
  const canEdit = hasPermission(role, "ESTOQUE", "edit");
  const canDelete = hasPermission(role, "ESTOQUE", "delete");
  const canBaixar = hasPermission(role, "ESTOQUE", "baixar");

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from("stock_items")
        .select("*")
        .order("updated_at", { ascending: false });
      setItems(data || []);
    } catch (err) {
      console.error("Erro ao carregar estoque:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const filteredItems = items.filter((i) => {
    const matchesSearch =
      matchSearch(i.name, search) ||
      matchSearch(i.location || "", search);
    const matchesCategory =
      filterCategory === "TODOS" || i.category === filterCategory;
    const matchesTeam = (i as any).team === activeTeam;
    return matchesSearch && matchesCategory && matchesTeam;
  });

  function getCategoryLabel(cat: string) {
    return STOCK_CATEGORIES.find((c) => c.value === cat)?.label || cat;
  }

  function getCategoryColor(cat: string) {
    switch (cat) {
      case "CARNE":
      case "CARNES":
        return "bg-red-100 text-red-700";
      case "FEIRA":
        return "bg-green-100 text-green-700";
      case "SUPRIMENTOS":
      case "OUTROS":
        return "bg-purple-100 text-purple-700";
      default:
        return "bg-blue-100 text-blue-700";
    }
  }

  async function handleSave(formData: Partial<StockItem>) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const payload = { ...formData, updated_by: actor, team: activeTeam } as any;

    if (editItem) {
      await supabase.from("stock_items").update(payload).eq("id", editItem.id);
    } else {
      await supabase.from("stock_items").insert(payload);
    }

    setSaving(false);
    setShowForm(false);
    setEditItem(null);
    loadItems();
  }

  async function handleDelete() {
    if (!deleteItem) return;
    setSaving(true);
    await supabase.from("stock_items").delete().eq("id", deleteItem.id);
    setSaving(false);
    setDeleteItem(null);
    loadItems();
  }

  async function handleBaixa(qty: number, notes: string) {
    if (!baixaItem) return;
    setSaving(true);
    const actor = profile?.full_name || "Sistema";

    await supabase.from("stock_movements").insert({
      stock_item_id: baixaItem.id,
      movement_type: "BAIXA",
      quantity: qty,
      movement_date: new Date().toISOString().split("T")[0],
      notes,
      created_by: actor,
    } as any);

    await supabase
      .from("stock_items")
      .update({ quantity: baixaItem.quantity - qty, updated_by: actor } as any)
      .eq("id", baixaItem.id);

    setSaving(false);
    setShowBaixa(false);
    setBaixaItem(null);
    loadItems();
  }

  const columns = [
    {
      key: "name",
      label: "Nome",
      render: (i: StockItem) => <span className="font-medium">{i.name}</span>,
    },
    {
      key: "category",
      label: "Categoria",
      render: (i: StockItem) => (
        <span
          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${getCategoryColor(i.category)}`}
        >
          {getCategoryLabel(i.category)}
        </span>
      ),
    },
    {
      key: "location",
      label: "Local",
      hideOnMobile: true,
      render: (i: StockItem) => i.location || "—",
    },
    {
      key: "default_quantity",
      label: "Padrão",
      render: (i: StockItem) => (
        <span className="text-text-light">{(i as any).default_quantity || "—"}</span>
      ),
    },
    {
      key: "quantity",
      label: "Qtd",
      render: (i: StockItem) => {
        const def = (i as any).default_quantity || 0;
        const isLow = def > 0 && i.quantity < def * 0.5;
        const isEmpty = i.quantity <= 0;
        return (
          <span className={`font-semibold ${isEmpty ? "text-danger" : isLow ? "text-amber-500" : "text-success"}`}>
            {i.quantity}
          </span>
        );
      },
    },
    {
      key: "expiry_date",
      label: "Validade",
      hideOnMobile: true,
      render: (i: StockItem) => formatDate(i.expiry_date),
    },
    {
      key: "updated_at",
      label: "Atualizado",
      hideOnMobile: true,
      render: (i: StockItem) => (
        <span className="text-text-light text-xs">
          {formatDateTime(i.updated_at)}
        </span>
      ),
    },
    {
      key: "actions",
      label: "",
      className: "w-24",
      render: (i: StockItem) => (
        <div className="flex items-center gap-1">
          {canBaixar && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setBaixaItem(i);
                setShowBaixa(true);
              }}
              className="p-1.5 text-amber-600 hover:bg-amber-50 rounded"
              title="Baixar"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 14l-7 7m0 0l-7-7m7 7V3"
                />
              </svg>
            </button>
          )}
          {canEdit && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setEditItem(i);
                setShowForm(true);
              }}
              className="p-1.5 text-primary hover:bg-blue-50 rounded"
              title="Editar"
            >
              <EditIcon />
            </button>
          )}
          {canDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setDeleteItem(i);
              }}
              className="p-1.5 text-danger hover:bg-red-50 rounded"
              title="Excluir"
            >
              <TrashIcon />
            </button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-text">Estoque</h1>

      {/* Team selector */}
      <div className="flex gap-2">
        <button
          onClick={() => setActiveTeam("EQUIPE_1")}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
            activeTeam === "EQUIPE_1"
              ? "bg-blue-600 text-white shadow-md"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          🚢 Equipe 1
        </button>
        <button
          onClick={() => setActiveTeam("EQUIPE_2")}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
            activeTeam === "EQUIPE_2"
              ? "bg-purple-600 text-white shadow-md"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          🚢 Equipe 2
        </button>
        <button
          onClick={() => setActiveTeam("EQUIPE_3")}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
            activeTeam === "EQUIPE_3"
              ? "bg-teal-600 text-white shadow-md"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200"
          }`}
        >
          🚢 Equipe 3
        </button>
      </div>

      {/* Category filter */}
      <div className="flex flex-wrap gap-2">
        {[{ value: "TODOS", label: "Todos" }, ...STOCK_CATEGORIES].map(
          (cat) => (
            <button
              key={cat.value}
              onClick={() => setFilterCategory(cat.value)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${
                filterCategory === cat.value
                  ? "bg-primary text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {cat.label}
            </button>
          )
        )}
      </div>

      <DataTable
        columns={columns}
        data={filteredItems}
        loading={loading}
        keyExtractor={(i) => i.id}
        emptyMessage="Nenhum item encontrado"
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por nome ou local..."
        actions={
          canCreate ? (
            <Button
              onClick={() => {
                setEditItem(null);
                setShowForm(true);
              }}
              size="sm"
            >
              <PlusIcon className="w-4 h-4" />
              Adicionar
            </Button>
          ) : undefined
        }
      />

      {/* Form Modal */}
      <StockFormModal
        open={showForm}
        onClose={() => {
          setShowForm(false);
          setEditItem(null);
        }}
        onSave={handleSave}
        item={editItem}
        saving={saving}
      />

      {/* Baixa Modal */}
      <BaixaModal
        open={showBaixa}
        onClose={() => {
          setShowBaixa(false);
          setBaixaItem(null);
        }}
        onConfirm={handleBaixa}
        item={baixaItem}
        saving={saving}
      />

      {/* Delete Confirm */}
      <ConfirmDialog
        open={!!deleteItem}
        onClose={() => setDeleteItem(null)}
        onConfirm={handleDelete}
        title="Excluir Item"
        message={`Tem certeza que deseja excluir "${deleteItem?.name}"?`}
        confirmLabel="Excluir"
        loading={saving}
      />
    </div>
  );
}

// ---------- Stock Form Modal ----------
function StockFormModal({
  open,
  onClose,
  onSave,
  item,
  saving,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<StockItem>) => void;
  item: StockItem | null;
  saving: boolean;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("SUPRIMENTOS");
  const [location, setLocation] = useState("");
  const [quantity, setQuantity] = useState(0);
  const [defaultQuantity, setDefaultQuantity] = useState(0);
  const [expiryDate, setExpiryDate] = useState("");

  useEffect(() => {
    if (item) {
      setName(item.name);
      setCategory(item.category);
      setLocation(item.location || "");
      setQuantity(item.quantity);
      setDefaultQuantity((item as any).default_quantity || 0);
      setExpiryDate(item.expiry_date || "");
    } else {
      setName("");
      setCategory("SUPRIMENTOS");
      setLocation("");
      setQuantity(0);
      setDefaultQuantity(0);
      setExpiryDate("");
    }
  }, [item, open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name,
      category: category as any,
      location: location || null,
      quantity,
      default_quantity: defaultQuantity,
      expiry_date: expiryDate || null,
      min_quantity: 0,
    } as any);
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={item ? "Editar Item" : "Novo Item"}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-text mb-1">
            Nome *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">
            Categoria
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
          >
            {STOCK_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">
            Local
          </label>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-text mb-1">
              Qtd Padrão
            </label>
            <input
              type="number"
              value={defaultQuantity}
              onChange={(e) => setDefaultQuantity(Number(e.target.value))}
              min={0}
              placeholder="Ex: 10"
              className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text mb-1">
              Qtd Atual
            </label>
            <input
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              min={0}
              className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text mb-1">
              Validade
            </label>
            <input
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
            />
          </div>
        </div>

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Baixa Modal ----------
function BaixaModal({
  open,
  onClose,
  onConfirm,
  item,
  saving,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (qty: number, notes: string) => void;
  item: StockItem | null;
  saving: boolean;
}) {
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    setQty(1);
    setNotes("");
  }, [open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onConfirm(qty, notes);
  }

  return (
    <Modal open={open} onClose={onClose} title="Baixar Estoque">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-text-light">
          Item: <strong>{item?.name}</strong> (disponível: {item?.quantity})
        </p>

        <div>
          <label className="block text-sm font-medium text-text mb-1">
            Quantidade *
          </label>
          <input
            type="number"
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
            min={1}
            max={item?.quantity || 1}
            required
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text mb-1">
            Observações
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none resize-none"
          />
        </div>

        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="warning" type="submit" disabled={saving}>
            {saving ? "Registrando..." : "Confirmar Baixa"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
