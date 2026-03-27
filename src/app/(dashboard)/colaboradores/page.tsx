"use client";

import { useEffect, useState, useCallback } from "react";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase-browser";
import { hasPermission } from "@/lib/rbac";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs } from "@/components/ui/tabs";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { formatDate, formatDateTime, matchSearch, MOVEMENT_TYPE_LABELS } from "@/lib/utils";
import type { Employee, Epi, Uniform, EpiMovement, UniformMovement, EpiMovementType } from "@/types/database";

export default function ColaboradoresPage() {
  const { profile } = useAuth();
  const supabase = createClient();
  const role = profile?.role || "RH";
  const canCreate = hasPermission(role, "EPI", "create");
  const canEdit = hasPermission(role, "EPI", "edit");
  const canDelete = hasPermission(role, "EPI", "delete");

  // --- EMPLOYEES ---
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [empSearch, setEmpSearch] = useState("");
  const [empForm, setEmpForm] = useState(false);
  const [editEmp, setEditEmp] = useState<Employee | null>(null);
  const [deleteEmp, setDeleteEmp] = useState<Employee | null>(null);

  // --- EPIs ---
  const [epis, setEpis] = useState<Epi[]>([]);
  const [epiSearch, setEpiSearch] = useState("");
  const [epiForm, setEpiForm] = useState(false);
  const [editEpi, setEditEpi] = useState<Epi | null>(null);
  const [deleteEpi, setDeleteEpi] = useState<Epi | null>(null);
  const [movEpi, setMovEpi] = useState<{ epi: Epi; type: EpiMovementType } | null>(null);

  // --- UNIFORMS ---
  const [uniforms, setUniforms] = useState<Uniform[]>([]);
  const [uniSearch, setUniSearch] = useState("");
  const [uniForm, setUniForm] = useState(false);
  const [editUni, setEditUni] = useState<Uniform | null>(null);
  const [deleteUni, setDeleteUni] = useState<Uniform | null>(null);
  const [movUni, setMovUni] = useState<{ uniform: Uniform; type: EpiMovementType } | null>(null);

  // --- HISTORY ---
  const [history, setHistory] = useState<Array<Record<string, unknown>>>([]);
  const [histSearch, setHistSearch] = useState("");
  const [histType, setHistType] = useState("Todos");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [empRes, epiRes, uniRes, epiMovRes, uniMovRes] = await Promise.all([
      supabase.from("employees").select("*").order("name"),
      supabase.from("epis").select("*").order("name"),
      supabase.from("uniforms").select("*").order("name"),
      supabase.from("epi_movements").select("*, epis(name)").order("created_at", { ascending: false }).limit(50),
      supabase.from("uniform_movements").select("*, uniforms(name)").order("created_at", { ascending: false }).limit(50),
    ]);

    setEmployees(empRes.data || []);
    setEpis(epiRes.data || []);
    setUniforms(uniRes.data || []);

    const combined: Array<Record<string, unknown>> = [];
    (epiMovRes.data || []).forEach((m: Record<string, unknown>) => {
      const epi = m.epis as Record<string, unknown> | null;
      combined.push({ ...m, item_name: epi?.name || "—", source: "EPI" });
    });
    (uniMovRes.data || []).forEach((m: Record<string, unknown>) => {
      const uni = m.uniforms as Record<string, unknown> | null;
      combined.push({ ...m, item_name: uni?.name || "—", source: "Uniforme" });
    });
    combined.sort((a, b) => new Date(b.created_at as string).getTime() - new Date(a.created_at as string).getTime());
    setHistory(combined);
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // --- SAVE handlers ---
  async function saveEmployee(data: Partial<Employee>) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const payload = { ...data, updated_by: actor } as any;
    if (editEmp) {
      await supabase.from("employees").update(payload).eq("id", editEmp.id);
    } else {
      await supabase.from("employees").insert(payload);
    }
    setSaving(false); setEmpForm(false); setEditEmp(null); loadAll();
  }

  async function saveEpi(data: Partial<Epi>) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const payload = { ...data, updated_by: actor } as any;
    if (editEpi) {
      await supabase.from("epis").update(payload).eq("id", editEpi.id);
    } else {
      await supabase.from("epis").insert(payload);
    }
    setSaving(false); setEpiForm(false); setEditEpi(null); loadAll();
  }

  async function saveUniform(data: Partial<Uniform>) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const payload = { ...data, updated_by: actor } as any;
    if (editUni) {
      await supabase.from("uniforms").update(payload).eq("id", editUni.id);
    } else {
      await supabase.from("uniforms").insert(payload);
    }
    setSaving(false); setUniForm(false); setEditUni(null); loadAll();
  }

  async function handleEpiMovement(empName: string, qty: number, notes: string) {
    if (!movEpi) return;
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const delta = movEpi.type === "ENTREGA" ? -qty : qty;

    await supabase.from("epi_movements").insert({
      epi_id: movEpi.epi.id, employee_name: empName, movement_type: movEpi.type,
      quantity: qty, movement_date: new Date().toISOString().split("T")[0], notes, created_by: actor,
    } as any);
    await supabase.from("epis").update({ stock_qty: movEpi.epi.stock_qty + delta, updated_by: actor } as any).eq("id", movEpi.epi.id);

    setSaving(false); setMovEpi(null); loadAll();
  }

  async function handleUniMovement(empName: string, qty: number, notes: string) {
    if (!movUni) return;
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const delta = movUni.type === "ENTREGA" ? -qty : qty;

    await supabase.from("uniform_movements").insert({
      uniform_id: movUni.uniform.id, employee_name: empName, movement_type: movUni.type,
      quantity: qty, movement_date: new Date().toISOString().split("T")[0], notes, created_by: actor,
    } as any);
    await supabase.from("uniforms").update({ stock_qty: movUni.uniform.stock_qty + delta, updated_by: actor } as any).eq("id", movUni.uniform.id);

    setSaving(false); setMovUni(null); loadAll();
  }

  // --- COLUMNS ---
  const empColumns = [
    { key: "name", label: "Nome", render: (e: Employee) => <span className="font-medium">{e.name}</span> },
    { key: "phone", label: "Telefone", hideOnMobile: true, render: (e: Employee) => e.phone || "—" },
    { key: "email", label: "Email", hideOnMobile: true, render: (e: Employee) => e.email || "—" },
    { key: "actions", label: "", className: "w-20", render: (e: Employee) => (
      <div className="flex gap-1">
        {canEdit && <button onClick={(ev) => { ev.stopPropagation(); setEditEmp(e); setEmpForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded"><EditIcon /></button>}
        {canDelete && <button onClick={(ev) => { ev.stopPropagation(); setDeleteEmp(e); }} className="p-1.5 text-danger hover:bg-red-50 rounded"><TrashIcon /></button>}
      </div>
    )},
  ];

  const epiColumns = [
    { key: "name", label: "EPI", render: (e: Epi) => <span className="font-medium">{e.name}</span> },
    { key: "ca_code", label: "CA", hideOnMobile: true, render: (e: Epi) => e.ca_code || "—" },
    { key: "size", label: "Tam.", render: (e: Epi) => e.size || "—" },
    { key: "stock_qty", label: "Qtd", render: (e: Epi) => <span className="font-semibold">{e.stock_qty}</span> },
    { key: "actions", label: "", className: "w-36", render: (e: Epi) => (
      <div className="flex gap-1">
        <button onClick={(ev) => { ev.stopPropagation(); setMovEpi({ epi: e, type: "ENTREGA" }); }} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded text-xs" title="Entregar">📤</button>
        <button onClick={(ev) => { ev.stopPropagation(); setMovEpi({ epi: e, type: "DEVOLUCAO" }); }} className="p-1.5 text-green-600 hover:bg-green-50 rounded text-xs" title="Devolver">📥</button>
        {canEdit && <button onClick={(ev) => { ev.stopPropagation(); setEditEpi(e); setEpiForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded"><EditIcon /></button>}
        {canDelete && <button onClick={(ev) => { ev.stopPropagation(); setDeleteEpi(e); }} className="p-1.5 text-danger hover:bg-red-50 rounded"><TrashIcon /></button>}
      </div>
    )},
  ];

  const uniColumns = [
    { key: "name", label: "Uniforme", render: (u: Uniform) => <span className="font-medium">{u.name}</span> },
    { key: "size", label: "Tam.", render: (u: Uniform) => u.size || "—" },
    { key: "stock_qty", label: "Qtd", render: (u: Uniform) => <span className="font-semibold">{u.stock_qty}</span> },
    { key: "actions", label: "", className: "w-36", render: (u: Uniform) => (
      <div className="flex gap-1">
        <button onClick={(ev) => { ev.stopPropagation(); setMovUni({ uniform: u, type: "ENTREGA" }); }} className="p-1.5 text-amber-600 hover:bg-amber-50 rounded text-xs" title="Entregar">📤</button>
        <button onClick={(ev) => { ev.stopPropagation(); setMovUni({ uniform: u, type: "DEVOLUCAO" }); }} className="p-1.5 text-green-600 hover:bg-green-50 rounded text-xs" title="Devolver">📥</button>
        {canEdit && <button onClick={(ev) => { ev.stopPropagation(); setEditUni(u); setUniForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded"><EditIcon /></button>}
        {canDelete && <button onClick={(ev) => { ev.stopPropagation(); setDeleteUni(u); }} className="p-1.5 text-danger hover:bg-red-50 rounded"><TrashIcon /></button>}
      </div>
    )},
  ];

  const filteredHistory = history.filter((h) => {
    const nameMatch = matchSearch(h.employee_name as string || "", histSearch) || matchSearch(h.item_name as string || "", histSearch);
    const typeMatch = histType === "Todos" || h.source === histType;
    return nameMatch && typeMatch;
  });

  const tabs = [
    {
      key: "colaboradores", label: "Colaboradores",
      content: (
        <DataTable columns={empColumns} data={employees.filter((e) => matchSearch(e.name, empSearch))}
          loading={loading} keyExtractor={(e) => e.id} searchValue={empSearch} onSearchChange={setEmpSearch}
          searchPlaceholder="Buscar colaborador..."
          actions={canCreate ? <Button size="sm" onClick={() => { setEditEmp(null); setEmpForm(true); }}><PlusIcon className="w-4 h-4" />Adicionar</Button> : undefined}
        />
      ),
    },
    {
      key: "epi", label: "EPI",
      content: (
        <DataTable columns={epiColumns} data={epis.filter((e) => matchSearch(e.name, epiSearch))}
          loading={loading} keyExtractor={(e) => e.id} searchValue={epiSearch} onSearchChange={setEpiSearch}
          searchPlaceholder="Buscar EPI..."
          actions={canCreate ? <Button size="sm" onClick={() => { setEditEpi(null); setEpiForm(true); }}><PlusIcon className="w-4 h-4" />Adicionar</Button> : undefined}
        />
      ),
    },
    {
      key: "uniforme", label: "Uniforme",
      content: (
        <DataTable columns={uniColumns} data={uniforms.filter((u) => matchSearch(u.name, uniSearch))}
          loading={loading} keyExtractor={(u) => u.id} searchValue={uniSearch} onSearchChange={setUniSearch}
          searchPlaceholder="Buscar uniforme..."
          actions={canCreate ? <Button size="sm" onClick={() => { setEditUni(null); setUniForm(true); }}><PlusIcon className="w-4 h-4" />Adicionar</Button> : undefined}
        />
      ),
    },
    {
      key: "historico", label: "Histórico",
      content: (
        <div className="space-y-3">
          <div className="flex gap-2">
            {["Todos", "EPI", "Uniforme"].map((t) => (
              <button key={t} onClick={() => setHistType(t)}
                className={`px-3 py-1.5 text-xs rounded-full font-medium transition ${histType === t ? "bg-primary text-white" : "bg-gray-100 text-text-light hover:bg-gray-200"}`}>
                {t}
              </button>
            ))}
          </div>
          <DataTable
            columns={[
              { key: "source", label: "Tipo", render: (h: Record<string, unknown>) => <span className={`text-xs px-2 py-0.5 rounded-full ${h.source === "EPI" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>{h.source as string}</span> },
              { key: "item_name", label: "Item", render: (h: Record<string, unknown>) => <span className="font-medium">{h.item_name as string}</span> },
              { key: "employee_name", label: "Colaborador", render: (h: Record<string, unknown>) => h.employee_name as string },
              { key: "movement_type", label: "Mov.", render: (h: Record<string, unknown>) => MOVEMENT_TYPE_LABELS[h.movement_type as string] || h.movement_type as string },
              { key: "quantity", label: "Qtd", hideOnMobile: true, render: (h: Record<string, unknown>) => String(h.quantity) },
              { key: "created_at", label: "Data", hideOnMobile: true, render: (h: Record<string, unknown>) => <span className="text-xs text-text-light">{formatDateTime(h.created_at as string)}</span> },
            ]}
            data={filteredHistory}
            loading={loading}
            keyExtractor={(h) => `${h.source}-${h.id}`}
            searchValue={histSearch}
            onSearchChange={setHistSearch}
            searchPlaceholder="Buscar por colaborador ou item..."
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-text">Colaboradores / EPI</h1>
      <Tabs tabs={tabs} />

      {/* Employee Form */}
      <EmployeeFormModal open={empForm} onClose={() => { setEmpForm(false); setEditEmp(null); }} onSave={saveEmployee} item={editEmp} saving={saving} />
      <ConfirmDialog open={!!deleteEmp} onClose={() => setDeleteEmp(null)} onConfirm={async () => { setSaving(true); await supabase.from("employees").delete().eq("id", deleteEmp!.id); setSaving(false); setDeleteEmp(null); loadAll(); }} title="Excluir Colaborador" message={`Excluir "${deleteEmp?.name}"?`} loading={saving} />

      {/* EPI Form */}
      <EpiFormModal open={epiForm} onClose={() => { setEpiForm(false); setEditEpi(null); }} onSave={saveEpi} item={editEpi} saving={saving} />
      <ConfirmDialog open={!!deleteEpi} onClose={() => setDeleteEpi(null)} onConfirm={async () => { setSaving(true); await supabase.from("epis").delete().eq("id", deleteEpi!.id); setSaving(false); setDeleteEpi(null); loadAll(); }} title="Excluir EPI" message={`Excluir "${deleteEpi?.name}"?`} loading={saving} />

      {/* Uniform Form */}
      <UniformFormModal open={uniForm} onClose={() => { setUniForm(false); setEditUni(null); }} onSave={saveUniform} item={editUni} saving={saving} />
      <ConfirmDialog open={!!deleteUni} onClose={() => setDeleteUni(null)} onConfirm={async () => { setSaving(true); await supabase.from("uniforms").delete().eq("id", deleteUni!.id); setSaving(false); setDeleteUni(null); loadAll(); }} title="Excluir Uniforme" message={`Excluir "${deleteUni?.name}"?`} loading={saving} />

      {/* EPI Movement */}
      <MovementModal open={!!movEpi} onClose={() => setMovEpi(null)} onConfirm={handleEpiMovement} title={movEpi?.type === "ENTREGA" ? `Entregar: ${movEpi?.epi.name}` : `Devolver: ${movEpi?.epi.name}`} saving={saving} employees={employees} />

      {/* Uniform Movement */}
      <MovementModal open={!!movUni} onClose={() => setMovUni(null)} onConfirm={handleUniMovement} title={movUni?.type === "ENTREGA" ? `Entregar: ${movUni?.uniform.name}` : `Devolver: ${movUni?.uniform.name}`} saving={saving} employees={employees} />
    </div>
  );
}

// --- FORM MODALS ---
function EmployeeFormModal({ open, onClose, onSave, item, saving }: { open: boolean; onClose: () => void; onSave: (d: Partial<Employee>) => void; item: Employee | null; saving: boolean }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [familyPhone, setFamilyPhone] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (item) { setName(item.name); setPhone(item.phone || ""); setEmail(item.email || ""); setBirthDate(item.birth_date || ""); setFamilyPhone(item.family_phone || ""); setNotes(item.notes || ""); }
    else { setName(""); setPhone(""); setEmail(""); setBirthDate(""); setFamilyPhone(""); setNotes(""); }
  }, [item, open]);

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Colaborador" : "Novo Colaborador"}>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name, phone: phone || null, email: email || null, birth_date: birthDate || null, family_phone: familyPhone || null, notes: notes || null }); }} className="space-y-4">
        <div><label className="block text-sm font-medium mb-1">Nome *</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        <div className="grid grid-cols-2 gap-4">
          <div><label className="block text-sm font-medium mb-1">Telefone</label><input type="text" value={phone} onChange={(e) => setPhone(e.target.value)} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
          <div><label className="block text-sm font-medium mb-1">Nascimento</label><input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        </div>
        <div><label className="block text-sm font-medium mb-1">Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        <div><label className="block text-sm font-medium mb-1">Tel. Familiar</label><input type="text" value={familyPhone} onChange={(e) => setFamilyPhone(e.target.value)} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        <div><label className="block text-sm font-medium mb-1">Observações</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none" /></div>
        <div className="flex gap-3 justify-end pt-2"><Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button></div>
      </form>
    </Modal>
  );
}

function EpiFormModal({ open, onClose, onSave, item, saving }: { open: boolean; onClose: () => void; onSave: (d: Partial<Epi>) => void; item: Epi | null; saving: boolean }) {
  const [name, setName] = useState("");
  const [caCode, setCaCode] = useState("");
  const [size, setSize] = useState("");
  const [stockQty, setStockQty] = useState(0);

  useEffect(() => {
    if (item) { setName(item.name); setCaCode(item.ca_code || ""); setSize(item.size || ""); setStockQty(item.stock_qty); }
    else { setName(""); setCaCode(""); setSize(""); setStockQty(0); }
  }, [item, open]);

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar EPI" : "Novo EPI"}>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name, ca_code: caCode || null, size: size || null, stock_qty: stockQty }); }} className="space-y-4">
        <div><label className="block text-sm font-medium mb-1">Nome *</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        <div className="grid grid-cols-2 gap-4">
          <div><label className="block text-sm font-medium mb-1">CA</label><input type="text" value={caCode} onChange={(e) => setCaCode(e.target.value)} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
          <div><label className="block text-sm font-medium mb-1">Tamanho</label><input type="text" value={size} onChange={(e) => setSize(e.target.value)} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        </div>
        <div><label className="block text-sm font-medium mb-1">Quantidade</label><input type="number" value={stockQty} onChange={(e) => setStockQty(Number(e.target.value))} min={0} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        <div className="flex gap-3 justify-end pt-2"><Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button></div>
      </form>
    </Modal>
  );
}

function UniformFormModal({ open, onClose, onSave, item, saving }: { open: boolean; onClose: () => void; onSave: (d: Partial<Uniform>) => void; item: Uniform | null; saving: boolean }) {
  const [name, setName] = useState("");
  const [size, setSize] = useState("");
  const [stockQty, setStockQty] = useState(0);

  useEffect(() => {
    if (item) { setName(item.name); setSize(item.size || ""); setStockQty(item.stock_qty); }
    else { setName(""); setSize(""); setStockQty(0); }
  }, [item, open]);

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Uniforme" : "Novo Uniforme"}>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name, size: size || null, stock_qty: stockQty }); }} className="space-y-4">
        <div><label className="block text-sm font-medium mb-1">Nome *</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} required className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        <div className="grid grid-cols-2 gap-4">
          <div><label className="block text-sm font-medium mb-1">Tamanho</label><input type="text" value={size} onChange={(e) => setSize(e.target.value)} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
          <div><label className="block text-sm font-medium mb-1">Quantidade</label><input type="number" value={stockQty} onChange={(e) => setStockQty(Number(e.target.value))} min={0} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        </div>
        <div className="flex gap-3 justify-end pt-2"><Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button></div>
      </form>
    </Modal>
  );
}

function MovementModal({ open, onClose, onConfirm, title, saving, employees }: { open: boolean; onClose: () => void; onConfirm: (emp: string, qty: number, notes: string) => void; title: string; saving: boolean; employees: Employee[] }) {
  const [empName, setEmpName] = useState("");
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");

  useEffect(() => { setEmpName(""); setQty(1); setNotes(""); }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form onSubmit={(e) => { e.preventDefault(); onConfirm(empName, qty, notes); }} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Colaborador *</label>
          <select value={empName} onChange={(e) => setEmpName(e.target.value)} required className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none">
            <option value="">Selecione...</option>
            {employees.map((e) => <option key={e.id} value={e.name}>{e.name}</option>)}
          </select>
        </div>
        <div><label className="block text-sm font-medium mb-1">Quantidade</label><input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} min={1} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none" /></div>
        <div><label className="block text-sm font-medium mb-1">Observações</label><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none" /></div>
        <div className="flex gap-3 justify-end pt-2"><Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button><Button type="submit" disabled={saving}>{saving ? "Registrando..." : "Confirmar"}</Button></div>
      </form>
    </Modal>
  );
}
