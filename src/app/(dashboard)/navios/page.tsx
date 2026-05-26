"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { hasPermission } from "@/lib/rbac";
import { db } from "@/lib/db";
import { releaseFinishedShipAllocations } from "@/lib/release-finished-ships";
import { PlusIcon, EditIcon, TrashIcon, SearchIcon } from "@/components/icons";

// ─── Types ───────────────────────────────────────────────────────────────────

type ShipStatus = "AGENDADO" | "EM_OPERACAO" | "CONCLUIDO" | "CANCELADO";

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
}

interface ShipEmployee {
  id: string;
  ship_id: string;
  employee_id: number;
  role_in_ship: string | null;
  employees: { name: string; team: string | null } | null;
}

interface ExternalShip {
  id: string;
  name: string;
  mmsi: string | null;
  imo: string | null;
  lat: number | null;
  lng: number | null;
  status: string | null;
  updatedAt: string;
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
  notes: "",
};

const CARGO_OPTIONS = ["CARVÃO", "CIMENTO", "UREIA", "SOJA", "MILHO", "AÇÚCAR"];

// Sementes iniciais. A lista mostrada no ComboBox combina estes valores com
// portos/clientes já usados em navios cadastrados (derivados em useMemo),
// então qualquer porto/cliente novo digitado vira parte da lista assim que
// o navio é salvo.
const DEFAULT_PORTS = ["Santos", "Paranaguá", "São Francisco do Sul"];
const DEFAULT_CLIENTS = ["Deep", "Transatlântica", "Continental", "Wilson"];

// AIS status -> badge color (used in MarineTraffic modal)
const EXTERNAL_STATUS_STYLES: Record<string, string> = {
  underway: "bg-emerald-100 text-emerald-700",
  underway_sailing: "bg-emerald-100 text-emerald-700",
  anchored: "bg-blue-100 text-blue-700",
  moored: "bg-indigo-100 text-indigo-700",
  fishing: "bg-cyan-100 text-cyan-700",
  not_under_command: "bg-amber-100 text-amber-700",
  restricted_maneuverability: "bg-amber-100 text-amber-700",
  constrained_by_draught: "bg-amber-100 text-amber-700",
  aground: "bg-red-100 text-red-700",
};

const EXTERNAL_STATUS_LABELS: Record<string, string> = {
  underway: "Em movimento",
  underway_sailing: "Em movimento",
  anchored: "Ancorado",
  moored: "Atracado",
  fishing: "Pesqueiro",
  not_under_command: "Sem comando",
  restricted_maneuverability: "Manobra restrita",
  constrained_by_draught: "Calado restrito",
  aground: "Encalhado",
  undefined: "Indefinido",
};

function externalStatusLabel(s: string | null): string {
  if (!s) return "—";
  return EXTERNAL_STATUS_LABELS[s] ?? s;
}

function externalStatusClass(s: string | null): string {
  if (!s) return "bg-gray-100 text-gray-700";
  return EXTERNAL_STATUS_STYLES[s] ?? "bg-gray-100 text-gray-700";
}

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "agora";
  if (mins < 60) return `há ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  return `há ${days}d`;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function NaviosPage() {
  const { profile } = useAuth();
  const pathname = usePathname();

  const [ships, setShips] = useState<Ship[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
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
  const [groupParticipants, setGroupParticipants] = useState<Set<number>>(new Set());
  const [groupSearch, setGroupSearch] = useState("");
  const [groupWarning, setGroupWarning] = useState<string | null>(null);
  // Per-employee function chosen by the user (employeeId → functionId as string)
  const [groupPerEmpFn, setGroupPerEmpFn] = useState<Map<number, string>>(new Map());
  // Active job functions, loaded once for the function selector
  const [jobFunctions, setJobFunctions] = useState<{ id: number; name: string; active: boolean }[]>([]);
  // Costado-only: shift date + period for the bulk-allocated rows
  const [costadoShiftDate, setCostadoShiftDate] = useState("");
  const [costadoShiftPeriod, setCostadoShiftPeriod] = useState("07-13");

  // Ship detail / crew panel
  const [selectedShip, setSelectedShip] = useState<Ship | null>(null);
  const [shipTeam, setShipTeam] = useState<string | null>(null); // "EQUIPE_1" | "EQUIPE_2" | null
  const [shipTeamLoading, setShipTeamLoading] = useState(false);

  // Delete confirm
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // External ships (AIS Stream) modal
  const [showExternalModal, setShowExternalModal] = useState(false);
  const [externalShips, setExternalShips] = useState<ExternalShip[]>([]);
  const [externalLoading, setExternalLoading] = useState(false);
  const [externalSearch, setExternalSearch] = useState("");
  const [externalSearchDebounced, setExternalSearchDebounced] = useState("");
  const [externalError, setExternalError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [selectedExternal, setSelectedExternal] = useState<ExternalShip | null>(null);
  const [externalTeam, setExternalTeam] = useState<string>("");
  const [creatingExternal, setCreatingExternal] = useState(false);

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
        .select("id, name, team, phone, status, role")
        .order("name");
      setEmployees((data as any[]) || []);
    } catch (err) {
      console.error("loadEmployees error:", err);
    }
  }, []);

  // Loads active job functions so the user can pick a função for each
  // employee in the "criar grupo + escalar" panel of the new-ship modal.
  const loadJobFunctions = useCallback(async () => {
    try {
      const { data } = await db
        .from("job_functions")
        .select("id, name, active")
        .order("name");
      setJobFunctions(((data as any[]) || []).filter((f) => f.active !== false));
    } catch (err) {
      console.error("loadJobFunctions error:", err);
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
  }, [loadShips, loadEmployees, loadJobFunctions, pathname]);

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
    setGroupSearch("");
    setGroupWarning(null);
    setGroupPerEmpFn(new Map());
    // Default shift date = today (the form's arrival_date is empty at this point).
    setCostadoShiftDate(new Date().toISOString().slice(0, 10));
    setCostadoShiftPeriod("07-13");
    setShowModal(true);
  }

  function openEdit(ship: Ship) {
    setEditingShip(ship);
    setCreateGroup(false);
    setGroupParticipants(new Set());
    setGroupSearch("");
    setGroupWarning(null);
    setGroupPerEmpFn(new Map());
    setCostadoShiftDate(new Date().toISOString().slice(0, 10));
    setCostadoShiftPeriod("07-13");
    setForm({
      name: ship.name,
      // <input type="date"> needs YYYY-MM-DD — the DB returns full ISO timestamps.
      arrival_date: ship.arrival_date ? ship.arrival_date.slice(0, 10) : "",
      departure_date: ship.departure_date ? ship.departure_date.slice(0, 10) : "",
      port: ship.port || "",
      status: ship.status,
      assigned_team: ship.assigned_team || "",
      cargo_type: ship.cargo_type || "",
      holds_count: ship.holds_count != null ? String(ship.holds_count) : "",
      client_name: ship.client_name || "",
      operation_type: getOperationType(ship.services),
      services: (ship.services || []).filter((s) => s !== "COSTADO"),
      notes: ship.notes || "",
    });
    setFormError("");
    setShowModal(true);
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
        for (const empId of Array.from(groupParticipants)) {
          const fnId = groupPerEmpFn.get(empId);
          if (!fnId) continue; // já validado, mas defensivo
          try {
            const row: Record<string, unknown> = {
              job_id: newJobId,
              function_id: parseInt(fnId, 10),
              employee_id: empId,
              quantity: 0,
              rate: 0,
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

      // 3) Cria grupo no WhatsApp com os mesmos colaboradores.
      if (createGroup && groupParticipants.size > 0) {
        const participantPhones = Array.from(groupParticipants)
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
                // Manda os IDs dos colaboradores selecionados pra o app
                // conseguir exibir nomes em "Dados do grupo" mesmo quando
                // o WhatsApp devolve LIDs opacos no lugar dos telefones.
                employeeIds: Array.from(groupParticipants),
              }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
              setGroupWarning(
                `Navio e escala criados, mas o grupo no WhatsApp falhou: ${body.error || `HTTP ${res.status}`}`,
              );
              setSaving(false);
              loadShips();
              return; // keep modal open so user can read the warning
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
      }

      // 4) DMs individuais — mesmo endpoint que a aba Escalação usa pra mandar
      //    "Você foi escalado pro navio X" no privado de cada funcionário.
      //    Uso targets="DM" porque a mensagem rica do grupo já foi enviada
      //    pelo /api/whatsapp/groups (NOVA OPERAÇÃO), evitando duplicação.
      //    Falha aqui é só warning — escala e grupo já foram criados.
      if (createGroup && groupParticipants.size > 0 && newShipId) {
        try {
          const notifyBody: Record<string, unknown> = {
            shipId: newShipId,
            kind: isCostado ? "COSTADO" : "EMBARQUE",
            employeeIds: Array.from(groupParticipants),
            targets: "DM",
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

  // ── External ships (AIS Stream) ────────────────────────────────────────────

  const loadExternalShips = useCallback(async () => {
    setExternalLoading(true);
    setExternalError(null);
    try {
      const res = await fetch("/api/external-ships", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Erro ${res.status}`);
      }
      const body = await res.json();
      setExternalShips(body.ships || []);
    } catch (err: any) {
      setExternalError(err.message || "Erro ao carregar navios.");
    } finally {
      setExternalLoading(false);
    }
  }, []);

  function openExternalModal() {
    setShowExternalModal(true);
    setExternalSearch("");
    setExternalSearchDebounced("");
    setSelectedExternal(null);
    setExternalTeam("");
    setSyncMessage(null);
    setExternalError(null);
    loadExternalShips();
  }

  async function handleSyncExternal() {
    setSyncing(true);
    setSyncMessage(null);
    setExternalError(null);
    try {
      const res = await fetch("/api/external-ships/sync", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Erro ${res.status}`);
      }
      setSyncMessage(`${body.upserted} navio(s) atualizado(s).`);
      await loadExternalShips();
    } catch (err: any) {
      setExternalError(err.message || "Erro ao sincronizar.");
    } finally {
      setSyncing(false);
    }
  }

  async function handleCreateFromExternal() {
    if (!selectedExternal) return;
    setCreatingExternal(true);
    setExternalError(null);
    try {
      const res = await fetch("/api/ships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          externalShipId: selectedExternal.id,
          assigned_team: externalTeam || null,
          status: "AGENDADO",
          port: "Santos",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Erro ${res.status}`);
      }
      setShowExternalModal(false);
      setSelectedExternal(null);
      setExternalTeam("");
      loadShips();
    } catch (err: any) {
      setExternalError(err.message || "Erro ao criar navio.");
    } finally {
      setCreatingExternal(false);
    }
  }

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setExternalSearchDebounced(externalSearch), 250);
    return () => clearTimeout(t);
  }, [externalSearch]);

  const filteredExternal = useMemo(() => {
    const q = externalSearchDebounced.trim().toLowerCase();
    if (!q) return externalShips;
    return externalShips.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.mmsi || "").includes(q) ||
        (s.imo || "").includes(q)
    );
  }, [externalShips, externalSearchDebounced]);

  // ── Crew helpers ───────────────────────────────────────────────────────────

  function openDetail(ship: Ship) {
    setSelectedShip(ship);
    setShipTeam(ship.assigned_team);
  }

  async function handleAssignTeam(team: string | null) {
    if (!selectedShip) return;
    setShipTeamLoading(true);
    await db.from("ships").update({ assigned_team: team } as any).eq("id", selectedShip.id);
    setShipTeam(team);
    setSelectedShip({ ...selectedShip, assigned_team: team });
    // Refresh ship list
    loadShips();
    setShipTeamLoading(false);
  }

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
              onClick={openExternalModal}
              className="flex items-center gap-2 px-4 py-2 bg-card border border-border text-text rounded-lg hover:bg-gray-50 transition text-sm font-medium shadow-sm"
            >
              <span aria-hidden>📡</span>
              Selecionar da Barra
            </button>
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
                          <span>🚢 Chegada: <span className="font-medium text-text">{formatDate(ship.arrival_date)}</span></span>
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
                      <div className="flex gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
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

        {/* Detail panel */}
        {selectedShip && (
          <div className="lg:w-80 bg-card rounded-xl border border-border p-4 space-y-4 self-start lg:sticky lg:top-4">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="font-bold text-text">{selectedShip.name}</h2>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[selectedShip.status]}`}>
                  {STATUS_LABELS[selectedShip.status]}
                </span>
              </div>
              <button onClick={() => setSelectedShip(null)} className="p-1 hover:bg-gray-100 rounded-lg transition text-text-light">
                ✕
              </button>
            </div>

            <div className="space-y-1.5 text-sm">
              {selectedShip.port && (
                <p><span className="text-text-light">Porto:</span> <span className="font-medium">{selectedShip.port}</span></p>
              )}
              {selectedShip.arrival_date && (
                <p><span className="text-text-light">Chegada:</span> <span className="font-medium">{formatDate(selectedShip.arrival_date)}</span></p>
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

            <div className="border-t border-border pt-3">
              <p className="text-xs font-semibold text-text-light uppercase tracking-wider mb-2">
                Equipe Designada
              </p>

              {canEdit ? (
                <div className="flex gap-2 mb-3">
                  {["EQUIPE_1", "EQUIPE_2"].map((t) => (
                    <button
                      key={t}
                      onClick={() => handleAssignTeam(shipTeam === t ? null : t)}
                      disabled={shipTeamLoading}
                      className={`flex-1 py-2 text-xs font-medium rounded-lg transition border ${
                        shipTeam === t
                          ? t === "EQUIPE_1"
                            ? "bg-blue-500 text-white border-blue-500"
                            : "bg-purple-500 text-white border-purple-500"
                          : "border-border hover:bg-gray-50 text-text-light"
                      }`}
                    >
                      {t === "EQUIPE_1" ? "⚓ Equipe 1" : "⚓ Equipe 2"}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm font-medium mb-3">
                  {shipTeam === "EQUIPE_1" ? (
                    <span className="text-blue-700">⚓ Equipe 1</span>
                  ) : shipTeam === "EQUIPE_2" ? (
                    <span className="text-purple-700">⚓ Equipe 2</span>
                  ) : (
                    <span className="text-text-light italic">Nenhuma equipe designada</span>
                  )}
                </p>
              )}

              {/* Show team members */}
              {shipTeam ? (
                <>
                  {(() => {
                    const members = getShipTeamMembers(selectedShip);
                    return members.length === 0 ? (
                      <p className="text-xs text-text-light italic">
                        Nenhum colaborador cadastrado na {shipTeam === "EQUIPE_1" ? "Equipe 1" : "Equipe 2"}.
                        Defina a equipe dos colaboradores em Colaboradores.
                      </p>
                    ) : (
                      <div>
                        <p className="text-xs text-text-light mb-2">{members.length} colaborador{members.length > 1 ? "es" : ""}</p>
                        <ul className="space-y-1.5">
                          {members.map((m) => (
                            <li key={m.id} className="flex items-center gap-2 text-sm py-1 px-2 bg-gray-50 rounded-lg">
                              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white ${
                                shipTeam === "EQUIPE_1" ? "bg-blue-500" : "bg-purple-500"
                              }`}>
                                {m.name.charAt(0).toUpperCase()}
                              </div>
                              <span className="font-medium text-text truncate">{m.name}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })()}
                </>
              ) : (
                <p className="text-xs text-text-light italic">Selecione Equipe 1 ou Equipe 2 para ver os colaboradores.</p>
              )}
            </div>
          </div>
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

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-text mb-1">Data de Chegada</label>
                  <input
                    type="date"
                    value={form.arrival_date}
                    onChange={(e) => setForm({ ...form, arrival_date: e.target.value })}
                    className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text mb-1">Data de Saída</label>
                  <input
                    type="date"
                    value={form.departure_date}
                    onChange={(e) => setForm({ ...form, departure_date: e.target.value })}
                    className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Porto / Local</label>
                <ComboBox
                  value={form.port}
                  onChange={(v) => setForm({ ...form, port: v })}
                  options={knownPorts}
                  placeholder="Selecione ou digite um porto..."
                  addLabel="Adicionar porto"
                />
                <p className="text-[10px] text-text-light mt-1">
                  Selecione um porto da lista ou digite um novo — ele será adicionado ao salvar.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-text mb-1">Equipe Designada</label>
                <select
                  value={form.assigned_team}
                  onChange={(e) => setForm({ ...form, assigned_team: e.target.value })}
                  className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm bg-white"
                >
                  <option value="">Sem equipe</option>
                  <option value="EQUIPE_1">Equipe 1</option>
                  <option value="EQUIPE_2">Equipe 2</option>
                </select>
              </div>

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
                          onChange={() => setForm({ ...form, operation_type: t, services: t === "COSTADO" ? [] : form.services })}
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
                      💬 Criar grupo no WhatsApp + escalar colaboradores
                    </span>
                  </label>

                  {createGroup && (() => {
                    const eligible = employees.filter(
                      (e) => (e.status ?? "ATIVO") === "ATIVO" && (e.phone || "").trim().length > 0,
                    );
                    const q = groupSearch.trim().toLowerCase();
                    const filteredEmps = q
                      ? eligible.filter((e) => e.name.toLowerCase().includes(q))
                      : eligible;
                    const isCostadoForm = form.operation_type === "COSTADO";
                    const selectedList = Array.from(groupParticipants)
                      .map((id) => employees.find((e) => e.id === id))
                      .filter(Boolean) as Employee[];

                    return (
                      <div className="space-y-3">
                        <p className="text-[11px] text-text-light">
                          O grupo será criado com o nome do navio
                          {form.name.trim() && <> (<strong className="text-text">{form.name.trim()}</strong>)</>}.{" "}
                          {isCostadoForm ? (
                            <>
                              Cada colaborador recebe um <strong className="text-text">aviso no privado</strong> de que haverá limpeza no costado. A escalação com data e turno é feita depois em{" "}
                              <strong className="text-text">🧹 Escalação de Costado</strong>.
                            </>
                          ) : (
                            <>
                              Cada colaborador é também escalado em{" "}
                              <strong className="text-text">⚓ Escalação de Embarque</strong>{" "}
                              — escolha a função de cada um.
                            </>
                          )}
                        </p>

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
                                return (
                                  <div
                                    key={emp.id}
                                    className="flex items-center gap-2 bg-white border border-emerald-100 rounded-md px-2 py-1.5"
                                  >
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
                                      {jobFunctions.map((f) => (
                                        <option key={f.id} value={f.id}>{f.name}</option>
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
                                      }}
                                      className="text-xs text-red-600 hover:bg-red-50 rounded p-1"
                                      title="Remover"
                                    >
                                      ✕
                                    </button>
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
                        <div className="max-h-48 overflow-y-auto border border-border rounded-lg bg-white">
                          {filteredEmps.length === 0 ? (
                            <p className="px-3 py-3 text-xs text-text-light italic text-center">
                              {eligible.length === 0
                                ? "Nenhum colaborador ATIVO com telefone cadastrado."
                                : "Nenhum colaborador corresponde à busca."}
                            </p>
                          ) : (
                            filteredEmps.map((emp) => {
                              const checked = groupParticipants.has(emp.id);
                              return (
                                <label
                                  key={emp.id}
                                  className={`flex items-center gap-2 px-3 py-2 border-b border-border last:border-0 cursor-pointer transition ${
                                    checked ? "bg-emerald-50 hover:bg-emerald-100" : "hover:bg-gray-50"
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() => {
                                      setGroupParticipants((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(emp.id)) next.delete(emp.id);
                                        else next.add(emp.id);
                                        return next;
                                      });
                                      // If unchecking, drop the function selection too
                                      if (groupParticipants.has(emp.id)) {
                                        setGroupPerEmpFn((m) => {
                                          const nm = new Map(m);
                                          nm.delete(emp.id);
                                          return nm;
                                        });
                                      }
                                    }}
                                    className="w-4 h-4 accent-emerald-600"
                                  />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-text truncate">{emp.name}</p>
                                    <p className="text-[10px] text-text-light">{emp.phone}{emp.role ? ` · ${emp.role}` : ""}</p>
                                  </div>
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

      {/* External ships (AIS Stream) modal */}
      {showExternalModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="p-5 border-b border-border flex items-center justify-between gap-3">
              <div>
                <h2 className="font-bold text-lg text-text">Selecionar da Barra</h2>
                <p className="text-xs text-text-light mt-0.5">
                  Navios próximos ao Porto de Santos (AIS Stream)
                </p>
              </div>
              <button
                onClick={() => setShowExternalModal(false)}
                className="p-1.5 hover:bg-gray-100 rounded-lg transition text-text-light"
              >
                ✕
              </button>
            </div>

            {/* Toolbar */}
            <div className="p-5 pb-3 space-y-3">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-light" />
                  <input
                    type="text"
                    placeholder="Buscar por nome, MMSI ou IMO..."
                    value={externalSearch}
                    onChange={(e) => setExternalSearch(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 bg-card"
                  />
                </div>
                <button
                  onClick={handleSyncExternal}
                  disabled={syncing}
                  className="px-3 py-2 text-sm bg-card border border-border text-text rounded-lg hover:bg-gray-50 transition disabled:opacity-50 whitespace-nowrap"
                  title="Capturar navios ao vivo do AIS Stream"
                >
                  {syncing ? "Atualizando..." : "🔄 Atualizar"}
                </button>
              </div>

              {syncMessage && (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  {syncMessage}
                </p>
              )}
              {externalError && (
                <p className="text-xs text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {externalError}
                </p>
              )}
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto px-5">
              {externalLoading ? (
                <div className="py-12 text-center text-text-light text-sm">
                  Carregando...
                </div>
              ) : filteredExternal.length === 0 ? (
                <div className="py-12 text-center">
                  <p className="text-3xl mb-2">📡</p>
                  <p className="text-sm text-text-light">
                    {externalShips.length === 0
                      ? "Nenhum navio em cache. Clique em Atualizar."
                      : "Nenhum navio corresponde à busca."}
                  </p>
                </div>
              ) : (
                <ul className="space-y-2 pb-2">
                  {filteredExternal.map((s) => {
                    const isSelected = selectedExternal?.id === s.id;
                    return (
                      <li key={s.id}>
                        <button
                          onClick={() => setSelectedExternal(s)}
                          className={`w-full text-left p-3 rounded-xl border transition ${
                            isSelected
                              ? "border-primary bg-primary/5"
                              : "border-border hover:bg-gray-50"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="font-semibold text-text truncate">{s.name}</h3>
                                <span
                                  className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${externalStatusClass(
                                    s.status
                                  )}`}
                                >
                                  {externalStatusLabel(s.status)}
                                </span>
                              </div>
                              <div className="flex flex-wrap gap-3 mt-1 text-[11px] text-text-light">
                                {s.mmsi && <span>MMSI: <span className="font-mono">{s.mmsi}</span></span>}
                                {s.imo && <span>IMO: <span className="font-mono">{s.imo}</span></span>}
                                {s.lat !== null && s.lng !== null && (
                                  <span>📍 {s.lat.toFixed(3)}, {s.lng.toFixed(3)}</span>
                                )}
                              </div>
                              <p className="text-[10px] text-text-light mt-1">
                                Atualizado {formatRelative(s.updatedAt)}
                              </p>
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* Footer with confirm */}
            <div className="p-5 border-t border-border space-y-3">
              {selectedExternal ? (
                <>
                  <div className="text-sm">
                    <p className="text-text-light text-xs">Selecionado:</p>
                    <p className="font-semibold text-text">{selectedExternal.name}</p>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-text mb-1">
                      Equipe Designada (opcional)
                    </label>
                    <select
                      value={externalTeam}
                      onChange={(e) => setExternalTeam(e.target.value)}
                      className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm bg-white"
                    >
                      <option value="">Sem equipe</option>
                      <option value="EQUIPE_1">Equipe 1</option>
                      <option value="EQUIPE_2">Equipe 2</option>
                    </select>
                  </div>
                  <div className="flex justify-end gap-3">
                    <button
                      onClick={() => setSelectedExternal(null)}
                      className="px-4 py-2 text-sm text-text-light hover:text-text hover:bg-gray-100 rounded-lg transition"
                    >
                      Voltar à lista
                    </button>
                    <button
                      onClick={handleCreateFromExternal}
                      disabled={creatingExternal}
                      className="px-5 py-2 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary-dark transition disabled:opacity-50"
                    >
                      {creatingExternal ? "Criando..." : "Cadastrar Navio"}
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-xs text-text-light text-center">
                  Selecione um navio para vinculá-lo a uma operação interna.
                </p>
              )}
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
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  addLabel: string;
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
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30 text-sm"
      />
      {open && (filtered.length > 0 || showAdd) && (
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
