"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { db } from "@/lib/db";
import { formatPhone, matchSearch } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { hasModuleAccess } from "@/lib/rbac";

interface StatusResponse {
  configured?: boolean;
  status?: { instance?: { state?: string } };
  error?: string;
}

interface EmployeeLite {
  id: number;
  name: string;
  phone: string | null;
  team: string | null;
  status: string | null;
}

interface GroupLite {
  remote_jid: string;
  push_name: string | null;
}

type Mode = "colaboradores" | "manual" | "grupo";

// Configuração dos avisos de Solicitações/Compras. Espelha o NotifyConfig do
// servidor (src/lib/services/solicitacoes-notify-config.ts); tipado localmente
// pra não importar o módulo de servidor (que puxa o Prisma) no bundle do client.
interface NotifyGroup { jid: string; label: string | null }
interface NotifyTarget { groups: NotifyGroup[]; functions: string[] }
interface RetornoNotifyTarget extends NotifyTarget { enabled: boolean }
interface NotifyConfig { novaSolicitacao: NotifyTarget; compraConcluida: NotifyTarget; retornoMaterial: RetornoNotifyTarget; embarqueLista: RetornoNotifyTarget }
interface FunctionLite { id: number; name: string; active?: boolean }
interface EmployeeRoleLite { id: number; name: string; phone: string | null; role: string | null; status: string | null; sector: string | null }
interface MemberLite { id: number; name: string; phone: string | null }

// Normaliza nome de função pra comparar com Employee.role (trim + maiúsculas).
const normFn = (s: string) => (s || "").trim().toUpperCase();

// Templates de dados ao vivo que o usuário pode inserir no texto antes de enviar
// pro grupo. Renderizados no servidor por /api/whatsapp/templates.
type TemplateKind = "EPI" | "UNIFORME" | "PRONTIDAO" | "COMPRAS";
type ScheduleTemplate = TemplateKind | "CUSTOM";
type ProntidaoTeam = "ALL" | "EQUIPE_1" | "EQUIPE_2" | "EQUIPE_3";

interface Schedule {
  id: string;
  group_jid: string;
  group_label: string | null;
  template: ScheduleTemplate;
  team: string | null;
  header_text: string | null;
  body_text: string | null;
  frequency: "DAILY" | "WEEKLY";
  weekday: number | null;
  hour: number;
  minute: number;
  enabled: boolean;
  sort_order: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
}

interface SchedForm {
  group_jid: string;
  template: ScheduleTemplate;
  team: ProntidaoTeam;
  header_text: string;
  body_text: string;
  frequency: "DAILY" | "WEEKLY";
  weekday: number;
  hour: number;
  minute: number;
}

interface SendResult {
  name: string;
  phone: string;
  ok: boolean;
  error?: string;
}

const WEEKDAY_NAMES = [
  "Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira",
  "Quinta-feira", "Sexta-feira", "Sábado",
];

const TEMPLATE_LABELS: Record<ScheduleTemplate, string> = {
  EPI: "Lista de EPIs",
  UNIFORME: "Lista de uniformes",
  PRONTIDAO: "Prontidão",
  COMPRAS: "Lista de compras",
  CUSTOM: "Mensagem personalizada",
};

const INITIAL_SCHED_FORM: SchedForm = {
  group_jid: "",
  template: "EPI",
  team: "ALL",
  header_text: "",
  body_text: "",
  frequency: "WEEKLY",
  weekday: 1,
  hour: 8,
  minute: 0,
};

// Editor de um "destino" de aviso: um grupo (opcional) + um conjunto de funções
// que recebem DM. Cada função mostra a contagem de pessoas e um "ver quem está"
// que lista os colaboradores (marcando quem está sem telefone).
function NotifyTargetEditor({
  target,
  onChange,
  functions,
  membersByFn,
  groups,
  groupFirst,
  funcLabel,
  funcHint,
  groupLabel,
  groupHint,
  disabled,
}: {
  target: NotifyTarget;
  onChange: (t: NotifyTarget) => void;
  functions: FunctionLite[];
  membersByFn: Map<string, MemberLite[]>;
  groups: GroupLite[];
  groupFirst: boolean;
  funcLabel: string;
  funcHint: string;
  groupLabel: string;
  groupHint: string;
  disabled: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const selected = new Set(target.functions.map(normFn));

  function toggleFn(name: string) {
    const norm = normFn(name);
    const next = selected.has(norm)
      ? target.functions.filter((f) => normFn(f) !== norm)
      : [...target.functions, name];
    onChange({ ...target, functions: next });
  }

  function toggleExpand(name: string) {
    const norm = normFn(name);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(norm)) next.delete(norm); else next.add(norm);
      return next;
    });
  }

  function setGroup(jid: string) {
    if (!jid) { onChange({ ...target, groups: [] }); return; }
    const g = groups.find((x) => x.remote_jid === jid);
    onChange({ ...target, groups: [{ jid, label: g?.push_name || null }] });
  }

  const groupBlock = (
    <div key="grp">
      <label className="block text-xs font-medium mb-1 text-text-light">{groupLabel}</label>
      <select
        value={target.groups[0]?.jid || ""}
        onChange={(e) => setGroup(e.target.value)}
        disabled={disabled}
        className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
      >
        <option value="">Nenhum grupo</option>
        {groups.map((g) => (
          <option key={g.remote_jid} value={g.remote_jid}>
            {g.push_name || g.remote_jid.replace("@g.us", "")}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-text-light mt-1">{groupHint}</p>
    </div>
  );

  const funcBlock = (
    <div key="fns">
      <label className="block text-xs font-medium mb-1 text-text-light">{funcLabel}</label>
      <div className="border border-border rounded-lg max-h-56 overflow-y-auto divide-y divide-border">
        {functions.length === 0 ? (
          <p className="text-xs text-text-light p-3">Nenhuma função cadastrada.</p>
        ) : (
          functions.map((fn) => {
            const members = membersByFn.get(normFn(fn.name)) || [];
            const checked = selected.has(normFn(fn.name));
            const isOpen = expanded.has(normFn(fn.name));
            return (
              <div key={fn.id}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleFn(fn.name)}
                    disabled={disabled}
                    className="w-4 h-4"
                  />
                  <span className="flex-1 text-sm">{fn.name}</span>
                  <span className="text-[11px] text-text-light">
                    {members.length} pessoa{members.length === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleExpand(fn.name)}
                    className="text-xs text-primary hover:underline"
                  >
                    {isOpen ? "ocultar" : "ver quem está"}
                  </button>
                </div>
                {isOpen && (
                  <div className="px-3 pb-2 pl-9 space-y-1 bg-gray-50">
                    {members.length === 0 ? (
                      <p className="text-xs text-text-light pt-1">Ninguém com essa função.</p>
                    ) : (
                      members.map((m) => {
                        const hasPhone = !!m.phone && m.phone.trim().length >= 10;
                        return (
                          <div key={m.id} className="flex items-center gap-2 text-xs pt-1">
                            <span className="flex-1">{m.name}</span>
                            {hasPhone ? (
                              <span className="font-mono text-text-light">{formatPhone(m.phone || "")}</span>
                            ) : (
                              <span className="text-amber-700">sem telefone</span>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <p className="text-[11px] text-text-light mt-1">{funcHint}</p>
    </div>
  );

  return (
    <div className="space-y-3">
      {groupFirst ? [groupBlock, funcBlock] : [funcBlock, groupBlock]}
    </div>
  );
}

export default function MensagensPage() {
  const { profile } = useAuth();
  const canView = !!profile && hasModuleAccess(profile.role, "MENSAGENS");
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  const [mode, setMode] = useState<Mode>("colaboradores");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Manual mode
  const [manualTo, setManualTo] = useState("");

  // Colaboradores mode
  const [employees, setEmployees] = useState<EmployeeLite[]>([]);
  const [loadingEmps, setLoadingEmps] = useState(true);
  const [empSearch, setEmpSearch] = useState("");
  const [empTeam, setEmpTeam] = useState<string>("Todos");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Grupo mode
  const [groups, setGroups] = useState<GroupLite[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [groupSearch, setGroupSearch] = useState("");
  const [selectedGroupJid, setSelectedGroupJid] = useState<string | null>(null);
  const [prontidaoTeam, setProntidaoTeam] = useState<ProntidaoTeam>("ALL");
  const [insertingTpl, setInsertingTpl] = useState<TemplateKind | null>(null);

  // Agendamentos
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loadingSchedules, setLoadingSchedules] = useState(true);
  const [savingSched, setSavingSched] = useState(false);
  const [schedMsg, setSchedMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [schedForm, setSchedForm] = useState<SchedForm>(INITIAL_SCHED_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const schedFormRef = useRef<HTMLFormElement>(null);

  // Configuração dos avisos de Solicitações/Compras
  const [notifyCfg, setNotifyCfg] = useState<NotifyConfig | null>(null);
  const [loadingCfg, setLoadingCfg] = useState(true);
  const [savingCfg, setSavingCfg] = useState(false);
  const [cfgMsg, setCfgMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [cfgFunctions, setCfgFunctions] = useState<FunctionLite[]>([]);
  const [cfgEmployees, setCfgEmployees] = useState<EmployeeRoleLite[]>([]);

  // Mensagem de aniversário (parabéns automático às 10h, no dia do aniversário)
  const [bdayEnabled, setBdayEnabled] = useState(false);
  const [bdayTemplate, setBdayTemplate] = useState("");
  const [loadingBday, setLoadingBday] = useState(true);
  const [savingBday, setSavingBday] = useState(false);
  const [bdayMsg, setBdayMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch("/api/whatsapp/status");
      const body = await res.json();
      setStatus(body);
    } catch (err) {
      setStatus({ error: (err as Error).message });
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  const loadEmployees = useCallback(async () => {
    setLoadingEmps(true);
    try {
      const res = await db
        .from("employees")
        .select("id, name, phone, team, status")
        .order("name");
      const data = (res.data || []) as EmployeeLite[];
      // Only employees with a phone number make sense for WhatsApp
      setEmployees(data.filter((e) => !!e.phone?.trim() && e.status === "ATIVO"));
    } catch (err) {
      console.error("Erro ao carregar colaboradores:", err);
    } finally {
      setLoadingEmps(false);
    }
  }, []);

  const loadGroups = useCallback(async () => {
    setLoadingGroups(true);
    try {
      const res = await fetch("/api/whatsapp/conversations");
      const body = await res.json();
      const convos = (body.conversations || []) as Array<{ remote_jid: string; push_name: string | null; is_group: boolean }>;
      const onlyGroups = convos
        .filter((c) => c.is_group)
        .map((c) => ({ remote_jid: c.remote_jid, push_name: c.push_name }))
        .sort((a, b) => (a.push_name || a.remote_jid).localeCompare(b.push_name || b.remote_jid, "pt-BR"));
      setGroups(onlyGroups);
    } catch (err) {
      console.error("Erro ao carregar grupos:", err);
    } finally {
      setLoadingGroups(false);
    }
  }, []);

  const loadSchedules = useCallback(async () => {
    setLoadingSchedules(true);
    try {
      const res = await fetch("/api/whatsapp/scheduled");
      if (!res.ok) { setSchedules([]); return; }
      const body = await res.json();
      setSchedules((body.schedules || []) as Schedule[]);
    } catch (err) {
      console.error("Erro ao carregar agendamentos:", err);
    } finally {
      setLoadingSchedules(false);
    }
  }, []);

  const loadNotifyConfig = useCallback(async () => {
    setLoadingCfg(true);
    try {
      const res = await fetch("/api/solicitacoes/notify-config");
      const body = await res.json();
      if (res.ok && body.config) setNotifyCfg(body.config as NotifyConfig);
    } catch (err) {
      console.error("Erro ao carregar config de avisos:", err);
    } finally {
      setLoadingCfg(false);
    }
  }, []);

  const loadBirthdayConfig = useCallback(async () => {
    setLoadingBday(true);
    try {
      const res = await fetch("/api/birthday-message");
      const body = await res.json();
      if (res.ok && body.config) {
        setBdayEnabled(!!body.config.enabled);
        setBdayTemplate(String(body.config.template || ""));
      }
    } catch (err) {
      console.error("Erro ao carregar mensagem de aniversário:", err);
    } finally {
      setLoadingBday(false);
    }
  }, []);

  const saveBirthdayConfig = useCallback(async () => {
    setSavingBday(true);
    setBdayMsg(null);
    try {
      const res = await fetch("/api/birthday-message", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: bdayEnabled, template: bdayTemplate }),
      });
      const body = await res.json();
      if (!res.ok) {
        setBdayMsg({ kind: "err", text: body.error || "Falha ao salvar." });
      } else {
        if (body.config) {
          setBdayEnabled(!!body.config.enabled);
          setBdayTemplate(String(body.config.template || ""));
        }
        setBdayMsg({ kind: "ok", text: "Mensagem de aniversário salva." });
      }
    } catch (err) {
      setBdayMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setSavingBday(false);
    }
  }, [bdayEnabled, bdayTemplate]);

  // Funções (job_functions ativas) + colaboradores (com função) pra montar o
  // seletor e o "ver quem está na função".
  const loadFunctions = useCallback(async () => {
    try {
      const [fnRes, empRes] = await Promise.all([
        db.from("job_functions").select("id, name, active").order("name"),
        db.from("employees").select("id, name, phone, role, status, sector").order("name"),
      ]);
      const fns = ((fnRes.data || []) as FunctionLite[]).filter((f) => f.active !== false);
      setCfgFunctions(fns);
      setCfgEmployees((empRes.data || []) as EmployeeRoleLite[]);
    } catch (err) {
      console.error("Erro ao carregar funções:", err);
    }
  }, []);

  useEffect(() => {
    if (!canView) return;
    loadStatus();
    loadEmployees();
    loadGroups();
    loadSchedules();
    loadNotifyConfig();
    loadFunctions();
    loadBirthdayConfig();
    const interval = setInterval(loadStatus, 10000);
    return () => clearInterval(interval);
  }, [canView, loadStatus, loadEmployees, loadGroups, loadSchedules, loadNotifyConfig, loadFunctions, loadBirthdayConfig]);

  const teams = useMemo(() => {
    const set = new Set<string>();
    employees.forEach((e) => { if (e.team) set.add(e.team); });
    return ["Todos", ...Array.from(set).sort()];
  }, [employees]);

  const filteredEmployees = useMemo(() => {
    return employees.filter((e) => {
      if (empTeam !== "Todos" && e.team !== empTeam) return false;
      if (empSearch && !matchSearch(e.name, empSearch)) return false;
      return true;
    });
  }, [employees, empSearch, empTeam]);

  function toggleEmployee(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filteredEmployees.forEach((e) => next.add(e.id));
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  const selectedCount = selectedIds.size;

  const filteredGroups = useMemo(() => {
    if (!groupSearch.trim()) return groups;
    return groups.filter((g) => matchSearch(g.push_name || g.remote_jid, groupSearch));
  }, [groups, groupSearch]);

  const selectedGroup = useMemo(
    () => groups.find((g) => g.remote_jid === selectedGroupJid) || null,
    [groups, selectedGroupJid],
  );

  // Pessoal ATIVO do setor Administrativo — quem sempre recebe o aviso de
  // retorno de material por DM (card "Retorno de material").
  const adminStaff = useMemo(
    () => cfgEmployees.filter(
      (e) => e.status !== "INATIVO" && (e.sector || "").trim().toUpperCase() === "ADMINISTRATIVO",
    ),
    [cfgEmployees],
  );

  // Mapa função (normalizada) → colaboradores ativos. Alimenta o "ver quem está".
  const membersByFn = useMemo(() => {
    const map = new Map<string, MemberLite[]>();
    for (const e of cfgEmployees) {
      if (e.status === "INATIVO") continue;
      const key = normFn(e.role || "");
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push({ id: e.id, name: e.name, phone: e.phone });
    }
    return map;
  }, [cfgEmployees]);

  async function saveNotifyConfig() {
    if (!notifyCfg) return;
    setSavingCfg(true);
    setCfgMsg(null);
    try {
      const res = await fetch("/api/solicitacoes/notify-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: notifyCfg }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.config) setNotifyCfg(body.config as NotifyConfig);
      setCfgMsg({ kind: "ok", text: "Configuração salva." });
    } catch (err) {
      setCfgMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setSavingCfg(false);
    }
  }

  // Busca o texto do template no servidor (dados ao vivo) e anexa ao final do
  // que já estiver escrito, separado por linha em branco.
  async function insertTemplate(kind: TemplateKind) {
    setInsertingTpl(kind);
    setMessage(null);
    try {
      const params = new URLSearchParams({ kind });
      if (kind === "PRONTIDAO") params.set("team", prontidaoTeam);
      const res = await fetch(`/api/whatsapp/templates?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const tpl = (body.text || "").trim();
      if (tpl) setText((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${tpl}` : tpl));
    } catch (err) {
      setMessage({ kind: "err", text: `Não consegui montar o template: ${(err as Error).message}` });
    } finally {
      setInsertingTpl(null);
    }
  }

  function recurrenceLabel(s: { frequency: "DAILY" | "WEEKLY"; weekday: number | null; hour: number; minute: number }): string {
    const time = `${String(s.hour).padStart(2, "0")}h${String(s.minute).padStart(2, "0")}`;
    if (s.frequency === "DAILY") return `Todo dia às ${time}`;
    return `${WEEKDAY_NAMES[s.weekday ?? 0]} às ${time}`;
  }

  function fmtBrDateTime(iso: string | null): string {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);
  }

  function scheduleSummary(s: Schedule): string {
    const tpl = TEMPLATE_LABELS[s.template];
    if (s.template !== "PRONTIDAO") return tpl;
    if (s.team && s.team !== "ALL") {
      const label = s.team === "EQUIPE_1" ? "Equipe 1" : s.team === "EQUIPE_2" ? "Equipe 2" : "Equipe 3";
      return `${tpl} (${label})`;
    }
    return `${tpl} (todas as equipes)`;
  }

  // Cria (POST) ou edita (PATCH) conforme editingId. O payload manda os campos
  // de texto como string (mesmo vazia) em vez de null: o PATCH mescla com `??`,
  // então um null reverteria pro valor antigo — "" deixa o usuário limpá-los.
  async function saveSchedule(e: React.FormEvent) {
    e.preventDefault();
    setSchedMsg(null);
    if (!schedForm.group_jid) {
      setSchedMsg({ kind: "err", text: "Escolha um grupo pro agendamento." });
      return;
    }
    if (schedForm.template === "CUSTOM" && !schedForm.body_text.trim()) {
      setSchedMsg({ kind: "err", text: "A mensagem personalizada precisa de um texto." });
      return;
    }
    setSavingSched(true);
    try {
      const grp = groups.find((g) => g.remote_jid === schedForm.group_jid);
      const payload = {
        group_jid: schedForm.group_jid,
        group_label: grp?.push_name || "",
        template: schedForm.template,
        team: schedForm.template === "PRONTIDAO" ? schedForm.team : null,
        header_text: schedForm.header_text.trim(),
        body_text: schedForm.template === "CUSTOM" ? schedForm.body_text.trim() : "",
        frequency: schedForm.frequency,
        weekday: schedForm.frequency === "WEEKLY" ? schedForm.weekday : null,
        hour: schedForm.hour,
        minute: schedForm.minute,
      };
      const res = await fetch(
        editingId ? `/api/whatsapp/scheduled/${editingId}` : "/api/whatsapp/scheduled",
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (editingId) {
        setSchedMsg({ kind: "ok", text: "Agendamento atualizado." });
        setEditingId(null);
        setSchedForm(INITIAL_SCHED_FORM);
      } else {
        setSchedMsg({ kind: "ok", text: "Agendamento criado." });
        setSchedForm((f) => ({ ...f, header_text: "", body_text: "" }));
      }
      loadSchedules();
    } catch (err) {
      setSchedMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setSavingSched(false);
    }
  }

  // Mapeia um agendamento salvo pros campos do formulário.
  function schedToForm(s: Schedule): SchedForm {
    const validTeams: ProntidaoTeam[] = ["ALL", "EQUIPE_1", "EQUIPE_2", "EQUIPE_3"];
    return {
      group_jid: s.group_jid,
      template: s.template,
      team: s.team && validTeams.includes(s.team as ProntidaoTeam) ? (s.team as ProntidaoTeam) : "ALL",
      header_text: s.header_text || "",
      body_text: s.body_text || "",
      frequency: s.frequency,
      weekday: s.weekday ?? 1,
      hour: s.hour,
      minute: s.minute,
    };
  }

  // Carrega os dados no formulário pra criar uma CÓPIA (novo agendamento).
  function duplicateSchedule(s: Schedule) {
    setEditingId(null);
    setSchedForm(schedToForm(s));
    setSchedMsg({ kind: "ok", text: "Cópia carregada no formulário abaixo — ajuste o que quiser e salve." });
    schedFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Carrega os dados no formulário pra EDITAR o próprio agendamento (salva por cima).
  function editSchedule(s: Schedule) {
    setEditingId(s.id);
    setSchedForm(schedToForm(s));
    setSchedMsg({ kind: "ok", text: "Editando agendamento — altere o que quiser e salve." });
    schedFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Sai do modo edição e limpa o formulário.
  function cancelEdit() {
    setEditingId(null);
    setSchedForm(INITIAL_SCHED_FORM);
    setSchedMsg(null);
  }

  async function toggleSchedule(s: Schedule) {
    setSchedMsg(null);
    try {
      const res = await fetch(`/api/whatsapp/scheduled/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      if (!res.ok) { const b = await res.json(); throw new Error(b.error || `HTTP ${res.status}`); }
      loadSchedules();
    } catch (err) {
      setSchedMsg({ kind: "err", text: (err as Error).message });
    }
  }

  async function deleteSchedule(s: Schedule) {
    if (!window.confirm(`Excluir o agendamento de "${s.group_label || s.group_jid}"?`)) return;
    setSchedMsg(null);
    try {
      const res = await fetch(`/api/whatsapp/scheduled/${s.id}`, { method: "DELETE" });
      if (!res.ok) { const b = await res.json(); throw new Error(b.error || `HTTP ${res.status}`); }
      loadSchedules();
    } catch (err) {
      setSchedMsg({ kind: "err", text: (err as Error).message });
    }
  }

  // Move um agendamento pra cima (-1) ou pra baixo (+1) na sequência de disparo.
  // Atualiza a ordem na hora (otimista) e persiste; em erro, recarrega do servidor.
  async function moveSchedule(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= schedules.length) return;
    const next = [...schedules];
    [next[index], next[target]] = [next[target], next[index]];
    setSchedules(next);
    setSchedMsg(null);
    try {
      const res = await fetch("/api/whatsapp/scheduled/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: next.map((s) => s.id) }),
      });
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.error || `HTTP ${res.status}`); }
    } catch (err) {
      setSchedMsg({ kind: "err", text: `Não consegui salvar a ordem: ${(err as Error).message}` });
      loadSchedules();
    }
  }

  async function sendOne(to: string, name: string, label?: string): Promise<SendResult> {
    try {
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, text, ...(label ? { label } : {}) }),
      });
      const body = await res.json();
      if (res.ok) return { name, phone: to, ok: true };
      return { name, phone: to, ok: false, error: body.error || `HTTP ${res.status}` };
    } catch (err) {
      return { name, phone: to, ok: false, error: (err as Error).message };
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    setResults(null);

    const targets: { name: string; phone: string; label?: string }[] = [];
    if (mode === "manual") {
      if (!manualTo.trim()) {
        setMessage({ kind: "err", text: "Informe um número." });
        return;
      }
      targets.push({ name: "Manual", phone: manualTo.trim() });
    } else if (mode === "grupo") {
      if (!selectedGroupJid) {
        setMessage({ kind: "err", text: "Selecione um grupo." });
        return;
      }
      const label = selectedGroup?.push_name || "Grupo";
      // No modo grupo o "phone" carrega o JID (...@g.us) e o label rotula o
      // stub que aparece em Conversas.
      targets.push({ name: label, phone: selectedGroupJid, label });
    } else {
      const selected = employees.filter((e) => selectedIds.has(e.id));
      if (selected.length === 0) {
        setMessage({ kind: "err", text: "Selecione ao menos um colaborador." });
        return;
      }
      for (const emp of selected) {
        if (emp.phone) targets.push({ name: emp.name, phone: emp.phone });
      }
    }

    if (!text.trim()) {
      setMessage({ kind: "err", text: "Escreva a mensagem antes de enviar." });
      return;
    }

    setSending(true);
    setProgress({ done: 0, total: targets.length });
    const all: SendResult[] = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      const r = await sendOne(t.phone, t.name, t.label);
      all.push(r);
      setProgress({ done: i + 1, total: targets.length });
      // small pause between sends to be gentle with WhatsApp
      if (i < targets.length - 1) await new Promise((res) => setTimeout(res, 800));
    }
    setResults(all);
    setSending(false);
    setProgress(null);

    const ok = all.filter((r) => r.ok).length;
    const fail = all.length - ok;
    if (fail === 0) {
      setMessage({ kind: "ok", text: `Enviado para ${ok} ${ok === 1 ? "destinatário" : "destinatários"}.` });
      setText("");
    } else if (ok === 0) {
      setMessage({ kind: "err", text: `Falhou em todos os ${fail} envios. Veja os detalhes abaixo.` });
    } else {
      setMessage({ kind: "err", text: `Enviado: ${ok} | Falhou: ${fail}. Veja detalhes abaixo.` });
    }
  }

  const stateRaw = status?.status?.instance?.state;
  const isConnected = stateRaw === "open";
  const isConfigured = status?.configured !== false;
  const canSend = isConnected && !sending;

  // Acesso restrito a Tecnologia, Executivo e Financeiro (ver MENSAGENS no rbac).
  // O menu já esconde a aba; isto barra o acesso por URL direta.
  if (profile && !canView) {
    return (
      <div className="max-w-2xl mx-auto mt-10">
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900">
          Você não tem acesso à página de Mensagens. Fale com a equipe de Tecnologia se precisar.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold text-text">Mensagens 📨</h1>
      <p className="text-sm text-text-light">
        Envie mensagens de WhatsApp pelo número da empresa, individualmente ou em massa para colaboradores.
      </p>

      {/* Status banner */}
      {loadingStatus ? (
        <div className="bg-gray-50 border border-border rounded-lg px-3 py-2 text-sm text-text-light">
          Verificando conexão...
        </div>
      ) : !isConfigured ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900">
          WhatsApp não configurado no servidor — avise a equipe de tecnologia.
        </div>
      ) : !isConnected ? (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-900">
          WhatsApp desconectado — peça pra equipe de tecnologia reconectar antes de enviar.
        </div>
      ) : (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-sm text-emerald-900 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500" />
          WhatsApp conectado e pronto pra enviar.
        </div>
      )}

      {message && (
        <div className={`rounded-lg px-3 py-2 text-sm border ${
          message.kind === "ok"
            ? "bg-emerald-50 border-emerald-200 text-emerald-900"
            : "bg-red-50 border-red-200 text-red-900"
        }`}>
          {message.text}
        </div>
      )}

      <section className="bg-card rounded-2xl border border-border p-6 space-y-4">
        {/* Mode toggle */}
        <div className="flex gap-2 border-b border-border pb-3">
          <button
            type="button"
            onClick={() => setMode("colaboradores")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              mode === "colaboradores"
                ? "bg-primary text-white"
                : "bg-gray-100 text-text-light hover:bg-gray-200"
            }`}
            disabled={sending}
          >
            Para colaboradores
          </button>
          <button
            type="button"
            onClick={() => setMode("grupo")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              mode === "grupo"
                ? "bg-primary text-white"
                : "bg-gray-100 text-text-light hover:bg-gray-200"
            }`}
            disabled={sending}
          >
            Para grupo
          </button>
          <button
            type="button"
            onClick={() => setMode("manual")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
              mode === "manual"
                ? "bg-primary text-white"
                : "bg-gray-100 text-text-light hover:bg-gray-200"
            }`}
            disabled={sending}
          >
            Número direto
          </button>
        </div>

        <form onSubmit={handleSend} className="space-y-4">
          {mode === "manual" ? (
            <div>
              <label className="block text-sm font-medium mb-1">
                Número (com DDD, sem +55)
              </label>
              <input
                type="text"
                value={manualTo}
                onChange={(e) => setManualTo(e.target.value)}
                placeholder="13988309100"
                disabled={!canSend}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none disabled:bg-gray-50 disabled:text-gray-500"
              />
              <p className="text-xs text-text-light mt-1">
                O +55 do Brasil é adicionado automaticamente.
              </p>
            </div>
          ) : mode === "grupo" ? (
            <div className="space-y-2">
              <label className="block text-sm font-medium">
                Grupo {selectedGroup ? `· ${selectedGroup.push_name || "sem nome"}` : "(nenhum selecionado)"}
              </label>
              <input
                type="text"
                value={groupSearch}
                onChange={(e) => setGroupSearch(e.target.value)}
                placeholder="🔍 Buscar grupo..."
                disabled={sending}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
              />
              <div className="border border-border rounded-lg max-h-64 overflow-y-auto">
                {loadingGroups ? (
                  <p className="text-sm text-text-light p-3">Carregando grupos...</p>
                ) : filteredGroups.length === 0 ? (
                  <p className="text-sm text-text-light p-3">
                    Nenhum grupo encontrado. Sincronize os grupos na aba Conversas.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {filteredGroups.map((g) => {
                      const checked = selectedGroupJid === g.remote_jid;
                      return (
                        <li key={g.remote_jid}>
                          <label className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                            <input
                              type="radio"
                              name="group-pick"
                              checked={checked}
                              onChange={() => setSelectedGroupJid(g.remote_jid)}
                              disabled={sending}
                              className="w-4 h-4"
                            />
                            <span className="flex-1 text-sm truncate">👥 {g.push_name || "(sem nome)"}</span>
                            <span className="text-[10px] text-text-light font-mono truncate max-w-[140px]">
                              {g.remote_jid.replace("@g.us", "")}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <label className="block text-sm font-medium">
                  Colaboradores ({selectedCount} selecionado{selectedCount === 1 ? "" : "s"})
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={selectAllFiltered}
                    disabled={sending || filteredEmployees.length === 0}
                    className="text-xs text-primary hover:underline disabled:opacity-50"
                  >
                    Selecionar todos ({filteredEmployees.length})
                  </button>
                  <span className="text-xs text-text-light">|</span>
                  <button
                    type="button"
                    onClick={clearSelection}
                    disabled={sending || selectedCount === 0}
                    className="text-xs text-primary hover:underline disabled:opacity-50"
                  >
                    Limpar seleção
                  </button>
                </div>
              </div>
              <div className="flex gap-2 flex-wrap">
                <input
                  type="text"
                  value={empSearch}
                  onChange={(e) => setEmpSearch(e.target.value)}
                  placeholder="🔍 Buscar por nome..."
                  disabled={sending}
                  className="flex-1 min-w-[200px] px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                />
                <select
                  value={empTeam}
                  onChange={(e) => setEmpTeam(e.target.value)}
                  disabled={sending}
                  className="px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                >
                  {teams.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="border border-border rounded-lg max-h-64 overflow-y-auto">
                {loadingEmps ? (
                  <p className="text-sm text-text-light p-3">Carregando colaboradores...</p>
                ) : filteredEmployees.length === 0 ? (
                  <p className="text-sm text-text-light p-3">
                    Nenhum colaborador ativo com telefone encontrado.
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {filteredEmployees.map((emp) => {
                      const checked = selectedIds.has(emp.id);
                      return (
                        <li key={emp.id}>
                          <label className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleEmployee(emp.id)}
                              disabled={sending}
                              className="w-4 h-4"
                            />
                            <span className="flex-1 text-sm">{emp.name}</span>
                            <span className="text-xs text-text-light font-mono">
                              {formatPhone(emp.phone || "")}
                            </span>
                            {emp.team && (
                              <span className="text-[10px] uppercase bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                                {emp.team}
                              </span>
                            )}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          )}

          {mode === "grupo" && (
            <div className="bg-gray-50 border border-border rounded-lg p-3 space-y-2">
              <p className="text-xs font-semibold text-text-light uppercase tracking-wider">
                Inserir dados ao vivo
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => insertTemplate("EPI")}
                  disabled={sending || insertingTpl !== null}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white border border-border hover:bg-gray-100 disabled:opacity-50"
                >
                  {insertingTpl === "EPI" ? "Montando..." : "📋 Lista de EPIs"}
                </button>
                <button
                  type="button"
                  onClick={() => insertTemplate("UNIFORME")}
                  disabled={sending || insertingTpl !== null}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white border border-border hover:bg-gray-100 disabled:opacity-50"
                >
                  {insertingTpl === "UNIFORME" ? "Montando..." : "👕 Lista de uniformes"}
                </button>
                <button
                  type="button"
                  onClick={() => insertTemplate("COMPRAS")}
                  disabled={sending || insertingTpl !== null}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white border border-border hover:bg-gray-100 disabled:opacity-50"
                >
                  {insertingTpl === "COMPRAS" ? "Montando..." : "🛒 Lista de compras"}
                </button>
                <span className="w-px h-5 bg-border" />
                <select
                  value={prontidaoTeam}
                  onChange={(e) => setProntidaoTeam(e.target.value as typeof prontidaoTeam)}
                  disabled={sending || insertingTpl !== null}
                  className="px-2 py-1.5 border border-border rounded-lg text-xs focus:ring-2 focus:ring-primary outline-none"
                >
                  <option value="ALL">Todas as equipes</option>
                  <option value="EQUIPE_1">Equipe 1</option>
                  <option value="EQUIPE_2">Equipe 2</option>
                  <option value="EQUIPE_3">Equipe 3</option>
                </select>
                <button
                  type="button"
                  onClick={() => insertTemplate("PRONTIDAO")}
                  disabled={sending || insertingTpl !== null}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white border border-border hover:bg-gray-100 disabled:opacity-50"
                >
                  {insertingTpl === "PRONTIDAO" ? "Montando..." : "⚓ Prontidão"}
                </button>
              </div>
              <p className="text-[11px] text-text-light">
                O texto entra no campo abaixo com os números atuais — você pode editar antes de enviar.
              </p>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium mb-1">Mensagem</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              disabled={!canSend}
              placeholder="Escreva a mensagem aqui..."
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>

          {progress && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-sm text-blue-900">
              Enviando {progress.done}/{progress.total}...
              <div className="w-full h-1.5 bg-blue-100 rounded-full mt-1.5 overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all"
                  style={{ width: `${(progress.done / progress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              variant="secondary"
              onClick={() => { setText(""); setManualTo(""); clearSelection(); setSelectedGroupJid(null); setMessage(null); setResults(null); }}
              disabled={sending}
            >
              Limpar
            </Button>
            <Button type="submit" disabled={!canSend}>
              {sending
                ? "Enviando..."
                : mode === "colaboradores"
                  ? `Enviar para ${selectedCount} colaborador${selectedCount === 1 ? "" : "es"}`
                  : mode === "grupo"
                    ? "Enviar para grupo"
                    : "Enviar"}
            </Button>
          </div>
        </form>
      </section>

      {/* Avisos de Solicitações e Compras */}
      <section className="bg-card rounded-2xl border border-border p-6 space-y-4">
        <div>
          <h2 className="text-lg font-bold text-text">Avisos de Solicitações e Compras 🛒</h2>
          <p className="text-sm text-text-light">
            Escolha pra onde vão os avisos automáticos: o grupo e as funções que recebem quando uma
            solicitação é criada e quando uma compra é concluída. Clique em &ldquo;ver quem está&rdquo; pra
            conferir os colaboradores de cada função.
          </p>
        </div>

        {cfgMsg && (
          <div className={`rounded-lg px-3 py-2 text-sm border ${
            cfgMsg.kind === "ok"
              ? "bg-emerald-50 border-emerald-200 text-emerald-900"
              : "bg-red-50 border-red-200 text-red-900"
          }`}>
            {cfgMsg.text}
          </div>
        )}

        {loadingCfg || !notifyCfg ? (
          <p className="text-sm text-text-light">Carregando configuração...</p>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="border border-border rounded-xl p-4 space-y-3">
              <div>
                <p className="text-sm font-semibold">🛒 Nova solicitação</p>
                <p className="text-[11px] text-text-light">Disparado quando alguém cria uma solicitação de compra.</p>
              </div>
              <NotifyTargetEditor
                target={notifyCfg.novaSolicitacao}
                onChange={(t) => setNotifyCfg((c) => (c ? { ...c, novaSolicitacao: t } : c))}
                functions={cfgFunctions}
                membersByFn={membersByFn}
                groups={groups}
                groupFirst={false}
                funcLabel="Funções que recebem o aviso (no WhatsApp particular)"
                funcHint="Cada pessoa dessas funções recebe a mensagem no WhatsApp dela."
                groupLabel="Grupo (opcional)"
                groupHint="Se escolher um grupo, o aviso também é postado nele."
                disabled={savingCfg}
              />
            </div>

            <div className="border border-border rounded-xl p-4 space-y-3">
              <div>
                <p className="text-sm font-semibold">✅ Compra concluída</p>
                <p className="text-[11px] text-text-light">Disparado quando a solicitação é aprovada e a compra registrada.</p>
              </div>
              <NotifyTargetEditor
                target={notifyCfg.compraConcluida}
                onChange={(t) => setNotifyCfg((c) => (c ? { ...c, compraConcluida: t } : c))}
                functions={cfgFunctions}
                membersByFn={membersByFn}
                groups={groups}
                groupFirst={true}
                groupLabel="Grupo de destino"
                groupHint="Sem grupo escolhido, usamos o grupo “Compras” padrão."
                funcLabel="Funções que também recebem (opcional)"
                funcHint="Além do grupo, cada pessoa dessas funções recebe no WhatsApp dela."
                disabled={savingCfg}
              />
            </div>

            <div className="border border-border rounded-xl p-4 space-y-3">
              <div>
                <p className="text-sm font-semibold">🛠️ Retorno de material (quebrados)</p>
                <p className="text-[11px] text-text-light">
                  Disparado pelo botão &ldquo;Enviar quebrados pro WhatsApp&rdquo; da tela Controle › Embarque/Retorno.
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={notifyCfg.retornoMaterial?.enabled !== false}
                  onChange={(e) => setNotifyCfg((c) => {
                    if (!c) return c;
                    const prev = c.retornoMaterial ?? { groups: [], functions: [], enabled: true };
                    return { ...c, retornoMaterial: { ...prev, enabled: e.target.checked } };
                  })}
                  disabled={savingCfg}
                  className="w-4 h-4"
                />
                <span>Enviar o aviso de quebrados</span>
              </label>

              <div className="bg-gray-50 border border-border rounded-lg px-3 py-2">
                <p className="text-[11px] font-medium text-text-light mb-1">
                  Quando ligado, avisa sempre o setor <strong>Administrativo</strong> no WhatsApp de cada um:
                </p>
                {adminStaff.length === 0 ? (
                  <p className="text-xs text-amber-700">Ninguém ativo no setor Administrativo.</p>
                ) : (
                  <div className="space-y-1">
                    {adminStaff.map((m) => {
                      const hasPhone = !!m.phone && m.phone.trim().length >= 10;
                      return (
                        <div key={m.id} className="flex items-center gap-2 text-xs">
                          <span className="flex-1">{m.name}</span>
                          {hasPhone ? (
                            <span className="font-mono text-text-light">{formatPhone(m.phone || "")}</span>
                          ) : (
                            <span className="text-amber-700">sem telefone</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium mb-1 text-text-light">Grupo (opcional)</label>
                <select
                  value={notifyCfg.retornoMaterial?.groups[0]?.jid || ""}
                  onChange={(e) => {
                    const jid = e.target.value;
                    const g = groups.find((x) => x.remote_jid === jid);
                    setNotifyCfg((c) => {
                      if (!c) return c;
                      const prev = c.retornoMaterial ?? { groups: [], functions: [], enabled: true };
                      return {
                        ...c,
                        retornoMaterial: { ...prev, groups: jid ? [{ jid, label: g?.push_name || null }] : [] },
                      };
                    });
                  }}
                  disabled={savingCfg || notifyCfg.retornoMaterial?.enabled === false}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                >
                  <option value="">Nenhum grupo</option>
                  {groups.map((g) => (
                    <option key={g.remote_jid} value={g.remote_jid}>
                      {g.push_name || g.remote_jid.replace("@g.us", "")}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-text-light mt-1">
                  Se escolher um grupo, o aviso também é postado nele — útil pra testar antes de valer.
                </p>
              </div>
            </div>

            <div className="border border-border rounded-xl p-4 space-y-3">
              <div>
                <p className="text-sm font-semibold">📦 Lista de embarque</p>
                <p className="text-[11px] text-text-light">
                  Disparado pelo botão &ldquo;Enviar lista pro WhatsApp&rdquo; da aba Embarque — posta os
                  materiais + rancho da equipe, com as quantidades que vão pro navio.
                </p>
              </div>

              <label className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={notifyCfg.embarqueLista?.enabled !== false}
                  onChange={(e) => setNotifyCfg((c) => {
                    if (!c) return c;
                    const prev = c.embarqueLista ?? { groups: [], functions: [], enabled: true };
                    return { ...c, embarqueLista: { ...prev, enabled: e.target.checked } };
                  })}
                  disabled={savingCfg}
                  className="w-4 h-4"
                />
                <span>Enviar a lista de embarque</span>
              </label>

              <div>
                <label className="block text-xs font-medium mb-1 text-text-light">Grupo de destino</label>
                <select
                  value={notifyCfg.embarqueLista?.groups[0]?.jid || ""}
                  onChange={(e) => {
                    const jid = e.target.value;
                    const g = groups.find((x) => x.remote_jid === jid);
                    setNotifyCfg((c) => {
                      if (!c) return c;
                      const prev = c.embarqueLista ?? { groups: [], functions: [], enabled: true };
                      return {
                        ...c,
                        embarqueLista: { ...prev, groups: jid ? [{ jid, label: g?.push_name || null }] : [] },
                      };
                    });
                  }}
                  disabled={savingCfg || notifyCfg.embarqueLista?.enabled === false}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                >
                  <option value="">Nenhum grupo</option>
                  {groups.map((g) => (
                    <option key={g.remote_jid} value={g.remote_jid}>
                      {g.push_name || g.remote_jid.replace("@g.us", "")}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-text-light mt-1">
                  Sem grupo escolhido o botão avisa e não envia — escolha o grupo de teste primeiro, depois o oficial.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button type="button" onClick={saveNotifyConfig} disabled={savingCfg || loadingCfg || !notifyCfg}>
            {savingCfg ? "Salvando..." : "Salvar configuração"}
          </Button>
        </div>
      </section>

      {/* Mensagem de aniversário */}
      <section className="bg-card rounded-2xl border border-border p-6 space-y-4">
        <div>
          <h2 className="text-lg font-bold text-text">Mensagem de Aniversário 🎂</h2>
          <p className="text-sm text-text-light">
            Todo dia, às <strong>10h</strong>, o sistema manda um WhatsApp de parabéns para quem
            faz aniversário — colaboradores <strong>ativos</strong> e <strong>com pendência</strong>
            {" "}(demitidos não recebem). O texto abaixo é enviado para o número de cada um.
          </p>
        </div>

        {bdayMsg && (
          <div className={`rounded-lg px-3 py-2 text-sm border ${
            bdayMsg.kind === "ok"
              ? "bg-emerald-50 border-emerald-200 text-emerald-900"
              : "bg-red-50 border-red-200 text-red-900"
          }`}>
            {bdayMsg.text}
          </div>
        )}

        <label className="flex items-center gap-2 text-sm font-medium cursor-pointer select-none">
          <input
            type="checkbox"
            checked={bdayEnabled}
            onChange={(e) => setBdayEnabled(e.target.checked)}
            disabled={loadingBday}
            className="w-4 h-4 accent-primary"
          />
          Enviar parabéns automaticamente
          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${bdayEnabled ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-600"}`}>
            {bdayEnabled ? "Ativo" : "Desligado"}
          </span>
        </label>

        <div>
          <label className="block text-sm font-medium mb-1">Texto da mensagem</label>
          <textarea
            value={bdayTemplate}
            onChange={(e) => setBdayTemplate(e.target.value)}
            disabled={loadingBday}
            rows={7}
            placeholder="🎉 Feliz aniversário, {nome}!"
            className="w-full px-3 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none font-mono"
          />
          <p className="text-[11px] text-text-light mt-1">
            Use <code className="px-1 rounded bg-gray-100">{"{nome}"}</code> (primeiro nome),{" "}
            <code className="px-1 rounded bg-gray-100">{"{nome_completo}"}</code> e{" "}
            <code className="px-1 rounded bg-gray-100">{"{idade}"}</code> — o sistema troca pelos dados de
            cada colaborador. Negrito do WhatsApp: *texto*.
          </p>
        </div>

        <div className="flex justify-end">
          <Button type="button" onClick={saveBirthdayConfig} disabled={savingBday || loadingBday}>
            {savingBday ? "Salvando..." : "Salvar mensagem"}
          </Button>
        </div>
      </section>

      {/* Mensagens agendadas */}
      <section className="bg-card rounded-2xl border border-border p-6 space-y-4">
        <div>
          <h2 className="text-lg font-bold text-text">Mensagens agendadas 🕒</h2>
          <p className="text-sm text-text-light">
            Dispare boletins recorrentes (estoque, prontidão ou texto livre) num grupo, no horário que escolher.
          </p>
        </div>

        {schedMsg && (
          <div className={`rounded-lg px-3 py-2 text-sm border ${
            schedMsg.kind === "ok"
              ? "bg-emerald-50 border-emerald-200 text-emerald-900"
              : "bg-red-50 border-red-200 text-red-900"
          }`}>
            {schedMsg.text}
          </div>
        )}

        {loadingSchedules ? (
          <p className="text-sm text-text-light">Carregando agendamentos...</p>
        ) : schedules.length === 0 ? (
          <p className="text-sm text-text-light">Nenhum agendamento ainda.</p>
        ) : (
          <>
            {schedules.length > 1 && (
              <p className="text-[11px] text-text-light mb-2">
                Quando vários agendamentos caem no mesmo horário, eles são enviados de cima pra baixo — use ↑/↓ pra ordenar.
              </p>
            )}
            <ul className="divide-y divide-border border border-border rounded-lg">
            {schedules.map((s, index) => (
              <li key={s.id} className={`flex items-start gap-3 px-3 py-2.5 ${editingId === s.id ? "bg-indigo-50" : ""}`}>
                <div className="flex flex-col gap-0.5 shrink-0 pt-0.5">
                  <button
                    type="button"
                    onClick={() => moveSchedule(index, -1)}
                    disabled={index === 0}
                    title="Subir na sequência de disparo"
                    aria-label="Subir"
                    className="w-5 h-5 inline-flex items-center justify-center rounded text-gray-500 hover:bg-gray-200 disabled:opacity-25 disabled:cursor-not-allowed text-xs leading-none"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSchedule(index, 1)}
                    disabled={index === schedules.length - 1}
                    title="Descer na sequência de disparo"
                    aria-label="Descer"
                    className="w-5 h-5 inline-flex items-center justify-center rounded text-gray-500 hover:bg-gray-200 disabled:opacity-25 disabled:cursor-not-allowed text-xs leading-none"
                  >
                    ↓
                  </button>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">
                    👥 {s.group_label || s.group_jid.replace("@g.us", "")}
                  </p>
                  <p className="text-xs text-text-light">
                    {scheduleSummary(s)} · {recurrenceLabel(s)}
                  </p>
                  <p className="text-[11px] text-text-light mt-0.5">
                    {s.enabled ? (
                      <>Próximo: <span className="font-medium">{fmtBrDateTime(s.next_run_at)}</span></>
                    ) : (
                      <span className="text-amber-700">Pausado</span>
                    )}
                    {s.last_status && (
                      <span className={`ml-2 ${s.last_status.startsWith("error") ? "text-red-700" : "text-emerald-700"}`}>
                        · último envio: {s.last_status.startsWith("error") ? "erro" : "ok"}
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => editSchedule(s)}
                    className="text-xs px-2 py-1 rounded-lg font-medium bg-indigo-100 text-indigo-800 hover:bg-indigo-200"
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    onClick={() => duplicateSchedule(s)}
                    className="text-xs px-2 py-1 rounded-lg font-medium bg-sky-100 text-sky-800 hover:bg-sky-200"
                  >
                    Duplicar
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleSchedule(s)}
                    className={`text-xs px-2 py-1 rounded-lg font-medium ${
                      s.enabled
                        ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                        : "bg-emerald-100 text-emerald-800 hover:bg-emerald-200"
                    }`}
                  >
                    {s.enabled ? "Pausar" : "Ativar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteSchedule(s)}
                    className="text-xs px-2 py-1 rounded-lg font-medium bg-gray-100 text-gray-700 hover:bg-red-100 hover:text-red-700"
                  >
                    Excluir
                  </button>
                </div>
              </li>
            ))}
            </ul>
          </>
        )}

        <form ref={schedFormRef} onSubmit={saveSchedule} className="border-t border-border pt-4 space-y-3">
          <p className="text-sm font-semibold">{editingId ? "Editar agendamento" : "Novo agendamento"}</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1 text-text-light">Grupo</label>
              <select
                value={schedForm.group_jid}
                onChange={(e) => setSchedForm((f) => ({ ...f, group_jid: e.target.value }))}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
              >
                <option value="">Selecione um grupo...</option>
                {groups.map((g) => (
                  <option key={g.remote_jid} value={g.remote_jid}>
                    {g.push_name || g.remote_jid.replace("@g.us", "")}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1 text-text-light">Conteúdo</label>
              <select
                value={schedForm.template}
                onChange={(e) => setSchedForm((f) => ({ ...f, template: e.target.value as ScheduleTemplate }))}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
              >
                <option value="EPI">Lista de EPIs</option>
                <option value="UNIFORME">Lista de uniformes</option>
                <option value="PRONTIDAO">Prontidão pra embarque</option>
                <option value="COMPRAS">Lista de compras</option>
                <option value="CUSTOM">Mensagem personalizada</option>
              </select>
            </div>

            {schedForm.template === "PRONTIDAO" && (
              <div>
                <label className="block text-xs font-medium mb-1 text-text-light">Equipe</label>
                <select
                  value={schedForm.team}
                  onChange={(e) => setSchedForm((f) => ({ ...f, team: e.target.value as ProntidaoTeam }))}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                >
                  <option value="ALL">Todas as equipes</option>
                  <option value="EQUIPE_1">Equipe 1</option>
                  <option value="EQUIPE_2">Equipe 2</option>
                  <option value="EQUIPE_3">Equipe 3</option>
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium mb-1 text-text-light">Frequência</label>
              <select
                value={schedForm.frequency}
                onChange={(e) => setSchedForm((f) => ({ ...f, frequency: e.target.value as "DAILY" | "WEEKLY" }))}
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
              >
                <option value="DAILY">Todo dia</option>
                <option value="WEEKLY">Toda semana</option>
              </select>
            </div>

            {schedForm.frequency === "WEEKLY" && (
              <div>
                <label className="block text-xs font-medium mb-1 text-text-light">Dia da semana</label>
                <select
                  value={schedForm.weekday}
                  onChange={(e) => setSchedForm((f) => ({ ...f, weekday: Number(e.target.value) }))}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                >
                  {WEEKDAY_NAMES.map((w, i) => <option key={i} value={i}>{w}</option>)}
                </select>
              </div>
            )}

            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs font-medium mb-1 text-text-light">Hora</label>
                <input
                  type="number" min={0} max={23}
                  value={schedForm.hour}
                  onChange={(e) => setSchedForm((f) => ({ ...f, hour: Math.max(0, Math.min(23, Number(e.target.value) || 0)) }))}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium mb-1 text-text-light">Minuto</label>
                <input
                  type="number" min={0} max={59}
                  value={schedForm.minute}
                  onChange={(e) => setSchedForm((f) => ({ ...f, minute: Math.max(0, Math.min(59, Number(e.target.value) || 0)) }))}
                  className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1 text-text-light">
              Cabeçalho (opcional) — texto fixo antes dos dados
            </label>
            <textarea
              value={schedForm.header_text}
              onChange={(e) => setSchedForm((f) => ({ ...f, header_text: e.target.value }))}
              rows={2}
              placeholder={"Ex: ~ Bom dia Equipe Cargo Ships Cleaning ~\nTenham todos um ótimo trabalho 👇"}
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-y whitespace-pre-wrap"
            />
          </div>

          {schedForm.template === "CUSTOM" && (
            <div>
              <label className="block text-xs font-medium mb-1 text-text-light">Mensagem personalizada</label>
              <textarea
                value={schedForm.body_text}
                onChange={(e) => setSchedForm((f) => ({ ...f, body_text: e.target.value }))}
                rows={3}
                placeholder="Texto que será enviado..."
                className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none resize-none"
              />
            </div>
          )}

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs text-text-light">
              {schedForm.template === "CUSTOM"
                ? "O texto vai exatamente como digitado."
                : "O conteúdo é montado com os números atuais no momento do envio."}
            </p>
            <div className="flex items-center gap-2">
              {editingId && (
                <Button type="button" variant="secondary" onClick={cancelEdit} disabled={savingSched}>
                  Cancelar
                </Button>
              )}
              <Button type="submit" disabled={savingSched}>
                {savingSched
                  ? "Salvando..."
                  : editingId
                    ? "Salvar alterações"
                    : "Salvar agendamento"}
              </Button>
            </div>
          </div>
        </form>
      </section>

      {/* Per-recipient results */}
      {results && results.length > 0 && (
        <section className="bg-card rounded-2xl border border-border p-6">
          <h3 className="text-sm font-semibold mb-3">Resultado do envio</h3>
          <ul className="divide-y divide-border text-sm">
            {results.map((r, idx) => (
              <li key={idx} className="py-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${r.ok ? "bg-emerald-500" : "bg-red-500"}`} />
                  <span className="flex-1 min-w-0">{r.name}</span>
                  <span className="text-xs text-text-light font-mono">{formatPhone(r.phone)}</span>
                </div>
                {!r.ok && r.error && (
                  <p className="ml-4 mt-1 text-xs text-red-700 whitespace-pre-wrap break-words">
                    {r.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
