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
import { matchSearch, buildCodeMap } from "@/lib/utils";
import { MovementModal } from "./movement-modal";
import type { Employee, EpiMovementType } from "@/types/database";

// Painel genérico para EPI e Uniforme — ambos têm a mesma forma
// ({ id, name, size, stock_qty }) e o mesmo fluxo de entrega/devolução, então
// um único componente parametrizado cobre os dois. As permissões de ação usam
// o módulo EPI (era assim no Colaboradores também).
interface SimpleItem { id: number; name: string; size: string | null; stock_qty: number; min_quantity: number }

const CONFIG = {
  EPI: { table: "epis", movements: "epi_movements", fk: "epi_id", singular: "EPI", colLabel: "EPI", searchPlaceholder: "Buscar EPI...", newTitle: "Novo EPI", editTitle: "Editar EPI" },
  UNIFORME: { table: "uniforms", movements: "uniform_movements", fk: "uniform_id", singular: "Uniforme", colLabel: "Uniforme", searchPlaceholder: "Buscar uniforme...", newTitle: "Novo Uniforme", editTitle: "Editar Uniforme" },
} as const;

export function SimpleInventoryPanel({ kind }: { kind: "EPI" | "UNIFORME" }) {
  const cfg = CONFIG[kind];
  const { profile } = useAuth();
  const pathname = usePathname();
  const role = profile?.role || "RH";
  const canCreate = hasPermission(role, "EPI", "create");
  const canEdit = hasPermission(role, "EPI", "edit");
  const canDelete = hasPermission(role, "EPI", "delete");

  const [items, setItems] = useState<SimpleItem[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(false);
  const [edit, setEdit] = useState<SimpleItem | null>(null);
  const [del, setDel] = useState<SimpleItem | null>(null);
  const [mov, setMov] = useState<{ item: SimpleItem; type: EpiMovementType } | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [itemsRes, empRes] = await Promise.all([
        db.from(cfg.table).select("*").order("name"),
        db.from("employees").select("id, name").order("name"),
      ]);
      setItems((itemsRes.data as SimpleItem[]) || []);
      setEmployees((empRes.data as Employee[]) || []);
    } catch (err) {
      console.error(`load ${cfg.table} error:`, err);
    } finally {
      setLoading(false);
    }
  }, [cfg.table]);

  useEffect(() => { loadAll(); }, [loadAll, pathname]);

  async function save(data: { name: string; size: string | null; stock_qty: number; min_quantity: number }) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const payload = { ...data, updated_by: actor } as Record<string, unknown>;
    if (edit) await db.from(cfg.table).update(payload).eq("id", edit.id);
    else await db.from(cfg.table).insert(payload);
    setSaving(false); setForm(false); setEdit(null); loadAll();
  }

  async function handleMovement(empName: string, qty: number, notes: string) {
    if (!mov) return;
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const delta = mov.type === "ENTREGA" ? -qty : qty;
    const { error: moveErr } = await db.from(cfg.movements).insert({
      [cfg.fk]: mov.item.id, employee_name: empName, movement_type: mov.type,
      quantity: qty, movement_date: new Date().toISOString().split("T")[0], notes, created_by: actor,
    } as Record<string, unknown>);
    if (moveErr) { alert(`Erro ao registrar movimentação: ${moveErr.message}`); setSaving(false); return; }
    const { error: updErr } = await db.from(cfg.table).update({ stock_qty: mov.item.stock_qty + delta, updated_by: actor } as Record<string, unknown>).eq("id", mov.item.id);
    if (updErr) { alert(`Erro ao atualizar estoque: ${updErr.message}`); setSaving(false); return; }
    setSaving(false); setMov(null); loadAll();
  }

  // Código derivado do nome (prefixo de iniciais + sequência), por item.
  const codeMap = useMemo(() => buildCodeMap(items, (i) => i.id, (i) => i.name), [items]);

  const columns = [
    { key: "name", label: cfg.colLabel, render: (i: SimpleItem) => <span className="font-medium">{i.name}</span> },
    { key: "code", label: "Código", render: (i: SimpleItem) => <span className="font-mono text-xs text-text-light">{codeMap.get(i.id) || "—"}</span> },
    { key: "size", label: "Tam.", render: (i: SimpleItem) => i.size || "—" },
    { key: "stock_qty", label: "Qtd", render: (i: SimpleItem) => {
      const low = i.min_quantity > 0 && i.stock_qty < i.min_quantity;
      return <span className={`font-semibold ${low ? "text-danger" : ""}`} title={low ? `Abaixo do mínimo (${i.min_quantity})` : undefined}>{i.stock_qty}</span>;
    } },
    { key: "min_quantity", label: "Mín.", render: (i: SimpleItem) => <span className="text-text-light text-sm">{i.min_quantity > 0 ? i.min_quantity : "—"}</span> },
    { key: "actions", label: "", className: "w-36", render: (i: SimpleItem) => (
      <div className="flex gap-1">
        <button onClick={(ev) => { ev.stopPropagation(); setMov({ item: i, type: "ENTREGA" }); }} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded text-xs" title="Entregar">📤</button>
        <button onClick={(ev) => { ev.stopPropagation(); setMov({ item: i, type: "DEVOLUCAO" }); }} className="p-1.5 text-green-600 hover:bg-green-50 rounded text-xs" title="Devolver">📥</button>
        {canEdit && <button onClick={(ev) => { ev.stopPropagation(); setEdit(i); setForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded"><EditIcon /></button>}
        {canDelete && <button onClick={(ev) => { ev.stopPropagation(); setDel(i); }} className="p-1.5 text-danger hover:bg-red-50 rounded"><TrashIcon /></button>}
      </div>
    )},
  ];

  return (
    <>
      <DataTable columns={columns} data={items.filter((i) => matchSearch(i.name, search) || matchSearch(codeMap.get(i.id) || "", search))}
        loading={loading} keyExtractor={(i) => i.id} searchValue={search} onSearchChange={setSearch}
        mobileCards
        onRowClick={canEdit ? (i) => { setEdit(i); setForm(true); } : undefined}
        searchPlaceholder={cfg.searchPlaceholder}
        actions={canCreate ? <Button size="sm" onClick={() => { setEdit(null); setForm(true); }}><PlusIcon className="w-4 h-4" />Adicionar</Button> : undefined}
      />
      <ItemFormModal open={form} onClose={() => { setForm(false); setEdit(null); }} onSave={save} item={edit} saving={saving} newTitle={cfg.newTitle} editTitle={cfg.editTitle} />
      <MovementModal open={!!mov} onClose={() => setMov(null)} onConfirm={handleMovement} title={mov ? `${mov.type === "ENTREGA" ? "Entregar" : "Devolver"}: ${mov.item.name}` : ""} saving={saving} employees={employees} />
      <ConfirmDialog open={!!del} onClose={() => setDel(null)}
        onConfirm={async () => { setSaving(true); await db.from(cfg.table).delete().eq("id", del!.id); setSaving(false); setDel(null); loadAll(); }}
        title={`Excluir ${cfg.singular}`} message={`Excluir "${del?.name}"?`} loading={saving} />
    </>
  );
}

function ItemFormModal({ open, onClose, onSave, item, saving, newTitle, editTitle }: {
  open: boolean;
  onClose: () => void;
  onSave: (d: { name: string; size: string | null; stock_qty: number; min_quantity: number }) => void;
  item: SimpleItem | null;
  saving: boolean;
  newTitle: string;
  editTitle: string;
}) {
  const [name, setName] = useState("");
  const [size, setSize] = useState("");
  const [stockQty, setStockQty] = useState(0);
  const [minQty, setMinQty] = useState(0);

  useEffect(() => {
    if (item) { setName(item.name); setSize(item.size || ""); setStockQty(item.stock_qty); setMinQty(item.min_quantity || 0); }
    else { setName(""); setSize(""); setStockQty(0); setMinQty(0); }
  }, [item, open]);

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title={item ? editTitle : newTitle}>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name, size: size || null, stock_qty: stockQty, min_quantity: minQty }); }} className="space-y-4">
        <div><label className="block text-sm font-medium mb-1">Nome *</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} /></div>
        <div><label className="block text-sm font-medium mb-1">Tamanho</label><input type="text" value={size} onChange={(e) => setSize(e.target.value)} className={inputCls} /></div>
        <div className="grid grid-cols-2 gap-4">
          <div><label className="block text-sm font-medium mb-1">Quantidade</label><input type="number" value={stockQty} onChange={(e) => setStockQty(Number(e.target.value))} min={0} className={inputCls} /></div>
          <div><label className="block text-sm font-medium mb-1">Qtd Mínima <span className="text-text-light font-normal">(opcional)</span></label><input type="number" value={minQty} onChange={(e) => setMinQty(Number(e.target.value))} min={0} placeholder="0 = sem mínimo" className={inputCls} /></div>
        </div>
        <div className="flex gap-3 justify-end pt-2"><Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button></div>
      </form>
    </Modal>
  );
}
