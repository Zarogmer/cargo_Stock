"use client";

import { useEffect, useState, useCallback } from "react";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { db } from "@/lib/db";
import { hasPermission } from "@/lib/rbac";
import { DataTable } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Tabs } from "@/components/ui/tabs";
import { PlusIcon, EditIcon, TrashIcon } from "@/components/icons";
import { formatPhone, matchSearch, parseLegacyDate, parseNrsWithDates, formatNrsWithDates, VALID_NRS, hasExpiredTraining, effectiveEmployeeStatus, employeeStatusLabel, type NrCode } from "@/lib/utils";
import { releaseFinishedShipAllocations } from "@/lib/release-finished-ships";
import type { Employee, JobFunction } from "@/types/database";
import { DocumentosTab } from "./documentos-tab";

export default function ColaboradoresPage() {
  const { profile } = useAuth();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") || "colaboradores";

  // EPI/Uniforme/Histórico migraram para o Almoxarifado — redireciona quem
  // chegar por um link/bookmark antigo de /colaboradores?tab=...
  const router = useRouter();
  const tabParam = searchParams.get("tab");
  useEffect(() => {
    if (tabParam === "epi" || tabParam === "uniforme" || tabParam === "historico") {
      router.replace(`/almoxarifado?tab=${tabParam}`);
    }
  }, [tabParam, router]);

  const role = profile?.role || "RH";
  const canCreate = hasPermission(role, "EPI", "create");
  const canEdit = hasPermission(role, "EPI", "edit");
  const canDelete = hasPermission(role, "EPI", "delete");
  // "Paga" (valor por função, igual à aba Valores do Financeiro) só Executivo e
  // Tecnologia podem alterar; RH e os demais apenas observam. Pedido do Guilherme.
  const canEditPaga = role === "EXECUTIVO" || role === "TECNOLOGIA";

  // --- EMPLOYEES ---
  const [employees, setEmployees] = useState<Employee[]>([]);
  // Funções vindas do Financeiro (tabela job_functions) — fonte única, usada no
  // formulário de cadastro pra manter Colaboradores e Financeiro em sincronia.
  const [jobRoleOptions, setJobRoleOptions] = useState<string[]>([]);
  // Funções completas (id + valor padrão) e o mapa de valores especiais por
  // colaborador ("empId-fnId" → rate), pra o modal e o detalhe mostrarem a
  // "Paga" certa conforme a função, sem fetch assíncrono ao abrir.
  const [jobFunctions, setJobFunctions] = useState<JobFunction[]>([]);
  const [specialRates, setSpecialRates] = useState<Map<string, number>>(new Map());
  const [empSearch, setEmpSearch] = useState("");
  const [empTeamFilter, setEmpTeamFilter] = useState("Todos");
  const [empStatusFilter, setEmpStatusFilter] = useState<"Todos" | "ATIVO" | "INATIVO" | "PENDENCIA">("Todos");
  const [empEscalaFilter, setEmpEscalaFilter] = useState<"Todos" | "DISPONIVEL" | "EMBARCADO" | "COSTADO">("Todos");
  const [empRoleFilter, setEmpRoleFilter] = useState("Todos");
  const [empViewMode, setEmpViewMode] = useState<"cards" | "spreadsheet">("cards");
  const [exportingXlsx, setExportingXlsx] = useState(false);
  const [empForm, setEmpForm] = useState(false);
  const [editEmp, setEditEmp] = useState<Employee | null>(null);
  const [deleteEmp, setDeleteEmp] = useState<Employee | null>(null);

  // --- EMPLOYEE DETAIL ---
  const [selectedEmp, setSelectedEmp] = useState<Employee | null>(null);
  const [empItems, setEmpItems] = useState<{ name: string; qty: number; source: string }[]>([]);
  const [loadingEmpItems, setLoadingEmpItems] = useState(false);

  // --- ESCALAÇÃO STATUS (active allocation kind per employee) ---
  const [escalaStatus, setEscalaStatus] = useState<Map<number, "EMBARQUE" | "COSTADO">>(new Map());

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setDbError(null);
    try {
      // Antes de listar, libera quem está embarcado em navio cuja data de
      // saída já passou. Mantém a coluna "Escalação" coerente sem exigir
      // intervenção manual do RH.
      try {
        await releaseFinishedShipAllocations(profile?.full_name || "sistema");
      } catch (err) {
        console.warn("[colaboradores] auto-release failed:", (err as Error).message);
      }

      const [empRes, allocRes, fnRes, rateRes] = await Promise.all([
        db.from("employees").select("*").order("name"),
        db.from("job_allocations").select("employee_id, kind, status").eq("status", "ATIVO"),
        db.from("job_functions").select("id, name, default_rate").order("name"),
        db.from("employee_function_rates").select("employee_id, function_id, rate"),
      ]);

      if (empRes.error) {
        console.error("DB error:", empRes.error);
        setDbError(`employees: ${empRes.error.code} ${empRes.error.message}`);
      }

      setEmployees(empRes.data || []);
      const fns = (fnRes.data as JobFunction[] | null) || [];
      setJobFunctions(fns);
      setJobRoleOptions(
        fns.map((f) => (f.name || "").trim()).filter(Boolean)
      );
      // Mapa "empId-fnId" → valor especial. O modal/detalhe usam pra puxar a Paga.
      const ratesMap = new Map<string, number>();
      ((rateRes.data as Array<{ employee_id: number; function_id: number; rate: string | number }> | null) || []).forEach((r) => {
        ratesMap.set(`${r.employee_id}-${r.function_id}`, Number(r.rate));
      });
      setSpecialRates(ratesMap);

      // Build escalação status map. EMBARQUE wins over COSTADO if both exist.
      const statusMap = new Map<number, "EMBARQUE" | "COSTADO">();
      ((allocRes.data as Array<{ employee_id: number | null; kind: string | null }> | null) || []).forEach((a) => {
        if (a.employee_id == null) return;
        const k = (a.kind || "EMBARQUE") as "EMBARQUE" | "COSTADO";
        const existing = statusMap.get(a.employee_id);
        if (!existing || (existing === "COSTADO" && k === "EMBARQUE")) {
          statusMap.set(a.employee_id, k);
        }
      });
      setEscalaStatus(statusMap);
    } catch (err) {
      console.error("loadAll error:", err);
    } finally {
      setLoading(false);
    }
  }, [profile?.full_name]);

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
        CONTRATO: e.contract_type ?? "",
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
  async function saveEmployee(data: Partial<Employee>, paga?: { functionId: number | null; rate: number | null }) {
    setSaving(true);
    const actor = profile?.full_name || "Sistema";
    const payload = { ...data, updated_by: actor } as any;
    const { data: saved, error } = editEmp
      ? await db.from("employees").update(payload).eq("id", editEmp.id)
      : await db.from("employees").insert(payload);
    if (error) {
      // Antes o erro era engolido e o modal fechava como se tivesse salvado —
      // por isso "alterar a função" parecia não funcionar. Agora avisa e mantém
      // o modal aberto pra não perder o que foi digitado.
      setSaving(false);
      alert(`Não foi possível salvar o colaborador: ${error.message}`);
      return;
    }
    // "Paga": grava o valor especial por função (employee_function_rates), igual
    // à aba Valores do Financeiro. Só Executivo/Tecnologia chegam aqui com `paga`.
    if (canEditPaga && paga && paga.functionId != null) {
      const empId = editEmp ? editEmp.id : (saved as any)?.id;
      if (empId != null) {
        const pagaErr = await saveSpecialRate(empId, paga.functionId, paga.rate);
        if (pagaErr) {
          setSaving(false);
          alert(`Colaborador salvo, mas não foi possível salvar a Paga: ${pagaErr}`);
          setEmpForm(false); setEditEmp(null); loadAll();
          return;
        }
      }
    }
    setSaving(false);
    setEmpForm(false); setEditEmp(null); loadAll();
  }

  // Grava/atualiza/remove o valor especial de um colaborador numa função e
  // propaga pros pagamentos em aberto — mesma lógica da aba Valores do
  // Financeiro. Retorna mensagem de erro (string) ou null em caso de sucesso.
  async function saveSpecialRate(employeeId: number, functionId: number, rate: number | null): Promise<string | null> {
    const fn = jobFunctions.find((f) => f.id === functionId);
    const defaultRate = fn ? Number(fn.default_rate) : NaN;
    const hasValue = rate != null && Number.isFinite(rate) && rate > 0;
    const isOverride = hasValue && rate !== defaultRate;

    const { data: existing } = await db
      .from("employee_function_rates")
      .select("id, rate")
      .eq("employee_id", employeeId)
      .eq("function_id", functionId);
    const row = ((existing as Array<{ id: number; rate: string | number }> | null) || [])[0];

    if (!row && !isOverride) return null; // já estava no valor padrão — nada a fazer

    let changed = false;
    if (isOverride) {
      if (row) {
        if (Number(row.rate) !== rate) {
          const res = await db.from("employee_function_rates").update({ rate }).eq("id", row.id);
          if (res?.error) return res.error.message;
          changed = true;
        }
      } else {
        const res = await db.from("employee_function_rates").insert({
          employee_id: employeeId, function_id: functionId, rate,
        });
        if (res?.error) return res.error.message;
        changed = true;
      }
    } else if (row) {
      // Voltou pro valor padrão da função → remove o override.
      const res = await db.from("employee_function_rates").delete().eq("id", row.id);
      if (res?.error) return res.error.message;
      changed = true;
    }
    if (!changed) return null;

    // Propaga pros pagamentos em aberto (jobs não fechados): as alocações desse
    // colaborador+função recebem o novo rate efetivo, igual ao Financeiro.
    const effective = isOverride ? (rate as number) : defaultRate;
    if (Number.isFinite(effective)) {
      const { data: openJobs } = await db
        .from("jobs").select("id").in("status", ["ABERTO", "EM_ANDAMENTO", "VERIFICADO"]);
      const openJobIds = ((openJobs as { id: number }[] | null) || []).map((j) => j.id);
      if (openJobIds.length > 0) {
        await db.from("job_allocations").update({ rate: effective })
          .eq("employee_id", employeeId)
          .eq("function_id", functionId)
          .in("job_id", openJobIds);
      }
    }
    return null;
  }

  // --- COLUMNS ---
  const teamLabels: Record<string, string> = { EQUIPE_1: "Equipe 1", EQUIPE_2: "Equipe 2", EQUIPE_3: "Equipe 3", COSTADO: "Costado" };
  const teamColors: Record<string, string> = { EQUIPE_1: "bg-blue-100 text-blue-700", EQUIPE_2: "bg-purple-100 text-purple-700", EQUIPE_3: "bg-teal-100 text-teal-700", COSTADO: "bg-amber-100 text-amber-700" };
  const empColumns = [
    { key: "name", label: "Nome", render: (e: Employee) => {
      const k = escalaStatus.get(e.id);
      const phone = formatPhone(e.phone);
      return (
        <div className="flex flex-col gap-1 min-w-0">
          <span className="font-medium break-words">{e.name}</span>
          {/* Mobile-only inline info — desktop has dedicated columns */}
          <div className="md:hidden flex flex-wrap gap-1 text-[10px]">
            {e.role && <span className="px-1.5 py-0.5 rounded-full font-medium bg-blue-100 text-blue-700">{e.role}</span>}
            {e.team && <span className={`px-1.5 py-0.5 rounded-full font-medium ${teamColors[e.team] || ""}`}>{teamLabels[e.team]}</span>}
            {k === "EMBARQUE" && <span className="px-1.5 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">⚓ Embarcado</span>}
            {k === "COSTADO" && <span className="px-1.5 py-0.5 rounded-full font-medium bg-cyan-100 text-cyan-700">⛏️ Costado</span>}
            {!k && <span className="px-1.5 py-0.5 rounded-full font-medium bg-emerald-100 text-emerald-700">✓ Disponível</span>}
            {e.sector && <span className="px-1.5 py-0.5 rounded-full font-medium bg-purple-100 text-purple-700">{e.sector}</span>}
          </div>
          {phone && <span className="md:hidden text-[11px] text-text-light font-mono">{phone}</span>}
        </div>
      );
    }},
    { key: "status", label: "Status", render: (e: Employee) => {
      const eff = effectiveEmployeeStatus(e);
      const cls = eff === "ATIVO" ? "bg-emerald-100 text-emerald-700"
                : eff === "INATIVO" ? "bg-red-100 text-red-700"
                : "bg-amber-100 text-amber-700";
      const autoFlagged = eff === "PENDENCIA" && e.status === "ATIVO";
      return (
        <span
          className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}
          title={autoFlagged ? "Pendência automática: treinamento (ASO/NR/Meio Ambiente) vencido" : undefined}
        >
          {employeeStatusLabel(eff)}{autoFlagged ? " ⚠️" : ""}
        </span>
      );
    }},
    { key: "role", label: "Função", hideOnMobile: true, render: (e: Employee) => e.role ? <span className="text-xs font-medium">{e.role}</span> : <span className="text-text-light text-xs">—</span> },
    { key: "contract_type", label: "Contrato", hideOnMobile: true, render: (e: Employee) => {
      if (!e.contract_type) return <span className="text-text-light text-xs">—</span>;
      const cls = e.contract_type === "REGISTRADO" ? "bg-emerald-100 text-emerald-700" : "bg-orange-100 text-orange-700";
      const label = e.contract_type === "REGISTRADO" ? "Mensalista" : "Intermitente";
      return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>;
    }},
    { key: "sector", label: "Setor", hideOnMobile: true, render: (e: Employee) => e.sector || "—" },
    { key: "team", label: "Equipe", hideOnMobile: true, render: (e: Employee) => e.team ? <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${teamColors[e.team] || ""}`}>{teamLabels[e.team]}</span> : <span className="text-text-light text-xs">—</span> },
    { key: "escalacao", label: "Escalação", hideOnMobile: true, render: (e: Employee) => {
      const k = escalaStatus.get(e.id);
      if (k === "EMBARQUE") return <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">⚓ Embarcado</span>;
      if (k === "COSTADO") return <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-cyan-100 text-cyan-700">⛏️ Costado</span>;
      return <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-emerald-100 text-emerald-700">✓ Disponível</span>;
    }},
    { key: "phone", label: "Telefone", hideOnMobile: true, render: (e: Employee) => formatPhone(e.phone) },
    { key: "actions", label: "", className: "w-20", render: (e: Employee) => (
      <div className="flex gap-1">
        {canEdit && <button onClick={(ev) => { ev.stopPropagation(); setEditEmp(e); setEmpForm(true); }} className="p-1.5 text-primary hover:bg-blue-50 rounded"><EditIcon /></button>}
        {canDelete && <button onClick={(ev) => { ev.stopPropagation(); setDeleteEmp(e); }} className="p-1.5 text-danger hover:bg-red-50 rounded"><TrashIcon /></button>}
      </div>
    )},
  ];

  const tabs = [
    {
      key: "colaboradores", label: "Colaboradores",
      content: (() => {
        // Funções disponíveis para o filtro — derivadas dos próprios dados, então
        // sempre refletem o que está cadastrado (inclusive valores personalizados).
        const availableRoles = Array.from(
          new Set(employees.map((e) => (e.role || "").trim()).filter(Boolean))
        ).sort((a, b) => a.localeCompare(b, "pt-BR"));
        const filteredEmployees = employees.filter((e) => {
          const nameMatch = matchSearch(e.name, empSearch);
          const statusMatch = empStatusFilter === "Todos" ? true : effectiveEmployeeStatus(e) === empStatusFilter;
          const teamMatch = empTeamFilter === "Todos" ? true :
            empTeamFilter === "Equipe 1" ? e.team === "EQUIPE_1" :
            empTeamFilter === "Equipe 2" ? e.team === "EQUIPE_2" :
            empTeamFilter === "Equipe 3" ? e.team === "EQUIPE_3" :
            empTeamFilter === "Costado" ? e.team === "COSTADO" :
            empTeamFilter === "Sem equipe" ? !e.team : true;
          const k = escalaStatus.get(e.id);
          const escalaMatch = empEscalaFilter === "Todos" ? true :
            empEscalaFilter === "DISPONIVEL" ? !k :
            empEscalaFilter === "EMBARCADO" ? k === "EMBARQUE" :
            empEscalaFilter === "COSTADO" ? k === "COSTADO" : true;
          const roleMatch = empRoleFilter === "Todos" ? true : (e.role || "").trim() === empRoleFilter;
          return nameMatch && statusMatch && teamMatch && escalaMatch && roleMatch;
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
                  {t === "Todos" ? "Todos" : employeeStatusLabel(t)}
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
            <div className="flex gap-2 flex-wrap items-center">
              <span className="text-xs text-text-light font-semibold uppercase tracking-wider">Escalação:</span>
              {([
                { key: "Todos", label: "Todos" },
                { key: "DISPONIVEL", label: "✓ Disponível" },
                { key: "EMBARCADO", label: "⚓ Embarcado" },
                { key: "COSTADO", label: "⛏️ Costado" },
              ] as const).map((t) => (
                <button key={t.key} onClick={() => setEmpEscalaFilter(t.key as typeof empEscalaFilter)}
                  className={`px-3 py-1.5 text-xs rounded-full font-medium transition ${empEscalaFilter === t.key ? "bg-primary text-white" : "bg-gray-100 text-text-light hover:bg-gray-200"}`}>
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex gap-2 flex-wrap items-center">
              <span className="text-xs text-text-light font-semibold uppercase tracking-wider">Função:</span>
              <select value={empRoleFilter} onChange={(e) => setEmpRoleFilter(e.target.value)}
                className={`px-3 py-1.5 text-xs rounded-full font-medium border outline-none transition focus:ring-2 focus:ring-primary cursor-pointer ${empRoleFilter !== "Todos" ? "bg-primary text-white border-primary" : "bg-gray-100 text-text-light border-transparent hover:bg-gray-200"}`}>
                <option value="Todos">Todas as funções</option>
                {availableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {empRoleFilter !== "Todos" && (
                <button onClick={() => setEmpRoleFilter("Todos")}
                  className="px-2 py-1.5 text-xs rounded-full font-medium text-text-light hover:bg-gray-200 transition"
                  title="Limpar filtro de função">
                  ✕ Limpar
                </button>
              )}
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
      key: "documentos", label: "Documentos",
      content: <DocumentosTab employees={employees} />,
    },
  ];

  const activeTabLabel = tabs.find((t) => t.key === initialTab)?.label;
  const docSub = searchParams.get("doc");
  const docSubLabel: Record<string, string> = {
    "dds": "DDS",
    "ficha-epi": "Ficha de EPI",
    "aviso-medico": "Aviso Médico",
    "recibo-pagamento": "Recibo de Pagamento",
    "folha-ponto": "Folha de Ponto",
  };
  const docCrumb = initialTab === "documentos" ? docSubLabel[docSub || "dds"] : null;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h1 className="text-2xl font-bold text-text">RH</h1>
        {activeTabLabel && (
          <>
            <span className="text-text-light">›</span>
            <span className="text-lg font-semibold text-text-light">{activeTabLabel}</span>
          </>
        )}
        {docCrumb && (
          <>
            <span className="text-text-light">›</span>
            <span className="text-lg font-semibold text-text-light">{docCrumb}</span>
          </>
        )}
      </div>

      {dbError && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 font-mono break-all">
          ⚠️ Erro ao carregar dados: {dbError}
        </div>
      )}

      <Tabs tabs={tabs} defaultTab={initialTab} hideHeader />

      {/* Employee Form */}
      <EmployeeFormModal open={empForm} onClose={() => { setEmpForm(false); setEditEmp(null); }} onSave={saveEmployee} item={editEmp} saving={saving} roleOptions={jobRoleOptions} functions={jobFunctions} specialRates={specialRates} canEditPaga={canEditPaga} />
      <ConfirmDialog open={!!deleteEmp} onClose={() => setDeleteEmp(null)} onConfirm={async () => { setSaving(true); await db.from("employees").delete().eq("id", deleteEmp!.id); setSaving(false); setDeleteEmp(null); loadAll(); }} title="Excluir Colaborador" message={`Excluir "${deleteEmp?.name}"?`} loading={saving} />

      {/* Employee Detail */}
      <Modal open={!!selectedEmp} onClose={() => setSelectedEmp(null)} title={selectedEmp?.name || ""}>
        {selectedEmp && (
          <div className="space-y-4">
            {/* Status / função */}
            <div className="flex flex-wrap gap-2">
              {selectedEmp.status && (() => {
                const eff = effectiveEmployeeStatus(selectedEmp);
                const autoFlagged = eff === "PENDENCIA" && selectedEmp.status === "ATIVO";
                const cls = eff === "ATIVO" ? "bg-emerald-100 text-emerald-700"
                          : eff === "INATIVO" ? "bg-red-100 text-red-700"
                          : "bg-amber-100 text-amber-700";
                return (
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-medium ${cls}`}
                    title={autoFlagged ? "Pendência automática: treinamento vencido" : undefined}
                  >
                    {employeeStatusLabel(eff)}{autoFlagged ? " ⚠️" : ""}
                  </span>
                );
              })()}
              {selectedEmp.role && <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 font-medium">{selectedEmp.role}</span>}
              {selectedEmp.contract_type && (
                <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                  selectedEmp.contract_type === "REGISTRADO" ? "bg-emerald-100 text-emerald-700" : "bg-orange-100 text-orange-700"
                }`}>
                  {selectedEmp.contract_type === "REGISTRADO" ? "Mensalista" : "Intermitente"}
                </span>
              )}
              {selectedEmp.sector && <span className="text-xs px-2 py-1 rounded-full bg-purple-100 text-purple-700 font-medium">{selectedEmp.sector}</span>}
              {selectedEmp.team && <span className={`text-xs px-2 py-1 rounded-full font-medium ${teamColors[selectedEmp.team] || ""}`}>{teamLabels[selectedEmp.team]}</span>}
              {(() => {
                const k = escalaStatus.get(selectedEmp.id);
                if (k === "EMBARQUE") return <span className="text-xs px-2 py-1 rounded-full font-medium bg-amber-100 text-amber-700">⚓ Embarcado</span>;
                if (k === "COSTADO") return <span className="text-xs px-2 py-1 rounded-full font-medium bg-cyan-100 text-cyan-700">⛏️ Escalado no Costado</span>;
                return <span className="text-xs px-2 py-1 rounded-full font-medium bg-emerald-100 text-emerald-700">✓ Disponível</span>;
              })()}
            </div>

            {/* Pessoais */}
            <div className="grid grid-cols-2 gap-3 text-sm">
              {selectedEmp.cpf && <div><span className="text-text-light">CPF:</span> <span className="font-medium font-mono">{selectedEmp.cpf}</span></div>}
              {selectedEmp.rg && <div><span className="text-text-light">RG:</span> <span className="font-medium font-mono">{selectedEmp.rg}</span></div>}
              {selectedEmp.isps_code && <div><span className="text-text-light">ISPS:</span> <span className="font-medium font-mono">{selectedEmp.isps_code}</span></div>}
              {selectedEmp.e_social && <div><span className="text-text-light">E-Social:</span> <span className="font-medium">{selectedEmp.e_social}</span></div>}
              <div><span className="text-text-light">Telefone:</span> <span className="font-medium">{formatPhone(selectedEmp.phone)}</span></div>
              {selectedEmp.family_phone && <div><span className="text-text-light">Tel. Familiar:</span> <span className="font-medium">{formatPhone(selectedEmp.family_phone)}</span></div>}
              {selectedEmp.birth_date && <div><span className="text-text-light">Nascimento:</span> <span className="font-medium">{selectedEmp.birth_date.slice(0, 10)}</span></div>}
              {selectedEmp.admission_date && <div><span className="text-text-light">Admissão:</span> <span className="font-medium">{selectedEmp.admission_date.slice(0, 10)}</span></div>}
              {selectedEmp.email && <div className="col-span-2"><span className="text-text-light">Email:</span> <span className="font-medium">{selectedEmp.email}</span></div>}
              {(() => {
                const p = effectivePaga(jobFunctions, specialRates, selectedEmp.id, selectedEmp.role);
                if (!p) return null;
                return <div><span className="text-text-light">Paga:</span> <span className="font-medium text-emerald-700">R$ {formatRateBR(p.rate)}{p.isSpecial ? " (especial)" : ""}</span></div>;
              })()}
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
                  {selectedEmp.nrs_training && (() => {
                    const map = parseNrsWithDates(selectedEmp.nrs_training);
                    const entries = Object.entries(map);
                    if (entries.length === 0) {
                      return <div className="col-span-2"><span className="text-text-light">NRs:</span> <span className="font-medium">{selectedEmp.nrs_training}</span></div>;
                    }
                    return (
                      <div className="col-span-2">
                        <span className="text-text-light">NRs:</span>{" "}
                        <span className="inline-flex flex-wrap gap-1 align-middle">
                          {entries.map(([nr, date]) => (
                            <span key={nr} className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">
                              NR-{nr}{date ? ` · ${date.split("-").reverse().join("/")}` : ""}
                            </span>
                          ))}
                        </span>
                      </div>
                    );
                  })()}
                  {selectedEmp.meio_ambiente_training && <div><span className="text-text-light">Meio Ambiente:</span> <span className="font-medium">{(() => { const iso = parseLegacyDate(selectedEmp.meio_ambiente_training); return iso ? iso.split("-").reverse().join("/") : selectedEmp.meio_ambiente_training; })()}</span></div>}
                  {selectedEmp.last_aso_date && <div><span className="text-text-light">Último ASO:</span> <span className="font-medium">{(() => { const iso = parseLegacyDate(selectedEmp.last_aso_date); return iso ? iso.split("-").reverse().join("/") : selectedEmp.last_aso_date; })()}</span></div>}
                  {selectedEmp.aso_status && <div><span className="text-text-light">Status ASO:</span> <span className="font-medium">{selectedEmp.aso_status}</span></div>}
                </div>
                <div className="flex gap-3 flex-wrap mt-2">
                  {selectedEmp.lifeguard_training && <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-100 text-cyan-700 font-medium">🛟 Salva-Vidas</span>}
                  {selectedEmp.rubber_boot && <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 font-medium">🥾 Bota Borracha</span>}
                  {selectedEmp.has_vaccination_card && <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">💉 Vacinação</span>}
                  {selectedEmp.has_cnh && <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">🚗 CNH</span>}
                  {selectedEmp.realiza_limpeza && <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">⚓ Limpeza</span>}
                  {selectedEmp.does_costado && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">⛏️ Costado</span>}
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

// Parse a CSV/legacy NRs string into a Set of NR numbers ("1", "6", "7", ...).
// Accepts: "1,6,7,17,29,35" (CSV) or legacy text like "14 e 15 janeiro 2025"
// (returns empty Set in that case — user will re-check the boxes).
function toggleNr(current: string, nr: NrCode, checked: boolean): string {
  const map = parseNrsWithDates(current);
  if (checked) {
    if (!(nr in map)) map[nr] = "";
  } else {
    delete map[nr];
  }
  return formatNrsWithDates(map);
}

function setNrDate(current: string, nr: NrCode, date: string): string {
  const map = parseNrsWithDates(current);
  map[nr] = date;
  return formatNrsWithDates(map);
}

function formatPhoneMask(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return `(${digits}`;
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

// Formata um valor em reais no padrão BR: 2 casas e vírgula decimal (320 → "320,00").
function formatRateBR(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2).replace(".", ",") : "";
}

// Paga efetiva = valor especial do colaborador na função (se houver) ou o valor
// padrão da função. Fonte única usada no modal e no detalhe do colaborador.
function effectivePaga(
  functions: JobFunction[],
  specialRates: Map<string, number>,
  employeeId: number | null | undefined,
  roleName: string | null | undefined,
): { rate: number; isSpecial: boolean; functionId: number } | null {
  const fn = functions.find((f) => f.name === roleName);
  if (!fn) return null;
  const special = employeeId != null ? specialRates.get(`${employeeId}-${fn.id}`) : undefined;
  const rate = special != null ? special : Number(fn.default_rate);
  if (!Number.isFinite(rate)) return null;
  return { rate, isSpecial: special != null, functionId: fn.id };
}

function EmployeeFormModal({ open, onClose, onSave, item, saving, roleOptions, functions, specialRates, canEditPaga }: { open: boolean; onClose: () => void; onSave: (d: Partial<Employee>, paga?: { functionId: number | null; rate: number | null }) => void; item: Employee | null; saving: boolean; roleOptions: string[]; functions: JobFunction[]; specialRates: Map<string, number>; canEditPaga: boolean }) {
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
  // Profissional
  const [status, setStatus] = useState<string>("ATIVO");
  const [sector, setSector] = useState<string>("");
  const [role, setRole] = useState("");
  // "Paga" — valor por função (especial do colaborador ou padrão da função).
  // Substitui o antigo campo "Salário" no formulário.
  const [paga, setPaga] = useState("");
  const [admissionDate, setAdmissionDate] = useState("");
  const [contractType, setContractType] = useState<string>("");
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
  const [doesCostado, setDoesCostado] = useState(false);

  useEffect(() => {
    if (item) {
      setName(item.name); setTeam(item.team || ""); setPhone(item.phone ? formatPhoneMask(item.phone) : "");
      setEmail(item.email || ""); setBirthDate(item.birth_date?.slice(0, 10) || "");
      setFamilyPhone(item.family_phone ? formatPhoneMask(item.family_phone) : ""); setNotes(item.notes || "");
      setCpf(item.cpf || ""); setRg(item.rg || "");
      setIspsCode(item.isps_code || ""); setESocial(item.e_social || "");
      setStatus(item.status || "ATIVO");
      setSector(item.sector || "");
      setRole(item.role || "");
      { const p = effectivePaga(functions, specialRates, item.id, item.role); setPaga(p ? formatRateBR(p.rate) : ""); }
      setAdmissionDate(item.admission_date?.slice(0, 10) || "");
      setContractType(item.contract_type || "");
      setBankName(item.bank_name || ""); setBankAgency(item.bank_agency || "");
      setBankAccount(item.bank_account || ""); setBankAccountType(item.bank_account_type || "");
      setHasVaccinationCard(item.has_vaccination_card || false);
      setHasCnh(item.has_cnh || false);
      setNrsTraining(item.nrs_training || "");
      setMeioAmbienteTraining(parseLegacyDate(item.meio_ambiente_training));
      setLifeguardTraining(item.lifeguard_training || false);
      setRubberBoot(item.rubber_boot || false);
      setBootSize(item.boot_size || "");
      setShirtSize(item.shirt_size || "");
      setBermudaSize(item.bermuda_size || "");
      setLastAsoDate(parseLegacyDate(item.last_aso_date));
      setAsoStatus(item.aso_status || "");
      setRealizaLimpeza(item.realiza_limpeza || false);
      setDoesCostado(item.does_costado || false);
    } else {
      setName(""); setTeam(""); setPhone(""); setEmail(""); setBirthDate("");
      setFamilyPhone(""); setNotes("");
      setCpf(""); setRg(""); setIspsCode(""); setESocial("");
      setStatus("ATIVO"); setSector(""); setRole(""); setPaga(""); setAdmissionDate(""); setContractType("");
      setBankName(""); setBankAgency(""); setBankAccount(""); setBankAccountType("");
      setHasVaccinationCard(false); setHasCnh(false);
      setNrsTraining(""); setMeioAmbienteTraining("");
      setLifeguardTraining(false); setRubberBoot(false);
      setBootSize(""); setShirtSize(""); setBermudaSize("");
      setLastAsoDate(""); setAsoStatus(""); setRealizaLimpeza(false);
      setDoesCostado(false);
    }
  }, [item, open]);

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  // Auto-derive Status ASO from the last ASO date — vencido if the 1-year
  // renewal already passed, OK otherwise. Empty if no date set.
  useEffect(() => {
    if (!lastAsoDate) {
      setAsoStatus("");
      return;
    }
    const last = new Date(lastAsoDate + "T00:00:00");
    if (Number.isNaN(last.getTime())) return;
    const next = new Date(last);
    next.setFullYear(next.getFullYear() + 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    setAsoStatus(next.getTime() < today.getTime() ? "VENCIDO" : "OK");
  }, [lastAsoDate]);

  // Auto-upgrade Status to PENDENCIA whenever any training (ASO / NR /
  // Meio Ambiente) is expired. Never downgrades — user has to clear it
  // manually once retrained — and never overrides INATIVO.
  useEffect(() => {
    if (status === "INATIVO" || status === "PENDENCIA") return;
    if (hasExpiredTraining({
      last_aso_date: lastAsoDate || null,
      nrs_training: nrsTraining || null,
      meio_ambiente_training: meioAmbienteTraining || null,
    })) {
      setStatus("PENDENCIA");
    }
  }, [lastAsoDate, nrsTraining, meioAmbienteTraining, status]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const selectedFn = functions.find((f) => f.name === role);
    const parsedPaga = paga.trim() === "" ? null : Number(paga.replace(",", "."));
    const pagaRate = parsedPaga != null && Number.isFinite(parsedPaga) ? parsedPaga : null;
    onSave({
      name, team: (team as any) || null, phone: phone || null,
      email: email || null, birth_date: birthDate || null,
      family_phone: familyPhone || null, notes: notes || null,
      cpf: cpf.replace(/\D/g, "") || null,
      rg: rg || null,
      isps_code: ispsCode || null,
      e_social: eSocial || null,
      status: (status as any) || "ATIVO",
      sector: (sector as any) || null,
      role: role || null,
      admission_date: admissionDate || null,
      contract_type: (contractType as any) || null,
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
      does_costado: doesCostado,
    }, { functionId: selectedFn?.id ?? null, rate: pagaRate });
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
            <div className="grid grid-cols-2 gap-4 mt-4">
              <div><label className="block text-sm font-medium mb-1">ISPS Code</label><input type="text" value={ispsCode} onChange={(e) => setIspsCode(e.target.value)} className={inputCls} /></div>
              <div><label className="block text-sm font-medium mb-1">E-Social</label><input type="text" value={eSocial} onChange={(e) => setESocial(e.target.value)} className={inputCls} /></div>
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
                <option value="INATIVO">Demitido</option>
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
              <select
                value={role}
                onChange={(e) => {
                  const newRole = e.target.value;
                  setRole(newRole);
                  // A Paga acompanha a função: puxa o valor especial do colaborador
                  // nessa função ou, na falta dele, o valor padrão da função.
                  const p = effectivePaga(functions, specialRates, item?.id ?? null, newRole);
                  setPaga(p ? formatRateBR(p.rate) : "");
                }}
                className={inputCls}
              >
                <option value="">Selecionar...</option>
                {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
                {/* Mantém o valor atual visível mesmo que não esteja na lista de
                    funções do Financeiro (cadastro antigo ainda não ajustado). */}
                {role && !roleOptions.includes(role) && <option value={role}>{role}</option>}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 flex items-center gap-2">
                Paga (R$)
                {(() => {
                  const p = effectivePaga(functions, specialRates, item?.id ?? null, role);
                  if (!p) return null;
                  return (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${p.isSpecial ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"}`}>
                      {p.isSpecial ? "valor especial" : "valor da função"}
                    </span>
                  );
                })()}
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={paga}
                onChange={(e) => setPaga(e.target.value)}
                onBlur={() => {
                  const raw = paga.trim().replace(",", ".");
                  if (raw === "") return;
                  const n = Number(raw);
                  if (Number.isFinite(n)) setPaga(formatRateBR(n));
                }}
                placeholder="0,00"
                disabled={!canEditPaga || !role}
                title={!canEditPaga ? "Somente Executivo e Tecnologia podem alterar a Paga" : (!role ? "Selecione a função primeiro" : undefined)}
                className={`${inputCls}${(!canEditPaga || !role) ? " bg-gray-50 text-text-light cursor-not-allowed" : ""}`}
              />
              <p className="text-[10px] text-text-light mt-1">
                {!canEditPaga
                  ? "Somente leitura · valor por função (Executivo/Tecnologia editam)."
                  : !role
                    ? "Selecione a função pra ver/editar a paga."
                    : "Vazio ou igual ao padrão remove o valor especial."}
              </p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Tipo de Contrato</label>
            <select value={contractType} onChange={(e) => setContractType(e.target.value)} className={inputCls}>
              <option value="">—</option>
              <option value="REGISTRADO">Mensalista</option>
              <option value="INTERMITENTE">Contrato Intermitente</option>
            </select>
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
            <div>
              <label className="block text-sm font-medium mb-1">Banco</label>
              <select value={bankName} onChange={(e) => setBankName(e.target.value)} className={inputCls}>
                <option value="">Selecionar...</option>
                <option value="BRADESCO">Bradesco</option>
                <option value="ITAU">Itaú</option>
                <option value="SANTANDER">Santander</option>
                <option value="PENDENCIA">Pendência</option>
              </select>
            </div>
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
          <div>
            <label className="block text-sm font-medium mb-2">NRs realizadas</label>
            <div className="space-y-2 p-3 bg-gray-50 border border-border rounded-lg">
              {VALID_NRS.map((nr) => {
                const map = parseNrsWithDates(nrsTraining);
                const selected = nr in map;
                const date = map[nr] || "";
                return (
                  <div key={nr} className="flex items-center gap-3">
                    <label className="flex items-center gap-2 cursor-pointer w-20 shrink-0">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(e) => setNrsTraining(toggleNr(nrsTraining, nr, e.target.checked))}
                        className="w-4 h-4 accent-primary"
                      />
                      <span className="text-sm font-medium">NR-{nr}</span>
                    </label>
                    <input
                      type="date"
                      value={date}
                      disabled={!selected}
                      onChange={(e) => setNrsTraining(setNrDate(nrsTraining, nr, e.target.value))}
                      className="flex-1 px-3 py-1.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none disabled:bg-gray-100 disabled:text-text-light"
                    />
                  </div>
                );
              })}
            </div>
            <p className="text-[10px] text-text-light mt-1">Marque a NR e informe a data em que foi concluída. Validade ~1 ano — aparece no alerta da dashboard ao se aproximar do vencimento.</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Meio Ambiente</label>
              <input type="date" value={meioAmbienteTraining} onChange={(e) => setMeioAmbienteTraining(e.target.value)} className={inputCls} />
              <p className="text-[10px] text-text-light mt-1">Validade ~1 ano.</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Último ASO</label>
              <input type="date" value={lastAsoDate} onChange={(e) => setLastAsoDate(e.target.value)} className={inputCls} />
              <p className="text-[10px] text-text-light mt-1">Próximo ASO em ~1 ano. Aparece no alerta da dashboard quando estiver próximo do vencimento.</p>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Status ASO</label>
            <select value={asoStatus} onChange={(e) => setAsoStatus(e.target.value)} className={inputCls}>
              <option value="">—</option>
              <option value="OK">OK</option>
              <option value="VENCIDO">Vencido</option>
            </select>
            <p className="text-[10px] text-text-light mt-1">Atualiza automaticamente ao alterar a data do Último ASO (vencido se passou de 1 ano).</p>
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
            <p className="text-xs font-semibold text-text-light uppercase tracking-wider mb-3">EPIs Específicos</p>
            <div className="flex gap-6 flex-wrap">
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
          <div className="border-t border-border pt-3 space-y-3">
            <div>
              <p className="text-xs font-semibold text-text-light uppercase tracking-wider mb-2">Documentos</p>
              <div className="flex gap-6 flex-wrap">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={hasVaccinationCard} onChange={(e) => setHasVaccinationCard(e.target.checked)} className="w-4 h-4 accent-primary" />
                  <span className="text-sm">💉 Cartão de Vacinação</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={hasCnh} onChange={(e) => setHasCnh(e.target.checked)} className="w-4 h-4 accent-primary" />
                  <span className="text-sm">🚗 CNH</span>
                </label>
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold text-text-light uppercase tracking-wider mb-2">Operacional</p>
              <div className="flex gap-6 flex-wrap">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={realizaLimpeza} onChange={(e) => setRealizaLimpeza(e.target.checked)} className="w-4 h-4 accent-primary" />
                  <span className="text-sm">⚓ Limpeza</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={doesCostado} onChange={(e) => setDoesCostado(e.target.checked)} className="w-4 h-4 accent-primary" />
                  <span className="text-sm">⛏️ Costado</span>
                </label>
              </div>
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

// --- SPREADSHEET VIEW (matches the original .xlsx layout) ---

const SHEET_COLUMNS: { key: keyof Employee | "__index" | "actions"; label: string; w?: string }[] = [
  { key: "__index", label: "#", w: "w-10" },
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
  { key: "contract_type", label: "Contrato", w: "w-28" },
  { key: "sector", label: "Setor", w: "w-32" },
];

function renderCell(emp: Employee, key: keyof Employee): React.ReactNode {
  const v = emp[key] as unknown;
  if (v === null || v === undefined || v === "") return <span className="text-gray-300">—</span>;
  if (typeof v === "boolean") return v ? "OK" : "—";
  if (key === "phone" || key === "family_phone") {
    return formatPhone(String(v));
  }
  if (key === "birth_date" || key === "admission_date") {
    const s = String(v);
    return s.slice(0, 10).split("-").reverse().join("/");
  }
  if (key === "last_aso_date" || key === "meio_ambiente_training") {
    const iso = parseLegacyDate(String(v));
    return iso ? iso.split("-").reverse().join("/") : String(v);
  }
  if (key === "status") {
    const eff = effectiveEmployeeStatus(emp);
    const autoFlagged = eff === "PENDENCIA" && emp.status === "ATIVO";
    const cls = eff === "ATIVO" ? "bg-emerald-100 text-emerald-700"
              : eff === "INATIVO" ? "bg-red-100 text-red-700"
              : "bg-amber-100 text-amber-700";
    return (
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${cls}`}
        title={autoFlagged ? "Pendência automática: treinamento vencido" : undefined}
      >
        {employeeStatusLabel(eff)}{autoFlagged ? " ⚠️" : ""}
      </span>
    );
  }
  if (key === "contract_type") {
    const cls = v === "REGISTRADO" ? "bg-emerald-100 text-emerald-700" : "bg-orange-100 text-orange-700";
    const label = v === "REGISTRADO" ? "Mensalista" : "Intermitente";
    return <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${cls}`}>{label}</span>;
  }
  if (key === "nrs_training") {
    const map = parseNrsWithDates(String(v));
    const entries = Object.entries(map);
    if (entries.length === 0) return String(v);
    return (
      <span className="inline-flex flex-wrap gap-0.5">
        {entries.map(([nr]) => (
          <span key={nr} className="text-[9px] px-1 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">{nr}</span>
        ))}
      </span>
    );
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
                      {c.key === "__index"
                        ? <span className="text-text-light tabular-nums">{idx + 1}</span>
                        : renderCell(emp, c.key as keyof Employee)}
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
