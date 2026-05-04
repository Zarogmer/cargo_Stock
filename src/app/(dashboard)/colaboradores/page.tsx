"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") || "colaboradores";

  const role = profile?.role || "RH";
  const canCreate = hasPermission(role, "EPI", "create");
  const canEdit = hasPermission(role, "EPI", "edit");
  const canDelete = hasPermission(role, "EPI", "delete");

  // --- EMPLOYEES ---
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [empSearch, setEmpSearch] = useState("");
  const [empTeamFilter, setEmpTeamFilter] = useState("Todos");
  const [empStatusFilter, setEmpStatusFilter] = useState<"Todos" | "ATIVO" | "INATIVO" | "PENDENCIA">("ATIVO");
  const [empViewMode, setEmpViewMode] = useState<"cards" | "spreadsheet">("cards");
  const [exportingXlsx, setExportingXlsx] = useState(false);
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

  // --- EMPLOYEE DETAIL ---
  const [selectedEmp, setSelectedEmp] = useState<Employee | null>(null);
  const [empItems, setEmpItems] = useState<{ name: string; qty: number; source: string }[]>([]);
  const [loadingEmpItems, setLoadingEmpItems] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      const [empRes, epiRes, uniRes, epiMovRes, uniMovRes] = await Promise.all([
        db.from("employees").select("*").order("name"),
        db.from("epis").select("*").order("name"),
        db.from("uniforms").select("*").order("name"),
        db.from("epi_movements").select("*, epis(name)").order("created_at", { ascending: false }).limit(50),
        db.from("uniform_movements").select("*, uniforms(name)").order("created_at", { ascending: false }).limit(50),
      ]);

      // Log all errors
      const errors: string[] = [];
      if (empRes.error) errors.push(`employees: ${empRes.error.code} ${empRes.error.message}`);
      if (epiRes.error) errors.push(`epis: ${epiRes.error.code} ${epiRes.error.message}`);
      if (uniRes.error) errors.push(`uniforms: ${uniRes.error.code} ${uniRes.error.message}`);
      if (epiMovRes.error) errors.push(`epi_movements: ${epiMovRes.error.code} ${epiMovRes.error.message}`);
      if (uniMovRes.error) errors.push(`uniform_movements: ${uniMovRes.error.code} ${uniMovRes.error.message}`);
      if (errors.length > 0) {
        console.error("DB errors:", errors);
        setDbError(errors.join(" | "));
      }

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
    } catch (err) {
      console.error("loadAll error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll, pathname]);

  // --- LOAD EMPLOYEE ITEMS ---
  async function loadEmployeeItems(emp: Employee) {
    setSelectedEmp(emp);
    setLoadingEmpItems(true);
    try {
      const [epiRes, uniRes] = await Promise.all([
        db.from("epi_movements").select("*, epis(name)").eq("employee_name", emp.name),
        db.from("uniform_movements").select("*, uniforms(name)").eq("employee_name", emp.name),
      ]);

      const items: { name: string; qty: number; source: string }[] = [];

      const epiMap = new Map<string, number>();
      (epiRes.data || []).forEach((m: any) => {
        const name = m.epis?.name || "?";
        const current = epiMap.get(name) || 0;
        epiMap.set(name, current + (m.movement_type === "ENTREGA" ? m.quantity : -m.quantity));
      });
      epiMap.forEach((qty, name) => { if (qty > 0) items.push({ name, qty, source: "EPI" }); });

      const uniMap = new Map<string, number>();
      (uniRes.data || []).forEach((m: any) => {
        const name = m.uniforms?.name || "?";
        const current = uniMap.get(name) || 0;
        uniMap.set(name, current + (m.movement_type === "ENTREGA" ? m.quantity : -m.quantity));
      });
      uniMap.forEach((qty, name) => { if (qty > 0) items.push({ name, qty, source: "Uniforme" }); });

      setEmpItems(items);
    } catch (err) {
      console.error("Error loading employee items:", err);
    } finally {
      setLoadingEmpItems(false);
    }
  }

  // --- EXPORT to XLSX (matches the original spreadsheet layout) ---
  async function handleExportXlsx(rows: Employee[]) {
    setExportingXlsx(true);
    try {
      const XLSX = await import("xlsx");
      const data = rows.map((e) => ({
        Subestipulante: e.subestipulante ?? "",
        "Módulo": e.modulo ?? "",
        "E SOCIAL": e.e_social ?? "",
        STATUS: e.status ?? "",
        FUNCIONARIOS: e.name,
        CPF: e.cpf ?? "",
        RG: e.rg ?? "",
        "ISPS CODE": e.isps_code ?? "",
        "Data de nascimento": e.birth_date ? e.birth_date.slice(0, 10) : "",
        "Data de admissão": e.admission_date ? e.admission_date.slice(0, 10) : "",
        AGENCIA: e.bank_agency ?? "",
        CONTA: e.bank_account ?? "",
        BANCO: e.bank_name ?? "",
        "PP/CC/CS": e.bank_account_type ?? "",
        TELEFONE: e.phone ?? "",
        "MEIO AMBIENTE": e.meio_ambiente_training ?? "",
        "NRS 1,6,7,17,29,35": e.nrs_training ?? "",
        EQUIPE: e.team ?? "",
        "SALVA VIDAS": e.lifeguard_training ? "OK" : "",
        "BOTA BORRACHA": e.rubber_boot ? "OK" : "",
        "N° BOTA": e.boot_size ?? "",
        "N° BLUSA": e.shirt_size ?? "",
        BERMUDA: e.bermuda_size ?? "",
        "ULTIMO ASO": e.last_aso_date ?? "",
        ASO: e.aso_status ?? "",
        "REALIZA LIMPEZA": e.realiza_limpeza === true ? "SIM" : e.realiza_limpeza === false ? "NÃO" : "",
        FUNÇÃO: e.role ?? "",
        SETOR: e.sector ?? "",
      }));
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "FUNCIONARIOS");
      const today = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `colaboradores_${today}.xlsx`);
    } catch (err) {
      console.error("Export failed:", err);
      alert("Falha ao gerar XLSX. Veja o console.");
    } finally {
      setExportingXlsx(false);
    }
  }

  // --- SAVE handlers ---
  async function saveEmployee(data: Partial<Employee>) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const payload = { ...data, updated_by: actor } as any;
    if (editEmp) {
      await db.from("employees").update(payload).eq("id", editEmp.id);
    } else {
      await db.from("employees").insert(payload);
    }
    setSaving(false); setEmpForm(false); setEditEmp(null); loadAll();
  }

  async function saveEpi(data: Partial<Epi>) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const payload = { ...data, updated_by: actor } as any;
    if (editEpi) {
      await db.from("epis").update(payload).eq("id", editEpi.id);
    } else {
      await db.from("epis").insert(payload);
    }
    setSaving(false); setEpiForm(false); setEditEpi(null); loadAll();
  }

  async function saveUniform(data: Partial<Uniform>) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const payload = { ...data, updated_by: actor } as any;
    if (editUni) {
      await db.from("uniforms").update(payload).eq("id", editUni.id);
    } else {
      await db.from("uniforms").insert(payload);
    }
    setSaving(false); setUniForm(false); setEditUni(null); loadAll();
  }

  async function handleEpiMovement(empName: string, qty: number, notes: string) {
    if (!movEpi) return;
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const delta = movEpi.type === "ENTREGA" ? -qty : qty;

    const { error: moveErr } = await db.from("epi_movements").insert({
      epi_id: movEpi.epi.id, employee_name: empName, movement_type: movEpi.type,
      quantity: qty, movement_date: new Date().toISOString().split("T")[0], notes, created_by: actor,
    } as any);
    if (moveErr) { alert(`Erro ao registrar movimentação: ${moveErr.message}`); setSaving(false); return; }

    const { error: updateErr } = await db.from("epis").update({ stock_qty: movEpi.epi.stock_qty + delta, updated_by: actor } as any).eq("id", movEpi.epi.id);
    if (updateErr) { alert(`Erro ao atualizar estoque: ${updateErr.message}`); setSaving(false); return; }

    setSaving(false); setMovEpi(null); loadAll();
  }

  async function handleUniMovement(empName: string, qty: number, notes: string) {
    if (!movUni) return;
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const delta = movUni.type === "ENTREGA" ? -qty : qty;

    const { error: moveErr } = await db.from("uniform_movements").insert({
      uniform_id: movUni.uniform.id, employee_name: empName, movement_type: movUni.type,
      quantity: qty, movement_date: new Date().toISOString().split("T")[0], notes, created_by: actor,
    } as any);
    if (moveErr) { alert(`Erro ao registrar movimentação: ${moveErr.message}`); setSaving(false); return; }

    const { error: updateErr } = await db.from("uniforms").update({ stock_qty: movUni.uniform.stock_qty + delta, updated_by: actor } as any).eq("id", movUni.uniform.id);
    if (updateErr) { alert(`Erro ao atualizar estoque: ${updateErr.message}`); setSaving(false); return; }

    setSaving(false); setMovUni(null); loadAll();
  }

  // --- COLUMNS ---
  const teamLabels: Record<string, string> = { EQUIPE_1: "Equipe 1", EQUIPE_2: "Equipe 2", EQUIPE_3: "Equipe 3", COSTADO: "Costado" };
  const teamColors: Record<string, string> = { EQUIPE_1: "bg-blue-100 text-blue-700", EQUIPE_2: "bg-purple-100 text-purple-700", EQUIPE_3: "bg-teal-100 text-teal-700", COSTADO: "bg-amber-100 text-amber-700" };
  const empColumns = [
    { key: "name", label: "Nome", render: (e: Employee) => <span className="font-medium">{e.name}</span> },
    { key: "status", label: "Status", render: (e: Employee) => {
      const cls = e.status === "ATIVO" ? "bg-emerald-100 text-emerald-700"
                : e.status === "INATIVO" ? "bg-red-100 text-red-700"
                : "bg-amber-100 text-amber-700";
      return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{e.status || "—"}</span>;
    }},
    { key: "role", label: "Função", render: (e: Employee) => e.role ? <span className="text-xs font-medium">{e.role}</span> : <span className="text-text-light text-xs">—</span> },
    { key: "sector", label: "Setor", hideOnMobile: true, render: (e: Employee) => e.sector || "—" },
    { key: "team", label: "Equipe", hideOnMobile: true, render: (e: Employee) => e.team ? <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${teamColors[e.team] || ""}`}>{teamLabels[e.team]}</span> : <span className="text-text-light text-xs">—</span> },
    { key: "phone", label: "Telefone", hideOnMobile: true, render: (e: Employee) => e.phone || "—" },
    { key: "actions", label: "", className: "w-20", render: (e: Employee) => (
      <div className="flex gap-1">
        {canEdit && <button onClick={(ev) => { ev.stopPropagation(); setEditEmp(e); setEmpForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded"><EditIcon /></button>}
        {canDelete && <button onClick={(ev) => { ev.stopPropagation(); setDeleteEmp(e); }} className="p-1.5 text-danger hover:bg-red-50 rounded"><TrashIcon /></button>}
      </div>
    )},
  ];

  const epiColumns = [
    { key: "name", label: "EPI", render: (e: Epi) => <span className="font-medium">{e.name}</span> },
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
      content: (() => {
        const filteredEmployees = employees.filter((e) => {
          const nameMatch = matchSearch(e.name, empSearch);
          const statusMatch = empStatusFilter === "Todos" ? true : e.status === empStatusFilter;
          const teamMatch = empTeamFilter === "Todos" ? true :
            empTeamFilter === "Equipe 1" ? e.team === "EQUIPE_1" :
            empTeamFilter === "Equipe 2" ? e.team === "EQUIPE_2" :
            empTeamFilter === "Equipe 3" ? e.team === "EQUIPE_3" :
            empTeamFilter === "Costado" ? e.team === "COSTADO" :
            empTeamFilter === "Sem equipe" ? !e.team : true;
          return nameMatch && statusMatch && teamMatch;
        });
        return (
          <div className="space-y-3">
            <div className="flex gap-2 flex-wrap items-center justify-between">
              <div className="flex gap-2 items-center">
                <span className="text-xs text-text-light font-semibold uppercase tracking-wider">Visualização:</span>
                <div className="inline-flex rounded-lg border border-border overflow-hidden">
                  <button onClick={() => setEmpViewMode("cards")}
                    className={`px-3 py-1.5 text-xs font-medium transition ${empViewMode === "cards" ? "bg-primary text-white" : "bg-card hover:bg-gray-50 text-text-light"}`}>
                    🃏 Cards
                  </button>
                  <button onClick={() => setEmpViewMode("spreadsheet")}
                    className={`px-3 py-1.5 text-xs font-medium transition ${empViewMode === "spreadsheet" ? "bg-primary text-white" : "bg-card hover:bg-gray-50 text-text-light"}`}>
                    📋 Planilha
                  </button>
                </div>
              </div>
              <button onClick={() => handleExportXlsx(filteredEmployees)}
                disabled={exportingXlsx || filteredEmployees.length === 0}
                className="px-3 py-1.5 text-xs font-medium bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed">
                {exportingXlsx ? "Gerando..." : "📥 Exportar XLSX"}
              </button>
            </div>

            <div className="flex gap-2 flex-wrap items-center">
              <span className="text-xs text-text-light font-semibold uppercase tracking-wider">Status:</span>
              {(["Todos", "ATIVO", "INATIVO", "PENDENCIA"] as const).map((t) => (
                <button key={t} onClick={() => setEmpStatusFilter(t)}
                  className={`px-3 py-1.5 text-xs rounded-full font-medium transition ${empStatusFilter === t ? "bg-primary text-white" : "bg-gray-100 text-text-light hover:bg-gray-200"}`}>
                  {t === "Todos" ? "Todos" : t === "ATIVO" ? "Ativo" : t === "INATIVO" ? "Inativo" : "Pendência"}
                </button>
              ))}
            </div>
            <div className="flex gap-2 flex-wrap items-center">
              <span className="text-xs text-text-light font-semibold uppercase tracking-wider">Equipe:</span>
              {["Todos", "Equipe 1", "Equipe 2", "Equipe 3", "Costado", "Sem equipe"].map((t) => (
                <button key={t} onClick={() => setEmpTeamFilter(t)}
                  className={`px-3 py-1.5 text-xs rounded-full font-medium transition ${empTeamFilter === t ? "bg-primary text-white" : "bg-gray-100 text-text-light hover:bg-gray-200"}`}>
                  {t}
                </button>
              ))}
            </div>

            {empViewMode === "cards" ? (
              <DataTable columns={empColumns} data={filteredEmployees}
                loading={loading} keyExtractor={(e) => e.id} searchValue={empSearch} onSearchChange={setEmpSearch}
                searchPlaceholder="Buscar colaborador..."
                onRowClick={(e) => loadEmployeeItems(e)}
                actions={canCreate ? <Button size="sm" onClick={() => { setEditEmp(null); setEmpForm(true); }}><PlusIcon className="w-4 h-4" />Adicionar</Button> : undefined}
              />
            ) : (
              <EmployeeSpreadsheetView
                employees={filteredEmployees}
                searchValue={empSearch}
                onSearchChange={setEmpSearch}
                onRowClick={(e) => { setEditEmp(e); setEmpForm(true); }}
                canCreate={canCreate}
                onCreate={() => { setEditEmp(null); setEmpForm(true); }}
              />
            )}
          </div>
        );
      })(),
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
      <h1 className="text-2xl font-bold text-text">Colaboradores</h1>

      {dbError && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 font-mono break-all">
          ⚠️ Erro ao carregar dados: {dbError}
        </div>
      )}

      <Tabs tabs={tabs} defaultTab={initialTab} />

      {/* Employee Form */}
      <EmployeeFormModal open={empForm} onClose={() => { setEmpForm(false); setEditEmp(null); }} onSave={saveEmployee} item={editEmp} saving={saving} />
      <ConfirmDialog open={!!deleteEmp} onClose={() => setDeleteEmp(null)} onConfirm={async () => { setSaving(true); await db.from("employees").delete().eq("id", deleteEmp!.id); setSaving(false); setDeleteEmp(null); loadAll(); }} title="Excluir Colaborador" message={`Excluir "${deleteEmp?.name}"?`} loading={saving} />

      {/* EPI Form */}
      <EpiFormModal open={epiForm} onClose={() => { setEpiForm(false); setEditEpi(null); }} onSave={saveEpi} item={editEpi} saving={saving} />
      <ConfirmDialog open={!!deleteEpi} onClose={() => setDeleteEpi(null)} onConfirm={async () => { setSaving(true); await db.from("epis").delete().eq("id", deleteEpi!.id); setSaving(false); setDeleteEpi(null); loadAll(); }} title="Excluir EPI" message={`Excluir "${deleteEpi?.name}"?`} loading={saving} />

      {/* Uniform Form */}
      <UniformFormModal open={uniForm} onClose={() => { setUniForm(false); setEditUni(null); }} onSave={saveUniform} item={editUni} saving={saving} />
      <ConfirmDialog open={!!deleteUni} onClose={() => setDeleteUni(null)} onConfirm={async () => { setSaving(true); await db.from("uniforms").delete().eq("id", deleteUni!.id); setSaving(false); setDeleteUni(null); loadAll(); }} title="Excluir Uniforme" message={`Excluir "${deleteUni?.name}"?`} loading={saving} />

      {/* EPI Movement */}
      <MovementModal open={!!movEpi} onClose={() => setMovEpi(null)} onConfirm={handleEpiMovement} title={movEpi?.type === "ENTREGA" ? `Entregar: ${movEpi?.epi.name}` : `Devolver: ${movEpi?.epi.name}`} saving={saving} employees={employees} />

      {/* Uniform Movement */}
      <MovementModal open={!!movUni} onClose={() => setMovUni(null)} onConfirm={handleUniMovement} title={movUni?.type === "ENTREGA" ? `Entregar: ${movUni?.uniform.name}` : `Devolver: ${movUni?.uniform.name}`} saving={saving} employees={employees} />

      {/* Employee Detail */}
      <Modal open={!!selectedEmp} onClose={() => setSelectedEmp(null)} title={selectedEmp?.name || ""}>
        {selectedEmp && (
          <div className="space-y-4">
            {/* Status / função */}
            <div className="flex flex-wrap gap-2">
              {selectedEmp.status && (
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                  selectedEmp.status === "ATIVO" ? "bg-emerald-100 text-emerald-700" :
                  selectedEmp.status === "INATIVO" ? "bg-red-100 text-red-700" :
                  "bg-amber-100 text-amber-700"
                }`}>{selectedEmp.status}</span>
              )}
              {selectedEmp.role && <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-medium">{selectedEmp.role}</span>}
              {selectedEmp.sector && <span className="text-xs px-2 py-1 rounded-full bg-purple-100 text-purple-700 font-medium">{selectedEmp.sector}</span>}
              {selectedEmp.team && <span className={`text-xs px-2 py-1 rounded-full font-medium ${teamColors[selectedEmp.team] || ""}`}>{teamLabels[selectedEmp.team]}</span>}
            </div>

            {/* Pessoais */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              {selectedEmp.cpf && <div><span className="text-text-light">CPF:</span> <span className="font-medium font-mono">{selectedEmp.cpf}</span></div>}
              {selectedEmp.rg && <div><span className="text-text-light">RG:</span> <span className="font-medium font-mono">{selectedEmp.rg}</span></div>}
              {selectedEmp.isps_code && <div><span className="text-text-light">ISPS:</span> <span className="font-medium font-mono">{selectedEmp.isps_code}</span></div>}
              {selectedEmp.e_social && <div><span className="text-text-light">E-Social:</span> <span className="font-medium">{selectedEmp.e_social}</span></div>}
              <div><span className="text-text-light">Telefone:</span> <span className="font-medium">{selectedEmp.phone || "—"}</span></div>
              {selectedEmp.family_phone && <div><span className="text-text-light">Tel. Familiar:</span> <span className="font-medium">{selectedEmp.family_phone}</span></div>}
              {selectedEmp.birth_date && <div><span className="text-text-light">Nascimento:</span> <span className="font-medium">{selectedEmp.birth_date.slice(0, 10)}</span></div>}
              {selectedEmp.admission_date && <div><span className="text-text-light">Admissão:</span> <span className="font-medium">{selectedEmp.admission_date.slice(0, 10)}</span></div>}
              {selectedEmp.email && <div className="col-span-2"><span className="text-text-light">Email:</span> <span className="font-medium">{selectedEmp.email}</span></div>}
              {selectedEmp.salary != null && <div><span className="text-text-light">Salário:</span> <span className="font-medium text-emerald-700">R$ {Number(selectedEmp.salary).toFixed(2)}</span></div>}
            </div>

            {/* Banco */}
            {(selectedEmp.bank_name || selectedEmp.bank_agency) && (
              <div className="border-t border-border pt-4">
                <h3 className="text-xs font-semibold text-text-light uppercase tracking-wider mb-2">💳 Bancário</h3>
                <p className="text-sm">
                  <span className="font-medium">{selectedEmp.bank_name}</span>
                  {selectedEmp.bank_account_type && <span className="ml-2 text-text-light">({selectedEmp.bank_account_type})</span>}
                </p>
                {(selectedEmp.bank_agency || selectedEmp.bank_account) && (
                  <p className="text-sm font-mono">Ag {selectedEmp.bank_agency || "—"} · Conta {selectedEmp.bank_account || "—"}</p>
                )}
              </div>
            )}

            {/* Treinamentos / ASO */}
            {(selectedEmp.nrs_training || selectedEmp.meio_ambiente_training || selectedEmp.last_aso_date || selectedEmp.lifeguard_training || selectedEmp.rubber_boot) && (
              <div className="border-t border-border pt-4">
                <h3 className="text-xs font-semibold text-text-light uppercase tracking-wider mb-2">🎓 Treinamentos / ASO</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  {selectedEmp.nrs_training && <div><span className="text-text-light">NRs:</span> <span className="font-medium">{selectedEmp.nrs_training}</span></div>}
                  {selectedEmp.meio_ambiente_training && <div><span className="text-text-light">Meio Ambiente:</span> <span className="font-medium">{selectedEmp.meio_ambiente_training}</span></div>}
                  {selectedEmp.last_aso_date && <div><span className="text-text-light">Último ASO:</span> <span className="font-medium">{selectedEmp.last_aso_date}</span></div>}
                  {selectedEmp.aso_status && <div><span className="text-text-light">Status ASO:</span> <span className="font-medium">{selectedEmp.aso_status}</span></div>}
                </div>
                <div className="flex gap-3 flex-wrap mt-2">
                  {selectedEmp.lifeguard_training && <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-100 text-cyan-700 font-medium">🛟 Salva-Vidas</span>}
                  {selectedEmp.rubber_boot && <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 font-medium">🥾 Bota Borracha</span>}
                  {selectedEmp.has_vaccination_card && <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">💉 Vacinação</span>}
                  {selectedEmp.has_cnh && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">🚗 CNH</span>}
                  {selectedEmp.realiza_limpeza && <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">🧽 Limpeza</span>}
                </div>
              </div>
            )}

            {/* Tamanhos */}
            {(selectedEmp.boot_size || selectedEmp.shirt_size || selectedEmp.bermuda_size) && (
              <div className="border-t border-border pt-4">
                <h3 className="text-xs font-semibold text-text-light uppercase tracking-wider mb-2">👕 Tamanhos</h3>
                <div className="flex gap-4 text-sm">
                  {selectedEmp.boot_size && <div><span className="text-text-light">Bota:</span> <span className="font-medium">{selectedEmp.boot_size}</span></div>}
                  {selectedEmp.shirt_size && <div><span className="text-text-light">Blusa:</span> <span className="font-medium">{selectedEmp.shirt_size}</span></div>}
                  {selectedEmp.bermuda_size && <div><span className="text-text-light">Bermuda:</span> <span className="font-medium">{selectedEmp.bermuda_size}</span></div>}
                </div>
              </div>
            )}

            {/* EPIs em posse */}
            <div className="border-t border-border pt-4">
              <h3 className="text-sm font-semibold text-text mb-3">EPIs e Uniformes em posse</h3>
              {loadingEmpItems ? (
                <p className="text-sm text-text-light text-center py-4">Carregando...</p>
              ) : empItems.length === 0 ? (
                <p className="text-sm text-text-light text-center py-4">Nenhum item entregue a este colaborador</p>
              ) : (
                <div className="space-y-2">
                  {empItems.map((item, i) => (
                    <div key={i} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${item.source === "EPI" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"}`}>{item.source}</span>
                        <span className="text-sm font-medium">{item.name}</span>
                      </div>
                      <span className="text-sm font-bold text-text">x{item.qty}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

// --- FORM MODALS ---
function formatPhoneMask(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return `(${digits}`;
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

function EmployeeFormModal({ open, onClose, onSave, item, saving }: { open: boolean; onClose: () => void; onSave: (d: Partial<Employee>) => void; item: Employee | null; saving: boolean }) {
  // Pessoais
  const [name, setName] = useState("");
  const [team, setTeam] = useState<string>("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [familyPhone, setFamilyPhone] = useState("");
  const [notes, setNotes] = useState("");
  // Identificação
  const [cpf, setCpf] = useState("");
  const [rg, setRg] = useState("");
  const [ispsCode, setIspsCode] = useState("");
  const [eSocial, setESocial] = useState("");
  const [subestipulante, setSubestipulante] = useState("");
  const [modulo, setModulo] = useState("");
  // Profissional
  const [status, setStatus] = useState<string>("ATIVO");
  const [sector, setSector] = useState<string>("");
  const [role, setRole] = useState("");
  const [salary, setSalary] = useState("");
  const [admissionDate, setAdmissionDate] = useState("");
  // Bancários
  const [bankName, setBankName] = useState("");
  const [bankAgency, setBankAgency] = useState("");
  const [bankAccount, setBankAccount] = useState("");
  const [bankAccountType, setBankAccountType] = useState("");
  // Documentos
  const [hasVaccinationCard, setHasVaccinationCard] = useState(false);
  const [hasCnh, setHasCnh] = useState(false);
  // Treinamentos
  const [nrsTraining, setNrsTraining] = useState("");
  const [meioAmbienteTraining, setMeioAmbienteTraining] = useState("");
  const [lifeguardTraining, setLifeguardTraining] = useState(false);
  const [rubberBoot, setRubberBoot] = useState(false);
  // Tamanhos
  const [bootSize, setBootSize] = useState("");
  const [shirtSize, setShirtSize] = useState("");
  const [bermudaSize, setBermudaSize] = useState("");
  // ASO
  const [lastAsoDate, setLastAsoDate] = useState("");
  const [asoStatus, setAsoStatus] = useState("");
  // Operacional
  const [realizaLimpeza, setRealizaLimpeza] = useState(false);

  useEffect(() => {
    if (item) {
      setName(item.name); setTeam(item.team || ""); setPhone(item.phone || "");
      setEmail(item.email || ""); setBirthDate(item.birth_date?.slice(0, 10) || "");
      setFamilyPhone(item.family_phone || ""); setNotes(item.notes || "");
      setCpf(item.cpf || ""); setRg(item.rg || "");
      setIspsCode(item.isps_code || ""); setESocial(item.e_social || "");
      setSubestipulante(item.subestipulante?.toString() || "");
      setModulo(item.modulo?.toString() || "");
      setStatus(item.status || "ATIVO");
      setSector(item.sector || "");
      setRole(item.role || "");
      setSalary(item.salary?.toString() || "");
      setAdmissionDate(item.admission_date?.slice(0, 10) || "");
      setBankName(item.bank_name || ""); setBankAgency(item.bank_agency || "");
      setBankAccount(item.bank_account || ""); setBankAccountType(item.bank_account_type || "");
      setHasVaccinationCard(item.has_vaccination_card || false);
      setHasCnh(item.has_cnh || false);
      setNrsTraining(item.nrs_training || "");
      setMeioAmbienteTraining(item.meio_ambiente_training || "");
      setLifeguardTraining(item.lifeguard_training || false);
      setRubberBoot(item.rubber_boot || false);
      setBootSize(item.boot_size || "");
      setShirtSize(item.shirt_size || "");
      setBermudaSize(item.bermuda_size || "");
      setLastAsoDate(item.last_aso_date || "");
      setAsoStatus(item.aso_status || "");
      setRealizaLimpeza(item.realiza_limpeza || false);
    } else {
      setName(""); setTeam(""); setPhone(""); setEmail(""); setBirthDate("");
      setFamilyPhone(""); setNotes("");
      setCpf(""); setRg(""); setIspsCode(""); setESocial("");
      setSubestipulante(""); setModulo("");
      setStatus("ATIVO"); setSector(""); setRole(""); setSalary(""); setAdmissionDate("");
      setBankName(""); setBankAgency(""); setBankAccount(""); setBankAccountType("");
      setHasVaccinationCard(false); setHasCnh(false);
      setNrsTraining(""); setMeioAmbienteTraining("");
      setLifeguardTraining(false); setRubberBoot(false);
      setBootSize(""); setShirtSize(""); setBermudaSize("");
      setLastAsoDate(""); setAsoStatus(""); setRealizaLimpeza(false);
    }
  }, [item, open]);

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name, team: (team as any) || null, phone: phone || null,
      email: email || null, birth_date: birthDate || null,
      family_phone: familyPhone || null, notes: notes || null,
      cpf: cpf.replace(/\D/g, "") || null,
      rg: rg || null,
      isps_code: ispsCode || null,
      e_social: eSocial || null,
      subestipulante: subestipulante ? Number(subestipulante) : null,
      modulo: modulo ? Number(modulo) : null,
      status: (status as any) || "ATIVO",
      sector: (sector as any) || null,
      role: role || null,
      salary: salary || null,
      admission_date: admissionDate || null,
      bank_name: bankName || null, bank_agency: bankAgency || null,
      bank_account: bankAccount || null,
      bank_account_type: (bankAccountType as any) || null,
      has_vaccination_card: hasVaccinationCard,
      has_cnh: hasCnh,
      nrs_training: nrsTraining || null,
      meio_ambiente_training: meioAmbienteTraining || null,
      lifeguard_training: lifeguardTraining,
      rubber_boot: rubberBoot,
      boot_size: bootSize || null,
      shirt_size: shirtSize || null,
      bermuda_size: bermudaSize || null,
      last_aso_date: lastAsoDate || null,
      aso_status: asoStatus || null,
      realiza_limpeza: realizaLimpeza,
    });
  }

  const tabs = [
    {
      key: "pessoal",
      label: "👤 Pessoal",
      content: (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium mb-1">Nome *</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} /></div>
            <div>
              <label className="block text-sm font-medium mb-1">Equipe</label>
              <select value={team} onChange={(e) => setTeam(e.target.value)} className={inputCls}>
                <option value="">Sem equipe</option>
                <option value="EQUIPE_1">Equipe 1</option>
                <option value="EQUIPE_2">Equipe 2</option>
                <option value="EQUIPE_3">Equipe 3</option>
                <option value="COSTADO">Costado</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium mb-1">Telefone</label><input type="text" value={phone} onChange={(e) => setPhone(formatPhoneMask(e.target.value))} placeholder="(13) 99999-9999" className={inputCls} /></div>
            <div><label className="block text-sm font-medium mb-1">Nascimento</label><input type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} className={inputCls} /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium mb-1">Email</label><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} /></div>
            <div><label className="block text-sm font-medium mb-1">Tel. Familiar</label><input type="text" value={familyPhone} onChange={(e) => setFamilyPhone(formatPhoneMask(e.target.value))} placeholder="(13) 99999-9999" className={inputCls} /></div>
          </div>
          <div className="border-t border-border pt-3 mt-3">
            <p className="text-xs font-semibold text-text-light uppercase tracking-wider mb-3">🆔 Identificação</p>
            <div className="grid grid-cols-2 gap-4">
              <div><label className="block text-sm font-medium mb-1">CPF</label><input type="text" value={cpf} onChange={(e) => setCpf(e.target.value)} placeholder="000.000.000-00" className={inputCls} /></div>
              <div><label className="block text-sm font-medium mb-1">RG</label><input type="text" value={rg} onChange={(e) => setRg(e.target.value)} className={inputCls} /></div>
            </div>
            <div className="grid grid-cols-3 gap-4 mt-4">
              <div><label className="block text-sm font-medium mb-1">ISPS Code</label><input type="text" value={ispsCode} onChange={(e) => setIspsCode(e.target.value)} className={inputCls} /></div>
              <div><label className="block text-sm font-medium mb-1">E-Social</label><input type="text" value={eSocial} onChange={(e) => setESocial(e.target.value)} className={inputCls} /></div>
              <div><label className="block text-sm font-medium mb-1">Módulo</label><input type="number" value={modulo} onChange={(e) => setModulo(e.target.value)} className={inputCls} /></div>
            </div>
          </div>
        </div>
      ),
    },
    {
      key: "vinculo",
      label: "💼 Vínculo",
      content: (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputCls}>
                <option value="ATIVO">Ativo</option>
                <option value="INATIVO">Inativo</option>
                <option value="PENDENCIA">Pendência</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Setor</label>
              <select value={sector} onChange={(e) => setSector(e.target.value)} className={inputCls}>
                <option value="">—</option>
                <option value="OPERACIONAL">Operacional</option>
                <option value="ADMINISTRATIVO">Administrativo</option>
              </select>
            </div>
            <div><label className="block text-sm font-medium mb-1">Admissão</label><input type="date" value={admissionDate} onChange={(e) => setAdmissionDate(e.target.value)} className={inputCls} /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Função</label>
              <input type="text" value={role} onChange={(e) => setRole(e.target.value.toUpperCase())} placeholder="WAP, AJUDANTE, ESFREGÃO..." className={inputCls} list="role-options" />
              <datalist id="role-options">
                <option value="WAP" />
                <option value="AJUDANTE" />
                <option value="ESFREGAO" />
                <option value="MAQUINISTA" />
                <option value="COZINHEIRO" />
                <option value="MECANICO" />
                <option value="ANALISTA RH" />
                <option value="ASSISTENTE" />
                <option value="OPERACIONAL" />
              </datalist>
            </div>
            <div><label className="block text-sm font-medium mb-1">Salário (R$)</label><input type="number" step="0.01" value={salary} onChange={(e) => setSalary(e.target.value)} placeholder="0,00" className={inputCls} /></div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Subestipulante</label>
            <input type="number" value={subestipulante} onChange={(e) => setSubestipulante(e.target.value)} className={inputCls} />
          </div>
        </div>
      ),
    },
    {
      key: "bancario",
      label: "💳 Bancário",
      content: (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium mb-1">Banco</label><input type="text" value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="Ex: ITAU, SANTANDER..." className={inputCls} /></div>
            <div>
              <label className="block text-sm font-medium mb-1">Tipo de Conta</label>
              <select value={bankAccountType} onChange={(e) => setBankAccountType(e.target.value)} className={inputCls}>
                <option value="">Selecionar...</option>
                <option value="CORRENTE">Corrente</option>
                <option value="POUPANCA">Poupança</option>
                <option value="CONTA_SAL">Conta Salário</option>
                <option value="DIGITAL">Digital</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium mb-1">Agência</label><input type="text" value={bankAgency} onChange={(e) => setBankAgency(e.target.value)} placeholder="0000" className={inputCls} /></div>
            <div><label className="block text-sm font-medium mb-1">Conta</label><input type="text" value={bankAccount} onChange={(e) => setBankAccount(e.target.value)} placeholder="00000-0" className={inputCls} /></div>
          </div>
        </div>
      ),
    },
    {
      key: "treinamentos",
      label: "🎓 Treinamentos",
      content: (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium mb-1">NRs (1, 6, 7, 17, 29, 35)</label><input type="text" value={nrsTraining} onChange={(e) => setNrsTraining(e.target.value)} placeholder="14 e 15 janeiro 2025" className={inputCls} /></div>
            <div><label className="block text-sm font-medium mb-1">Meio Ambiente</label><input type="text" value={meioAmbienteTraining} onChange={(e) => setMeioAmbienteTraining(e.target.value)} placeholder="20 de janeiro 2025" className={inputCls} /></div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium mb-1">Último ASO</label><input type="text" value={lastAsoDate} onChange={(e) => setLastAsoDate(e.target.value)} placeholder="06 de janeiro de 2026" className={inputCls} /></div>
            <div>
              <label className="block text-sm font-medium mb-1">Status ASO</label>
              <select value={asoStatus} onChange={(e) => setAsoStatus(e.target.value)} className={inputCls}>
                <option value="">—</option>
                <option value="OK">OK</option>
                <option value="VENCIDO">Vencido</option>
                <option value="INATIVO">Inativo</option>
              </select>
            </div>
          </div>
          <div className="flex gap-6 flex-wrap pt-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={lifeguardTraining} onChange={(e) => setLifeguardTraining(e.target.checked)} className="w-4 h-4 accent-primary" />
              <span className="text-sm">🛟 Salva-Vidas</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={rubberBoot} onChange={(e) => setRubberBoot(e.target.checked)} className="w-4 h-4 accent-primary" />
              <span className="text-sm">🥾 Bota de Borracha</span>
            </label>
          </div>
        </div>
      ),
    },
    {
      key: "epi",
      label: "👕 EPI & Docs",
      content: (
        <div className="space-y-4">
          <div>
            <p className="text-xs font-semibold text-text-light uppercase tracking-wider mb-3">Tamanhos</p>
            <div className="grid grid-cols-3 gap-4">
              <div><label className="block text-sm font-medium mb-1">Bota</label><input type="text" value={bootSize} onChange={(e) => setBootSize(e.target.value)} placeholder="42" className={inputCls} /></div>
              <div><label className="block text-sm font-medium mb-1">Blusa</label><input type="text" value={shirtSize} onChange={(e) => setShirtSize(e.target.value)} placeholder="G" className={inputCls} /></div>
              <div><label className="block text-sm font-medium mb-1">Bermuda</label><input type="text" value={bermudaSize} onChange={(e) => setBermudaSize(e.target.value)} placeholder="46" className={inputCls} /></div>
            </div>
          </div>
          <div className="border-t border-border pt-3">
            <p className="text-xs font-semibold text-text-light uppercase tracking-wider mb-3">Documentos / Operacional</p>
            <div className="flex gap-6 flex-wrap">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={hasVaccinationCard} onChange={(e) => setHasVaccinationCard(e.target.checked)} className="w-4 h-4 accent-primary" />
                <span className="text-sm">💉 Cartão de Vacinação</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={hasCnh} onChange={(e) => setHasCnh(e.target.checked)} className="w-4 h-4 accent-primary" />
                <span className="text-sm">🚗 CNH</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={realizaLimpeza} onChange={(e) => setRealizaLimpeza(e.target.checked)} className="w-4 h-4 accent-primary" />
                <span className="text-sm">🧽 Realiza Limpeza</span>
              </label>
            </div>
          </div>
          <div className="border-t border-border pt-3">
            <label className="block text-sm font-medium mb-1">📝 Observações</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`${inputCls} resize-none`} />
          </div>
        </div>
      ),
    },
  ];

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar Colaborador" : "Novo Colaborador"} maxWidth="max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Tabs tabs={tabs} />
        <div className="flex gap-3 justify-end pt-2 border-t border-border">
          <Button variant="secondary" type="button" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={saving}>{saving ? "Salvando..." : "Salvar"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function EpiFormModal({ open, onClose, onSave, item, saving }: { open: boolean; onClose: () => void; onSave: (d: Partial<Epi>) => void; item: Epi | null; saving: boolean }) {
  const [name, setName] = useState("");
  const [size, setSize] = useState("");
  const [stockQty, setStockQty] = useState(0);

  useEffect(() => {
    if (item) { setName(item.name); setSize(item.size || ""); setStockQty(item.stock_qty); }
    else { setName(""); setSize(""); setStockQty(0); }
  }, [item, open]);

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title={item ? "Editar EPI" : "Novo EPI"}>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name, size: size || null, stock_qty: stockQty }); }} className="space-y-4">
        <div><label className="block text-sm font-medium mb-1">Nome *</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} required className={inputCls} /></div>
        <div className="grid grid-cols-2 gap-4">
          <div><label className="block text-sm font-medium mb-1">Tamanho</label><input type="text" value={size} onChange={(e) => setSize(e.target.value)} className={inputCls} /></div>
          <div><label className="block text-sm font-medium mb-1">Quantidade</label><input type="number" value={stockQty} onChange={(e) => setStockQty(Number(e.target.value))} min={0} className={inputCls} /></div>
        </div>
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

// --- SPREADSHEET VIEW (matches the original .xlsx layout) ---

const SHEET_COLUMNS: { key: keyof Employee | "actions"; label: string; w?: string }[] = [
  { key: "subestipulante", label: "Subest", w: "w-16" },
  { key: "modulo", label: "Mód", w: "w-12" },
  { key: "e_social", label: "E SOCIAL", w: "w-20" },
  { key: "status", label: "Status", w: "w-20" },
  { key: "name", label: "Funcionário", w: "w-56" },
  { key: "cpf", label: "CPF", w: "w-32" },
  { key: "rg", label: "RG", w: "w-28" },
  { key: "isps_code", label: "ISPS", w: "w-20" },
  { key: "birth_date", label: "Nascimento", w: "w-28" },
  { key: "admission_date", label: "Admissão", w: "w-28" },
  { key: "bank_agency", label: "Agência", w: "w-20" },
  { key: "bank_account", label: "Conta", w: "w-24" },
  { key: "bank_name", label: "Banco", w: "w-24" },
  { key: "bank_account_type", label: "Tipo", w: "w-24" },
  { key: "phone", label: "Telefone", w: "w-32" },
  { key: "meio_ambiente_training", label: "M. Ambiente", w: "w-40" },
  { key: "nrs_training", label: "NRs", w: "w-40" },
  { key: "team", label: "Equipe", w: "w-24" },
  { key: "lifeguard_training", label: "Salva-Vidas", w: "w-24" },
  { key: "rubber_boot", label: "B. Borracha", w: "w-24" },
  { key: "boot_size", label: "Bota", w: "w-14" },
  { key: "shirt_size", label: "Blusa", w: "w-14" },
  { key: "bermuda_size", label: "Bermuda", w: "w-16" },
  { key: "last_aso_date", label: "Últ. ASO", w: "w-32" },
  { key: "aso_status", label: "ASO", w: "w-16" },
  { key: "realiza_limpeza", label: "Limpeza", w: "w-20" },
  { key: "role", label: "Função", w: "w-28" },
  { key: "sector", label: "Setor", w: "w-32" },
];

function renderCell(emp: Employee, key: keyof Employee): React.ReactNode {
  const v = emp[key] as unknown;
  if (v === null || v === undefined || v === "") return <span className="text-gray-300">—</span>;
  if (typeof v === "boolean") return v ? "OK" : "—";
  if (key === "birth_date" || key === "admission_date") {
    const s = String(v);
    return s.slice(0, 10).split("-").reverse().join("/");
  }
  if (key === "status") {
    const cls = v === "ATIVO" ? "bg-emerald-100 text-emerald-700"
              : v === "INATIVO" ? "bg-red-100 text-red-700"
              : "bg-amber-100 text-amber-700";
    return <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${cls}`}>{String(v)}</span>;
  }
  return String(v);
}

function EmployeeSpreadsheetView({
  employees,
  searchValue,
  onSearchChange,
  onRowClick,
  canCreate,
  onCreate,
}: {
  employees: Employee[];
  searchValue: string;
  onSearchChange: (v: string) => void;
  onRowClick: (e: Employee) => void;
  canCreate: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-center justify-between">
        <input
          type="text"
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Buscar colaborador..."
          className="flex-1 max-w-xs px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
        />
        <span className="text-xs text-text-light">{employees.length} registro(s)</span>
        {canCreate && (
          <Button size="sm" onClick={onCreate}>
            <PlusIcon className="w-4 h-4" />Adicionar
          </Button>
        )}
      </div>

      <div className="overflow-auto border border-border rounded-lg max-h-[70vh]">
        <table className="text-xs whitespace-nowrap">
          <thead className="sticky top-0 bg-gray-50 z-10">
            <tr>
              {SHEET_COLUMNS.map((c) => (
                <th
                  key={String(c.key)}
                  className={`${c.w || ""} px-2 py-2 text-left font-semibold text-text-light border-b border-r border-border bg-gray-50`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {employees.length === 0 ? (
              <tr>
                <td colSpan={SHEET_COLUMNS.length} className="px-4 py-8 text-center text-text-light">
                  Nenhum colaborador encontrado
                </td>
              </tr>
            ) : (
              employees.map((emp, idx) => (
                <tr
                  key={emp.id}
                  onClick={() => onRowClick(emp)}
                  className={`cursor-pointer hover:bg-blue-50 transition ${
                    idx % 2 === 0 ? "bg-white" : "bg-gray-50/50"
                  }`}
                >
                  {SHEET_COLUMNS.map((c) => (
                    <td
                      key={String(c.key)}
                      className={`${c.w || ""} px-2 py-1.5 border-b border-r border-border overflow-hidden text-ellipsis`}
                    >
                      {renderCell(emp, c.key as keyof Employee)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-text-light italic">Clique em uma linha pra editar.</p>
    </div>
  );
}
