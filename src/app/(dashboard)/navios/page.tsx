"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { releaseFinishedShipAllocations, promoteStartedShips } from "@/lib/release-finished-ships";
import { useSendWhatsappPref, EnviarWhatsappToggle } from "@/lib/escala-whatsapp-pref";
import { PlusIcon, EditIcon, TrashIcon, SearchIcon } from "@/components/icons";
import { SHIFT_PERIODS, isEscalableJobUnit, type ShiftPeriod } from "@/types/database";
import { Modal } from "@/components/ui/modal";

// ─── Types ───────────────────────────────────────────────────────────────────

type ShipStatus = "AGENDADO" | "EM_OPERACAO" | "CONCLUIDO" | "CANCELADO";

type BoardingSituation = "VISTORIA" | "IMEDIATO" | "AGENDADO" | "PERSONALIZADO";

interface Ship {
  id: string;
  name: string;
  arrival_date: string | null;
  departure_date: string | null;
  port: string | null;
  status: ShipStatus;
  assigned_team: string | null;
  notes: string | null;
  cargo_type: string | null;
  holds_count: number | null;
  client_name: string | null;
  services: string[];
  boarding_situation: BoardingSituation | null;
  boarding_scheduled_at: string | null;
  boarding_custom_text: string | null;
  created_at: string;
  created_by: string;
}

type OperationType = "EMBARQUE" | "COSTADO";

const EMBARQUE_SERVICES: { value: string; label: string }[] = [
  { value: "LAVAGEM_PORAO", label: "Lavagem de Porão" },
  { value: "PINTURA", label: "Pintura" },
  { value: "RASPAGEM", label: "Raspagem" },
];

const SERVICE_LABELS: Record<string, string> = {
  ...Object.fromEntries(EMBARQUE_SERVICES.map((s) => [s.value, s.label])),
  COSTADO: "Costado",
};

// Tipo é derivado de services: ["COSTADO"] = Costado; senão = Embarque.
function getOperationType(services: string[] | null | undefined): OperationType {
  return services && services.includes("COSTADO") ? "COSTADO" : "EMBARQUE";
}

interface Employee {
  id: number;
  name: string;
  team: string | null;
  phone: string | null;
  status: string | null;
  role: string | null;
  sector: "OPERACIONAL" | "ADMINISTRATIVO" | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STATUS_OPTIONS: ShipStatus[] = ["AGENDADO", "EM_OPERACAO", "CONCLUIDO", "CANCELADO"];

const STATUS_LABELS: Record<ShipStatus, string> = {
  AGENDADO: "Agendado",
  EM_OPERACAO: "Em Operação",
  CONCLUIDO: "Concluído",
  CANCELADO: "Cancelado",
};

const STATUS_COLORS: Record<ShipStatus, string> = {
  AGENDADO: "bg-blue-100 text-blue-700",
  EM_OPERACAO: "bg-amber-100 text-amber-700",
  CONCLUIDO: "bg-emerald-100 text-emerald-700",
  CANCELADO: "bg-red-100 text-red-700",
};

const EMPTY_FORM = {
  name: "",
  arrival_date: "",
  departure_date: "",
  port: "",
  status: "AGENDADO" as ShipStatus,
  assigned_team: "" as string,
  cargo_type: "",
  holds_count: "" as string, // stored as text in the form so the input can be empty
  client_name: "",
  operation_type: "EMBARQUE" as OperationType,
  services: [] as string[], // só populado quando operation_type=EMBARQUE
  // Situação do embarque (EMBARQUE only). "" = não informado.
  boarding_situation: "" as BoardingSituation | "",
  // Usado só quando boarding_situation=AGENDADO. Formato datetime-local: "YYYY-MM-DDTHH:mm".
  boarding_scheduled_at: "",
  // Usado só quando boarding_situation=PERSONALIZADO. Texto livre da situação.
  boarding_custom_text: "",
  notes: "",
};

const BOARDING_SITUATION_LABELS: Record<BoardingSituation, string> = {
  VISTORIA: "Navio passando por vistoria",
  IMEDIATO: "Embarque imediato",
  AGENDADO: "Embarque agendado (com horário)",
  PERSONALIZADO: "Personalizado (escrever texto)",
};

const CARGO_OPTIONS = ["CARVÃO", "CIMENTO", "UREIA", "SOJA", "MILHO", "AÇÚCAR"];

// Sementes iniciais. A lista mostrada no ComboBox combina estes valores com
// portos/clientes já usados em navios cadastrados (derivados em useMemo),
// então qualquer porto/cliente novo digitado vira parte da lista assim que
// o navio é salvo.
const DEFAULT_PORTS = ["Santos", "Paranaguá", "São Francisco do Sul"];
const DEFAULT_CLIENTS = ["Deep", "Transatlântica", "Continental", "Wilson"];

// Categorias de despesa do navio — espelham as do Financeiro (job_adjustments).
// Um gasto lançado aqui vira um JobAdjustment ADICIONAL no Job do navio, então
// já entra no custo da operação no fechamento. Manter em sincronia com
// EXPENSE_CATEGORIES de financeiro/page.tsx.
// Rótulos dos turnos de Costado (espelham os da Escalação > Costado). Usados no
// form "Adicionar funcionário" da lateral quando o navio é do tipo Costado.
const PERIOD_LABELS: Record<ShiftPeriod, string> = {
  "07-13": "07h às 13h",
  "13-19": "13h às 19h",
  "19-01": "19h às 01h",
  "01-07": "01h às 07h",
};

const EXPENSE_CATEGORIES: { value: string; label: string }[] = [
  { value: "COMPRAS", label: "Compras" },
  { value: "QUIMICA", label: "Química" },
  { value: "MATERIAL_DANIFICADO", label: "Material danificado" },
  { value: "AJUDA_DE_CUSTO", label: "Ajuda de custo" },
  { value: "ALIMENTACAO", label: "Alimentação" },
  { value: "RESTAURANTE", label: "Jantar/Restaurante" },
  { value: "OUTROS", label: "Outros" },
];

function expenseCategoryLabel(cat: string | null | undefined): string {
  if (!cat) return "Outros";
  return EXPENSE_CATEGORIES.find((c) => c.value === cat)?.label || cat;
}

function brl(n: number): string {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

// Tipo leve do gasto do navio (subset de job_adjustments).
interface ShipExpense {
  id: number;
  job_id: string;
  type: string;
  category: string | null;
  description: string;
  amount: string | number;
}

// Tipo leve de uma compra do Controle de Compras (subset de purchase_orders),
// usado no seletor "Puxar do Controle de Compras" do resumo do navio.
interface PurchaseOrderLite {
  id: string;
  description: string;
  supplier: string | null;
  purchase_date: string | null;
  total_value: string | number;
  ship_name: string | null;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function NaviosPage() {
  const { profile } = useAuth();
  const pathname = usePathname();

  const [ships, setShips] = useState<Ship[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  // IDs de funcionarios que ja tem job_allocation ATIVA em qualquer navio.
  // Usado pra esconder eles da lista de selecao no modal de novo navio --
  // a regra do RH eh: uma pessoa nao pode estar em duas operacoes ao mesmo
  // tempo (embarque ou costado).
  const [occupiedEmployeeKind, setOccupiedEmployeeKind] = useState<Map<number, "EMBARQUE" | "COSTADO">>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<ShipStatus | "TODOS">("TODOS");

  // Modal state
  const [showModal, setShowModal] = useState(false);
  const [editingShip, setEditingShip] = useState<Ship | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  // WhatsApp group + scale creation (only when creating a new ship)
  const [createGroup, setCreateGroup] = useState(false);
  // "Avisar no WhatsApp ao escalar?" — DESLIGADO por padrão. Por padrão o navio
  // é criado e os colaboradores escalados (allocations) SEM sair grupo nem DM.
  // Marcado, além de escalar, cria o grupo e dispara os avisos. Avisar é opt-in.
  // Ver escala-whatsapp-pref.
  const { send: sendWhats, setSend: setSendWhats } = useSendWhatsappPref();
  const [groupParticipants, setGroupParticipants] = useState<Set<number>>(new Set());
  // Quando marcado, todo funcionário ATIVO do setor ADMINISTRATIVO com telefone
  // entra no grupo do WhatsApp (mas NÃO é escalado — admin não trabalha no navio).
  const [includeAdminSector, setIncludeAdminSector] = useState(false);
  const [groupSearch, setGroupSearch] = useState("");
  const [groupWarning, setGroupWarning] = useState<string | null>(null);
  // Per-employee function chosen by the user (employeeId → functionId as string)
  const [groupPerEmpFn, setGroupPerEmpFn] = useState<Map<number, string>>(new Map());
  // OPCIONAL: 2ª função do mesmo colaborador (employeeId → functionId). Raro, mas
  // acontece (ex.: vai como AJUDANTE e também como SUPERVISOR no mesmo navio).
  // Quando preenchida, gera uma 2ª job_allocation → o colaborador recebe as duas
  // pagas. A chave só existe quando o usuário clicou em "+ 2ª função".
  const [groupPerEmpFn2, setGroupPerEmpFn2] = useState<Map<number, string>>(new Map());
  // Active job functions, loaded once for the function selector
  const [jobFunctions, setJobFunctions] = useState<{ id: number; name: string; active: boolean; default_rate: string | number; unit: string }[]>([]);
  // Só funções operacionais entram na escala (porão/embarque + costado). As
  // mensalistas/admin (ex.: Analista RH) ficam de fora dos seletores de função
  // — mas `jobFunctions` continua completo pros lookups por id (nome/rate).
  const escalableFunctions = useMemo(() => jobFunctions.filter((f) => isEscalableJobUnit(f.unit)), [jobFunctions]);
  // Costado-only: shift date + period for the bulk-allocated rows
  const [costadoShiftDate, setCostadoShiftDate] = useState("");
  const [costadoShiftPeriod, setCostadoShiftPeriod] = useState("07-13");

  // Modelos de "Situação personalizada" salvos (compartilhados pela equipe —
  // tabela boarding_situation_templates). O usuário escreve um texto uma vez,
  // salva como modelo e reaproveita em outros navios depois.
  const [situationTemplates, setSituationTemplates] = useState<{ id: number; text: string }[]>([]);
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Ship detail / crew panel
  const [selectedShip, setSelectedShip] = useState<Ship | null>(null);

  // Dados financeiros do navio selecionado (tripulação escalada + gastos),
  // carregados sob demanda ao abrir o painel. A tripulação vem das
  // job_allocations ATIVAS do(s) Job(s) do navio; os gastos das job_adjustments.
  const [shipAllocs, setShipAllocs] = useState<Array<{ id: number; employee_id: number | null; function_id: number; kind: string | null; status: string }>>([]);
  const [shipExpenses, setShipExpenses] = useState<ShipExpense[]>([]);
  const [shipFinLoading, setShipFinLoading] = useState(false);

  // Form "Adicionar gasto" do painel do navio.
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [expenseDesc, setExpenseDesc] = useState("");
  const [expenseCategory, setExpenseCategory] = useState("COMPRAS");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [savingExpense, setSavingExpense] = useState(false);
  const [expenseError, setExpenseError] = useState<string | null>(null);

  // Form "Adicionar funcionário" (escalar) do painel do navio. Mesma ideia do
  // gasto: escala um colaborador direto na lateral, criando uma job_allocation
  // ATIVA no Job do navio (kind = tipo da operação do navio).
  const [showAddCrew, setShowAddCrew] = useState(false);
  const [crewEmpId, setCrewEmpId] = useState("");
  const [crewFnId, setCrewFnId] = useState("");
  const [crewShiftDate, setCrewShiftDate] = useState(""); // só COSTADO
  const [crewShiftPeriod, setCrewShiftPeriod] = useState<ShiftPeriod>("07-13"); // só COSTADO
  const [savingCrew, setSavingCrew] = useState(false);
  const [crewError, setCrewError] = useState<string | null>(null);

  // "Puxar do Controle de Compras": seletor das últimas compras (purchase_orders)
  // pra lançar como gasto do navio sem redigitar. Cada compra escolhida vira um
  // JobAdjustment ADICIONAL (mesma forma do gasto manual).
  const [showPullPurchases, setShowPullPurchases] = useState(false);
  const [recentPurchases, setRecentPurchases] = useState<PurchaseOrderLite[]>([]);
  const [purchasesLoading, setPurchasesLoading] = useState(false);
  const [selectedPurchaseIds, setSelectedPurchaseIds] = useState<Set<string>>(new Set());
  const [pullingPurchases, setPullingPurchases] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);

  // Delete confirm
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // "Fechar" navio Em Operação: a Data de Saída é informada no resumo do navio
  // (modal de detalhe), onde também dá pra puxar as compras antes de fechar.
  const [closeDate, setCloseDate] = useState("");

  const canEdit = profile ? hasPermission(profile.role, "NAVIOS", "edit") : false;
  const canCreate = profile ? hasPermission(profile.role, "NAVIOS", "create") : false;
  const canDelete = profile ? hasPermission(profile.role, "NAVIOS", "delete") : false;

  // ── Load data ──────────────────────────────────────────────────────────────

  const loadShips = useCallback(async () => {
    setLoading(true);
    try {
      // Faxina automática: libera funcionários presos em navios cuja data de
      // saída já passou. O resultado fica disponível em background — a UI já
      // mostra a lista atualizada na próxima leitura porque a tabela de
      // colaboradores observa job_allocations.status=ATIVO.
      try {
        await releaseFinishedShipAllocations(profile?.full_name || "sistema");
      } catch (err) {
        console.warn("[navios] auto-release failed:", (err as Error).message);
      }

      // Auto-promove: navio cuja data de embarque já chegou/passou deixa de ser
      // "Agendado" e vira "Em Operação" sozinho (idempotente, não-fatal).
      try {
        await promoteStartedShips();
      } catch (err) {
        console.warn("[navios] auto-promote failed:", (err as Error).message);
      }

      const { data } = await db
        .from("ships")
        .select("*")
        .order("arrival_date", { ascending: false });
      setShips(data || []);
    } catch (err) {
      console.error("loadShips error:", err);
    } finally {
      setLoading(false);
    }
  }, [profile?.full_name]);

  const loadEmployees = useCallback(async () => {
    try {
      const { data } = await db
        .from("employees")
        .select("id, name, team, phone, status, role, sector")
        .order("name");
      setEmployees((data as any[]) || []);
    } catch (err) {
      console.error("loadEmployees error:", err);
    }
  }, []);

  // Carrega o conjunto de funcionarios que ja estao em alguma alocacao ATIVA,
  // anotando o tipo de operacao (EMBARQUE ou COSTADO). No seletor o nome
  // continua aparecendo, mas em cinza e com badge indicando onde ele esta --
  // regra do RH: ninguem em duas operacoes ao mesmo tempo, mas o RH quer
  // SABER quem nao da pra escalar, em vez do nome sumir.
  const loadOccupied = useCallback(async () => {
    try {
      const { data } = await db
        .from("job_allocations")
        .select("employee_id, kind")
        .eq("status", "ATIVO");
      const map = new Map<number, "EMBARQUE" | "COSTADO">();
      for (const a of (data as Array<{ employee_id: number | null; kind: string | null }> | null) || []) {
        if (a.employee_id == null) continue;
        const k: "EMBARQUE" | "COSTADO" = a.kind === "COSTADO" ? "COSTADO" : "EMBARQUE";
        // COSTADO ganha precedencia se ja existir entrada -- alguem em ambos
        // (raro, mas possivel se houver bug de dados) aparece como Costado
        // por ser o vinculo mais especifico (turno + data).
        const prev = map.get(a.employee_id);
        if (!prev || k === "COSTADO") map.set(a.employee_id, k);
      }
      setOccupiedEmployeeKind(map);
    } catch (err) {
      console.error("loadOccupied error:", err);
    }
  }, []);

  // Loads active job functions so the user can pick a função for each
  // employee in the "criar grupo + escalar" panel of the new-ship modal.
  const loadJobFunctions = useCallback(async () => {
    try {
      const { data } = await db
        .from("job_functions")
        .select("id, name, active, default_rate, unit")
        .order("name");
      setJobFunctions(((data as any[]) || []).filter((f) => f.active !== false));
    } catch (err) {
      console.error("loadJobFunctions error:", err);
    }
  }, []);

  // Carrega os modelos de situação personalizada salvos pela equipe.
  const loadSituationTemplates = useCallback(async () => {
    try {
      const { data } = await db
        .from("boarding_situation_templates")
        .select("id, text")
        .order("created_at", { ascending: false });
      setSituationTemplates((data as { id: number; text: string }[]) || []);
    } catch (err) {
      console.error("loadSituationTemplates error:", err);
    }
  }, []);

  // Salva o texto atual da situação personalizada como modelo reutilizável.
  // Ignora vazio e duplicatas exatas pra não poluir a lista.
  const handleSaveTemplate = useCallback(async () => {
    const text = form.boarding_custom_text.trim();
    if (!text || savingTemplate) return;
    if (situationTemplates.some((t) => t.text.trim() === text)) return;
    setSavingTemplate(true);
    try {
      await db.from("boarding_situation_templates").insert({
        text,
        created_by: profile?.full_name || "sistema",
      });
      await loadSituationTemplates();
    } catch (err) {
      console.error("save template error:", err);
    } finally {
      setSavingTemplate(false);
    }
  }, [form.boarding_custom_text, savingTemplate, situationTemplates, profile?.full_name, loadSituationTemplates]);

  const handleDeleteTemplate = useCallback(async (id: number) => {
    try {
      await db.from("boarding_situation_templates").delete().eq("id", id);
      setSituationTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      console.error("delete template error:", err);
    }
  }, []);

  // Get team members for a ship based on assigned_team
  const getShipTeamMembers = useCallback((ship: Ship) => {
    if (!ship.assigned_team) return [];
    return employees.filter((e) => e.team === ship.assigned_team);
  }, [employees]);

  // Combobox lists: seeds + valores únicos já usados em navios cadastrados.
  // Dedup é case-insensitive mas preserva a primeira capitalização vista —
  // assim "Santos" e "santos" não duplicam, mas mostramos como foi digitado.
  const knownPorts = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of DEFAULT_PORTS) map.set(p.toLowerCase(), p);
    for (const s of ships) {
      const v = (s.port || "").trim();
      if (v && !map.has(v.toLowerCase())) map.set(v.toLowerCase(), v);
    }
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [ships]);

  const knownClients = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of DEFAULT_CLIENTS) map.set(c.toLowerCase(), c);
    for (const s of ships) {
      const v = (s.client_name || "").trim();
      if (v && !map.has(v.toLowerCase())) map.set(v.toLowerCase(), v);
    }
    return Array.from(map.values()).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [ships]);

  useEffect(() => {
    loadShips();
    loadEmployees();
    loadJobFunctions();
    loadOccupied();
    loadSituationTemplates();
  }, [loadShips, loadEmployees, loadJobFunctions, loadOccupied, loadSituationTemplates, pathname]);

  // ── Filter ─────────────────────────────────────────────────────────────────

  const filtered = ships.filter((s) => {
    const matchSearch =
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      (s.port || "").toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === "TODOS" || s.status === filterStatus;
    return matchSearch && matchStatus;
  });

  // ── Modal helpers ──────────────────────────────────────────────────────────

  function openCreate() {
    setEditingShip(null);
    setForm(EMPTY_FORM);
    setFormError("");
    setCreateGroup(false);
    setGroupParticipants(new Set());
    setIncludeAdminSector(false);
    setGroupSearch("");
    setGroupWarning(null);
    setGroupPerEmpFn(new Map());
    setGroupPerEmpFn2(new Map());
    // Default shift date = today (the form's arrival_date is empty at this point).
    setCostadoShiftDate(new Date().toISOString().slice(0, 10));
    setCostadoShiftPeriod("07-13");
    setShowModal(true);
  }

  function openEdit(ship: Ship) {
    setEditingShip(ship);
    setCreateGroup(false);
    setGroupParticipants(new Set());
    setIncludeAdminSector(false);
    setGroupSearch("");
    setGroupWarning(null);
    setGroupPerEmpFn(new Map());
    setGroupPerEmpFn2(new Map());
    setCostadoShiftDate(new Date().toISOString().slice(0, 10));
    setCostadoShiftPeriod("07-13");
    const opType = getOperationType(ship.services);
    setForm({
      name: ship.name,
      // <input type="date"> needs YYYY-MM-DD — the DB returns full ISO timestamps.
      arrival_date: ship.arrival_date ? ship.arrival_date.slice(0, 10) : "",
      departure_date: ship.departure_date ? ship.departure_date.slice(0, 10) : "",
      // Costado eh sempre Santos -- ignora o que tiver no banco (pode ser
      // legado de antes desta regra).
      port: opType === "COSTADO" ? "Santos" : (ship.port || ""),
      status: ship.status,
      assigned_team: ship.assigned_team || "",
      cargo_type: ship.cargo_type || "",
      holds_count: ship.holds_count != null ? String(ship.holds_count) : "",
      client_name: ship.client_name || "",
      operation_type: opType,
      services: (ship.services || []).filter((s) => s !== "COSTADO"),
      boarding_situation: (ship.boarding_situation || "") as BoardingSituation | "",
      // DB devolve ISO "2026-05-26T13:00:00.000Z". datetime-local quer "2026-05-26T13:00".
      boarding_scheduled_at: ship.boarding_scheduled_at ? ship.boarding_scheduled_at.slice(0, 16) : "",
      boarding_custom_text: ship.boarding_custom_text || "",
      notes: ship.notes || "",
    });
    setFormError("");
    setShowModal(true);
  }

  // Ao escolher Equipe 1 / Equipe 2 no formulário, já marca os colaboradores
  // daquela equipe pra escalar e preenche a função de cada um pelo cargo. Pula
  // quem está preso em outra operação ativa. Trocar de equipe (ou voltar pra
  // "Sem equipe") limpa os membros de equipe antes, pra seleção refletir só a
  // equipe atual. Não faz nada na edição — lá não se escala ninguém.
  function selectTeamMembersForForm(team: string) {
    if (editingShip) return;
    const validTeam = team === "EQUIPE_1" || team === "EQUIPE_2";
    // Elegíveis pra Embarque: ATIVO/PENDENCIA com telefone (Administrativo
    // incluso), da equipe escolhida e livres (não presos em outra operação).
    const teamAvailable = validTeam
      ? employees.filter((e) => {
          const status = e.status ?? "ATIVO";
          return (
            e.team === team &&
            (status === "ATIVO" || status === "PENDENCIA") &&
            (e.phone || "").trim().length > 0 &&
            !occupiedEmployeeKind.has(e.id)
          );
        })
      : [];

    setGroupParticipants((prev) => {
      const next = new Set(prev);
      for (const e of employees) {
        if (e.team === "EQUIPE_1" || e.team === "EQUIPE_2") next.delete(e.id);
      }
      for (const e of teamAvailable) next.add(e.id);
      return next;
    });
    setGroupPerEmpFn((m) => {
      const nm = new Map(m);
      for (const e of employees) {
        if (e.team === "EQUIPE_1" || e.team === "EQUIPE_2") nm.delete(e.id);
      }
      for (const e of teamAvailable) {
        const role = (e.role || "").trim().toUpperCase();
        const fn = role ? escalableFunctions.find((f) => f.name.toUpperCase() === role) : null;
        if (fn) nm.set(e.id, String(fn.id));
      }
      return nm;
    });
    setGroupPerEmpFn2((m) => {
      const nm = new Map(m);
      for (const e of employees) {
        if (e.team === "EQUIPE_1" || e.team === "EQUIPE_2") nm.delete(e.id);
      }
      return nm;
    });
  }

  async function handleSave() {
    if (!form.name.trim()) {
      setFormError("Nome do navio é obrigatório.");
      return;
    }
    setSaving(true);
    setFormError("");

    const holdsParsed = form.holds_count.trim() ? Number.parseInt(form.holds_count, 10) : null;
    if (holdsParsed != null && (Number.isNaN(holdsParsed) || holdsParsed < 0)) {
      setFormError("Quantidade de porão inválida.");
      setSaving(false);
      return;
    }

    // Costado não usa produto/porão — força null pra não persistir lixo se o
    // usuário tiver preenchido antes de trocar pra Costado.
    const isCostado = form.operation_type === "COSTADO";
    // Situação do embarque só faz sentido pra EMBARQUE. AGENDADO sem horário cai pra null.
    const boardingSituation = !isCostado && form.boarding_situation ? form.boarding_situation : null;
    const boardingScheduledAt =
      boardingSituation === "AGENDADO" && form.boarding_scheduled_at
        ? new Date(form.boarding_scheduled_at).toISOString()
        : null;
    // Texto livre só vale pra situação PERSONALIZADO; nos demais casos some.
    const boardingCustomText =
      boardingSituation === "PERSONALIZADO" && form.boarding_custom_text.trim()
        ? form.boarding_custom_text.trim()
        : null;
    const payload = {
      name: form.name.trim(),
      arrival_date: form.arrival_date || null,
      departure_date: form.departure_date || null,
      port: form.port.trim() || null,
      status: form.status,
      assigned_team: form.assigned_team || null,
      cargo_type: isCostado ? null : (form.cargo_type.trim() || null),
      holds_count: isCostado ? null : holdsParsed,
      client_name: form.client_name.trim() || null,
      services: isCostado ? ["COSTADO"] : form.services.filter((s) => s !== "COSTADO"),
      boarding_situation: boardingSituation,
      boarding_scheduled_at: boardingScheduledAt,
      boarding_custom_text: boardingCustomText,
      notes: form.notes.trim() || null,
      created_by: profile?.full_name || "sistema",
    };

    if (editingShip) {
      const { error } = await db
        .from("ships")
        .update(payload)
        .eq("id", editingShip.id);
      if (error) { setFormError(error.message); setSaving(false); return; }
      if (selectedShip?.id === editingShip.id) {
        setSelectedShip({ ...editingShip, ...payload });
      }
    } else {
      // ── Validações pré-flight da seção "criar grupo + escalar" ────────────
      // Faço antes do INSERT do navio pra evitar criar registro sem validar a
      // intenção do usuário primeiro. Se algo aqui falha, ninguém é criado.
      // Costado não escala no momento da criação, então pula a checagem de
      // função por colaborador (que é exigida só pra montar a allocation).
      if (!isCostado && createGroup && groupParticipants.size > 0) {
        const missingFn = Array.from(groupParticipants).filter((id) => !groupPerEmpFn.get(id));
        if (missingFn.length > 0) {
          const names = missingFn
            .map((id) => employees.find((e) => e.id === id)?.name)
            .filter(Boolean)
            .join(", ");
          setFormError(`Defina a função para: ${names}`);
          setSaving(false);
          return;
        }
      }

      const insertResult: any = await db.from("ships").insert(payload);
      if (insertResult.error) { setFormError(insertResult.error.message); setSaving(false); return; }

      const newShip = insertResult.data;
      const newShipId: string | undefined =
        Array.isArray(newShip) ? newShip[0]?.id : newShip?.id;

      // 1) Auto-cria Job financeiro vinculado ao navio. Capturo o id pra
      //    poder pendurar job_allocations nele se o usuário escolheu escalar.
      let newJobId: string | undefined;
      if (newShipId) {
        try {
          const jobPayload: Record<string, unknown> = {
            name: payload.name,
            ship_id: newShipId,
            start_date: payload.arrival_date || new Date().toISOString().slice(0, 10),
            end_date: payload.departure_date,
            status: "ABERTO",
            client: payload.client_name,
            cargo_type: payload.cargo_type,
            holds_count: payload.holds_count,
            port: payload.port,
            created_by: profile?.full_name || "sistema",
          };
          const jobRes: any = await db.from("jobs").insert(jobPayload);
          if (jobRes.error) {
            console.warn("[navios] auto-create Job failed:", jobRes.error.message);
          } else {
            const j = jobRes.data;
            newJobId = Array.isArray(j) ? j[0]?.id : j?.id;
          }
        } catch (err) {
          console.warn("[navios] auto-create Job exception:", (err as Error).message);
        }
      }

      // 2) Escalação: cria uma job_allocation por colaborador selecionado,
      //    com a função escolhida no modal. Pra Costado também grava o turno.
      //    Status ATIVO, quantity/rate/pluxee zeram (a aba Financeiro ajusta
      //    depois — mesma convenção da Escalação manual).
      //
      //    Costado: pula a escalação automática (só cria o grupo + manda DM
      //    avisando "vai ter limpeza no costado"). Quem escala depois é o
      //    supervisor pela aba Escalação > Costado, com data e turno.
      if (!isCostado && createGroup && groupParticipants.size > 0 && newJobId) {
        const profileName = profile?.full_name || "sistema";
        const now = new Date().toISOString();
        const allocationErrors: string[] = [];
        // Pré-carrega overrides de valor por funcionário pra estas funções
        // — assim funcionários com valor especial cadastrado em "Valores
        // especiais" já entram com o rate correto, sem precisar editar.
        const fnIdsInUse = Array.from(new Set(
          [
            ...Array.from(groupPerEmpFn.values()),
            ...Array.from(groupPerEmpFn2.values()), // 2ª função (pode estar vazia)
          ]
            .map((v) => parseInt(v, 10))
            .filter((n) => Number.isFinite(n)),
        ));
        const overridesMap = new Map<string, number>(); // chave: `${empId}-${fnId}`
        if (fnIdsInUse.length > 0) {
          const { data: ovData } = await db
            .from("employee_function_rates")
            .select("employee_id, function_id, rate")
            .in("function_id", fnIdsInUse);
          for (const o of (ovData || []) as { employee_id: number; function_id: number; rate: string | number }[]) {
            overridesMap.set(`${o.employee_id}-${o.function_id}`, Number(o.rate));
          }
        }
        // Cria uma job_allocation pra um par (colaborador, função), já com o
        // rate certo: override por pessoa > default_rate da função. Sem isso o
        // Pagamento de Embarque abriria com R$ 0,00 até alguém ajustar à mão.
        const insertAlloc = async (empId: number, fnIdNum: number) => {
          const fnRow = jobFunctions.find((f) => f.id === fnIdNum);
          const fnDefaultRate = Number(
            overridesMap.get(`${empId}-${fnIdNum}`) ?? fnRow?.default_rate ?? 0,
          );
          try {
            const row: Record<string, unknown> = {
              job_id: newJobId,
              function_id: fnIdNum,
              employee_id: empId,
              quantity: 0,
              rate: fnDefaultRate,
              pluxee_value: 0,
              status: "ATIVO",
              kind: isCostado ? "COSTADO" : "EMBARQUE",
              added_by: profileName,
              added_at: now,
            };
            if (isCostado) {
              row.shift_date = costadoShiftDate;
              row.shift_period = costadoShiftPeriod;
            }
            const allocRes: any = await db.from("job_allocations").insert(row);
            if (allocRes.error) allocationErrors.push(allocRes.error.message);
          } catch (err) {
            allocationErrors.push((err as Error).message);
          }
        };

        for (const empId of Array.from(groupParticipants)) {
          const fnId = groupPerEmpFn.get(empId);
          if (!fnId) continue; // já validado, mas defensivo
          const fnIdNum = parseInt(fnId, 10);
          await insertAlloc(empId, fnIdNum);

          // 2ª função OPCIONAL: só gera quando foi escolhida e é diferente da
          // principal. Vira uma 2ª linha no Pagamento de Embarque (mesmo navio,
          // mesmo colaborador, outra função) → o colaborador recebe as duas pagas.
          const fnId2 = groupPerEmpFn2.get(empId);
          if (fnId2) {
            const fnId2Num = parseInt(fnId2, 10);
            if (Number.isFinite(fnId2Num) && fnId2Num !== fnIdNum) {
              await insertAlloc(empId, fnId2Num);
            }
          }
        }
        if (allocationErrors.length > 0) {
          setGroupWarning(
            `Navio criado, mas ${allocationErrors.length} colaborador(es) não puderam ser escalados: ${allocationErrors[0]}`,
          );
        }
      } else if (createGroup && groupParticipants.size > 0 && !newJobId) {
        setGroupWarning(
          "Navio criado, mas o pagamento financeiro não foi gerado — sem ele não é possível escalar. Tente em Pagamento de Embarque → Sincronizar navios.",
        );
      }

      // 3) WhatsApp: comportamento diverge por tipo de operação.
      //    EMBARQUE → broadcast pros grupos fixos Equipe 1 + Equipe 2 (não
      //               cria grupo novo; setor admin não precisa entrar em nada
      //               porque já são membros dos grupos das equipes).
      //    COSTADO  → cria grupo do navio com colaboradores selecionados
      //               (admin sector entra se a caixinha marcou).
      if (sendWhats && createGroup && groupParticipants.size > 0) {
        if (isCostado) {
          // ── Costado: cria grupo no WhatsApp com os mesmos colaboradores ──
          const adminMemberIds = includeAdminSector
            ? employees
                .filter(
                  (e) =>
                    (e.status ?? "ATIVO") === "ATIVO" &&
                    e.sector === "ADMINISTRATIVO" &&
                    (e.phone || "").trim().length > 0,
                )
                .map((e) => e.id)
            : [];
          const allMemberIds = Array.from(
            new Set<number>([...Array.from(groupParticipants), ...adminMemberIds]),
          );
          const participantPhones = allMemberIds
            .map((id) => employees.find((e) => e.id === id)?.phone || "")
            .filter((p) => p.trim().length > 0);

          if (participantPhones.length === 0) {
            setGroupWarning(
              (prev) =>
                prev ||
                "Navio criado, mas nenhum dos colaboradores selecionados tem telefone válido pra criar o grupo.",
            );
          } else {
            try {
              const res = await fetch("/api/whatsapp/groups", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  subject: payload.name,
                  participants: participantPhones,
                  shipId: newShipId,
                  employeeIds: allMemberIds,
                }),
              });
              const body = await res.json().catch(() => ({}));
              if (!res.ok) {
                setGroupWarning(
                  `Navio e escala criados, mas o grupo no WhatsApp falhou: ${body.error || `HTTP ${res.status}`}`,
                );
                setSaving(false);
                loadShips();
                return;
              }
              if (body.status === "partial" && body.warning) {
                setGroupWarning(body.warning);
                setSaving(false);
                loadShips();
                return;
              }
            } catch (err) {
              setGroupWarning(`Navio e escala criados, mas falha ao chamar a API de grupo: ${(err as Error).message}`);
              setSaving(false);
              loadShips();
              return;
            }
          }
        } else {
          // ── Embarque: broadcast pros grupos fixos Equipe 1 + Equipe 2 ────
          try {
            const res = await fetch("/api/whatsapp/groups", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                mode: "BROADCAST_TEAMS",
                shipId: newShipId,
                employeeIds: Array.from(groupParticipants),
              }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
              setGroupWarning(
                `Navio e escala criados, mas o aviso pros grupos das equipes falhou: ${body.error || `HTTP ${res.status}`}`,
              );
              setSaving(false);
              loadShips();
              return;
            }
            if (body.status === "partial" && body.warning) {
              setGroupWarning(body.warning);
            }
          } catch (err) {
            setGroupWarning(`Navio e escala criados, mas falha ao avisar grupos das equipes: ${(err as Error).message}`);
            setSaving(false);
            loadShips();
            return;
          }
        }
      }

      // 4) Notificações WhatsApp — endpoint compartilhado com a aba Escalação.
      //    EMBARQUE: dispara DOIS posts no grupo (NOVA OPERAÇÃO já foi enviada
      //    pelo /api/whatsapp/groups; aqui sai o segundo "Equipe escalada"
      //    com a função de cada um) + DMs individuais. targets="BOTH".
      //    COSTADO: targets="DM" + mode="PREVIEW" (aviso "vai ter limpeza";
      //    a escalação real ocorre depois em Escalação > Costado).
      //    Falha aqui é só warning — escala e grupo já foram criados.
      if (sendWhats && createGroup && groupParticipants.size > 0 && newShipId) {
        try {
          const notifyBody: Record<string, unknown> = {
            shipId: newShipId,
            kind: isCostado ? "COSTADO" : "EMBARQUE",
            employeeIds: Array.from(groupParticipants),
            targets: isCostado ? "DM" : "BOTH",
          };
          if (isCostado) {
            // Costado: aviso prévio no privado, sem escalação ainda.
            notifyBody.mode = "PREVIEW";
          }
          const notifyRes = await fetch("/api/escalacao/notify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(notifyBody),
          });
          const notifyJson = await notifyRes.json().catch(() => ({} as any));
          if (!notifyRes.ok) {
            console.warn("[navios] notify DMs failed:", notifyJson.error || notifyRes.status);
            setGroupWarning(
              `Navio, escala e grupo criados, mas DMs individuais falharam: ${notifyJson.error || `HTTP ${notifyRes.status}`}`,
            );
          } else if (notifyJson.results) {
            // Surface partial DM failures (ex.: funcionário sem telefone) sem bloquear.
            const failed = (notifyJson.results as Array<{ ok: boolean; error?: string; target: string }>)
              .filter((r) => !r.ok);
            if (failed.length > 0) {
              setGroupWarning(
                `Navio, escala e grupo criados. ${notifyJson.sent || 0} DM(s) enviada(s), ${failed.length} falharam (ex.: ${failed[0].target} — ${failed[0].error}).`,
              );
            }
          }
        } catch (err) {
          console.warn("[navios] notify DMs exception:", (err as Error).message);
          setGroupWarning(`Navio, escala e grupo criados, mas falha ao enviar DMs: ${(err as Error).message}`);
        }
      }
    }

    setSaving(false);
    setShowModal(false);
    loadShips();
  }

  async function handleDelete(id: string) {
    // Libera os colaboradores embarcados antes de apagar o navio. Sem isso, as
    // job_allocations ficam órfãs com status=ATIVO e o RH vê o funcionário
    // como "Embarcado" eternamente. Fluxo:
    //  1) acha os jobs vinculados ao navio
    //  2) marca todas as job_allocations ATIVAS desses jobs como REMOVIDO
    //  3) marca os jobs como CANCELADO (preserva histórico)
    //  4) só então apaga o navio
    const jobsRes = await db.from("jobs").select("id").eq("ship_id", id);
    const jobIds: string[] = (jobsRes.data || []).map((j: { id: string }) => j.id);
    if (jobIds.length > 0) {
      const now = new Date().toISOString();
      const actor = profile?.full_name || "sistema";
      for (const jobId of jobIds) {
        await db
          .from("job_allocations")
          .update({ status: "REMOVIDO", removed_at: now, removed_by: actor, removal_reason: "Navio apagado" })
          .eq("job_id", jobId)
          .eq("status", "ATIVO");
        await db.from("jobs").update({ status: "CANCELADO" }).eq("id", jobId);
      }
    }
    await db.from("ships").delete().eq("id", id);
    if (selectedShip?.id === id) setSelectedShip(null);
    setDeleteId(null);
    loadShips();
  }

  // Fecha o navio: registra a data de saída, marca CONCLUIDO e fecha a ponta
  // do(s) job(s) (end_date). Só depois disso o navio aparece no Financeiro.
  async function handleClose() {
    if (!selectedShip || !closeDate) return;
    await db.from("ships").update({ status: "CONCLUIDO", departure_date: closeDate }).eq("id", selectedShip.id);
    await db.from("jobs").update({ end_date: closeDate }).eq("ship_id", selectedShip.id);
    // Atualiza o resumo aberto pra refletir Concluído (a seção de fechar some).
    setSelectedShip({ ...selectedShip, status: "CONCLUIDO", departure_date: closeDate });
    loadShips();
  }

  // ── Crew helpers ───────────────────────────────────────────────────────────

  // Carrega tripulação escalada + gastos do navio selecionado. Acha os Job(s) do
  // navio e puxa as job_allocations ATIVAS e as job_adjustments daquele(s) job(s).
  const loadShipFinance = useCallback(async (ship: Ship) => {
    setShipFinLoading(true);
    try {
      const { data: jobsData } = await db.from("jobs").select("id").eq("ship_id", ship.id);
      const jobIds = ((jobsData as { id: string }[]) || []).map((j) => j.id);
      if (jobIds.length === 0) {
        setShipAllocs([]);
        setShipExpenses([]);
        return;
      }
      const [allocRes, adjRes] = await Promise.all([
        db.from("job_allocations").select("id, employee_id, function_id, kind, status").in("job_id", jobIds).eq("status", "ATIVO"),
        db.from("job_adjustments").select("id, job_id, type, category, description, amount").in("job_id", jobIds).order("created_at", { ascending: false }),
      ]);
      setShipAllocs((allocRes.data as any[]) || []);
      setShipExpenses((adjRes.data as ShipExpense[]) || []);
    } catch (err) {
      console.error("loadShipFinance error:", err);
      setShipAllocs([]);
      setShipExpenses([]);
    } finally {
      setShipFinLoading(false);
    }
  }, []);

  function openDetail(ship: Ship) {
    setSelectedShip(ship);
    setShowAddExpense(false);
    setExpenseDesc("");
    setExpenseAmount("");
    setExpenseCategory("COMPRAS");
    setExpenseError(null);
    setShowAddCrew(false);
    setCrewEmpId("");
    setCrewFnId("");
    setCrewShiftDate(new Date().toISOString().slice(0, 10));
    setCrewShiftPeriod("07-13");
    setCrewError(null);
    setShowPullPurchases(false);
    setSelectedPurchaseIds(new Set());
    setPullError(null);
    // Data de Saída do "Fechar Navio" (rodapé do resumo): a já registrada ou hoje.
    setCloseDate(ship.departure_date ? ship.departure_date.slice(0, 10) : new Date().toISOString().slice(0, 10));
    loadShipFinance(ship);
  }

  // Garante que o navio tem um Job financeiro (alguns navios — criados pela
  // "Selecionar da Barra" ou legados — não têm). Devolve o id do Job, criando um
  // se preciso. Mesma forma do Job auto-criado em handleSave.
  async function ensureShipJob(ship: Ship): Promise<string> {
    const { data: jobsData } = await db.from("jobs").select("id").eq("ship_id", ship.id);
    const existing = ((jobsData as { id: string }[]) || [])[0]?.id;
    if (existing) return existing;
    const jobPayload: Record<string, unknown> = {
      name: ship.name,
      ship_id: ship.id,
      start_date: ship.arrival_date ? ship.arrival_date.slice(0, 10) : new Date().toISOString().slice(0, 10),
      end_date: ship.departure_date ? ship.departure_date.slice(0, 10) : null,
      status: "ABERTO",
      client: ship.client_name,
      cargo_type: ship.cargo_type,
      holds_count: ship.holds_count,
      port: ship.port,
      created_by: profile?.full_name || "sistema",
    };
    const jobRes: any = await db.from("jobs").insert(jobPayload);
    if (jobRes.error) throw new Error(jobRes.error.message);
    const j = jobRes.data;
    const newId = Array.isArray(j) ? j[0]?.id : j?.id;
    if (!newId) throw new Error("Não consegui criar o registro financeiro do navio.");
    return newId;
  }

  // Lança um gasto do navio: vira um JobAdjustment ADICIONAL no Job do navio
  // (despesas SOMAM ao custo da operação — mesma convenção do Financeiro), então
  // já aparece no fechamento/relatório financeiro daquele navio.
  async function handleAddExpense(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedShip) return;
    const amountNum = parseFloat(expenseAmount.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setExpenseError("Informe um valor válido (ex.: 150,00).");
      return;
    }
    if (!expenseDesc.trim()) {
      setExpenseError("Descreva o que foi comprado/gasto.");
      return;
    }
    setSavingExpense(true);
    setExpenseError(null);
    try {
      const jobId = await ensureShipJob(selectedShip);
      const res: any = await db.from("job_adjustments").insert({
        job_id: jobId,
        type: "ADICIONAL",
        category: expenseCategory,
        description: expenseDesc.trim(),
        amount: amountNum,
      });
      if (res?.error) throw new Error(res.error.message);
      setExpenseDesc("");
      setExpenseAmount("");
      setExpenseCategory("COMPRAS");
      setShowAddExpense(false);
      await loadShipFinance(selectedShip);
    } catch (err: any) {
      setExpenseError(err?.message || "Falha ao salvar o gasto.");
    } finally {
      setSavingExpense(false);
    }
  }

  async function handleDeleteExpense(id: number) {
    if (!selectedShip) return;
    await db.from("job_adjustments").delete().eq("id", id);
    await loadShipFinance(selectedShip);
  }

  // Carrega as últimas compras do Controle de Compras (purchase_orders) pro
  // seletor "Puxar". Mais recentes primeiro.
  const loadRecentPurchases = useCallback(async () => {
    setPurchasesLoading(true);
    try {
      const { data } = await db
        .from("purchase_orders")
        .select("id, description, supplier, purchase_date, total_value, ship_name")
        .order("purchase_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(40);
      setRecentPurchases((data as PurchaseOrderLite[]) || []);
    } catch (err) {
      console.error("loadRecentPurchases error:", err);
      setRecentPurchases([]);
    } finally {
      setPurchasesLoading(false);
    }
  }, []);

  function openPullPurchases() {
    setShowAddExpense(false);
    setShowPullPurchases(true);
    setSelectedPurchaseIds(new Set());
    setPullError(null);
    loadRecentPurchases();
  }

  // Lança as compras selecionadas como gasto do navio: cada uma vira um
  // JobAdjustment ADICIONAL (categoria COMPRAS) com o valor total da compra,
  // igual ao gasto manual — então já entra no custo da operação no Financeiro.
  async function handlePullPurchases() {
    if (!selectedShip || selectedPurchaseIds.size === 0) return;
    setPullingPurchases(true);
    setPullError(null);
    try {
      const jobId = await ensureShipJob(selectedShip);
      const chosen = recentPurchases.filter((p) => selectedPurchaseIds.has(p.id));
      for (const p of chosen) {
        const desc = p.supplier ? `${p.description} (${p.supplier})` : p.description;
        const res: any = await db.from("job_adjustments").insert({
          job_id: jobId,
          type: "ADICIONAL",
          category: "COMPRAS",
          description: desc,
          amount: Number(p.total_value) || 0,
        });
        if (res?.error) throw new Error(res.error.message);
      }
      setShowPullPurchases(false);
      setSelectedPurchaseIds(new Set());
      await loadShipFinance(selectedShip);
    } catch (err: any) {
      setPullError(err?.message || "Falha ao puxar as compras.");
    } finally {
      setPullingPurchases(false);
    }
  }

  // Escala um colaborador direto pela lateral do navio: cria uma job_allocation
  // ATIVA no Job do navio, com a função escolhida e o rate certo (override por
  // pessoa > default_rate da função — mesma regra da escala do modal). kind = tipo
  // da operação do navio. Costado também grava o turno (data + período) pra a
  // alocação aparecer na grade de Escalação > Costado.
  async function handleAddCrew(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedShip) return;
    const empIdNum = parseInt(crewEmpId, 10);
    const fnIdNum = parseInt(crewFnId, 10);
    if (!Number.isFinite(empIdNum)) { setCrewError("Selecione um colaborador."); return; }
    if (!Number.isFinite(fnIdNum)) { setCrewError("Selecione a função."); return; }
    const isCostado = getOperationType(selectedShip.services) === "COSTADO";
    if (isCostado && !crewShiftDate) { setCrewError("Informe a data do turno."); return; }
    setSavingCrew(true);
    setCrewError(null);
    try {
      const jobId = await ensureShipJob(selectedShip);
      // rate: override por pessoa > default_rate da função.
      const fnRow = jobFunctions.find((f) => f.id === fnIdNum);
      const { data: ovData } = await db
        .from("employee_function_rates")
        .select("rate")
        .eq("employee_id", empIdNum)
        .eq("function_id", fnIdNum);
      const override = (ovData as { rate: string | number }[] | null)?.[0]?.rate;
      const rate = Number(override ?? fnRow?.default_rate ?? 0);
      const row: Record<string, unknown> = {
        job_id: jobId,
        function_id: fnIdNum,
        employee_id: empIdNum,
        quantity: 0,
        rate,
        pluxee_value: 0,
        status: "ATIVO",
        kind: isCostado ? "COSTADO" : "EMBARQUE",
        added_by: profile?.full_name || "sistema",
        added_at: new Date().toISOString(),
      };
      if (isCostado) {
        row.shift_date = crewShiftDate;
        row.shift_period = crewShiftPeriod;
      }
      const res: any = await db.from("job_allocations").insert(row);
      if (res?.error) throw new Error(res.error.message);
      setShowAddCrew(false);
      setCrewEmpId("");
      setCrewFnId("");
      await loadShipFinance(selectedShip);
      await loadOccupied();
    } catch (err: any) {
      setCrewError(err?.message || "Falha ao escalar o colaborador.");
    } finally {
      setSavingCrew(false);
    }
  }

  // Tripulação escalada do navio (deduplicada por colaborador — quem tem 2
  // funções aparece uma vez com as duas). Nome vem de `employees`; função de
  // `jobFunctions` (ambos já carregados).
  const shipCrew = useMemo(() => {
    const byEmp = new Map<number, { id: number; name: string; functions: string[] }>();
    for (const a of shipAllocs) {
      if (a.employee_id == null) continue;
      const emp = employees.find((e) => e.id === a.employee_id);
      const fn = jobFunctions.find((f) => f.id === a.function_id);
      const entry = byEmp.get(a.employee_id) || { id: a.employee_id, name: emp?.name || `#${a.employee_id}`, functions: [] };
      if (fn?.name && !entry.functions.includes(fn.name)) entry.functions.push(fn.name);
      byEmp.set(a.employee_id, entry);
    }
    return Array.from(byEmp.values()).sort((x, y) => x.name.localeCompare(y.name, "pt-BR"));
  }, [shipAllocs, employees, jobFunctions]);

  // Colaboradores que aparecem no seletor de "Adicionar funcionário" da lateral:
  // ATIVOS/PENDENCIA que ainda não estão neste navio. Quem está preso em OUTRA
  // operação ativa continua na lista, mas desabilitado (regra do RH — ninguém em
  // duas operações ao mesmo tempo), igual ao modal de novo navio.
  const crewAddOptions = useMemo(() => {
    const onShip = new Set(shipCrew.map((m) => m.id));
    return employees.filter((e) => {
      const status = e.status ?? "ATIVO";
      return (status === "ATIVO" || status === "PENDENCIA") && !onShip.has(e.id);
    });
  }, [employees, shipCrew]);

  const shipExpenseTotal = shipExpenses.reduce(
    (s, a) => s + (a.type === "ADICIONAL" ? Number(a.amount) : -Number(a.amount)),
    0,
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-2">
          <span className="text-4xl animate-bounce">🚢</span>
          <span className="text-sm text-text-light animate-pulse">Carregando navios...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-text">Navios ⚓</h1>
          <p className="text-text-light text-sm mt-0.5">
            Controle de operações de lavagem de porão
          </p>
        </div>
        {canCreate && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-dark transition text-sm font-medium shadow-sm"
            >
              <PlusIcon className="w-4 h-4" />
              Novo Navio
            </button>
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {STATUS_OPTIONS.map((s) => {
          const count = ships.filter((sh) => sh.status === s).length;
          return (
            <button
              key={s}
              onClick={() => setFilterStatus(filterStatus === s ? "TODOS" : s)}
              className={`rounded-xl p-3 text-left border transition ${
                filterStatus === s ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-gray-50"
              }`}
            >
              <p className="text-2xl font-bold text-text">{count}</p>
              <p className="text-xs text-text-light mt-0.5">{STATUS_LABELS[s]}</p>
            </button>
          );
        })}
      </div>

      <div className="flex gap-4 flex-col lg:flex-row">
        {/* Ship list */}
        <div className="flex-1 min-w-0">
          {/* Filters */}
          <div className="flex gap-2 mb-4">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-light" />
              <input
                type="text"
                placeholder="Buscar navio ou porto..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 bg-card"
              />
            </div>
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as ShipStatus | "TODOS")}
              className="px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 bg-card"
            >
              <option value="TODOS">Todos</option>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
          </div>

          {/* List */}
          {filtered.length === 0 ? (
            <div className="bg-card rounded-xl border border-border p-12 text-center">
              <p className="text-4xl mb-3">⚓</p>
              <p className="text-text-light">Nenhum navio encontrado</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filtered.map((ship) => (
                <div
                  key={ship.id}
                  onClick={() => openDetail(ship)}
                  className={`bg-card rounded-xl border transition cursor-pointer p-4 hover:shadow-md ${
                    selectedShip?.id === ship.id ? "border-primary shadow-md" : "border-border"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold text-text truncate">{ship.name}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${STATUS_COLORS[ship.status]}`}>
                          {STATUS_LABELS[ship.status]}
                        </span>
                      </div>
                      {ship.assigned_team && (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
                          ship.assigned_team === "EQUIPE_1" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                        }`}>
                          {ship.assigned_team === "EQUIPE_1" ? "Equipe 1" : "Equipe 2"}
                        </span>
                      )}
                      {ship.port && (
                        <p className="text-xs text-text-light mt-1 flex items-center gap-1">
                          <span>📍</span> {ship.port}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-3 mt-2 text-xs text-text-light">
                        {ship.arrival_date && (
                          <span>🚢 Início da Operação: <span className="font-medium text-text">{formatDate(ship.arrival_date)}</span></span>
                        )}
                        {ship.departure_date && (
                          <span>🏁 Saída: <span className="font-medium text-text">{formatDate(ship.departure_date)}</span></span>
                        )}
                        {ship.client_name && (
                          <span>Cliente: <span className="font-medium text-text">{ship.client_name}</span></span>
                        )}
                        {ship.cargo_type && (
                          <span>Produto: <span className="font-medium text-text">{ship.cargo_type}</span></span>
                        )}
                        {ship.holds_count != null && (
                          <span>Porão: <span className="font-medium text-text">{ship.holds_count}</span></span>
                        )}
                        {(() => {
                          const t = getOperationType(ship.services);
                          const subs = (ship.services || []).filter((s) => s !== "COSTADO");
                          return (
                            <>
                              <span>Tipo: <span className="font-medium text-text">{t === "EMBARQUE" ? "⚓ Embarque" : "🧹 Costado"}</span></span>
                              {t === "EMBARQUE" && subs.length > 0 && (
                                <span>Serviços: <span className="font-medium text-text">{subs.map((s) => SERVICE_LABELS[s] || s).join(", ")}</span></span>
                              )}
                            </>
                          );
                        })()}
                      </div>
                      {ship.notes && (
                        <p className="text-xs text-text-light mt-1.5 line-clamp-1 italic">&ldquo;{ship.notes}&rdquo;</p>
                      )}
                    </div>

                    {(canEdit || canDelete) && (
                      <div className="flex gap-1 shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
                        {canEdit && ship.status === "EM_OPERACAO" && (
                          <button
                            onClick={() => openDetail(ship)}
                            className="px-2 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition whitespace-nowrap"
                            title="Abrir o navio — puxe as compras e registre a saída pra fechar"
                          >
                            🏁 Fechar
                          </button>
                        )}
                        {canEdit && (
                          <button
                            onClick={() => openEdit(ship)}
                            className="p-1.5 text-text-light hover:text-primary hover:bg-primary/10 rounded-lg transition"
                            title="Editar"
                          >
                            <EditIcon className="w-4 h-4" />
                          </button>
                        )}
                        {canDelete && (
                          <button
                            onClick={() => setDeleteId(ship.id)}
                            className="p-1.5 text-text-light hover:text-danger hover:bg-danger/10 rounded-lg transition"
                            title="Excluir"
                          >
                            <TrashIcon className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Resumo do navio — modal aberto ao clicar no card (igual ao "Editar",
            mas em modo leitura + escala de funcionários + custos). */}
        {selectedShip && (
          <Modal open onClose={() => setSelectedShip(null)} title={selectedShip.name}>
            <div className="space-y-4">
            <span className={`inline-block text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[selectedShip.status]}`}>
              {STATUS_LABELS[selectedShip.status]}
            </span>

            <div className="space-y-1.5 text-sm">
              {selectedShip.port && (
                <p><span className="text-text-light">Porto:</span> <span className="font-medium">{selectedShip.port}</span></p>
              )}
              {selectedShip.arrival_date && (
                <p><span className="text-text-light">Início da Operação:</span> <span className="font-medium">{formatDate(selectedShip.arrival_date)}</span></p>
              )}
              {selectedShip.departure_date && (
                <p><span className="text-text-light">Saída:</span> <span className="font-medium">{formatDate(selectedShip.departure_date)}</span></p>
              )}
              {selectedShip.client_name && (
                <p><span className="text-text-light">Cliente:</span> <span className="font-medium">{selectedShip.client_name}</span></p>
              )}
              {selectedShip.cargo_type && (
                <p><span className="text-text-light">Produto:</span> <span className="font-medium">{selectedShip.cargo_type}</span></p>
              )}
              {selectedShip.holds_count != null && (
                <p><span className="text-text-light">Porão:</span> <span className="font-medium">{selectedShip.holds_count}</span></p>
              )}
              {(() => {
                const t = getOperationType(selectedShip.services);
                const subs = (selectedShip.services || []).filter((s) => s !== "COSTADO");
                return (
                  <>
                    <p>
                      <span className="text-text-light">Tipo:</span>{" "}
                      <span className="font-medium">{t === "EMBARQUE" ? "⚓ Embarque" : "🧹 Costado"}</span>
                    </p>
                    {t === "EMBARQUE" && subs.length > 0 && (
                      <p>
                        <span className="text-text-light">Serviços:</span>{" "}
                        <span className="font-medium">{subs.map((s) => SERVICE_LABELS[s] || s).join(", ")}</span>
                      </p>
                    )}
                  </>
                );
              })()}
              {selectedShip.notes && (
                <p className="text-text-light italic text-xs pt-1">&ldquo;{selectedShip.notes}&rdquo;</p>
              )}
            </div>

            {/* Funcionários do navio: a tripulação realmente escalada
                (job_allocations ATIVAS). Sem escala mas com equipe definida,
                cai pros colaboradores da equipe (só leitura) pra não ficar vazio. */}
            <div className="border-t border-border pt-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-text-light uppercase tracking-wider">
                  Funcionários
                </p>
                {canEdit && !showAddCrew && (
                  <button
                    onClick={() => { setShowAddCrew(true); setCrewError(null); }}
                    className="flex items-center gap-1 text-xs font-medium text-primary hover:bg-primary/10 px-2 py-1 rounded-lg transition"
                  >
                    <PlusIcon className="w-3.5 h-3.5" /> Adicionar
                  </button>
                )}
              </div>

              {showAddCrew && (() => {
                const isCostadoShip = getOperationType(selectedShip.services) === "COSTADO";
                return (
                  <form onSubmit={handleAddCrew} className="space-y-2 mb-3 p-2.5 bg-gray-50 rounded-lg border border-border">
                    <select
                      value={crewEmpId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setCrewEmpId(id);
                        // Auto-preenche a função pelo cargo do colaborador, se casar
                        // com uma função cadastrada (mesma lógica do modal).
                        const emp = employees.find((x) => String(x.id) === id);
                        const role = (emp?.role || "").trim().toUpperCase();
                        const fn = role ? escalableFunctions.find((f) => f.name.toUpperCase() === role) : null;
                        if (fn) setCrewFnId(String(fn.id));
                      }}
                      autoFocus
                      className="w-full px-2.5 py-1.5 border border-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      <option value="">Selecione o colaborador…</option>
                      {crewAddOptions.map((emp) => {
                        const occKind = occupiedEmployeeKind.get(emp.id) || null;
                        return (
                          <option key={emp.id} value={emp.id} disabled={!!occKind}>
                            {emp.name}{emp.role ? ` · ${emp.role}` : ""}
                            {occKind ? (occKind === "COSTADO" ? " — em costado" : " — embarcado") : ""}
                          </option>
                        );
                      })}
                    </select>
                    <select
                      value={crewFnId}
                      onChange={(e) => setCrewFnId(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      <option value="">Função…</option>
                      {escalableFunctions.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                    {isCostadoShip && (
                      <div className="flex gap-2">
                        <input
                          type="date"
                          value={crewShiftDate}
                          onChange={(e) => setCrewShiftDate(e.target.value)}
                          className="flex-1 px-2.5 py-1.5 border border-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                        <select
                          value={crewShiftPeriod}
                          onChange={(e) => setCrewShiftPeriod(e.target.value as ShiftPeriod)}
                          className="flex-1 px-2.5 py-1.5 border border-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30"
                        >
                          {SHIFT_PERIODS.map((p) => (
                            <option key={p} value={p}>{PERIOD_LABELS[p]}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    {escalableFunctions.length === 0 && (
                      <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                        ⚠️ Nenhuma função operacional cadastrada em Financeiro → Funções e Valores. Cadastre antes pra poder escalar.
                      </p>
                    )}
                    {crewError && <p className="text-xs text-danger">{crewError}</p>}
                    <div className="flex gap-2 justify-end">
                      <button type="button" onClick={() => { setShowAddCrew(false); setCrewError(null); }} className="text-xs text-text-light hover:text-text px-2 py-1">
                        Cancelar
                      </button>
                      <button type="submit" disabled={savingCrew} className="text-xs font-medium bg-primary text-white px-3 py-1.5 rounded-lg hover:bg-primary-dark transition disabled:opacity-60">
                        {savingCrew ? "Escalando..." : "Escalar"}
                      </button>
                    </div>
                  </form>
                );
              })()}

              {shipFinLoading ? (
                <p className="text-xs text-text-light italic">Carregando…</p>
              ) : shipCrew.length > 0 ? (
                <div>
                  <p className="text-xs text-text-light mb-2">{shipCrew.length} escalado{shipCrew.length > 1 ? "s" : ""}</p>
                  <ul className="space-y-1.5">
                    {shipCrew.map((m) => (
                      <li key={m.id} className="flex items-center gap-2 text-sm py-1 px-2 bg-gray-50 rounded-lg">
                        <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white bg-primary shrink-0">
                          {m.name.charAt(0).toUpperCase()}
                        </div>
                        <span className="font-medium text-text truncate flex-1">{m.name}</span>
                        {m.functions.length > 0 && (
                          <span className="text-[10px] text-text-light truncate shrink-0 max-w-[45%]" title={m.functions.join(", ")}>
                            {m.functions.join(", ")}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (() => {
                const members = selectedShip.assigned_team ? getShipTeamMembers(selectedShip) : [];
                if (members.length > 0) {
                  return (
                    <div>
                      <p className="text-xs text-text-light mb-2">
                        {selectedShip.assigned_team === "EQUIPE_1" ? "Equipe 1" : "Equipe 2"} · {members.length} colaborador{members.length > 1 ? "es" : ""} <span className="italic">(não escalados)</span>
                      </p>
                      <ul className="space-y-1.5">
                        {members.map((m) => (
                          <li key={m.id} className="flex items-center gap-2 text-sm py-1 px-2 bg-gray-50 rounded-lg">
                            <div className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white bg-gray-400 shrink-0">
                              {m.name.charAt(0).toUpperCase()}
                            </div>
                            <span className="font-medium text-text truncate">{m.name}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                }
                return showAddCrew ? null : <p className="text-xs text-text-light italic">Nenhum funcionário escalado neste navio.</p>;
              })()}
            </div>

            {/* Compras e gastos do navio. Cada lançamento vira um custo
                (JobAdjustment ADICIONAL) no Financeiro daquele navio. */}
            <div className="border-t border-border pt-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-text-light uppercase tracking-wider">
                  Compras e Gastos
                </p>
                {canEdit && !showAddExpense && !showPullPurchases && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={openPullPurchases}
                      className="flex items-center gap-1 text-xs font-medium text-primary hover:bg-primary/10 px-2 py-1 rounded-lg transition"
                      title="Puxar das últimas compras do Controle de Compras"
                    >
                      🛒 Puxar
                    </button>
                    <button
                      onClick={() => { setShowAddExpense(true); setExpenseError(null); }}
                      className="flex items-center gap-1 text-xs font-medium text-primary hover:bg-primary/10 px-2 py-1 rounded-lg transition"
                    >
                      <PlusIcon className="w-3.5 h-3.5" /> Adicionar
                    </button>
                  </div>
                )}
              </div>

              {showAddExpense && (
                <form onSubmit={handleAddExpense} className="space-y-2 mb-3 p-2.5 bg-gray-50 rounded-lg border border-border">
                  <input
                    type="text"
                    value={expenseDesc}
                    onChange={(e) => setExpenseDesc(e.target.value)}
                    placeholder="Descrição (ex.: química, luvas, rancho...)"
                    autoFocus
                    className="w-full px-2.5 py-1.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                  <div className="flex gap-2">
                    <select
                      value={expenseCategory}
                      onChange={(e) => setExpenseCategory(e.target.value)}
                      className="flex-1 px-2.5 py-1.5 border border-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-primary/30"
                    >
                      {EXPENSE_CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </select>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={expenseAmount}
                      onChange={(e) => setExpenseAmount(e.target.value)}
                      placeholder="R$ 0,00"
                      className="w-24 px-2.5 py-1.5 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>
                  {expenseError && <p className="text-xs text-danger">{expenseError}</p>}
                  <div className="flex gap-2 justify-end">
                    <button type="button" onClick={() => { setShowAddExpense(false); setExpenseError(null); }} className="text-xs text-text-light hover:text-text px-2 py-1">
                      Cancelar
                    </button>
                    <button type="submit" disabled={savingExpense} className="text-xs font-medium bg-primary text-white px-3 py-1.5 rounded-lg hover:bg-primary-dark transition disabled:opacity-60">
                      {savingExpense ? "Salvando..." : "Lançar gasto"}
                    </button>
                  </div>
                </form>
              )}

              {/* Puxar do Controle de Compras: escolhe uma ou mais das últimas
                  compras (purchase_orders) pra lançar como gasto do navio. */}
              {showPullPurchases && (
                <div className="space-y-2 mb-3 p-2.5 bg-gray-50 rounded-lg border border-border">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-text">Últimas compras</p>
                    <button onClick={() => setShowPullPurchases(false)} className="text-text-light hover:text-text text-xs px-1">✕</button>
                  </div>
                  {purchasesLoading ? (
                    <p className="text-xs text-text-light italic">Carregando compras…</p>
                  ) : recentPurchases.length === 0 ? (
                    <p className="text-xs text-text-light italic">Nenhuma compra registrada no Controle de Compras.</p>
                  ) : (
                    <>
                      <ul className="space-y-1 max-h-56 overflow-auto">
                        {recentPurchases.map((p) => {
                          const checked = selectedPurchaseIds.has(p.id);
                          return (
                            <li key={p.id}>
                              <label className={`flex items-start gap-2 px-2 py-1.5 rounded-lg cursor-pointer ${checked ? "bg-emerald-50" : "hover:bg-white"}`}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => setSelectedPurchaseIds((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                                    return next;
                                  })}
                                  className="mt-0.5 w-4 h-4 accent-emerald-600 shrink-0"
                                />
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm font-medium text-text truncate">{p.description}</p>
                                  <p className="text-[10px] text-text-light truncate">
                                    {[p.supplier, p.purchase_date ? formatDate(p.purchase_date) : null, p.ship_name ? `🚢 ${p.ship_name}` : null].filter(Boolean).join(" · ") || "—"}
                                  </p>
                                </div>
                                <span className="text-sm font-semibold text-text whitespace-nowrap">{brl(Number(p.total_value) || 0)}</span>
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                      {pullError && <p className="text-xs text-danger">{pullError}</p>}
                      <div className="flex items-center gap-2 justify-end">
                        <span className="text-[10px] text-text-light mr-auto">{selectedPurchaseIds.size} selecionada(s)</span>
                        <button type="button" onClick={() => setShowPullPurchases(false)} className="text-xs text-text-light hover:text-text px-2 py-1">
                          Cancelar
                        </button>
                        <button
                          type="button"
                          disabled={pullingPurchases || selectedPurchaseIds.size === 0}
                          onClick={handlePullPurchases}
                          className="text-xs font-medium bg-primary text-white px-3 py-1.5 rounded-lg hover:bg-primary-dark transition disabled:opacity-60"
                        >
                          {pullingPurchases ? "Adicionando…" : "Adicionar como gasto"}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {shipFinLoading ? (
                <p className="text-xs text-text-light italic">Carregando…</p>
              ) : shipExpenses.length === 0 ? (
                !showAddExpense && !showPullPurchases && <p className="text-xs text-text-light italic">Nenhum gasto lançado. Clique em Adicionar.</p>
              ) : (
                <>
                  <ul className="space-y-1.5 max-h-48 overflow-auto">
                    {shipExpenses.map((a) => (
                      <li key={a.id} className="flex items-start gap-2 text-sm py-1.5 px-2 bg-gray-50 rounded-lg group">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-text truncate">{a.description || "—"}</p>
                          <span className="text-[10px] text-text-light">{expenseCategoryLabel(a.category)}</span>
                        </div>
                        <span className="font-semibold text-sm text-text whitespace-nowrap">{brl(Number(a.amount))}</span>
                        {canDelete && (
                          <button
                            onClick={() => handleDeleteExpense(a.id)}
                            className="p-1 text-text-light hover:text-danger hover:bg-danger/10 rounded transition opacity-0 group-hover:opacity-100 shrink-0"
                            title="Excluir gasto"
                          >
                            <TrashIcon className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-border">
                    <span className="text-xs font-semibold text-text-light uppercase tracking-wider">Total</span>
                    <span className="font-bold text-text">{brl(shipExpenseTotal)}</span>
                  </div>
                  <p className="text-[10px] text-text-light mt-1.5">
                    Estes gastos entram como custo deste navio no Financeiro.
                  </p>
                </>
              )}
            </div>

            {/* Fechar Navio — só pra navios Em Operação. Fica no fim do resumo,
                depois de Funcionários e Compras e Gastos, pra o usuário puxar as
                compras (acima) antes de registrar a saída e liberar pro Financeiro. */}
            {canEdit && selectedShip.status === "EM_OPERACAO" && (
              <div className="border-t border-border pt-3">
                <p className="text-xs font-semibold text-text-light uppercase tracking-wider mb-2">Fechar Navio</p>
                <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 space-y-2.5">
                  <p className="text-xs text-emerald-900">
                    🏁 Registra a saída, marca como <strong>Concluído</strong> e libera o navio pro <strong>Financeiro</strong>. Puxe as compras acima antes, se precisar.
                  </p>
                  <div className="flex flex-col sm:flex-row sm:items-end gap-2">
                    <div className="flex-1">
                      <label className="block text-xs font-medium text-text mb-1">Data de Saída *</label>
                      <input
                        type="date"
                        value={closeDate}
                        onChange={(e) => setCloseDate(e.target.value)}
                        className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm bg-white"
                      />
                    </div>
                    <button
                      onClick={handleClose}
                      disabled={!closeDate}
                      className="py-2 px-4 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                    >
                      🏁 Fechar Navio
                    </button>
                  </div>
                </div>
              </div>
            )}
            </div>
          </Modal>
        )}
      </div>

      {/* Create/Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-5 border-b border-border flex items-center justify-between">
              <h2 className="font-bold text-lg text-text">
                {editingShip ? "Editar Navio" : "Novo Navio"}
              </h2>
              <button onClick={() => setShowModal(false)} className="p-1.5 hover:bg-gray-100 rounded-lg transition text-text-light">✕</button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-text mb-1">Nome do Navio *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ex: MV Nordic Star"
                  className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
                />
              </div>

              {/* Tipo da Operação vem logo após o nome (2º campo) — define o
                  resto do form (porto fica travado em Santos pra Costado,
                  serviços só aparecem pra Embarque, Equipe Designada some em
                  Costado etc.). */}
              <div>
                <label className="block text-sm font-medium text-text mb-1">Tipo da Operação</label>
                <div className="grid grid-cols-2 gap-2">
                  {(["EMBARQUE", "COSTADO"] as OperationType[]).map((t) => {
                    const checked = form.operation_type === t;
                    return (
                      <label
                        key={t}
                        className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg border cursor-pointer transition ${
                          checked
                            ? "border-primary bg-primary/5 text-primary font-semibold"
                            : "border-border hover:bg-gray-50 text-text"
                        }`}
                      >
                        <input
                          type="radio"
                          name="operation_type"
                          checked={checked}
                          onChange={() => setForm({
                            ...form,
                            operation_type: t,
                            services: t === "COSTADO" ? [] : form.services,
                            // Costado cria grupo próprio do navio — não usa
                            // assigned_team. Limpa pra não persistir lixo.
                            assigned_team: t === "COSTADO" ? "" : form.assigned_team,
                            // Costado eh sempre no porto de Santos -- a operacao
                            // de limpeza de costado da empresa so acontece la.
                            // Se voltar pra Embarque, mantem o que o usuario
                            // tiver digitado (pode ser outro porto).
                            port: t === "COSTADO" ? "Santos" : form.port,
                          })}
                          className="h-4 w-4 accent-primary"
                        />
                        <span>{t === "EMBARQUE" ? "⚓ Embarque" : "🧹 Costado"}</span>
                      </label>
                    );
                  })}
                </div>

                {form.operation_type === "EMBARQUE" ? (
                  <div className="mt-3">
                    <label className="block text-sm font-medium text-text mb-1">Serviços do Embarque</label>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {EMBARQUE_SERVICES.map((s) => {
                        const checked = form.services.includes(s.value);
                        return (
                          <label
                            key={s.value}
                            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg border cursor-pointer transition ${
                              checked
                                ? "border-primary bg-primary/5 text-primary"
                                : "border-border hover:bg-gray-50 text-text"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                setForm({
                                  ...form,
                                  services: e.target.checked
                                    ? [...form.services, s.value]
                                    : form.services.filter((x) => x !== s.value),
                                });
                              }}
                              className="h-4 w-4 accent-primary"
                            />
                            <span>{s.label}</span>
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-text-light mt-1">Marque um ou mais serviços que serão executados.</p>
                  </div>
                ) : (
                  <p className="text-[11px] text-text-light mt-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg">
                    🧹 <strong>Costado:</strong> sem sub-serviços.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Início da Operação</label>
                <input
                  type="date"
                  value={form.arrival_date}
                  onChange={(e) => setForm({ ...form, arrival_date: e.target.value })}
                  className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
                />
                {/* A data de saída não é mais preenchida aqui — ela é registrada
                    ao "Fechar" o navio (card de navio Em Operação). */}
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Porto / Local</label>
                <ComboBox
                  value={form.port}
                  onChange={(v) => setForm({ ...form, port: v })}
                  options={knownPorts}
                  placeholder="Selecione ou digite um porto..."
                  addLabel="Adicionar porto"
                  disabled={form.operation_type === "COSTADO"}
                />
                <p className="text-[10px] text-text-light mt-1">
                  {form.operation_type === "COSTADO"
                    ? "🔒 Costado é sempre no porto de Santos — não editável."
                    : "Selecione um porto da lista ou digite um novo — ele será adicionado ao salvar."}
                </p>
              </div>

              {/* Equipe Designada só faz sentido pra Embarque — define qual
                  grupo fixo (Equipe 1 / Equipe 2) receberá a mensagem. Em
                  Costado um grupo novo é criado por navio. */}
              {form.operation_type === "EMBARQUE" && (
                <div>
                  <label className="block text-sm font-medium text-text mb-1">Equipe Designada</label>
                  <select
                    value={form.assigned_team}
                    onChange={(e) => {
                      const team = e.target.value;
                      setForm({ ...form, assigned_team: team });
                      selectTeamMembersForForm(team);
                    }}
                    className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm bg-white"
                  >
                    <option value="">Sem equipe</option>
                    <option value="EQUIPE_1">Equipe 1</option>
                    <option value="EQUIPE_2">Equipe 2</option>
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-text mb-1">Cliente</label>
                <ComboBox
                  value={form.client_name}
                  onChange={(v) => setForm({ ...form, client_name: v })}
                  options={knownClients}
                  placeholder="Selecione ou digite um cliente..."
                  addLabel="Adicionar cliente"
                />
                <p className="text-[10px] text-text-light mt-1">
                  Selecione um cliente da lista ou digite um novo — ele será adicionado ao salvar.
                </p>
              </div>

              {/* "Situação do Embarque" foi movida para dentro da caixa "Avisar
                  grupo" (mais abaixo) — só é necessária quando se vai mandar a
                  mensagem do WhatsApp. */}

              {form.operation_type === "EMBARQUE" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-text mb-1">Produto / Carga</label>
                    <input
                      type="text"
                      value={form.cargo_type}
                      onChange={(e) => setForm({ ...form, cargo_type: e.target.value.toUpperCase() })}
                      placeholder="Ex: CARVÃO"
                      list="cargo-options"
                      className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
                    />
                    <datalist id="cargo-options">
                      {CARGO_OPTIONS.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                    <p className="text-[10px] text-text-light mt-1">Selecione ou digite o produto transportado</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-text mb-1">Porão (qtd)</label>
                    <input
                      type="number"
                      min={0}
                      value={form.holds_count}
                      onChange={(e) => setForm({ ...form, holds_count: e.target.value })}
                      placeholder="Ex: 5"
                      className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-text mb-1">Observações</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Informações adicionais sobre a operação..."
                  rows={3}
                  className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm resize-none"
                />
              </div>

              {!editingShip && (
                <div className="border border-emerald-200 bg-emerald-50/40 rounded-lg p-3 space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={createGroup}
                      onChange={(e) => setCreateGroup(e.target.checked)}
                      className="h-4 w-4 accent-emerald-600"
                    />
                    <span className="text-sm font-medium text-text">
                      👥 Escalar colaboradores
                    </span>
                  </label>

                  {createGroup && (
                    form.operation_type === "COSTADO" ? (
                      <EnviarWhatsappToggle
                        send={sendWhats}
                        setSend={setSendWhats}
                        label="📲 Criar grupo e avisar no WhatsApp"
                        sentHint="Cria o grupo do navio no WhatsApp e avisa cada colaborador no privado."
                        idleHint="Nenhum grupo será criado e ninguém será avisado no WhatsApp."
                      />
                    ) : (
                      <EnviarWhatsappToggle
                        send={sendWhats}
                        setSend={setSendWhats}
                        label="📲 Avisar os grupos das equipes"
                        sentHint="Os grupos das equipes serão avisados no WhatsApp."
                        idleHint="Apenas escala — nenhum grupo será avisado."
                      />
                    )
                  )}

                  {createGroup && sendWhats && form.operation_type === "EMBARQUE" && (
                    <div>
                      <label className="block text-sm font-medium text-text mb-1">Situação do Embarque</label>
                      <div className="grid grid-cols-1 gap-2">
                        {(["VISTORIA", "IMEDIATO", "AGENDADO", "PERSONALIZADO"] as BoardingSituation[]).map((s) => {
                          const checked = form.boarding_situation === s;
                          return (
                            <label
                              key={s}
                              className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg border cursor-pointer transition ${
                                checked
                                  ? "border-primary bg-primary/5 text-primary font-semibold"
                                  : "border-border hover:bg-white text-text"
                              }`}
                            >
                              <input
                                type="radio"
                                name="boarding_situation"
                                checked={checked}
                                onChange={() => setForm({ ...form, boarding_situation: s })}
                                className="h-4 w-4 accent-primary"
                              />
                              <span>{BOARDING_SITUATION_LABELS[s]}</span>
                            </label>
                          );
                        })}
                      </div>
                      {form.boarding_situation === "AGENDADO" && (
                        <div className="mt-3">
                          <label className="block text-sm font-medium text-text mb-1">Data e horário no galpão</label>
                          <input
                            type="datetime-local"
                            value={form.boarding_scheduled_at}
                            onChange={(e) => setForm({ ...form, boarding_scheduled_at: e.target.value })}
                            className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
                          />
                          <p className="text-[10px] text-text-light mt-1">
                            Aparecerá na mensagem do grupo (ex.: &quot;estar no galpão dia 26/05 às 13h&quot;).
                          </p>
                        </div>
                      )}
                      {form.boarding_situation === "PERSONALIZADO" && (
                        <div className="mt-3 space-y-2">
                          <label className="block text-sm font-medium text-text mb-1">Texto da situação</label>
                          <textarea
                            value={form.boarding_custom_text}
                            onChange={(e) => setForm({ ...form, boarding_custom_text: e.target.value })}
                            placeholder="Ex.: Embarque liberado pela Receita — apresentar-se ao agente no portão 3."
                            rows={3}
                            className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm resize-none"
                          />
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={handleSaveTemplate}
                              disabled={!form.boarding_custom_text.trim() || savingTemplate}
                              className="text-xs px-3 py-1.5 bg-primary/10 text-primary rounded-lg hover:bg-primary/20 font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              💾 {savingTemplate ? "Salvando..." : "Salvar como modelo"}
                            </button>
                            <span className="text-[10px] text-text-light">
                              Escreva o texto livre — ele aparece na linha de Situação da mensagem do grupo.
                            </span>
                          </div>

                          {situationTemplates.length > 0 && (
                            <div className="border border-border rounded-lg p-2 bg-white">
                              <p className="text-[10px] font-semibold text-text-light uppercase tracking-wider mb-1.5">
                                Modelos salvos — clique para usar
                              </p>
                              <div className="space-y-1">
                                {situationTemplates.map((t) => {
                                  const active = form.boarding_custom_text.trim() === t.text.trim();
                                  return (
                                    <div
                                      key={t.id}
                                      className={`flex items-start gap-2 rounded-md border px-2 py-1.5 bg-white transition ${
                                        active ? "border-primary" : "border-border"
                                      }`}
                                    >
                                      <button
                                        type="button"
                                        onClick={() => setForm({ ...form, boarding_custom_text: t.text })}
                                        className="flex-1 min-w-0 text-left text-xs text-text hover:text-primary"
                                        title="Usar este modelo"
                                      >
                                        {t.text}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDeleteTemplate(t.id)}
                                        className="text-xs text-red-500 hover:bg-red-50 rounded p-0.5 shrink-0"
                                        title="Excluir modelo"
                                      >
                                        ✕
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      <p className="text-[10px] text-text-light mt-1">
                        Escolha a situação — o texto enviado ao grupo do WhatsApp se adapta automaticamente.
                      </p>
                    </div>
                  )}

                  {createGroup && (() => {
                    const isCostadoForm = form.operation_type === "COSTADO";
                    // No Costado, o setor Administrativo não aparece pra escalar
                    // — eles entram só pela caixinha "Incluir setor Administrativo
                    // no grupo". No Embarque, o RH pediu pra deixar Administrativo
                    // na lista também (alguns vão pra bordo). ATIVO + PENDENCIA
                    // aparecem (PENDENCIA ainda pode trabalhar, só sinaliza doc
                    // vencida). INATIVO/demitido fica fora. Quem ja esta em outra
                    // operacao continua na lista mas desabilitado (cinza + badge).
                    const eligible = employees.filter(
                      (e) => {
                        const status = e.status ?? "ATIVO";
                        return (
                          (status === "ATIVO" || status === "PENDENCIA") &&
                          (e.phone || "").trim().length > 0 &&
                          (!isCostadoForm || e.sector !== "ADMINISTRATIVO")
                        );
                      },
                    );
                    const q = groupSearch.trim().toLowerCase();
                    const filteredEmps = q
                      ? eligible.filter((e) => e.name.toLowerCase().includes(q))
                      : eligible;
                    const selectedList = Array.from(groupParticipants)
                      .map((id) => employees.find((e) => e.id === id))
                      .filter(Boolean) as Employee[];
                    // Funcionários do setor Administrativo com telefone (entram só
                    // no grupo do WhatsApp, sem escalar nem precisar de função).
                    const adminMembers = employees.filter(
                      (e) =>
                        (e.status ?? "ATIVO") === "ATIVO" &&
                        e.sector === "ADMINISTRATIVO" &&
                        (e.phone || "").trim().length > 0,
                    );

                    return (
                      <div className="space-y-3">
                        {/* Embarque: hint sob a checkbox foi removido a pedido
                            do RH (card Trello #37). Costado mantém a explicação
                            porque o fluxo é diferente (cria grupo do navio +
                            escala só na próxima etapa). */}
                        {isCostadoForm && (
                          <p className="text-[11px] text-text-light">
                            O grupo será criado com o nome do navio
                            {form.name.trim() && <> (<strong className="text-text">{form.name.trim()}</strong>)</>}.{" "}
                            Cada colaborador recebe um <strong className="text-text">aviso no privado</strong> de que haverá limpeza no costado. A escalação com data e turno é feita depois em{" "}
                            <strong className="text-text">🧹 Escalação de Costado</strong>.
                          </p>
                        )}

                        {/* Embarque: badge mostrando qual equipe receberá a
                            mensagem no WhatsApp (card Trello #39). Só aparece
                            quando "Avisar no WhatsApp" está marcado — sem aviso,
                            ninguém é notificado e o badge não faz sentido. Cores
                            combinam com o badge da equipe na lista de navios:
                            Equipe 1 = azul, Equipe 2 = roxo. Sem equipe =
                            âmbar de alerta. */}
                        {!isCostadoForm && sendWhats && (
                          form.assigned_team === "EQUIPE_1" ? (
                            <div className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md bg-blue-100 text-blue-700 border border-blue-200">
                              🎯 Equipe 1 será notificada
                            </div>
                          ) : form.assigned_team === "EQUIPE_2" ? (
                            <div className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md bg-purple-100 text-purple-700 border border-purple-200">
                              🎯 Equipe 2 será notificada
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md bg-amber-100 text-amber-800 border border-amber-300">
                              ⚠️ Selecione uma Equipe Designada acima — sem equipe, nenhum grupo receberá o aviso
                            </div>
                          )
                        )}

                        {/* O botão "Escalar toda a Equipe" foi removido: agora
                            escolher a Equipe Designada acima já marca os
                            colaboradores da equipe automaticamente. */}

                        {/* Setor Administrativo só faz sentido no Costado, onde
                            criamos um grupo novo. No Embarque a mensagem vai
                            pros grupos fixos das equipes, que já têm os
                            administrativos como membros. */}
                        {isCostadoForm && (
                          <label className="flex items-start gap-2 cursor-pointer bg-white border border-emerald-200 rounded-md px-2 py-2">
                            <input
                              type="checkbox"
                              checked={includeAdminSector}
                              onChange={(e) => setIncludeAdminSector(e.target.checked)}
                              className="h-4 w-4 mt-0.5 accent-emerald-600"
                            />
                            <div className="text-xs">
                              <p className="font-medium text-text">
                                👔 Incluir setor Administrativo no grupo
                              </p>
                              <p className="text-text-light mt-0.5">
                                {adminMembers.length === 0
                                  ? "Nenhum funcionário ATIVO do Administrativo com telefone cadastrado."
                                  : `${adminMembers.length} pessoa(s) do Administrativo serão adicionadas ao grupo — sem escalar, só para receber as mensagens.`}
                              </p>
                            </div>
                          </label>
                        )}

                        {/* Lista de selecionados com select de função (só Embarque — Costado não escala ainda) */}
                        {!isCostadoForm && selectedList.length > 0 && (
                          <div className="p-2 bg-white border border-emerald-200 rounded-lg">
                            <p className="text-[10px] font-semibold text-emerald-900 uppercase tracking-wider mb-2">
                              {selectedList.length} selecionado(s) — defina a função
                            </p>
                            <div className="space-y-1.5 max-h-44 overflow-y-auto">
                              {selectedList.map((emp) => {
                                const curFn = groupPerEmpFn.get(emp.id) || "";
                                const fnMissing = !curFn;
                                // 2ª função: a chave só existe depois que o usuário
                                // clica em "+ 2ª função". Vazia = ainda escolhendo.
                                const has2nd = groupPerEmpFn2.has(emp.id);
                                const curFn2 = groupPerEmpFn2.get(emp.id) || "";
                                const fn2Missing = has2nd && !curFn2;
                                return (
                                  <div
                                    key={emp.id}
                                    className="bg-white border border-emerald-100 rounded-md px-2 py-1.5 space-y-1.5"
                                  >
                                    {/* Função principal */}
                                    <div className="flex items-center gap-2">
                                      <span className="flex-1 min-w-0 text-xs font-medium truncate">{emp.name}</span>
                                      <select
                                        value={curFn}
                                        onChange={(ev) =>
                                          setGroupPerEmpFn((m) => new Map(m).set(emp.id, ev.target.value))
                                        }
                                        className={`text-xs px-2 py-1 border rounded ${
                                          fnMissing ? "border-red-300 bg-red-50" : "border-border"
                                        }`}
                                      >
                                        <option value="">Função...</option>
                                        {escalableFunctions.map((f) => (
                                          <option key={f.id} value={String(f.id)}>{f.name}</option>
                                        ))}
                                      </select>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setGroupParticipants((prev) => {
                                            const next = new Set(prev);
                                            next.delete(emp.id);
                                            return next;
                                          });
                                          setGroupPerEmpFn((m) => {
                                            const nm = new Map(m);
                                            nm.delete(emp.id);
                                            return nm;
                                          });
                                          setGroupPerEmpFn2((m) => {
                                            const nm = new Map(m);
                                            nm.delete(emp.id);
                                            return nm;
                                          });
                                        }}
                                        className="text-xs text-red-600 hover:bg-red-50 rounded p-1"
                                        title="Remover"
                                      >
                                        ✕
                                      </button>
                                    </div>

                                    {/* 2ª função OPCIONAL — rara, mas acontece. Gera uma
                                        2ª escalação/pagamento separado pro mesmo colaborador. */}
                                    {has2nd ? (
                                      <div className="flex items-center gap-2 pl-2 border-l-2 border-emerald-200">
                                        <span className="flex-1 min-w-0 text-[10px] font-medium text-emerald-800">
                                          2ª função <span className="font-normal text-text-light">(paga à parte)</span>
                                        </span>
                                        <select
                                          value={curFn2}
                                          onChange={(ev) =>
                                            setGroupPerEmpFn2((m) => new Map(m).set(emp.id, ev.target.value))
                                          }
                                          className={`text-xs px-2 py-1 border rounded ${
                                            fn2Missing ? "border-red-300 bg-red-50" : "border-border"
                                          }`}
                                        >
                                          <option value="">Função...</option>
                                          {escalableFunctions
                                            .filter((f) => String(f.id) !== curFn)
                                            .map((f) => (
                                              <option key={f.id} value={String(f.id)}>{f.name}</option>
                                            ))}
                                        </select>
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setGroupPerEmpFn2((m) => {
                                              const nm = new Map(m);
                                              nm.delete(emp.id);
                                              return nm;
                                            })
                                          }
                                          className="text-xs text-red-600 hover:bg-red-50 rounded p-1"
                                          title="Remover 2ª função"
                                        >
                                          ✕
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setGroupPerEmpFn2((m) => new Map(m).set(emp.id, ""))
                                        }
                                        className="text-[10px] font-medium text-emerald-700 hover:bg-emerald-50 rounded px-1.5 py-0.5"
                                      >
                                        + 2ª função (opcional)
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Costado: mostra lista enxuta de selecionados (sem função, sem turno) */}
                        {isCostadoForm && selectedList.length > 0 && (
                          <div className="p-2 bg-white border border-emerald-200 rounded-lg">
                            <p className="text-[10px] font-semibold text-emerald-900 uppercase tracking-wider mb-2">
                              {selectedList.length} selecionado(s)
                            </p>
                            <div className="space-y-1.5 max-h-44 overflow-y-auto">
                              {selectedList.map((emp) => (
                                <div
                                  key={emp.id}
                                  className="flex items-center gap-2 bg-white border border-emerald-100 rounded-md px-2 py-1.5"
                                >
                                  <span className="flex-1 min-w-0 text-xs font-medium truncate">{emp.name}</span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setGroupParticipants((prev) => {
                                        const next = new Set(prev);
                                        next.delete(emp.id);
                                        return next;
                                      });
                                    }}
                                    className="text-xs text-red-600 hover:bg-red-50 rounded p-1"
                                    title="Remover"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        <input
                          type="text"
                          value={groupSearch}
                          onChange={(e) => setGroupSearch(e.target.value)}
                          placeholder="🔍 Buscar colaborador..."
                          className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm bg-white"
                        />
                        {occupiedEmployeeKind.size > 0 && (
                          <p className="text-[10px] text-text-light px-1">
                            ℹ️ Colaboradores em <span className="text-text-light italic">cinza</span> já estão em outra operação ativa e não podem ser escalados de novo.
                          </p>
                        )}
                        <div className="max-h-48 overflow-y-auto border border-border rounded-lg bg-white">
                          {filteredEmps.length === 0 ? (
                            <p className="px-3 py-3 text-xs text-text-light italic text-center">
                              {eligible.length === 0
                                ? "Nenhum colaborador disponível (todos ATIVOS já estão em alguma operação ou sem telefone)."
                                : "Nenhum colaborador corresponde à busca."}
                            </p>
                          ) : (
                            filteredEmps.map((emp) => {
                              const checked = groupParticipants.has(emp.id);
                              const occKind = occupiedEmployeeKind.get(emp.id) || null;
                              const isOccupied = !!occKind;
                              return (
                                <label
                                  key={emp.id}
                                  className={`flex items-center gap-2 px-3 py-2 border-b border-border last:border-0 transition ${
                                    isOccupied
                                      ? "bg-gray-50 cursor-not-allowed"
                                      : checked
                                        ? "bg-emerald-50 hover:bg-emerald-100 cursor-pointer"
                                        : "hover:bg-gray-50 cursor-pointer"
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={isOccupied}
                                    onChange={() => {
                                      if (isOccupied) return;
                                      const wasChecked = groupParticipants.has(emp.id);
                                      setGroupParticipants((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(emp.id)) next.delete(emp.id);
                                        else next.add(emp.id);
                                        return next;
                                      });
                                      if (wasChecked) {
                                        // Desmarcou → limpa a função (e a 2ª, se houver).
                                        setGroupPerEmpFn((m) => {
                                          const nm = new Map(m);
                                          nm.delete(emp.id);
                                          return nm;
                                        });
                                        setGroupPerEmpFn2((m) => {
                                          const nm = new Map(m);
                                          nm.delete(emp.id);
                                          return nm;
                                        });
                                      } else {
                                        // Marcou → auto-preenche com a função cadastrada
                                        // no colaborador (emp.role), se houver match.
                                        const role = (emp.role || "").trim().toUpperCase();
                                        const fn = role
                                          ? escalableFunctions.find((f) => f.name.toUpperCase() === role)
                                          : null;
                                        if (fn) {
                                          setGroupPerEmpFn((m) => new Map(m).set(emp.id, String(fn.id)));
                                        }
                                      }
                                    }}
                                    className="w-4 h-4 accent-emerald-600 disabled:opacity-50"
                                  />
                                  <div className="flex-1 min-w-0">
                                    <p className={`text-sm font-medium truncate ${isOccupied ? "text-text-light" : "text-text"}`}>{emp.name}</p>
                                    <p className="text-[10px] text-text-light">{emp.phone}{emp.role ? ` · ${emp.role}` : ""}</p>
                                  </div>
                                  {isOccupied && (
                                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0 ${
                                      occKind === "COSTADO"
                                        ? "bg-amber-100 text-amber-800"
                                        : "bg-blue-100 text-blue-800"
                                    }`}>
                                      {occKind === "COSTADO" ? "Costado" : "Embarcado"}
                                    </span>
                                  )}
                                </label>
                              );
                            })
                          )}
                        </div>
                        {!isCostadoForm && jobFunctions.length === 0 && (
                          <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
                            ⚠️ Nenhuma função cadastrada em Financeiro → Funções e Valores. Cadastre antes pra poder escalar.
                          </p>
                        )}
                      </div>
                    );
                  })()}
                </div>
              )}

              {formError && (
                <p className="text-sm text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">{formError}</p>
              )}
              {groupWarning && (
                <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  {groupWarning}
                </p>
              )}
            </div>
            <div className="p-5 border-t border-border flex justify-end gap-3">
              <button
                onClick={() => setShowModal(false)}
                className="px-4 py-2 text-sm text-text-light hover:text-text hover:bg-gray-100 rounded-lg transition"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-dark transition disabled:opacity-50"
              >
                {saving ? "Salvando..." : editingShip ? "Salvar Alterações" : "Cadastrar Navio"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm">
            <div className="text-center">
              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <TrashIcon className="w-6 h-6 text-danger" />
              </div>
              <h3 className="font-bold text-text mb-1">Excluir Navio</h3>
              <p className="text-sm text-text-light mb-4">
                Esta ação removerá o navio e toda a equipe atribuída. Não pode ser desfeita.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteId(null)}
                className="flex-1 py-2 text-sm text-text-light hover:text-text hover:bg-gray-100 rounded-lg transition"
              >
                Cancelar
              </button>
              <button
                onClick={() => handleDelete(deleteId)}
                className="flex-1 py-2 bg-danger text-white text-sm font-medium rounded-lg hover:bg-red-600 transition"
              >
                Excluir
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(dateStr: string) {
  // Use only the YYYY-MM-DD part to avoid TZ shifts; works for both
  // plain "2026-04-14" and ISO "2026-04-14T00:00:00.000Z".
  const [year, month, day] = dateStr.slice(0, 10).split("-");
  return `${day}/${month}/${year}`;
}

// ─── ComboBox ─────────────────────────────────────────────────────────────────
// Input + dropdown que mostra sugestões filtradas e oferece "+ Adicionar X"
// quando o usuário digita um valor que ainda não existe na lista. O valor
// novo só é "fixado" quando o navio é salvo (sem mexer no banco enquanto o
// usuário ainda está digitando) — na próxima abertura do modal aparece como
// sugestão porque a lista é derivada de ships.

function ComboBox({
  value,
  onChange,
  options,
  placeholder,
  addLabel,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  addLabel: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fecha o dropdown ao clicar fora.
  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const q = value.trim().toLowerCase();
  const filtered = q
    ? options.filter((o) => o.toLowerCase().includes(q))
    : options;
  const hasExactMatch = options.some((o) => o.toLowerCase() === q);
  const showAdd = q.length > 0 && !hasExactMatch;

  function pick(v: string) {
    onChange(v);
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => { if (disabled) return; onChange(e.target.value); setOpen(true); }}
        onFocus={() => { if (!disabled) setOpen(true); }}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={disabled}
        className={`w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm ${
          disabled ? "bg-gray-100 text-text-light cursor-not-allowed" : ""
        }`}
      />
      {!disabled && open && (filtered.length > 0 || showAdd) && (
        <div className="absolute top-full left-0 right-0 z-20 mt-1 max-h-56 overflow-y-auto bg-white border border-border rounded-lg shadow-lg">
          {filtered.map((opt) => (
            <button
              key={opt}
              type="button"
              onMouseDown={(e) => e.preventDefault()} /* mantém foco no input */
              onClick={() => pick(opt)}
              className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition"
            >
              {opt}
            </button>
          ))}
          {showAdd && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(value.trim())}
              className="w-full text-left px-3 py-2 text-sm bg-emerald-50 text-emerald-800 hover:bg-emerald-100 transition font-medium border-t border-emerald-200"
            >
              + {addLabel}: <strong>{value.trim()}</strong>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
