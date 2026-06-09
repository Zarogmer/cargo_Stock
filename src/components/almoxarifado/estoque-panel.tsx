"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { formatDate, formatDateTime, matchSearch, parseDecimalBR, formatQty, buildCodeMap, unitSuffix } from "@/lib/utils";
import type { StockItem } from "@/types/database";

const STOCK_CATEGORIES = [
  { value: "SUPRIMENTOS", label: "Suprimentos" },
  { value: "CARNE", label: "Carne" },
  { value: "FEIRA", label: "Feira" },
];

// Unidades de medida do rancho. Carne normalmente é KG (peso), o resto varia
// (un, fardo, litro, caixa, pacote, dúzia, saco).
const STOCK_UNITS = [
  { value: "UN", label: "Unidade (un)" },
  { value: "KG", label: "Quilograma (kg)" },
  { value: "FARDO", label: "Fardo" },
  { value: "L", label: "Litro (L)" },
  { value: "CX", label: "Caixa (cx)" },
  { value: "PCT", label: "Pacote (pct)" },
  { value: "DZ", label: "Dúzia (dz)" },
  { value: "SACO", label: "Saco" },
];

// Painel de Rancho (comida/suprimentos por equipe, stock_items filtrados por
// EQUIPE_1/2/3) — corpo da antiga página /estoque, hoje renderizado como a aba
// "Rancho" do Almoxarifado. (O nome do componente segue EstoquePanel por
// histórico; a aba "Estoque" agora é o MateriaisPanel.)
export function EstoquePanel() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("TODOS");
  const [activeTeam, setActiveTeam] = useState<"EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3">("EQUIPE_1");
  const [editItem, setEditItem] = useState<StockItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showBaixa, setShowBaixa] = useState(false);
  const [baixaItem, setBaixaItem] = useState<StockItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<StockItem | null>(null);
  const [saving, setSaving] = useState(false);
  const [showPreparar, setShowPreparar] = useState(false);
  const [preparing, setPreparing] = useState(false);

  const role = profile?.role || "RH";
  const canCreate = hasPermission(role, "ESTOQUE", "create");
  const canEdit = hasPermission(role, "ESTOQUE", "edit");
  const canDelete = hasPermission(role, "ESTOQUE", "delete");
  const canBaixar = hasPermission(role, "ESTOQUE", "baixar");

  const loadItems = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      const { data, error } = await db
        .from("stock_items")
        .select("*")
        .order("updated_at", { ascending: false });
      if (error) {
        console.error("DB stock_items error:", error);
        setDbError(`${error.code}: ${error.message} — ${error.hint || ""}`);
      }
      setItems(data || []);
    } catch (err) {
      console.error("Erro ao carregar estoque:", err);
      setDbError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadItems();
  }, [loadItems, pathname]);

  // Código derivado do nome (prefixo de iniciais + sequência), por item.
  const codeMap = useMemo(() => buildCodeMap(items, (i) => i.id, (i) => i.name), [items]);

  const filteredItems = items.filter((i) => {
    const matchesSearch =
      matchSearch(i.name, search) ||
      matchSearch(codeMap.get(i.id) || "", search);
    const matchesCategory =
      filterCategory === "TODOS" || i.category === filterCategory;
    const matchesTeam = i.team === activeTeam;
    return matchesSearch && matchesCategory && matchesTeam;
  });

  // Itens cadastrados na Reserva (ex-Equipe 3) — base do botão "Preparar".
  const reservaCount = items.filter((i) => i.team === "EQUIPE_3").length;

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
    const payload = { ...formData, updated_by: actor, team: activeTeam } as Record<string, unknown>;

    if (editItem) {
      await db.from("stock_items").update(payload).eq("id", editItem.id);
    } else {
      await db.from("stock_items").insert(payload);
    }

    setSaving(false);
    setShowForm(false);
    setEditItem(null);
    loadItems();
  }

  async function handleDelete() {
    if (!deleteItem) return;
    setSaving(true);
    await db.from("stock_items").delete().eq("id", deleteItem.id);
    setSaving(false);
    setDeleteItem(null);
    loadItems();
  }

  async function handleBaixa(qty: number, notes: string) {
    if (!baixaItem) return;
    setSaving(true);
    const actor = profile?.full_name || "Sistema";

    await db.from("stock_movements").insert({
      stock_item_id: baixaItem.id,
      movement_type: "BAIXA",
      quantity: qty,
      movement_date: new Date().toISOString().split("T")[0],
      notes,
      created_by: actor,
    } as Record<string, unknown>);

    await db
      .from("stock_items")
      .update({ quantity: Math.round((baixaItem.quantity - qty) * 1000) / 1000, updated_by: actor } as Record<string, unknown>)
      .eq("id", baixaItem.id);

    setSaving(false);
    setShowBaixa(false);
    setBaixaItem(null);
    loadItems();
  }

  // "Preparar": copia os itens da Reserva (EQUIPE_3) para a equipe escolhida,
  // usando a quantidade padrão de cada um (a qtd de suprimentos é sempre a mesma).
  // Casa por nome: item existente na equipe é atualizado; o que falta é criado.
  async function handlePreparar(targetTeam: "EQUIPE_1" | "EQUIPE_2") {
    setPreparing(true);
    const actor = profile?.full_name || "Sistema";
    const reservaItems = items.filter((i) => i.team === "EQUIPE_3");
    const destItems = items.filter((i) => i.team === targetTeam);
    const norm = (s: string) => (s || "").trim().toLowerCase();
    for (const it of reservaItems) {
      const qty = it.default_quantity || 0;
      const existing = destItems.find((d) => norm(d.name) === norm(it.name));
      const payload = {
        name: it.name,
        category: it.category,
        unit: it.unit,
        quantity: qty,
        default_quantity: it.default_quantity,
        min_quantity: 0,
        team: targetTeam,
        updated_by: actor,
      } as Record<string, unknown>;
      if (existing) {
        await db.from("stock_items").update(payload).eq("id", existing.id);
      } else {
        await db.from("stock_items").insert(payload);
      }
    }
    setPreparing(false);
    setShowPreparar(false);
    loadItems();
  }

  const columns = [
    {
      key: "name",
      label: "Nome",
      render: (i: StockItem) => <span className="font-medium">{i.name}</span>,
    },
    {
      key: "code",
      label: "Código",
      render: (i: StockItem) => <span className="font-mono text-xs text-text-light">{codeMap.get(i.id) || "—"}</span>,
    },
    {
      key: "category",
      label: "Categoria",
      render: (i: StockItem) => (
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${getCategoryColor(i.category)}`}>
          {getCategoryLabel(i.category)}
        </span>
      ),
    },
    {
      key: "default_quantity",
      label: "Padrão",
      render: (i: StockItem) => (
        <span className="text-text-light">{i.default_quantity ? `${formatQty(i.default_quantity)} ${unitSuffix(i.unit)}` : "—"}</span>
      ),
    },
    {
      key: "quantity",
      label: "Qtd",
      render: (i: StockItem) => {
        const def = i.default_quantity || 0;
        const isLow = def > 0 && i.quantity < def * 0.5;
        const isEmpty = i.quantity <= 0;
        return (
          <span className={`font-semibold ${isEmpty ? "text-danger" : isLow ? "text-amber-500" : "text-success"}`}>
            {formatQty(i.quantity)} <span className="text-xs font-normal text-text-light">{unitSuffix(i.unit)}</span>
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
        <span className="text-text-light text-xs">{formatDateTime(i.updated_at)}</span>
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
              onClick={(e) => { e.stopPropagation(); setBaixaItem(i); setShowBaixa(true); }}
              className="p-1.5 text-amber-600 hover:bg-amber-50 rounded"
              title="Baixar"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </button>
          )}
          {canEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); setEditItem(i); setShowForm(true); }}
              className="p-1.5 text-primary hover:bg-blue-50 rounded"
              title="Editar"
            >
              <EditIcon />
            </button>
          )}
          {canDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); setDeleteItem(i); }}
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
      {dbError && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 font-mono break-all">
          ⚠️ Erro ao carregar dados: {dbError}
        </div>
      )}

      {/* Team selector */}
      <div className="flex gap-2">
        <button
          onClick={() => setActiveTeam("EQUIPE_1")}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${activeTeam === "EQUIPE_1" ? "bg-blue-600 text-white shadow-md" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
        >
          🚢 Equipe 1
        </button>
        <button
          onClick={() => setActiveTeam("EQUIPE_2")}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${activeTeam === "EQUIPE_2" ? "bg-purple-600 text-white shadow-md" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
        >
          🚢 Equipe 2
        </button>
        <button
          onClick={() => setActiveTeam("EQUIPE_3")}
          className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${activeTeam === "EQUIPE_3" ? "bg-teal-600 text-white shadow-md" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
        >
          📦 Reserva
        </button>
      </div>

      {/* Category filter */}
      <div className="flex flex-wrap gap-2">
        {[{ value: "TODOS", label: "Todos" }, ...STOCK_CATEGORIES].map((cat) => (
          <button
            key={cat.value}
            onClick={() => setFilterCategory(cat.value)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition ${filterCategory === cat.value ? "bg-primary text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      <DataTable
        columns={columns}
        data={filteredItems}
        loading={loading}
        keyExtractor={(i) => i.id}
        emptyMessage="Nenhum item encontrado"
        mobileCards
        onRowClick={canEdit ? (i) => { setEditItem(i); setShowForm(true); } : undefined}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por nome ou código..."
        actions={
          <div className="flex items-center gap-2">
            {activeTeam === "EQUIPE_3" && canCreate && (
              <Button variant="secondary" size="sm" onClick={() => setShowPreparar(true)} disabled={reservaCount === 0}>
                📦 Preparar
              </Button>
            )}
            {canCreate && (
              <Button onClick={() => { setEditItem(null); setShowForm(true); }} size="sm">
                <PlusIcon className="w-4 h-4" />
                Adicionar
              </Button>
            )}
          </div>
        }
      />

      <StockFormModal
        open={showForm}
        onClose={() => { setShowForm(false); setEditItem(null); }}
        onSave={handleSave}
        item={editItem}
        saving={saving}
      />

      <BaixaModal
        open={showBaixa}
        onClose={() => { setShowBaixa(false); setBaixaItem(null); }}
        onConfirm={handleBaixa}
        item={baixaItem}
        saving={saving}
      />

      <PrepararModal
        open={showPreparar}
        onClose={() => setShowPreparar(false)}
        onConfirm={handlePreparar}
        count={reservaCount}
        saving={preparing}
      />

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

function StockFormModal({ open, onClose, onSave, item, saving }: {
  open: boolean;
  onClose: () => void;
  onSave: (data: Partial<StockItem>) => void;
  item: StockItem | null;
  saving: boolean;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("SUPRIMENTOS");
  const [unit, setUnit] = useState("UN");
  // Strings para aceitar vírgula (ex.: "1,5"); convertidas no submit.
  const [quantity, setQuantity] = useState("");
  const [defaultQuantity, setDefaultQuantity] = useState("");
  const [expiryDate, setExpiryDate] = useState("");

  useEffect(() => {
    if (item) {
      setName(item.name);
      setCategory(item.category);
      setUnit(item.unit || "UN");
      setQuantity(formatQty(item.quantity));
      setDefaultQuantity(item.default_quantity ? formatQty(item.default_quantity) : "");
      setExpiryDate(item.expiry_date || "");
    } else {
      setName("");
      setCategory("SUPRIMENTOS");
      setUnit("UN");
      setQuantity("");
      setDefaultQuantity("");
      setExpiryDate("");
    }
  }, [item, open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name,
      category: category as StockItem["category"],
      unit,
      quantity: parseDecimalBR(quantity),
      default_quantity: parseDecimalBR(defaultQuantity),
      expiry_date: expiryDate || null,
      min_quantity: 0,
    });
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Item" : "Novo Item"}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-text mb-1">Nome *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-text mb-1">Categoria</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
            {STOCK_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-text mb-1">Unidade de medida</label>
          <select value={unit} onChange={(e) => setUnit(e.target.value)} className={inputCls}>
            {STOCK_UNITS.map((u) => (
              <option key={u.value} value={u.value}>{u.label}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-text mb-1">Qtd Padrão</label>
            <input type="text" inputMode="decimal" value={defaultQuantity} onChange={(e) => setDefaultQuantity(e.target.value)} placeholder="Ex: 10 ou 1,5" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium text-text mb-1">Qtd Atual</label>
            <input type="text" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Ex: 1,5" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium text-text mb-1">Validade</label>
            <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function BaixaModal({ open, onClose, onConfirm, item, saving }: {
  open: boolean;
  onClose: () => void;
  onConfirm: (qty: number, notes: string) => void;
  item: StockItem | null;
  saving: boolean;
}) {
  const [qty, setQty] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => { setQty(""); setNotes(""); }, [open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onConfirm(parseDecimalBR(qty), notes);
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";

  return (
    <Modal open={open} onClose={onClose} title="Baixar Rancho">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-text-light">
          Item: <strong>{item?.name}</strong> (disponível: {formatQty(item?.quantity)})
        </p>
        <div>
          <label className="block text-sm font-medium text-text mb-1">Quantidade *</label>
          <input type="text" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Ex: 1,5" required className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-text mb-1">Observações</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${inputCls} resize-none`} />
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button variant="warning" type="submit" disabled={saving}>{saving ? "Registrando..." : "Confirmar Baixa"}</Button>
        </div>
      </form>
    </Modal>
  );
}

// Modal do botão "Preparar" da Reserva: escolhe a equipe destino (1 ou 2) e
// copia os itens da Reserva com a quantidade padrão.
function PrepararModal({ open, onClose, onConfirm, count, saving }: {
  open: boolean;
  onClose: () => void;
  onConfirm: (team: "EQUIPE_1" | "EQUIPE_2") => void;
  count: number;
  saving: boolean;
}) {
  const [team, setTeam] = useState<"EQUIPE_1" | "EQUIPE_2">("EQUIPE_1");

  useEffect(() => { if (open) setTeam("EQUIPE_1"); }, [open]);

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";

  return (
    <Modal open={open} onClose={onClose} title="Preparar suprimentos da Reserva">
      <div className="space-y-4">
        <p className="text-sm text-text-light">
          Copia os <strong>{count}</strong> {count === 1 ? "item" : "itens"} da Reserva para a equipe escolhida,
          usando a <strong>quantidade padrão</strong> de cada um. Itens com o mesmo nome na equipe são atualizados;
          os que faltam são criados.
        </p>
        <div>
          <label className="block text-sm font-medium text-text mb-1">Equipe destino</label>
          <select value={team} onChange={(e) => setTeam(e.target.value as "EQUIPE_1" | "EQUIPE_2")} className={inputCls}>
            <option value="EQUIPE_1">Equipe 1</option>
            <option value="EQUIPE_2">Equipe 2</option>
          </select>
        </div>
        <div className="flex gap-3 justify-end pt-2">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="button" onClick={() => onConfirm(team)} disabled={saving || count === 0}>
            {saving ? "Preparando..." : "Preparar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
