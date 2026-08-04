"use client";

// Relatórios de Bordo: o supervisor escalado (papel SUPERVISOR) — ou a gestão —
// registra a lavagem dos porões/costado, avalia os colaboradores da equipe,
// adiciona fotos (com a marca d'água da Cargo queimada no upload) e gera os
// três PDFs: Cleaning Report, Relatório Fotográfico e Avaliação de Desempenho.
//
// Visibilidade: o supervisor só vê os navios em que o colaborador vinculado ao
// login está escalado (Escalação de Embarque/Costado); o serviço escalado
// define se ele vê o relatório de EMBARQUE, de COSTADO ou os dois. O escopo é
// aplicado no servidor (/api/relatorios) — a tela só reflete.
//
// A aba Avaliações sincroniza sozinha (polling) enquanto está aberta: a gestão
// vê ao vivo as notas que o supervisor salva de bordo — edições locais ainda
// não salvas nunca são sobrescritas pelo refresh.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { hasModuleAccess } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon, TrashIcon } from "@/components/icons";
import { processReportPhoto } from "@/lib/watermark";
import {
  EVAL_CRITERIA,
  printCleaningReport,
  printEvaluationReport,
  printPhotoReport,
  type ActivityRow,
  type EvaluationPrintRow,
  type HoldRow,
  type PhotoMeta,
} from "@/lib/ship-report-print";

type Kind = "EMBARQUE" | "COSTADO";

interface ShipInfo {
  id: string;
  name: string;
  port: string | null;
  status: string;
  arrival_date: string | null;
  departure_date: string | null;
  cargo_type: string | null;
  holds_count: number | null;
  client_name: string | null;
}

interface NavioItem {
  job_id: string;
  job_name: string;
  ship: ShipInfo | null;
  kinds: Kind[];
  reports: { kind: string; status: string; updated_at: string; photos: number }[];
}

interface TeamMember {
  employee_id: number;
  name: string;
  function_name: string | null;
}

interface EvaluationApi {
  employee_id: number;
  productivity: number;
  quality: number;
  teamwork: number;
  safety: number;
  initiative: number;
  punctuality: number;
  technical: number;
  comments: string | null;
  evaluated_by?: string | null;
  updated_at?: string;
}

interface ReportApi {
  id: string;
  report_date: string | null;
  port: string | null;
  status: string;
  remarks: string | null;
  etc_date: string | null;
  etc_time: string | null;
  holds: (HoldRow & { id: number })[];
  activities: (ActivityRow & { id: number })[];
  photos: (PhotoMeta & { created_by: string; created_at: string })[];
}

interface DetailData {
  job: { id: string; name: string };
  ship: ShipInfo | null;
  kind: Kind;
  report: ReportApi | null;
  team: TeamMember[];
  evaluations: EvaluationApi[];
  // Média histórica de cada membro nos outros navios (só vem pra gestão).
  history?: Record<number, { avg: number; count: number }>;
}

interface EvalDraft {
  productivity: number;
  quality: number;
  teamwork: number;
  safety: number;
  initiative: number;
  punctuality: number;
  technical: number;
  comments: string;
}

const EMPTY_EVAL: EvalDraft = {
  productivity: 0, quality: 0, teamwork: 0, safety: 0,
  initiative: 0, punctuality: 0, technical: 0, comments: "",
};

function toDraft(e: EvaluationApi): EvalDraft {
  return {
    productivity: e.productivity, quality: e.quality,
    teamwork: e.teamwork, safety: e.safety,
    initiative: e.initiative, punctuality: e.punctuality,
    technical: e.technical, comments: e.comments || "",
  };
}

const SHIP_STATUS_CHIP: Record<string, { label: string; cls: string }> = {
  AGENDADO: { label: "Agendado", cls: "bg-blue-100 text-blue-700" },
  EM_OPERACAO: { label: "Em operação", cls: "bg-amber-100 text-amber-700" },
  CONCLUIDO: { label: "Concluído", cls: "bg-emerald-100 text-emerald-700" },
};

const KIND_LABEL: Record<Kind, string> = { EMBARQUE: "Embarque", COSTADO: "Costado" };
const KIND_EMOJI: Record<Kind, string> = { EMBARQUE: "⚓", COSTADO: "🌊" };
const STAGES = [
  { value: "ANTES", label: "Antes" },
  { value: "DURANTE", label: "Durante" },
  { value: "DEPOIS", label: "Depois" },
];

// Opções do Registro de atividades (select — "Parada" registra período sem
// operação). "Outra..." abre texto livre, com estas mesmas sugestões no datalist.
const ACTIVITY_SUGGESTIONS = [
  "Lavagem com água salgada",
  "Lavagem com água doce",
  "Parada",
  "Parada por chuva",
  "Parada — aguardando liberação do porão",
  "Enxágue",
  "Secagem do porão",
  "Remoção de resíduos de carga",
  "Montagem de equipamentos",
];

// Locais da foto além dos porões (Embarque), na ordem do ciclo real da
// operação: caminhão → material a bordo → navio → volta. Substituem o antigo
// "Geral / sem porão"; o PDF traduz cada um pro inglês (holdLabelEn).
const PHOTO_PLACES = [
  "Carregamento do caminhão",
  "Embarque de material",
  "Navio",
  "Desembarque do navio",
  "Descarregamento do caminhão",
];

// Sentinela do select de atividade: troca a linha pra texto livre.
const CUSTOM_ACTIVITY = "__outra__";

// time_range é texto no banco ("22:00 - 01:40") — os pickers de hora convertem
// pra lá e de volta. Valores legados que não parseiam aparecem vazios no picker
// mas só são sobrescritos se o usuário mexer.
function normalizeTime(v: string | null | undefined): string {
  const m = String(v || "").trim().match(/^(\d{1,2})[:hH.](\d{2})$/);
  if (!m) return "";
  const h = Number(m[1]);
  if (h > 23 || Number(m[2]) > 59) return "";
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

function splitTimeRange(v: string | null | undefined): { start: string; end: string } {
  const [a = "", b = ""] = String(v || "").split(/\s*[-–—]\s*/);
  return { start: normalizeTime(a), end: normalizeTime(b) };
}

function joinTimeRange(start: string, end: string): string {
  if (start && end) return `${start} - ${end}`;
  if (start) return start; // atividade em aberto: só o início
  if (end) return `- ${end}`; // só término — o "-" na frente preserva o lado no reload
  return "";
}

function emptyHold(label: string): HoldRow {
  return {
    label,
    status: "PENDENTE",
    start_time: null,
    end_time: null,
    salt_start: null,
    salt_end: null,
    fresh_start: null,
    fresh_end: null,
    completion_pct: 0,
  };
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isoDateOnly(v: string | null): string {
  return v ? String(v).slice(0, 10) : "";
}

export default function RelatoriosPage() {
  const { profile } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (profile && !hasModuleAccess(profile.role, "RELATORIOS")) router.replace("/");
  }, [profile, router]);

  const [navios, setNavios] = useState<NavioItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [showFinished, setShowFinished] = useState(false);
  const [selected, setSelected] = useState<{ jobId: string; kind: Kind } | null>(null);

  const loadNavios = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/relatorios/navios");
      const json = await res.json();
      if (!res.ok) {
        setLoadError(json.error || "Erro ao carregar navios.");
        return;
      }
      setNavios(json.data || []);
    } catch {
      setLoadError("Erro ao conectar com o servidor.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadNavios();
  }, [loadNavios]);

  const filtered = useMemo(() => {
    return navios.filter((n) => {
      if (!n.ship) return false;
      if (!showFinished && n.ship.status === "CONCLUIDO") return false;
      const text = `${n.ship.name} ${n.ship.port || ""} ${n.ship.client_name || ""}`.toLowerCase();
      return text.includes(search.toLowerCase());
    });
  }, [navios, search, showFinished]);

  if (selected) {
    return (
      <ReportDetail
        jobId={selected.jobId}
        kind={selected.kind}
        supervisorName={profile?.full_name || "—"}
        onBack={() => {
          setSelected(null);
          loadNavios();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-text">Relatórios de Bordo</h1>
        <p className="text-sm text-text-light mt-1">
          {profile?.role === "SUPERVISOR"
            ? "Navios em que você está escalado. Registre a lavagem, avalie a equipe, adicione fotos e gere os relatórios."
            : "Relatórios de lavagem, fotos e avaliações preenchidos pelos supervisores a bordo."}
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar navio..."
          className="flex-1 px-4 py-2.5 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none bg-white"
        />
        <label className="flex items-center gap-2 text-sm text-text-light cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showFinished}
            onChange={(e) => setShowFinished(e.target.checked)}
            className="accent-primary w-4 h-4"
          />
          Mostrar concluídos
        </label>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700">
          ⚠️ {loadError}
        </div>
      )}

      {loading ? (
        <div className="bg-card rounded-xl border border-border p-10 text-center text-text-light text-sm animate-pulse">
          Carregando navios...
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-10 text-center">
          <p className="text-4xl mb-2">🚢</p>
          <p className="text-sm text-text-light">
            {navios.length === 0
              ? "Nenhum navio escalado para você no momento. Quando o gestor te escalar num navio, ele aparece aqui."
              : "Nenhum navio encontrado com esse filtro."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((n) => {
            const chip = SHIP_STATUS_CHIP[n.ship!.status];
            return (
              <div key={n.job_id} className="bg-card rounded-xl border border-border p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-bold text-text truncate">{n.ship!.name}</p>
                    <p className="text-xs text-text-light mt-0.5">
                      {[n.ship!.port, n.ship!.cargo_type, n.ship!.client_name].filter(Boolean).join(" · ") || "—"}
                    </p>
                  </div>
                  {chip && (
                    <span className={`shrink-0 text-xs px-2 py-1 rounded-full font-medium ${chip.cls}`}>
                      {chip.label}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  {n.kinds.map((k) => {
                    const rep = n.reports.find((r) => r.kind === k);
                    return (
                      <button
                        key={k}
                        onClick={() => setSelected({ jobId: n.job_id, kind: k })}
                        className="flex-1 min-w-[130px] px-3 py-2.5 rounded-lg border border-border hover:border-primary hover:bg-primary/5 transition text-left"
                      >
                        <p className="text-sm font-semibold text-text">
                          {KIND_EMOJI[k]} {KIND_LABEL[k]}
                        </p>
                        <p className="text-xs text-text-light mt-0.5">
                          {rep
                            ? `${rep.status === "COMPLETO" ? "✅ Completo" : "📝 Em andamento"}${rep.photos ? ` · ${rep.photos} foto${rep.photos > 1 ? "s" : ""}` : ""}`
                            : "Sem relatório ainda"}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Detalhe de um navio+serviço ─────────────────────────────────────────────

function ReportDetail({
  jobId,
  kind,
  supervisorName,
  onBack,
}: {
  jobId: string;
  kind: Kind;
  supervisorName: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<DetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"lavagem" | "avaliacoes" | "fotos" | "gerar">("lavagem");

  // ── Rascunho da lavagem ────────────────────────────────────────────────────
  const [header, setHeader] = useState({
    report_date: todayIso(),
    port: "",
    status: "EM_ANDAMENTO",
    remarks: "",
    etc_date: "",
    etc_time: "",
  });
  const [holds, setHolds] = useState<HoldRow[]>([]);
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  // Linhas de atividade em modo "Outra..." (texto livre) — por índice.
  const [customActivityRows, setCustomActivityRows] = useState<Set<number>>(new Set());
  const [savingReport, setSavingReport] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  // ── Avaliações ────────────────────────────────────────────────────────────
  const [evals, setEvals] = useState<Map<number, EvalDraft>>(new Map());
  const [savingEvals, setSavingEvals] = useState(false);
  // Colaboradores com edição local ainda não salva — a sincronização automática
  // não passa por cima deles. Limpa ao salvar/recarregar.
  const dirtyEvalsRef = useRef<Set<number>>(new Set());
  // Versão local das avaliações: salvar/recarregar invalida um refresh em voo
  // (senão um GET disparado antes do PUT desfaria o que acabou de ser salvo).
  const evalsSyncRef = useRef(0);

  // ── Fotos ─────────────────────────────────────────────────────────────────
  const [photos, setPhotos] = useState<(PhotoMeta & { created_by?: string })[]>([]);
  // Embarque começa no primeiro local do ciclo; Costado mantém "Geral / sem área".
  const [uploadHold, setUploadHold] = useState(kind === "EMBARQUE" ? PHOTO_PLACES[0] : "");
  const [uploadStage, setUploadStage] = useState("ANTES");
  const [uploadCaption, setUploadCaption] = useState("");
  const [uploadProgress, setUploadProgress] = useState("");
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [deletePhoto, setDeletePhoto] = useState<PhotoMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/relatorios/${jobId}?kind=${kind}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || "Erro ao carregar o relatório.");
        return;
      }
      const d: DetailData = json.data;
      setData(d);

      const r = d.report;
      setHeader({
        report_date: isoDateOnly(r?.report_date ?? null) || todayIso(),
        port: r?.port ?? d.ship?.port ?? "",
        status: r?.status ?? "EM_ANDAMENTO",
        remarks: r?.remarks ?? "",
        etc_date: r?.etc_date ?? "",
        etc_time: r?.etc_time ?? "",
      });

      if (r && r.holds.length > 0) {
        setHolds(r.holds.map((h) => ({ ...h })));
      } else if (kind === "EMBARQUE" && d.ship?.holds_count) {
        // Primeiro acesso: já monta a lista de porões do navio.
        setHolds(Array.from({ length: d.ship.holds_count }, (_, i) => emptyHold(`Porão ${i + 1}`)));
      } else {
        setHolds([]);
      }
      setActivities(r ? r.activities.map((a) => ({ ...a })) : []);
      setPhotos(r ? r.photos : []);

      const map = new Map<number, EvalDraft>();
      for (const member of d.team) {
        const existing = d.evaluations.find((e) => e.employee_id === member.employee_id);
        map.set(member.employee_id, existing ? toDraft(existing) : { ...EMPTY_EVAL });
      }
      setEvals(map);
      dirtyEvalsRef.current.clear();
      evalsSyncRef.current++;
    } catch {
      setError("Erro ao conectar com o servidor.");
    } finally {
      setLoading(false);
    }
  }, [jobId, kind]);

  useEffect(() => {
    load();
  }, [load]);

  // Sincronização das avaliações: enquanto a aba Avaliações está aberta, busca
  // de tempos em tempos o que foi salvo por outra pessoa (ex.: a gestão vendo
  // ao vivo as notas que o supervisor lança de bordo). Só atualiza quem não tem
  // edição local pendente.
  const refreshEvals = useCallback(async () => {
    const ver = evalsSyncRef.current;
    try {
      const res = await fetch(`/api/relatorios/${jobId}?kind=${kind}`);
      if (!res.ok) return;
      const json = await res.json();
      const d: DetailData | undefined = json.data;
      if (!d || ver !== evalsSyncRef.current) return; // salvou/recarregou no meio
      setData((prev) => (prev ? { ...prev, team: d.team, evaluations: d.evaluations, history: d.history } : prev));
      setEvals((prev) => {
        const next = new Map<number, EvalDraft>();
        for (const member of d.team) {
          const mine = dirtyEvalsRef.current.has(member.employee_id)
            ? prev.get(member.employee_id)
            : undefined;
          if (mine) {
            next.set(member.employee_id, mine);
            continue;
          }
          const existing = d.evaluations.find((e) => e.employee_id === member.employee_id);
          next.set(member.employee_id, existing ? toDraft(existing) : { ...EMPTY_EVAL });
        }
        return next;
      });
    } catch {
      // refresh silencioso — a próxima rodada tenta de novo
    }
  }, [jobId, kind]);

  useEffect(() => {
    if (tab !== "avaliacoes") return;
    refreshEvals();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refreshEvals();
    }, 10_000);
    return () => clearInterval(id);
  }, [tab, refreshEvals]);

  const holdLabels = useMemo(
    () => holds.map((h) => h.label).filter(Boolean),
    [holds]
  );

  // Preencheu horário de uma atividade/fase ligada a um porão pendente → o
  // porão entra em "Em andamento" sozinho (Completo não é rebaixado).
  const markHoldInProgress = useCallback((label: string | null | undefined) => {
    if (!label) return;
    setHolds((prev) =>
      prev.map((h) => (h.label === label && h.status === "PENDENTE" ? { ...h, status: "EM_ANDAMENTO" } : h))
    );
  }, []);

  async function saveReport() {
    setSavingReport(true);
    setSavedMsg("");
    try {
      const res = await fetch(`/api/relatorios/${jobId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, report: header, holds, activities }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSavedMsg(`⚠️ ${json.error || "Erro ao salvar."}`);
        return;
      }
      setSavedMsg("✅ Relatório salvo!");
      setTimeout(() => setSavedMsg(""), 3000);
    } catch {
      setSavedMsg("⚠️ Erro ao conectar com o servidor.");
    } finally {
      setSavingReport(false);
    }
  }

  async function saveEvals() {
    if (!data) return;
    setSavingEvals(true);
    setSavedMsg("");
    try {
      const payload = data.team.map((m) => ({ employee_id: m.employee_id, ...(evals.get(m.employee_id) || EMPTY_EVAL) }));
      const res = await fetch(`/api/relatorios/${jobId}/avaliacoes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, evaluations: payload }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSavedMsg(`⚠️ ${json.error || "Erro ao salvar."}`);
        return;
      }
      dirtyEvalsRef.current.clear();
      evalsSyncRef.current++;
      refreshEvals(); // atualiza o "avaliado por" na hora
      setSavedMsg("✅ Avaliações salvas!");
      setTimeout(() => setSavedMsg(""), 3000);
    } catch {
      setSavedMsg("⚠️ Erro ao conectar com o servidor.");
    } finally {
      setSavingEvals(false);
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setUploadErrors([]);
    const errs: string[] = [];
    for (let i = 0; i < list.length; i++) {
      setUploadProgress(`Enviando foto ${i + 1} de ${list.length}...`);
      try {
        const dataUrl = await processReportPhoto(list[i]);
        const res = await fetch(`/api/relatorios/${jobId}/fotos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            hold_label: uploadHold || null,
            stage: uploadStage,
            caption: uploadCaption || null,
            image_data: dataUrl,
          }),
        });
        const json = await res.json();
        if (!res.ok) {
          errs.push(`${list[i].name}: ${json.error || "erro no envio"}`);
          continue;
        }
        setPhotos((prev) => [...prev, json.data]);
      } catch {
        errs.push(`${list[i].name}: formato não suportado`);
      }
    }
    setUploadProgress("");
    setUploadErrors(errs);
    setUploadCaption("");
  }

  async function confirmDeletePhoto() {
    if (!deletePhoto) return;
    setDeleting(true);
    try {
      await fetch(`/api/relatorios/fotos/${deletePhoto.id}`, { method: "DELETE" });
      setPhotos((prev) => prev.filter((p) => p.id !== deletePhoto.id));
      setDeletePhoto(null);
    } finally {
      setDeleting(false);
    }
  }

  // ── Geração dos PDFs ──────────────────────────────────────────────────────

  const vesselName = data?.ship?.name || data?.job.name || "—";

  function generateCleaning() {
    printCleaningReport({
      vesselName,
      kind,
      reportDate: header.report_date || null,
      port: header.port || null,
      complete: header.status === "COMPLETO",
      holds,
      activities,
      remarks: header.remarks || null,
      etcDate: header.etc_date || null,
      etcTime: header.etc_time || null,
      supervisorName,
    });
  }

  function generatePhotos() {
    printPhotoReport({
      vesselName,
      kind,
      reportDate: header.report_date || null,
      photos,
    });
  }

  function generateEvaluations() {
    if (!data) return;
    const rows: EvaluationPrintRow[] = data.team
      .map((m) => {
        const e = evals.get(m.employee_id) || EMPTY_EVAL;
        return { name: m.name, function_name: m.function_name, ...e, comments: e.comments || null };
      })
      .filter((r) => EVAL_CRITERIA.some((c) => Number(r[c.key]) > 0));
    printEvaluationReport({ vesselName, reportDate: header.report_date || null, rows });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="bg-card rounded-xl border border-border p-10 text-center text-text-light text-sm animate-pulse">
        Carregando relatório...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <button onClick={onBack} className="text-sm text-primary hover:underline">← Voltar</button>
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700">
          ⚠️ {error || "Erro ao carregar."}
        </div>
      </div>
    );
  }

  const tabs = [
    { key: "lavagem" as const, label: kind === "COSTADO" ? "🧽 Lavagem do Costado" : "🧽 Lavagem dos Porões" },
    { key: "avaliacoes" as const, label: "⭐ Avaliações" },
    { key: "fotos" as const, label: `📷 Fotos${photos.length ? ` (${photos.length})` : ""}` },
    { key: "gerar" as const, label: "📄 Gerar Relatórios" },
  ];

  const inputCls = "w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none bg-white";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={onBack} className="text-sm text-primary hover:underline shrink-0">← Voltar</button>
        <h1 className="text-xl md:text-2xl font-bold text-text">
          {KIND_EMOJI[kind]} {vesselName}
          <span className="text-text-light font-medium text-base ml-2">· {KIND_LABEL[kind]}</span>
        </h1>
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3.5 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition ${
              tab === t.key ? "bg-primary text-white shadow-sm" : "bg-card border border-border text-text-light hover:text-text"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {savedMsg && (
        <div className={`rounded-lg p-2.5 text-sm ${savedMsg.startsWith("✅") ? "bg-emerald-50 border border-emerald-200 text-emerald-700" : "bg-red-50 border border-red-200 text-red-700"}`}>
          {savedMsg}
        </div>
      )}

      {/* ── Lavagem ── */}
      {tab === "lavagem" && (
        <div className="space-y-4">
          <div className="bg-card rounded-xl border border-border p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-light mb-1">Data do relatório</label>
              <input type="date" value={header.report_date} onChange={(e) => setHeader((h) => ({ ...h, report_date: e.target.value }))} className={inputCls} />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-light mb-1">Porto / Fundeio</label>
              <input type="text" value={header.port} onChange={(e) => setHeader((h) => ({ ...h, port: e.target.value }))} className={inputCls} placeholder="Santos" />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-light mb-1">Status do relatório</label>
              <select value={header.status} onChange={(e) => setHeader((h) => ({ ...h, status: e.target.value }))} className={inputCls}>
                <option value="EM_ANDAMENTO">Em andamento</option>
                <option value="COMPLETO">Completo</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-light mb-1">Previsão de término (ETC)</label>
              <div className="flex gap-1.5">
                <input type="text" value={header.etc_date} onChange={(e) => setHeader((h) => ({ ...h, etc_date: e.target.value }))} className={inputCls} placeholder="Data" />
                <input type="text" value={header.etc_time} onChange={(e) => setHeader((h) => ({ ...h, etc_time: e.target.value }))} className={inputCls} placeholder="Hora" />
              </div>
            </div>
          </div>

          {/* Porões / áreas */}
          <div className="bg-card rounded-xl border border-border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-text text-sm">
                {kind === "COSTADO" ? "Áreas do costado" : "Porões"}
              </p>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  setHolds((prev) => [
                    ...prev,
                    emptyHold(kind === "COSTADO" ? `Área ${prev.length + 1}` : `Porão ${prev.length + 1}`),
                  ])
                }
              >
                <PlusIcon className="w-4 h-4" />
                Adicionar
              </Button>
            </div>

            {holds.length === 0 && (
              <p className="text-sm text-text-light">Nenhum {kind === "COSTADO" ? "área" : "porão"} adicionado.</p>
            )}

            <div className="space-y-2">
              {holds.map((h, i) => {
                const patch = (p: Partial<HoldRow>) =>
                  setHolds((prev) => prev.map((x, j) => (j === i ? { ...x, ...p } : x)));
                // Horário preenchido em porão pendente → "Em andamento" sozinho.
                const patchTime = (
                  field: "salt_start" | "salt_end" | "fresh_start" | "fresh_end",
                  v: string
                ) =>
                  patch({
                    [field]: v || null,
                    ...(v && h.status === "PENDENTE" ? { status: "EM_ANDAMENTO" } : {}),
                  } as Partial<HoldRow>);
                return (
                  <div key={i} className="bg-gray-50 rounded-lg p-2.5 space-y-2">
                    <div className="grid grid-cols-[1fr_auto] md:grid-cols-[1fr_150px_90px_36px] gap-2 items-center">
                      <input type="text" value={h.label} onChange={(e) => patch({ label: e.target.value })} className={inputCls} placeholder={kind === "COSTADO" ? "Área" : "Porão"} />
                      <select value={h.status} onChange={(e) => patch({ status: e.target.value, completion_pct: e.target.value === "COMPLETO" ? 100 : h.completion_pct })} className={inputCls}>
                        <option value="PENDENTE">Pendente</option>
                        <option value="EM_ANDAMENTO">Em andamento</option>
                        <option value="COMPLETO">Completo</option>
                      </select>
                      <div className="flex items-center gap-1">
                        <input type="number" min={0} max={100} value={h.completion_pct} onChange={(e) => patch({ completion_pct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} className={inputCls} />
                        <span className="text-xs text-text-light">%</span>
                      </div>
                      <button onClick={() => setHolds((prev) => prev.filter((_, j) => j !== i))} title="Remover" className="p-1.5 text-text-light hover:text-danger hover:bg-danger/10 rounded-lg transition justify-self-end">
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </div>
                    {/* Fases da lavagem: água salgada (lavagem) e doce (enxágue).
                        Empilha até lg — em ~768-850px as metades espremiam os
                        inputs de horário a ~40px (ilegível). */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-text-light w-24 shrink-0">🌊 Água salgada</span>
                        <input type="time" value={normalizeTime(h.salt_start)} onChange={(e) => patchTime("salt_start", e.target.value)} className={inputCls} title="Início" />
                        <span className="text-xs text-text-light shrink-0">→</span>
                        <input type="time" value={normalizeTime(h.salt_end)} onChange={(e) => patchTime("salt_end", e.target.value)} className={inputCls} title="Término" />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-text-light w-24 shrink-0">💧 Água doce</span>
                        <input type="time" value={normalizeTime(h.fresh_start)} onChange={(e) => patchTime("fresh_start", e.target.value)} className={inputCls} title="Início" />
                        <span className="text-xs text-text-light shrink-0">→</span>
                        <input type="time" value={normalizeTime(h.fresh_end)} onChange={(e) => patchTime("fresh_end", e.target.value)} className={inputCls} title="Término" />
                      </div>
                    </div>
                    {/* Horário geral legado (relatório salvo antes das fases):
                        só aparece quando tem valor — dá pra ver, corrigir ou
                        limpar (limpou e salvou → some de vez). */}
                    {(h.start_time || h.end_time) && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-amber-700 w-24 shrink-0" title="Registrado antes da divisão por fases">🕐 Horário geral</span>
                        <input type="text" value={h.start_time || ""} onChange={(e) => patch({ start_time: e.target.value })} className={inputCls} placeholder="Início" />
                        <input type="text" value={h.end_time || ""} onChange={(e) => patch({ end_time: e.target.value })} className={inputCls} placeholder="Término" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Atividades */}
          <div className="bg-card rounded-xl border border-border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-text text-sm">Registro de atividades</p>
              <Button size="sm" variant="secondary" onClick={() => setActivities((prev) => [...prev, { time_range: "", activity: "", hold_label: "" }])}>
                <PlusIcon className="w-4 h-4" />
                Adicionar
              </Button>
            </div>

            {activities.length === 0 && <p className="text-sm text-text-light">Nenhuma atividade registrada.</p>}

            {/* O modo texto livre ("Outra...") completa com as mesmas sugestões */}
            <datalist id="activity-suggestions">
              {ACTIVITY_SUGGESTIONS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>

            <div className="space-y-2">
              {activities.map((a, i) => {
                const patchAct = (p: Partial<ActivityRow>) =>
                  setActivities((prev) => prev.map((x, j) => (j === i ? { ...x, ...p } : x)));
                const { start, end } = splitTimeRange(a.time_range);
                // Valor fora da lista (legado/texto livre) mantém a linha em modo texto.
                const custom = customActivityRows.has(i) || (!!a.activity && !ACTIVITY_SUGGESTIONS.includes(a.activity));
                const setTime = (which: "start" | "end", v: string) => {
                  patchAct({ time_range: joinTimeRange(which === "start" ? v : start, which === "end" ? v : end) || null });
                  if (v) markHoldInProgress(a.hold_label);
                };
                return (
                  <div key={i} className="grid grid-cols-2 md:grid-cols-[220px_1fr_150px_36px] gap-2 items-center bg-gray-50 rounded-lg p-2">
                    <div className="col-span-2 md:col-span-1 flex items-center gap-1">
                      <input type="time" value={start} onChange={(e) => setTime("start", e.target.value)} className={inputCls} title="Início" />
                      <span className="text-xs text-text-light shrink-0">→</span>
                      <input type="time" value={end} onChange={(e) => setTime("end", e.target.value)} className={inputCls} title="Término" />
                    </div>
                    {custom ? (
                      <div className="flex items-center gap-1">
                        <input type="text" list="activity-suggestions" value={a.activity} onChange={(e) => patchAct({ activity: e.target.value })} className={inputCls} placeholder="Digite a atividade..." />
                        <button
                          onClick={() => {
                            setCustomActivityRows((prev) => {
                              const n = new Set(prev);
                              n.delete(i);
                              return n;
                            });
                            patchAct({ activity: "" });
                          }}
                          title="Voltar pra lista de atividades"
                          className="px-2 py-1.5 text-text-light hover:text-text hover:bg-gray-200 rounded-lg transition shrink-0 text-sm"
                        >
                          ☰
                        </button>
                      </div>
                    ) : (
                      <select
                        value={a.activity}
                        onChange={(e) => {
                          if (e.target.value === CUSTOM_ACTIVITY) {
                            setCustomActivityRows((prev) => new Set(prev).add(i));
                            patchAct({ activity: "" });
                          } else {
                            patchAct({ activity: e.target.value });
                          }
                        }}
                        className={inputCls}
                      >
                        <option value="">— atividade —</option>
                        {ACTIVITY_SUGGESTIONS.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                        <option value={CUSTOM_ACTIVITY}>✏️ Outra (digitar)...</option>
                      </select>
                    )}
                    <select
                      value={a.hold_label || ""}
                      onChange={(e) => {
                        const label = e.target.value || null;
                        patchAct({ hold_label: label });
                        if (start || end) markHoldInProgress(label);
                      }}
                      className={inputCls}
                    >
                      <option value="">— {kind === "COSTADO" ? "área" : "porão"} —</option>
                      {holdLabels.map((l) => (
                        <option key={l} value={l}>{l}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => {
                        setActivities((prev) => prev.filter((_, j) => j !== i));
                        // Reindexa o modo texto das linhas seguintes.
                        setCustomActivityRows((prev) => {
                          const n = new Set<number>();
                          for (const j of prev) {
                            if (j === i) continue;
                            n.add(j > i ? j - 1 : j);
                          }
                          return n;
                        });
                      }}
                      title="Remover"
                      className="p-1.5 text-text-light hover:text-danger hover:bg-danger/10 rounded-lg transition justify-self-end"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Observações */}
          <div className="bg-card rounded-xl border border-border p-4 space-y-2">
            <p className="font-semibold text-text text-sm">Observações</p>
            <textarea value={header.remarks} onChange={(e) => setHeader((h) => ({ ...h, remarks: e.target.value }))} rows={3} className={inputCls} placeholder="Observações gerais da operação..." />
          </div>

          <div className="flex justify-end">
            <Button onClick={saveReport} disabled={savingReport}>
              {savingReport ? "Salvando..." : "💾 Salvar relatório"}
            </Button>
          </div>
        </div>
      )}

      {/* ── Avaliações ── */}
      {tab === "avaliacoes" && (
        <div className="space-y-4">
          {data.team.length === 0 ? (
            <div className="bg-card rounded-xl border border-border p-8 text-center text-sm text-text-light">
              Nenhum colaborador escalado neste serviço ainda.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 text-xs text-text-light">
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
                Sincronização automática ligada: avaliações salvas por outra pessoa (ex.: o supervisor a bordo) aparecem aqui sozinhas, sem recarregar a página.
              </div>
              {data.team.map((m) => {
                const e = evals.get(m.employee_id) || EMPTY_EVAL;
                const rated = EVAL_CRITERIA.map((c) => e[c.key as keyof EvalDraft] as number).filter((v) => v > 0);
                const avg = rated.length ? (rated.reduce((s, v) => s + v, 0) / rated.length).toFixed(1) : null;
                const hist = data.history?.[m.employee_id];
                const saved = data.evaluations.find((x) => x.employee_id === m.employee_id);
                return (
                  <div key={m.employee_id} className="bg-card rounded-xl border border-border p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div>
                        <p className="font-bold text-text">{m.name}</p>
                        <p className="text-xs text-text-light">{m.function_name || "Colaborador"}</p>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        {saved?.evaluated_by && (
                          <span
                            className="text-xs px-2 py-1 rounded-full bg-blue-50 text-blue-700 font-medium"
                            title={saved.updated_at ? `Última atualização: ${new Date(saved.updated_at).toLocaleString("pt-BR")}` : undefined}
                          >
                            ✍️ {saved.evaluated_by}
                          </span>
                        )}
                        {hist && (
                          <span
                            className="text-xs px-2 py-1 rounded-full bg-amber-100 text-amber-800 font-medium"
                            title={`Média das avaliações que este colaborador recebeu em ${hist.count} outro(s) navio(s)`}
                          >
                            ⭐ Histórico: {hist.avg.toFixed(1)} ({hist.count} navio{hist.count > 1 ? "s" : ""})
                          </span>
                        )}
                        {avg && <span className="text-sm font-bold text-primary">Média: {avg}</span>}
                      </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-1.5">
                      {EVAL_CRITERIA.map((c) => {
                        const value = e[c.key as keyof EvalDraft] as number;
                        return (
                          <div key={c.key} className="flex items-center justify-between gap-2">
                            <span className="text-sm text-text">{c.label}</span>
                            <div className="flex items-center gap-0.5">
                              {[1, 2, 3, 4, 5].map((n) => (
                                <button
                                  key={n}
                                  type="button"
                                  onClick={() => {
                                    dirtyEvalsRef.current.add(m.employee_id);
                                    setEvals((prev) => {
                                      const next = new Map(prev);
                                      next.set(m.employee_id, { ...e, [c.key]: value === n ? 0 : n });
                                      return next;
                                    });
                                  }}
                                  className={`text-xl leading-none transition ${n <= value ? "text-amber-500" : "text-gray-300 hover:text-amber-300"}`}
                                  title={`${n} estrela${n > 1 ? "s" : ""}`}
                                >
                                  ★
                                </button>
                              ))}
                              <span className="text-xs text-text-light w-7 text-right">{value > 0 ? `(${value})` : ""}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    <textarea
                      value={e.comments}
                      onChange={(ev) => {
                        dirtyEvalsRef.current.add(m.employee_id);
                        setEvals((prev) => {
                          const next = new Map(prev);
                          next.set(m.employee_id, { ...e, comments: ev.target.value });
                          return next;
                        });
                      }}
                      rows={2}
                      className={inputCls}
                      placeholder="Observações do supervisor sobre este colaborador..."
                    />
                  </div>
                );
              })}
              <div className="flex justify-end">
                <Button onClick={saveEvals} disabled={savingEvals}>
                  {savingEvals ? "Salvando..." : "💾 Salvar avaliações"}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Fotos ── */}
      {tab === "fotos" && (
        <div className="space-y-4">
          <div className="bg-card rounded-xl border border-border p-4 space-y-3">
            <p className="font-semibold text-text text-sm">Adicionar fotos</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <select value={uploadHold} onChange={(e) => setUploadHold(e.target.value)} className={inputCls}>
                {kind === "COSTADO" ? (
                  <option value="">Geral / sem área</option>
                ) : (
                  PHOTO_PLACES.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))
                )}
                {holdLabels.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
              <select value={uploadStage} onChange={(e) => setUploadStage(e.target.value)} className={inputCls}>
                {STAGES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label} da lavagem</option>
                ))}
              </select>
              <input type="text" value={uploadCaption} onChange={(e) => setUploadCaption(e.target.value)} className={`${inputCls} col-span-2`} placeholder="Legenda (opcional)" />
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={!!uploadProgress}
              className="w-full border-2 border-dashed border-border hover:border-primary/60 rounded-xl p-6 text-center transition disabled:opacity-60"
            >
              <p className="text-3xl mb-1">📷</p>
              <p className="text-sm font-medium text-text">
                {uploadProgress || "Selecionar fotos (câmera ou galeria)"}
              </p>
              <p className="text-xs text-text-light mt-1">
                A marca d&apos;água da Cargo é aplicada automaticamente em cada foto.
              </p>
            </button>
            {uploadErrors.length > 0 && (
              <p className="text-xs text-danger">Falhou: {uploadErrors.join("; ")}</p>
            )}
          </div>

          {photos.length === 0 ? (
            <div className="bg-card rounded-xl border border-border p-8 text-center text-sm text-text-light">
              Nenhuma foto adicionada ainda.
            </div>
          ) : (
            (() => {
              const groups = new Map<string, typeof photos>();
              for (const p of photos) {
                const key = `${p.hold_label || "Geral"} · ${STAGES.find((s) => s.value === p.stage)?.label || p.stage}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key)!.push(p);
              }
              return [...groups.entries()].map(([label, items]) => (
                <div key={label} className="space-y-2">
                  <p className="text-sm font-semibold text-text">{label} <span className="text-text-light font-normal">({items.length})</span></p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    {items.map((p) => (
                      <div key={p.id} className="bg-card rounded-xl border border-border overflow-hidden">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/relatorios/fotos/${p.id}`} alt={p.caption || label} className="w-full h-36 object-cover" loading="lazy" />
                        <div className="p-2 flex items-center justify-between gap-1">
                          <p className="text-xs text-text-light truncate">{p.caption || "—"}</p>
                          <button onClick={() => setDeletePhoto(p)} title="Excluir foto" className="p-1 text-text-light hover:text-danger hover:bg-danger/10 rounded transition shrink-0">
                            <TrashIcon className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ));
            })()
          )}
        </div>
      )}

      {/* ── Gerar relatórios ── */}
      {tab === "gerar" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-3">
            <p className="text-3xl">🧽</p>
            <div className="flex-1">
              <p className="font-bold text-text">Cleaning Report</p>
              <p className="text-xs text-text-light mt-1">
                Relatório operacional da lavagem (1 página, em inglês): status por {kind === "COSTADO" ? "área" : "porão"}, atividades, observações, ETC e assinatura.
              </p>
            </div>
            <Button onClick={generateCleaning}>Gerar PDF</Button>
          </div>

          <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-3">
            <p className="text-3xl">📷</p>
            <div className="flex-1">
              <p className="font-bold text-text">Relatório Fotográfico</p>
              <p className="text-xs text-text-light mt-1">
                Capa + uma foto por página (antes/durante/depois), com a marca d&apos;água da Cargo. {photos.length} foto{photos.length === 1 ? "" : "s"} no relatório.
              </p>
            </div>
            <Button onClick={generatePhotos} disabled={photos.length === 0}>Gerar PDF</Button>
          </div>

          <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-3">
            <p className="text-3xl">⭐</p>
            <div className="flex-1">
              <p className="font-bold text-text">Avaliação de Desempenho</p>
              <p className="text-xs text-text-light mt-1">
                Avaliação da equipe com notas por critério, pontos a melhorar e observações do supervisor.
              </p>
            </div>
            <Button onClick={generateEvaluations} disabled={data.team.length === 0}>Gerar PDF</Button>
          </div>

          <div className="md:col-span-3 bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-900">
            💡 O relatório abre numa nova janela já com o diálogo de impressão — escolha{" "}
            <strong>&quot;Salvar como PDF&quot;</strong> pra baixar o arquivo. No celular, use o menu de
            compartilhar/imprimir do navegador. Gere o PDF <strong>depois de salvar</strong> as
            alterações, pra sair tudo atualizado.
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!deletePhoto}
        onClose={() => setDeletePhoto(null)}
        onConfirm={confirmDeletePhoto}
        title="Excluir foto"
        message="Excluir esta foto do relatório?"
        loading={deleting}
      />
    </div>
  );
}
