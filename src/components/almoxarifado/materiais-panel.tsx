"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission, type Module } from "@/lib/rbac";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ImagePicker, ImageLightbox } from "@/components/ui/image-picker";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { formatDateTime, matchSearch, parseDecimalBR, formatQty, buildCodeMap } from "@/lib/utils";
import type { StockItem } from "@/types/database";

// Inventário genérico do Almoxarifado: itens com QUANTIDADE, mínimo, baixa (⬇️) e
// foto. Reaproveita a tabela `stock_items` usando o campo `team` como sentinela
// pra separar cada setor:
//   GALPAO     → aba "Estoque" (materiais do galpão)
//   FERRAMENTA → aba "Ferramenta"
//   ELETRICA   → aba "Elétrica"
// (Rancho usa EQUIPE_1/2/3 e o Embarque filtra por equipe — todos ignoram estes
// sentinelas.) O grupo/categoria do item fica em `location`; `category` é sempre
// OUTROS (enum fixo, não usado aqui). Maquinário NÃO usa este painel — é
// empréstimo por equipe (tabela `tools`, ToolsPanel).
export type InventoryKind = "GALPAO" | "FERRAMENTA" | "ELETRICA";

interface KindConfig {
  module: Module;
  singular: string;        // "Material", "Ferramenta", "Elétrica"
  newTitle: string;
  editTitle: string;
  emptyMsg: string;
  searchPlaceholder: string;
  groups: string[];        // sugestões de categoria (datalist)
}

// Grupos conhecidos por setor. O campo aceita texto livre via datalist, então
// novas categorias podem ser criadas na hora.
const STOCK_GROUPS = [
  "Elétrica", "EPI e Químicos", "Hidrojato", "Pistola e Caneta", "Rodas",
  "Líquidos", "Ferramentas", "Mangueiras e Conexões", "Varões", "Cozinha", "Outros",
];

const KIND_CONFIG: Record<InventoryKind, KindConfig> = {
  GALPAO: {
    module: "ESTOQUE", singular: "Material", newTitle: "Novo Material", editTitle: "Editar Material",
    emptyMsg: "Nenhum material encontrado", searchPlaceholder: "Buscar por nome ou código...", groups: STOCK_GROUPS,
  },
  FERRAMENTA: {
    module: "FERRAMENTAS", singular: "Ferramenta", newTitle: "Nova Ferramenta", editTitle: "Editar Ferramenta",
    emptyMsg: "Nenhuma ferramenta encontrada", searchPlaceholder: "Buscar ferramenta...", groups: ["Manual", "Elétrica", "Medição", "Corte", "Outros"],
  },
  ELETRICA: {
    module: "ELETRICA", singular: "Item elétrico", newTitle: "Novo item elétrico", editTitle: "Editar item elétrico",
    emptyMsg: "Nenhum item encontrado", searchPlaceholder: "Buscar item elétrico...", groups: ["Cabos", "Conectores", "Disjuntores", "Lâmpadas", "Tomadas", "Outros"],
  },
};

export function StockInventoryPanel({ kind }: { kind: InventoryKind }) {
  const cfg = KIND_CONFIG[kind];
  const TEAM = kind; // o sentinela em stock_items.team é o próprio kind
  const { profile } = useAuth();
  const pathname = usePathname();
  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dbError, setDbError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [editItem, setEditItem] = useState<StockItem | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showBaixa, setShowBaixa] = useState(false);
  const [baixaItem, setBaixaItem] = useState<StockItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<StockItem | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const role = profile?.role || "RH";
  const canCreate = hasPermission(role, cfg.module, "create");
  const canEdit = hasPermission(role, cfg.module, "edit");
  const canDelete = hasPermission(role, cfg.module, "delete");
  const canBaixar = hasPermission(role, cfg.module, "baixar");

  const loadItems = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      const { data, error } = await db
        .from("stock_items")
        .select("*")
        .eq("team", TEAM)
        .order("name", { ascending: true });
      if (error) {
        console.error("DB stock_items error:", error);
        setDbError(`${error.code}: ${error.message} — ${error.hint || ""}`);
      }
      setItems(data || []);
    } catch (err) {
      console.error("Erro ao carregar itens:", err);
      setDbError(String(err));
    } finally {
      setLoading(false);
    }
  }, [TEAM]);

  useEffect(() => {
    loadItems();
  }, [loadItems, pathname]);

  // Código derivado do nome (prefixo de iniciais + sequência), por item.
  const codeMap = useMemo(() => buildCodeMap(items, (i) => i.id, (i) => i.name), [items]);

  // Categorias (grupos) presentes nos dados — usadas só como sugestões (datalist)
  // no formulário; o filtro por categoria foi removido (cada setor já é uma aba).
  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const i of items) set.add(i.location || "Outros");
    return [...set].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [items]);

  const filteredItems = items.filter((i) =>
    matchSearch(i.name, search) || matchSearch(codeMap.get(i.id) || "", search),
  );

  async function handleSave(formData: { name: string; location: string; quantity: number; min_quantity: number; image_url: string | null; notes: string | null }) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const payload = {
      name: formData.name,
      location: formData.location,
      quantity: formData.quantity,
      category: "OUTROS",
      team: TEAM,
      min_quantity: formData.min_quantity,
      image_url: formData.image_url,
      notes: formData.notes,
      updated_by: actor,
    } as Record<string, unknown>;

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

  const columns = [
    {
      key: "image",
      label: "",
      className: "w-12",
      render: (i: StockItem) => i.image_url ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); setLightbox(i.image_url); }} className="shrink-0" title="Ver foto">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={i.image_url} alt={i.name} className="w-9 h-9 rounded object-cover border border-border" />
        </button>
      ) : (
        <div className="w-9 h-9 rounded bg-gray-100 border border-border flex items-center justify-center text-text-light" title="Sem foto">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
        </div>
      ),
    },
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
      key: "location",
      label: "Categoria",
      render: (i: StockItem) => (
        <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
          {i.location || "Outros"}
        </span>
      ),
    },
    {
      key: "quantity",
      label: "Qtd",
      render: (i: StockItem) => {
        const belowMin = i.min_quantity > 0 && i.quantity < i.min_quantity;
        const isEmpty = i.quantity <= 0;
        return (
          <span className={`font-semibold ${isEmpty || belowMin ? "text-danger" : ""}`} title={belowMin ? `Abaixo do mínimo (${formatQty(i.min_quantity)})` : undefined}>
            {formatQty(i.quantity)}
          </span>
        );
      },
    },
    {
      key: "min_quantity",
      label: "Mín.",
      render: (i: StockItem) => (
        <span className="text-text-light text-sm">{i.min_quantity > 0 ? formatQty(i.min_quantity) : "—"}</span>
      ),
    },
    {
      key: "notes",
      label: "Obs",
      hideOnMobile: true,
      render: (i: StockItem) => i.notes ? (
        <span className="text-xs text-text-light max-w-[200px] truncate block" title={i.notes}>{i.notes}</span>
      ) : <span className="text-text-light">—</span>,
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

      <DataTable
        columns={columns}
        data={filteredItems}
        loading={loading}
        keyExtractor={(i) => i.id}
        emptyMessage={cfg.emptyMsg}
        mobileCards
        onRowClick={canEdit ? (i) => { setEditItem(i); setShowForm(true); } : undefined}
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder={cfg.searchPlaceholder}
        actions={canCreate ? (
          <Button onClick={() => { setEditItem(null); setShowForm(true); }} size="sm">
            <PlusIcon className="w-4 h-4" />
            Adicionar
          </Button>
        ) : undefined}
      />

      <MaterialFormModal
        open={showForm}
        onClose={() => { setShowForm(false); setEditItem(null); }}
        onSave={handleSave}
        item={editItem}
        groups={groups.length > 0 ? groups : cfg.groups}
        newTitle={cfg.newTitle}
        editTitle={cfg.editTitle}
        saving={saving}
      />

      <BaixaModal
        open={showBaixa}
        onClose={() => { setShowBaixa(false); setBaixaItem(null); }}
        onConfirm={handleBaixa}
        item={baixaItem}
        saving={saving}
      />

      <ConfirmDialog
        open={!!deleteItem}
        onClose={() => setDeleteItem(null)}
        onConfirm={handleDelete}
        title={`Excluir ${cfg.singular}`}
        message={`Tem certeza que deseja excluir "${deleteItem?.name}"?`}
        confirmLabel="Excluir"
        loading={saving}
      />

      <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}

function MaterialFormModal({ open, onClose, onSave, item, groups, newTitle, editTitle, saving }: {
  open: boolean;
  onClose: () => void;
  onSave: (data: { name: string; location: string; quantity: number; min_quantity: number; image_url: string | null; notes: string | null }) => void;
  item: StockItem | null;
  groups: string[];
  newTitle: string;
  editTitle: string;
  saving: boolean;
}) {
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  // Strings para aceitar vírgula (ex.: "1,5"); convertidas no submit.
  const [quantity, setQuantity] = useState("");
  const [minQuantity, setMinQuantity] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (item) {
      setName(item.name);
      setGroup(item.location || "");
      setQuantity(formatQty(item.quantity));
      setMinQuantity(item.min_quantity ? formatQty(item.min_quantity) : "");
      setImageUrl(item.image_url || null);
      setNotes(item.notes || "");
    } else {
      setName("");
      setGroup("");
      setQuantity("");
      setMinQuantity("");
      setImageUrl(null);
      setNotes("");
    }
  }, [item, open]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name,
      location: group.trim() || "Outros",
      quantity: parseDecimalBR(quantity),
      // Mínimo é inteiro (coluna Int); arredonda caso digitem decimal.
      min_quantity: Math.round(parseDecimalBR(minQuantity)),
      image_url: imageUrl,
      notes: notes.trim() || null,
    });
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary focus:border-transparent outline-none";

  return (
    <Modal open={open} onClose={onClose} title={item ? editTitle : newTitle}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-text mb-1">Nome *</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} />
        </div>
        <div>
          <label className="block text-sm font-medium text-text mb-1">Categoria</label>
          <input
            type="text"
            list="material-groups"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="Ex: Elétrica, Hidrojato, Cozinha..."
            className={inputCls}
          />
          <datalist id="material-groups">
            {groups.map((g) => <option key={g} value={g} />)}
          </datalist>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text mb-1">Qtd Atual</label>
            <input type="text" inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Ex: 8" className={inputCls} />
          </div>
          <div>
            <label className="block text-sm font-medium text-text mb-1">Qtd Mínima <span className="text-text-light font-normal">(opcional)</span></label>
            <input type="text" inputMode="numeric" value={minQuantity} onChange={(e) => setMinQuantity(e.target.value)} placeholder="0 = sem mínimo" className={inputCls} />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-text mb-1">Observações <span className="text-text-light font-normal">(opcional)</span></label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Ex: specs técnicas, localização..." className={`${inputCls} resize-none`} />
        </div>
        <ImagePicker value={imageUrl} onChange={setImageUrl} label="Foto do produto (opcional)" />
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
    <Modal open={open} onClose={onClose} title="Baixar item">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-text-light">
          Item: <strong>{item?.name}</strong> (disponível: {formatQty(item?.quantity)})
        </p>
        <div>
          <label className="block text-sm font-medium text-text mb-1">Quantidade *</label>
          <input type="text" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Ex: 2" required className={inputCls} />
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
