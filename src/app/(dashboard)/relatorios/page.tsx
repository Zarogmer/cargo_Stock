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
// Avaliações: SÓ o SUPERVISOR dá nota (e não avalia a si mesmo — quem tem
// função SUPERVISOR fica fora da lista). A gestão vê em modo leitura, ao vivo
// (polling enquanto a aba está aberta), o que o supervisor lançou de bordo;
// edições locais do supervisor nunca são sobrescritas pelo refresh.
// Acesso ao módulo: Gestor/RH/Executivo/Financeiro/Tecnologia + Supervisor
// (ver RELATORIOS no rbac.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { hasModuleAccess } from "@/lib/rbac";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PlusIcon, TrashIcon } from "@/components/icons";
import { processReportPhoto, sniffImageType } from "@/lib/watermark";
import { shareOrDownloadBlob } from "@/lib/print";
import {
  EVAL_CRITERIA,
  photoBlockKey,
  photoPlaceRank,
  GENERAL_BLOCK,
  type ActivityRow,
  type HoldRow,
  type PhotoMeta,
} from "@/lib/report-format";

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
  sections: SectionRow[];
}

// Bloco de fotos com legenda própria / criado à mão. Os blocos fixos (ciclo da
// operação + porões do navio) aparecem na tela mesmo sem linha no banco.
interface SectionRow {
  id: number;
  label: string;
  caption: string | null;
  sort_order: number;
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

// Rótulos do select de fase no upload de fotos ("Durante A lavagem" — com a
// gramática certa). A fase só existe pra porão/área; locais do ciclo vão sem
// fase (stage GERAL).
const STAGE_UPLOAD_LABEL: Record<string, string> = {
  ANTES: "Antes da lavagem",
  DURANTE: "Durante a lavagem",
  DEPOIS: "Depois da lavagem",
};

// Opções do Registro de atividades (select — "Parada" registra período sem
// operação). "Outra..." abre texto livre, com estas mesmas sugestões no datalist.
// (Lavagem com água salgada/doce saiu da lista: o horário das duas fases é
// registrado por porão, na tabela de cima.)
const ACTIVITY_SUGGESTIONS = [
  "Parada",
  "Parada — aguardando liberação do porão",
  "Enxágue",
  "Secagem do porão",
  "Remoção de resíduos de carga",
  "Montagem de equipamentos",
  "Desmontagem do material",
  "Embarque de equipamentos",
  "Retirada de materiais",
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

// Texto do relatório pro WhatsApp (botão "Enviar pro WhatsApp"): resumo em
// PT-BR do que foi preenchido na aba Lavagem — é mensagem interna pro
// escritório, diferente dos PDFs (inglês). Usa a formatação do app (*negrito*).
// A previsão de término (ETC) vai logo no cabeçalho, junto do status: é o dado
// que o escritório mais procura na mensagem, não dava pra ficar no rodapé.
function buildWhatsText(opts: {
  vesselName: string;
  kind: Kind;
  header: { report_date: string; port: string; status: string; remarks: string; etc_date: string; etc_time: string };
  holds: HoldRow[];
  activities: ActivityRow[];
  supervisorName: string;
}): string {
  const { header, holds, activities } = opts;
  const HOLD_STATUS_PT: Record<string, string> = {
    PENDENTE: "Pendente",
    EM_ANDAMENTO: "Em andamento",
    COMPLETO: "Completo",
  };
  // Uma linha por fase, com nome por extenso — só emoji não dava pra saber
  // qual era a salgada e qual era a doce.
  const phase = (emoji: string, name: string, start: string | null, end: string | null) => {
    if (!start && !end) return null;
    if (start && end) return `${emoji} ${name}: ${start} às ${end}`;
    if (start) return `${emoji} ${name}: iniciou às ${start}`;
    return `${emoji} ${name}: terminou às ${end}`;
  };

  const L: string[] = [];
  L.push(`🚢 *RELATÓRIO DE BORDO — ${opts.vesselName}* (${KIND_LABEL[opts.kind]})`);
  const dateBr = header.report_date ? header.report_date.split("-").reverse().join("/") : "";
  const info = [dateBr && `📅 ${dateBr}`, header.port && `📍 ${header.port}`].filter(Boolean).join(" · ");
  if (info) L.push(info);
  L.push(header.status === "COMPLETO" ? "✅ Operação completa" : "🔄 Operação em andamento");
  const etc = [header.etc_date, header.etc_time].filter((v) => String(v || "").trim()).join(" às ");
  if (etc) L.push(`⏳ *Previsão de término:* ${etc}`);

  const named = holds.filter((h) => h.label.trim());
  if (named.length) {
    L.push("", `*${opts.kind === "COSTADO" ? "Áreas do costado" : "Porões"}*`);
    for (const h of named) {
      L.push(`• ${h.label} — ${HOLD_STATUS_PT[h.status] || h.status} · ${h.completion_pct}%`);
      for (const line of [
        phase("🌊", "Água salgada", h.salt_start, h.salt_end),
        phase("💧", "Água doce", h.fresh_start, h.fresh_end),
        phase("🕐", "Horário geral", h.start_time, h.end_time),
      ]) {
        if (line) L.push(`   ${line}`);
      }
    }
  }

  const acts = activities.filter((a) => a.activity.trim());
  if (acts.length) {
    L.push("", "*Atividades*");
    for (const a of acts) {
      L.push(`• ${a.time_range ? `${a.time_range} — ` : ""}${a.activity}${a.hold_label ? ` (${a.hold_label})` : ""}`);
    }
  }

  if (header.remarks.trim()) L.push("", "*Observações*", header.remarks.trim());
  L.push("", `_Enviado pelo Cargo Stock — ${opts.supervisorName}_`);
  return L.join("\n");
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

// EMBARQUE com nº de porões no cadastro (aba Navios): a lista do relatório É a
// do navio — completa com vazios até o nº do cadastro; linhas salvas ALÉM dele
// (legado de antes da trava) continuam visíveis só pra dar baixa. O supervisor
// não adiciona porão: o Adicionar some e o PUT rejeita exceder o cadastro.
function mergeShipHolds(saved: HoldRow[], count: number): HoldRow[] {
  const rows: HoldRow[] = Array.from({ length: count }, (_, i) =>
    saved[i] ? { ...saved[i] } : emptyHold(`Porão ${i + 1}`)
  );
  for (let i = count; i < saved.length; i++) rows.push({ ...saved[i] });
  return rows;
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
        canRate={profile?.role === "SUPERVISOR"}
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
  canRate,
  onBack,
}: {
  jobId: string;
  kind: Kind;
  supervisorName: string;
  // true só pro papel SUPERVISOR: ele dá as notas. A gestão vê em modo leitura.
  canRate: boolean;
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
    remarks: "",
    etc_date: "",
    etc_time: "",
  });
  // Status SALVO do relatório (EM_ANDAMENTO | COMPLETO). Não é select: muda só
  // pelas ações "Concluir relatório" (qualquer um) e "Reabrir" (só gestão).
  // COMPLETO trava o relatório inteiro pro SUPERVISOR — tela e API.
  const [savedStatus, setSavedStatus] = useState("EM_ANDAMENTO");
  const [confirmConclude, setConfirmConclude] = useState(false);
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
  // A aba é montada em BLOCOS (locais do ciclo + porões + blocos criados à
  // mão). Cada bloco tem seu próprio botão de adicionar foto, sua legenda e —
  // nos porões — a fase da lavagem. Não existe mais um seletor global de local.
  const [photos, setPhotos] = useState<(PhotoMeta & { created_by?: string })[]>([]);
  const [sections, setSections] = useState<SectionRow[]>([]);
  // Fase escolhida em cada bloco de porão (default: Antes).
  const [blockStage, setBlockStage] = useState<Record<string, string>>({});
  // Legendas sendo digitadas: do bloco (por rótulo) e da foto (por id).
  const [blockCaptions, setBlockCaptions] = useState<Record<string, string>>({});
  const [photoCaptions, setPhotoCaptions] = useState<Record<number, string>>({});
  const [uploadProgress, setUploadProgress] = useState("");
  // Qual bloco está enviando agora (mostra o progresso no lugar certo).
  const [uploadingLabel, setUploadingLabel] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<string[]>([]);
  const [deletePhoto, setDeletePhoto] = useState<PhotoMeta | null>(null);
  const [deleting, setDeleting] = useState(false);
  // ── Geração dos PDFs ──────────────────────────────────────────────────────
  const [generatingPdf, setGeneratingPdf] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Destino do próximo arquivo escolhido — setado ao clicar no bloco.
  const uploadTargetRef = useRef<{ label: string; stage: string }>({ label: "", stage: "GERAL" });

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
        remarks: r?.remarks ?? "",
        etc_date: r?.etc_date ?? "",
        etc_time: r?.etc_time ?? "",
      });
      setSavedStatus(r?.status ?? "EM_ANDAMENTO");

      if (kind === "EMBARQUE" && d.ship?.holds_count) {
        // A lista de porões vem do cadastro do navio (aba Navios).
        setHolds(mergeShipHolds(r?.holds ?? [], d.ship.holds_count));
      } else if (r && r.holds.length > 0) {
        setHolds(r.holds.map((h) => ({ ...h })));
      } else {
        setHolds([]);
      }
      setActivities(r ? r.activities.map((a) => ({ ...a })) : []);
      setPhotos(r ? r.photos : []);
      setSections(r?.sections ?? []);
      setBlockCaptions(Object.fromEntries((r?.sections ?? []).map((s) => [s.label, s.caption || ""])));
      setPhotoCaptions(Object.fromEntries((r?.photos ?? []).map((p) => [p.id, p.caption || ""])));

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

  // Quem aparece na aba Avaliações: a equipe escalada SEM supervisor — o
  // supervisor avalia, não é avaliado (nem por ele mesmo, nem pela gestão).
  const evalTeam = useMemo(
    () => (data?.team || []).filter((m) => (m.function_name || "").trim().toUpperCase() !== "SUPERVISOR"),
    [data?.team]
  );

  // Blocos da aba Fotos, na MESMA ordem em que saem no PDF: locais do ciclo da
  // operação, porões do cadastro do navio, blocos criados à mão e qualquer
  // rótulo que já tenha foto (relatórios antigos). Todos existem na tela mesmo
  // vazios — é só clicar no bloco pra adicionar foto nele.
  const photoBlocks = useMemo(() => {
    const labels: string[] = [];
    const push = (l: string) => {
      const label = photoBlockKey(l);
      if (!labels.includes(label)) labels.push(label);
    };
    if (kind === "EMBARQUE") PHOTO_PLACES.forEach(push);
    else push(GENERAL_BLOCK);
    holdLabels.forEach(push);
    sections.forEach((s) => push(s.label));
    photos.forEach((p) => push(p.hold_label || ""));

    const fixed = new Set(
      (kind === "EMBARQUE" ? PHOTO_PLACES : [GENERAL_BLOCK]).concat(holdLabels).map(photoBlockKey)
    );
    const orderOf = new Map(sections.map((s) => [s.label, s.sort_order]));

    return labels
      .map((label) => ({
        label,
        isHold: holdLabels.includes(label),
        fixed: fixed.has(label),
        rank: photoPlaceRank(label, orderOf.get(label) ?? 0),
      }))
      .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, "pt-BR", { numeric: true }));
  }, [kind, holdLabels, sections, photos]);

  // Preencheu horário de uma atividade/fase ligada a um porão pendente → o
  // porão entra em "Em andamento" sozinho (Completo não é rebaixado).
  const markHoldInProgress = useCallback((label: string | null | undefined) => {
    if (!label) return;
    setHolds((prev) =>
      prev.map((h) => (h.label === label && h.status === "PENDENTE" ? { ...h, status: "EM_ANDAMENTO" } : h))
    );
  }, []);

  // nextStatus: sem argumento = salvar mantendo o status atual; "COMPLETO" =
  // Concluir relatório; "EM_ANDAMENTO" (vindo de um concluído) = Reabrir.
  async function saveReport(nextStatus?: "EM_ANDAMENTO" | "COMPLETO") {
    const statusToSave = nextStatus ?? savedStatus;
    setSavingReport(true);
    setSavedMsg("");
    try {
      const res = await fetch(`/api/relatorios/${jobId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, report: { ...header, status: statusToSave }, holds, activities }),
      });
      const json = await res.json();
      if (!res.ok) {
        setSavedMsg(`⚠️ ${json.error || "Erro ao salvar."}`);
        return;
      }
      setSavedStatus(statusToSave);
      setSavedMsg(
        nextStatus === "COMPLETO"
          ? "✅ Relatório concluído! A partir de agora só a gestão consegue editar."
          : nextStatus === "EM_ANDAMENTO"
            ? "🔓 Relatório reaberto — o supervisor pode editar de novo."
            : "✅ Relatório salvo!"
      );
      setTimeout(() => setSavedMsg(""), 5000);
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
      const payload = evalTeam.map((m) => ({ employee_id: m.employee_id, ...(evals.get(m.employee_id) || EMPTY_EVAL) }));
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

  // Abre o seletor de arquivos já sabendo em que bloco (e fase) a foto entra.
  function openPicker(label: string, stage: string) {
    uploadTargetRef.current = { label, stage };
    setUploadErrors([]);
    fileInputRef.current?.click();
  }

  async function handleFiles(files: FileList | null) {
    const target = uploadTargetRef.current;
    const list = files ? Array.from(files) : [];
    setUploadErrors([]);
    setUploadingLabel(target.label);
    if (list.length === 0) {
      setUploadErrors(["Nenhuma foto veio da galeria — tente selecionar de novo."]);
      return;
    }
    const errs: string[] = [];

    // O File que a galeria do celular entrega é só um ponteiro pra foto (no
    // iPhone, um item do Photos, às vezes ainda no iCloud). Esse ponteiro pode
    // morrer no meio do envio — enquanto a foto anterior sobe, o app vai pro
    // background ou o input é resetado — e aí nada mais é lido. Por isso os
    // bytes de TODAS as fotos são copiados aqui, antes de qualquer ida ao
    // servidor. (Foto tirada na hora pela câmera não sofria disso: era um
    // arquivo temporário de verdade.)
    setUploadProgress(`Lendo ${list.length} foto${list.length > 1 ? "s" : ""}...`);
    const items: { name: string; blob: Blob | null }[] = [];
    for (const f of list) {
      const name = f.name || "foto";
      try {
        const buf = await f.arrayBuffer();
        const head = new Uint8Array(buf.slice(0, 16));
        const type = sniffImageType(head) || f.type || "application/octet-stream";
        items.push({ name, blob: new Blob([buf], { type }) });
      } catch {
        items.push({ name, blob: null });
      }
    }

    for (let i = 0; i < list.length; i++) {
      setUploadProgress(`Enviando foto ${i + 1} de ${list.length}...`);
      const item = items[i];
      if (!item.blob) {
        errs.push(`${item.name}: o celular não deixou ler o arquivo (se a foto está no iCloud, abra ela na galeria primeiro)`);
        continue;
      }
      try {
        const dataUrl = await processReportPhoto(item.blob);
        const res = await fetch(`/api/relatorios/${jobId}/fotos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            hold_label: target.label,
            // Fase de lavagem só em porão/área; locais do ciclo vão sem fase.
            stage: target.stage,
            image_data: dataUrl,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          errs.push(`${item.name}: ${json.error || `erro no envio (${res.status})`}`);
          continue;
        }
        setPhotos((prev) => [...prev, json.data]);
      } catch (err) {
        errs.push(`${item.name}: ${err instanceof Error ? err.message : "não foi possível enviar"}`);
      }
    }
    setUploadProgress("");
    setUploadingLabel(null);
    setUploadErrors(errs);
  }

  // ── Blocos de foto ────────────────────────────────────────────────────────

  // Legenda do bloco: cria a linha na primeira vez que alguém escreve algo.
  async function saveBlockCaption(label: string) {
    const caption = (blockCaptions[label] ?? "").trim();
    const current = sections.find((s) => s.label === label);
    if ((current?.caption || "") === caption) return;
    if (!current && !caption) return;
    try {
      const res = await fetch(`/api/relatorios/${jobId}/secoes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, label, caption }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUploadErrors([json.error || "Não deu pra salvar a legenda do bloco."]);
        return;
      }
      setSections((prev) => [...prev.filter((s) => s.label !== label), json.data]);
    } catch {
      setUploadErrors(["Erro ao conectar com o servidor."]);
    }
  }

  async function savePhotoCaption(id: number) {
    const caption = (photoCaptions[id] ?? "").trim();
    const current = photos.find((p) => p.id === id);
    if (!current || (current.caption || "") === caption) return;
    try {
      const res = await fetch(`/api/relatorios/fotos/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caption }),
      });
      if (!res.ok) return;
      setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, caption: caption || null } : p)));
    } catch {
      // legenda é detalhe: falhou, o texto continua na tela pra tentar de novo
    }
  }

  // Bloco só some da tela quando está vazio: os fixos (ciclo + porões) nunca
  // saem, e sobrou remoção só pros rótulos livres de relatórios antigos.
  async function removeBlock(label: string) {
    try {
      const res = await fetch(
        `/api/relatorios/${jobId}/secoes?kind=${kind}&label=${encodeURIComponent(label)}`,
        { method: "DELETE" }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setUploadErrors([json.error || "Não deu pra remover o bloco."]);
        return;
      }
      setSections((prev) => prev.filter((s) => s.label !== label));
    } catch {
      setUploadErrors(["Erro ao conectar com o servidor."]);
    }
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

  // Abre o WhatsApp do celular do supervisor com o relatório pronto e deixa ELE
  // escolher pra onde vai: wa.me SEM número cai na tela de "enviar para", que
  // lista contatos e grupos (antes ia direto pro chat da empresa, e o relatório
  // costuma ser postado num grupo do navio). Salva o relatório junto, pra
  // mensagem e sistema ficarem idênticos.
  function sendToWhats() {
    const text = buildWhatsText({
      vesselName,
      kind,
      header: { ...header, status: savedStatus },
      holds,
      activities,
      supervisorName,
    });
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
    // Relatório concluído é só leitura — manda a mensagem sem tentar salvar.
    if (!(canRate && savedStatus === "COMPLETO")) saveReport();
  }

  // O PDF é montado no servidor (src/lib/report-pdf.ts) e baixado como arquivo
  // — igual aos documentos do RH. No celular abre o menu de compartilhar.
  // Conteúdo = o que está SALVO: o aviso da aba lembra de salvar antes.
  async function downloadPdf(tipo: "cleaning" | "fotos" | "avaliacao") {
    setPdfError("");
    setGeneratingPdf(tipo);
    try {
      const res = await fetch(`/api/relatorios/${jobId}/pdf?kind=${kind}&tipo=${tipo}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Erro ${res.status}`);
      }
      const blob = await res.blob();
      const name = res.headers.get("Content-Disposition")?.match(/filename\*=UTF-8''([^;]+)/);
      const fileName = name ? decodeURIComponent(name[1]) : `Relatorio ${vesselName}.pdf`;
      await shareOrDownloadBlob(blob, fileName);
    } catch (err) {
      setPdfError(err instanceof Error ? err.message : "Não foi possível gerar o PDF.");
    } finally {
      setGeneratingPdf(null);
    }
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

  // > 0 = Embarque com nº de porões no cadastro do navio: lista travada nesse
  // tamanho (sem Adicionar; rótulo e exclusão bloqueados nas linhas do cadastro).
  const lockedHolds = kind === "EMBARQUE" ? data.ship?.holds_count || 0 : 0;

  // Relatório concluído + visão do supervisor = tudo somente leitura (a gestão
  // continua editando e pode reabrir).
  const locked = canRate && savedStatus === "COMPLETO";

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

      {/* Abas quebram linha no celular: em ~390px as 4 não cabiam e a última
          ficava cortada na borda (a rolagem lateral passava despercebida). */}
      <div className="flex flex-wrap gap-1.5">
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
          {savedStatus === "COMPLETO" && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800">
              ✅ Relatório concluído
              {locked
                ? " — somente leitura. Precisando corrigir algo, peça pra gestão reabrir."
                : ". O supervisor não consegue mais editar — use “Reabrir relatório” pra liberar de novo."}
            </div>
          )}
          {/* fieldset desabilita todos os campos de uma vez quando o relatório
              está concluído na visão do supervisor. min-w-0 anula o
              min-width:min-content padrão de fieldset (quebraria o responsivo). */}
          <fieldset disabled={locked} className="space-y-4 min-w-0">
          {/* Cabeçalho: uma coluna no celular. Em duas, o input de data (que no
              iOS tem largura mínima própria) estourava a célula e encostava no
              campo do lado. min-w-0 solta as células do min-width:auto do grid. */}
          <div className="bg-card rounded-xl border border-border p-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
            <div className="min-w-0">
              <label className="block text-xs font-medium text-text-light mb-1">Data do relatório</label>
              <input type="date" value={header.report_date} onChange={(e) => setHeader((h) => ({ ...h, report_date: e.target.value }))} className={inputCls} />
            </div>
            <div className="min-w-0">
              <label className="block text-xs font-medium text-text-light mb-1">Porto / Fundeio</label>
              <input type="text" value={header.port} onChange={(e) => setHeader((h) => ({ ...h, port: e.target.value }))} className={inputCls} placeholder="Santos" />
            </div>
            <div className="min-w-0">
              <label className="block text-xs font-medium text-text-light mb-1">Status do relatório</label>
              {/* Não é mais select: o status muda pelo Concluir/Reabrir. */}
              <div className={`px-3 py-2 rounded-lg border text-sm font-medium ${savedStatus === "COMPLETO" ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-amber-50 border-amber-200 text-amber-700"}`}>
                {savedStatus === "COMPLETO" ? "✅ Concluído" : "🔄 Em andamento"}
              </div>
            </div>
            <div className="min-w-0">
              <label className="block text-xs font-medium text-text-light mb-1">Previsão de término (ETC)</label>
              <div className="flex gap-1.5">
                <input type="text" value={header.etc_date} onChange={(e) => setHeader((h) => ({ ...h, etc_date: e.target.value }))} className={`${inputCls} min-w-0`} placeholder="Data" />
                <input type="text" value={header.etc_time} onChange={(e) => setHeader((h) => ({ ...h, etc_time: e.target.value }))} className={`${inputCls} min-w-0`} placeholder="Hora" />
              </div>
            </div>
          </div>

          {/* Porões / áreas */}
          <div className="bg-card rounded-xl border border-border p-4 space-y-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <p className="font-semibold text-text text-sm">
                  {kind === "COSTADO" ? "Áreas do costado" : "Porões"}
                </p>
                {lockedHolds > 0 && (
                  <p className="text-xs text-text-light mt-0.5">
                    {lockedHolds} {lockedHolds > 1 ? "porões" : "porão"} conforme o cadastro do navio (aba Navios).
                  </p>
                )}
              </div>
              {lockedHolds === 0 && (
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
              )}
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
                // Linha do cadastro do navio: nome fixo e sem exclusão. Linhas
                // além do cadastro (legado) seguem editáveis pra dar baixa.
                const fixed = lockedHolds > 0 && i < lockedHolds;
                return (
                  <div key={i} className="bg-gray-50 rounded-lg p-2.5 space-y-2">
                    <div className="grid grid-cols-[1fr_auto] md:grid-cols-[1fr_150px_90px_36px] gap-2 items-center">
                      {fixed ? (
                        <p className="px-3 py-2 text-sm font-semibold text-text">{h.label}</p>
                      ) : (
                        <input type="text" value={h.label} onChange={(e) => patch({ label: e.target.value })} className={inputCls} placeholder={kind === "COSTADO" ? "Área" : "Porão"} />
                      )}
                      <select value={h.status} onChange={(e) => patch({ status: e.target.value, completion_pct: e.target.value === "COMPLETO" ? 100 : h.completion_pct })} className={inputCls}>
                        <option value="PENDENTE">Pendente</option>
                        <option value="EM_ANDAMENTO">Em andamento</option>
                        <option value="COMPLETO">Completo</option>
                      </select>
                      <div className="flex items-center gap-1">
                        <input type="number" min={0} max={100} value={h.completion_pct} onChange={(e) => patch({ completion_pct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} className={inputCls} />
                        <span className="text-xs text-text-light">%</span>
                      </div>
                      {!fixed && (
                        <button onClick={() => setHolds((prev) => prev.filter((_, j) => j !== i))} title="Remover" className="p-1.5 text-text-light hover:text-danger hover:bg-danger/10 rounded-lg transition justify-self-end">
                          <TrashIcon className="w-4 h-4" />
                        </button>
                      )}
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
                  // No celular a linha é [campo | lixeira]: horário e atividade
                  // ocupam a largura toda e o porão divide a última fileira com
                  // a lixeira. Antes a lixeira caía sozinha numa 3ª fileira e
                  // deixava metade dela em branco.
                  <div key={i} className="grid grid-cols-[1fr_32px] md:grid-cols-[220px_1fr_150px_36px] gap-2 items-center bg-gray-50 rounded-lg p-2">
                    <div className="col-span-2 md:col-span-1 flex items-center gap-1 min-w-0">
                      <input type="time" value={start} onChange={(e) => setTime("start", e.target.value)} className={`${inputCls} min-w-0`} title="Início" />
                      <span className="text-xs text-text-light shrink-0">→</span>
                      <input type="time" value={end} onChange={(e) => setTime("end", e.target.value)} className={`${inputCls} min-w-0`} title="Término" />
                    </div>
                    {custom ? (
                      <div className="col-span-2 md:col-span-1 flex items-center gap-1 min-w-0">
                        <input type="text" list="activity-suggestions" value={a.activity} onChange={(e) => patchAct({ activity: e.target.value })} className={`${inputCls} min-w-0`} placeholder="Digite a atividade..." />
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
                        className={`${inputCls} col-span-2 md:col-span-1`}
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
                      className={`${inputCls} min-w-0`}
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
          </fieldset>

          <div className="flex justify-end gap-2 flex-wrap">
            <Button
              variant="success"
              onClick={sendToWhats}
              disabled={savingReport}
              title="Abre o WhatsApp com o relatório pronto — você escolhe o contato ou grupo pra enviar"
            >
              📲 Enviar pro WhatsApp
            </Button>
            {!canRate && savedStatus === "COMPLETO" && (
              <Button variant="warning" onClick={() => saveReport("EM_ANDAMENTO")} disabled={savingReport}>
                🔓 Reabrir relatório
              </Button>
            )}
            {!locked && (
              <Button onClick={() => saveReport()} disabled={savingReport}>
                {savingReport ? "Salvando..." : "💾 Salvar relatório"}
              </Button>
            )}
            {!locked && savedStatus !== "COMPLETO" && (
              <Button
                variant="success"
                onClick={() => setConfirmConclude(true)}
                disabled={savingReport}
                title="Fecha o relatório: depois de concluído, o supervisor não edita mais (a gestão pode reabrir)"
              >
                ✅ Concluir relatório
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ── Avaliações ──
          Supervisor (canRate): dá as notas da equipe — sem avaliar a si mesmo.
          Gestão: SÓ LEITURA, ao vivo — vê o que o supervisor lançou de bordo. */}
      {tab === "avaliacoes" && (
        <div className="space-y-4">
          {!canRate && (
            <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 text-xs text-text-light">
              <span className="relative flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
              Ao vivo: aqui você acompanha as avaliações que o supervisor lança de bordo — elas aparecem sozinhas, sem recarregar a página.
            </div>
          )}
          {evalTeam.length === 0 ? (
            <div className="bg-card rounded-xl border border-border p-8 text-center text-sm text-text-light">
              Nenhum colaborador pra avaliar neste serviço ainda.
            </div>
          ) : (
            <>
              {evalTeam.map((m) => {
                const e = evals.get(m.employee_id) || EMPTY_EVAL;
                const rated = EVAL_CRITERIA.map((c) => e[c.key as keyof EvalDraft] as number).filter((v) => v > 0);
                const avg = rated.length ? (rated.reduce((s, v) => s + v, 0) / rated.length).toFixed(1) : null;
                const hist = data.history?.[m.employee_id];
                const saved = data.evaluations.find((x) => x.employee_id === m.employee_id);
                const hasAny = rated.length > 0 || !!e.comments.trim();
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

                    {canRate ? (
                      <>
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
                      </>
                    ) : hasAny ? (
                      <>
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-1.5">
                          {EVAL_CRITERIA.map((c) => {
                            const value = e[c.key as keyof EvalDraft] as number;
                            return (
                              <div key={c.key} className="flex items-center justify-between gap-2">
                                <span className="text-sm text-text">{c.label}</span>
                                <div className="flex items-center gap-0.5">
                                  {[1, 2, 3, 4, 5].map((n) => (
                                    <span key={n} className={`text-xl leading-none ${n <= value ? "text-amber-500" : "text-gray-200"}`}>
                                      ★
                                    </span>
                                  ))}
                                  <span className="text-xs text-text-light w-7 text-right">{value > 0 ? `(${value})` : "—"}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {e.comments.trim() && (
                          <p className="text-sm text-text bg-gray-50 rounded-lg p-2.5 whitespace-pre-wrap">💬 {e.comments}</p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-text-light">⏳ O supervisor ainda não avaliou este colaborador.</p>
                    )}
                  </div>
                );
              })}
              {canRate && (
                <div className="flex justify-end">
                  <Button onClick={saveEvals} disabled={savingEvals}>
                    {savingEvals ? "Salvando..." : "💾 Salvar avaliações"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Fotos ── */}
      {tab === "fotos" && (
        <div className="space-y-4">
          {locked && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm text-emerald-800">
              ✅ Relatório concluído — as fotos ficam travadas. Precisando mexer, peça pra gestão reabrir.
            </div>
          )}
          {/* Um input só, escondido: o bloco clicado define destino e fase. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={async (e) => {
              // Só limpa o input DEPOIS de processar: no iPhone, resetar o
              // input no meio do envio invalida as fotos da galeria.
              const input = e.currentTarget;
              await handleFiles(input.files);
              input.value = "";
            }}
          />

          {uploadErrors.length > 0 && (
            <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 space-y-1">
              <p className="text-sm font-semibold text-danger">⚠️ Não deu pra enviar:</p>
              <ul className="text-xs text-danger space-y-0.5">
                {uploadErrors.map((e, i) => (
                  <li key={i}>• {e}</li>
                ))}
              </ul>
            </div>
          )}

          {!locked && (
            <p className="text-xs text-text-light">
              Cada bloco vira uma seção do Relatório Fotográfico, nesta ordem. Clique no bloco pra
              adicionar as fotos dele — a marca d&apos;água da Cargo entra sozinha.
            </p>
          )}

          {photoBlocks.map((b) => {
            const items = photos.filter((p) => photoBlockKey(p.hold_label) === b.label);
            const stage = blockStage[b.label] || "ANTES";
            const sending = uploadingLabel === b.label && !!uploadProgress;
            // Fase da foto normalizada: qualquer coisa fora de Antes/Durante/
            // Depois (fotos antigas com stage GERAL) cai em "Sem fase".
            const stageOf = (p: PhotoMeta) => (STAGES.some((s) => s.value === p.stage) ? p.stage : "GERAL");
            const chips = b.isHold
              ? [
                  ...STAGES.map((s) => ({ value: s.value, label: STAGE_UPLOAD_LABEL[s.value] || s.label })),
                  // "Sem fase" só aparece se existir foto antiga assim.
                  ...(items.some((p) => stageOf(p) === "GERAL") ? [{ value: "GERAL", label: "Sem fase" }] : []),
                ]
              : [];
            // O chip é FILTRO: mostra só as fotos da fase escolhida, senão o
            // supervisor troca a fase e continua vendo as mesmas fotos.
            const shown = b.isHold ? items.filter((p) => stageOf(p) === stage) : items;

            return (
              <div key={b.label} className="bg-card rounded-xl border border-border p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-text">
                    {b.label}{" "}
                    <span className="text-text-light font-normal text-sm">({items.length})</span>
                  </p>
                  {!b.fixed && !locked && (
                    <button
                      onClick={() => removeBlock(b.label)}
                      title={items.length ? "Apague as fotos antes de remover o bloco" : "Remover bloco"}
                      className="p-1 text-text-light hover:text-danger hover:bg-danger/10 rounded transition shrink-0"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  )}
                </div>

                {locked ? (
                  blockCaptions[b.label] ? (
                    <p className="text-sm text-text-light">📝 {blockCaptions[b.label]}</p>
                  ) : null
                ) : (
                  <input
                    type="text"
                    value={blockCaptions[b.label] ?? ""}
                    onChange={(e) => setBlockCaptions((prev) => ({ ...prev, [b.label]: e.target.value }))}
                    onBlur={() => saveBlockCaption(b.label)}
                    placeholder="Legenda do bloco (opcional — sai no PDF)"
                    className={inputCls}
                  />
                )}

                {/* Fase da lavagem: só porão/área tem antes/durante/depois.
                    O chip escolhe a fase que aparece E a que recebe a foto. */}
                {b.isHold && (
                  <div className="flex flex-wrap gap-1.5">
                    {chips.map((c) => {
                      const count = items.filter((p) => stageOf(p) === c.value).length;
                      return (
                        <button
                          key={c.value}
                          onClick={() => setBlockStage((prev) => ({ ...prev, [b.label]: c.value }))}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                            stage === c.value
                              ? "bg-primary text-white border-primary"
                              : "bg-card text-text-light border-border hover:border-primary/60"
                          }`}
                        >
                          {c.label} ({count})
                        </button>
                      );
                    })}
                  </div>
                )}

                {!locked && (
                  <button
                    onClick={() => openPicker(b.label, b.isHold ? stage : "GERAL")}
                    disabled={!!uploadProgress}
                    className="w-full border-2 border-dashed border-border hover:border-primary/60 rounded-xl py-4 text-center transition disabled:opacity-60"
                  >
                    <p className="text-sm font-medium text-text">
                      {sending ? uploadProgress : `📷 Adicionar fotos${b.isHold ? ` · ${STAGE_UPLOAD_LABEL[stage]}` : ""}`}
                    </p>
                  </button>
                )}

                {shown.length === 0 ? (
                  <p className="text-xs text-text-light">
                    {b.isHold ? "Nenhuma foto nesta fase ainda." : "Nenhuma foto neste bloco ainda."}
                  </p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                    {shown.map((p) => (
                      <div key={p.id} className="bg-bg rounded-xl border border-border overflow-hidden">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={`/api/relatorios/fotos/${p.id}`} alt={p.caption || b.label} className="w-full h-36 object-cover" loading="lazy" />
                        <div className="p-2 space-y-1.5">
                          {locked ? (
                            <p className="text-xs text-text-light truncate">{p.caption || "—"}</p>
                          ) : (
                            <div className="flex items-center gap-1">
                              <input
                                type="text"
                                value={photoCaptions[p.id] ?? ""}
                                onChange={(e) => setPhotoCaptions((prev) => ({ ...prev, [p.id]: e.target.value }))}
                                onBlur={() => savePhotoCaption(p.id)}
                                placeholder="Legenda da foto"
                                className="flex-1 min-w-0 px-2 py-1 text-xs border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                              />
                              <button
                                onClick={() => setDeletePhoto(p)}
                                title="Excluir foto"
                                className="p-1 text-text-light hover:text-danger hover:bg-danger/10 rounded transition shrink-0"
                              >
                                <TrashIcon className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

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
            <Button onClick={() => downloadPdf("cleaning")} disabled={!!generatingPdf}>
              {generatingPdf === "cleaning" ? "Gerando..." : "Baixar PDF"}
            </Button>
          </div>

          <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-3">
            <p className="text-3xl">📷</p>
            <div className="flex-1">
              <p className="font-bold text-text">Relatório Fotográfico</p>
              <p className="text-xs text-text-light mt-1">
                Capa + uma foto por página (antes/durante/depois), com a marca d&apos;água da Cargo. {photos.length} foto{photos.length === 1 ? "" : "s"} no relatório.
              </p>
            </div>
            <Button onClick={() => downloadPdf("fotos")} disabled={photos.length === 0 || !!generatingPdf}>
              {generatingPdf === "fotos" ? "Gerando..." : "Baixar PDF"}
            </Button>
          </div>

          <div className="bg-card rounded-xl border border-border p-5 flex flex-col gap-3">
            <p className="text-3xl">⭐</p>
            <div className="flex-1">
              <p className="font-bold text-text">Avaliação de Desempenho</p>
              <p className="text-xs text-text-light mt-1">
                Avaliação da equipe com notas por critério, pontos a melhorar e observações do supervisor.
              </p>
            </div>
            <Button onClick={() => downloadPdf("avaliacao")} disabled={evalTeam.length === 0 || !!generatingPdf}>
              {generatingPdf === "avaliacao" ? "Gerando..." : "Baixar PDF"}
            </Button>
          </div>

          {pdfError && (
            <div className="md:col-span-3 bg-danger/10 border border-danger/30 rounded-xl p-3 text-sm text-danger">
              ⚠️ {pdfError}
            </div>
          )}

          <div className="md:col-span-3 bg-blue-50 border border-blue-200 rounded-xl p-4 text-xs text-blue-900">
            💡 O PDF é gerado no servidor e baixa direto (no celular abre o menu de compartilhar).
            Gere o PDF <strong>depois de salvar</strong> as alterações, pra sair tudo atualizado.
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

      <ConfirmDialog
        open={confirmConclude}
        onClose={() => setConfirmConclude(false)}
        onConfirm={() => {
          setConfirmConclude(false);
          saveReport("COMPLETO");
        }}
        title="Concluir relatório"
        message={
          canRate
            ? "Concluir o relatório? Depois de concluído você não consegue mais editar — só a gestão reabre."
            : "Concluir o relatório? O supervisor não vai mais conseguir editar (você pode reabrir quando quiser)."
        }
        loading={savingReport}
      />
    </div>
  );
}
