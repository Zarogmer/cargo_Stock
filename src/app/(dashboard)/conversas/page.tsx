"use client";

import { useEffect, useState, useCallback, useRef, useMemo, Fragment } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Modal } from "@/components/ui/modal";
import { TrashIcon, PlusIcon } from "@/components/icons";
import { db } from "@/lib/db";
import { useAuth } from "@/lib/auth-context";
import { formatPhone, cleanSenderName } from "@/lib/utils";

interface Conversation {
  remote_jid: string;
  push_name: string | null;
  last_text: string | null;
  last_message_type: string;
  last_from_me: boolean;
  last_timestamp_ms: string;
  message_count: number;
  is_group: boolean;
}

interface Message {
  id: string;
  message_id: string | null;
  remote_jid: string;
  from_me: boolean;
  push_name: string | null;
  message_type: string;
  text: string | null;
  media_mimetype: string | null;
  media_filename: string | null;
  timestamp_ms: string;
  created_at: string;
}

interface ShipOpt {
  id: string;
  name: string;
  whatsapp_group_jid: string | null;
}

// Full response of GET /api/whatsapp/groups/[jid] — used by the info panel.
interface GroupInfo {
  jid: string;
  subject: string | null;
  description: string | null;
  created_at_ms: number | null;
  owner: string | null;
  size: number;
  participants: Array<{
    jid: string;
    phone: string;
    admin: string | null;
    push_name: string | null;
    employee: { id: number; name: string; team: string | null; status: string | null; phone: string | null } | null;
  }>;
  ship: {
    id: string;
    name: string;
    status: string;
    port: string | null;
    arrival_date: string | null;
    departure_date: string | null;
  } | null;
}

interface EmpOpt {
  id: number;
  name: string;
  phone: string | null;
  status: string | null;
}

// "5513999999999@s.whatsapp.net" → "5513999999999"
function jidToNumber(jid: string): string {
  return jid.replace(/@.*$/, "");
}

function displayName(c: Conversation): string {
  if (c.push_name && c.push_name.trim()) return c.push_name;
  if (c.is_group) return "Grupo";
  return formatPhone(jidToNumber(c.remote_jid)) || c.remote_jid;
}

// Tudo no fuso do Brasil — o usuário raciocina em horário de Brasília,
// independente do fuso do navegador/servidor.
const BR_TZ = "America/Sao_Paulo";

// "YYYY-MM-DD" do dia no fuso BR — usado pra agrupar mensagens por dia.
function brDayKey(ms: string | number): string {
  return new Date(Number(ms)).toLocaleDateString("en-CA", { timeZone: BR_TZ });
}

// Rótulo do separador de dia, estilo WhatsApp: "Hoje", "Ontem" ou data por extenso.
function dayLabel(ms: string | number): string {
  const key = brDayKey(ms);
  if (key === brDayKey(Date.now())) return "Hoje";
  if (key === brDayKey(Date.now() - 86400000)) return "Ontem";
  return new Date(Number(ms)).toLocaleDateString("pt-BR", {
    timeZone: BR_TZ, day: "2-digit", month: "long", year: "numeric",
  });
}

// Hora (HH:mm) no fuso BR — usada em cada bolha de mensagem.
function formatMsgTime(ms: string | number): string {
  return new Date(Number(ms)).toLocaleTimeString("pt-BR", {
    timeZone: BR_TZ, hour: "2-digit", minute: "2-digit",
  });
}

// Rótulo curto pra lista de conversas (hora se hoje, "Ontem", senão data).
function formatTime(ms: string | number): string {
  const key = brDayKey(ms);
  if (key === brDayKey(Date.now())) return formatMsgTime(ms);
  if (key === brDayKey(Date.now() - 86400000)) return "Ontem";
  return new Date(Number(ms)).toLocaleDateString("pt-BR", { timeZone: BR_TZ, day: "2-digit", month: "2-digit" });
}

function formatFullDateTime(ms: string | number): string {
  return new Date(Number(ms)).toLocaleString("pt-BR", {
    timeZone: BR_TZ,
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function previewLine(c: Conversation): string {
  const prefix = c.last_from_me ? "Você: " : "";
  // Sistemas (groupParticipantUpdate, systemNotice) já vêm com texto humano —
  // mostra direto, sem o prefixo "Você:" (não é fala de ninguém).
  if (c.last_message_type === "groupParticipantUpdate" || c.last_message_type === "systemNotice") {
    return c.last_text || "Evento do grupo";
  }
  if (c.last_text) return `${prefix}${c.last_text}`;
  const typeLabels: Record<string, string> = {
    imageMessage: "📷 Foto",
    videoMessage: "🎥 Vídeo",
    audioMessage: "🎵 Áudio",
    documentMessage: "📄 Documento",
    stickerMessage: "🖼️ Figurinha",
    locationMessage: "📍 Localização",
    contactMessage: "👤 Contato",
  };
  return `${prefix}${typeLabels[c.last_message_type] || c.last_message_type}`;
}

// Click-to-load: keeps the chat light by only downloading media when the user
// explicitly asks for it (Evolution can return base64 blobs in the hundreds of KB).
function MediaBubble({ msg, onImageClick }: { msg: Message; onImageClick: (src: string) => void }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ base64: string; mimetype: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    if (!msg.message_id) { setErr("Mensagem sem id — não dá pra carregar mídia."); return; }
    setLoading(true); setErr(null);
    try {
      const res = await fetch(`/api/whatsapp/media/${encodeURIComponent(msg.message_id)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setData(body);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const mime = msg.media_mimetype || "";
  const isImage = mime.startsWith("image/");
  const isAudio = mime.startsWith("audio/");
  const isVideo = mime.startsWith("video/");

  if (!data) {
    return (
      <div>
        {msg.text && <p className="text-sm mb-2 whitespace-pre-wrap">{msg.text}</p>}
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-xs px-2 py-1 bg-white/10 hover:bg-white/20 rounded transition disabled:opacity-50"
        >
          {loading ? "Carregando..." : `⬇️ ${
            isImage ? "Ver imagem" : isAudio ? "Ouvir áudio" : isVideo ? "Ver vídeo" : "Baixar arquivo"
          }${msg.media_filename ? ` (${msg.media_filename})` : ""}`}
        </button>
        {err && <p className="text-xs text-red-200 mt-1">{err}</p>}
      </div>
    );
  }

  const src = data.base64.startsWith("data:") ? data.base64 : `data:${data.mimetype};base64,${data.base64}`;

  if (isImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt="imagem"
        className="max-w-xs rounded-lg cursor-zoom-in hover:opacity-90 transition"
        onClick={() => onImageClick(src)}
      />
    );
  }
  if (isAudio) {
    return <audio controls src={src} className="max-w-xs" />;
  }
  if (isVideo) {
    return <video controls src={src} className="max-w-xs rounded-lg" />;
  }
  return (
    <a href={src} download={msg.media_filename || "arquivo"} className="text-xs underline">
      Baixar {msg.media_filename || "arquivo"}
    </a>
  );
}

// Fullscreen image viewer. Click backdrop or press ESC to close.
function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    // Lock scroll under the overlay so the page doesn't jiggle when we open it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center p-4 cursor-zoom-out"
      role="dialog"
      aria-label="Imagem ampliada"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 text-white text-2xl w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 transition flex items-center justify-center"
        aria-label="Fechar"
      >
        ×
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="imagem ampliada"
        onClick={(e) => e.stopPropagation()}
        className="max-w-full max-h-full object-contain rounded-lg cursor-default shadow-2xl"
      />
    </div>
  );
}

// Mapa "visto por última vez" por conversa (jid → timestamp ms) no localStorage,
// pra marcar conversas/mensagens novas (não lidas) na aba.
function readSeenMap(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem("conversas_seen") || "{}") as Record<string, number>; } catch { return {}; }
}
function writeSeenMap(map: Record<string, number>) {
  try { localStorage.setItem("conversas_seen", JSON.stringify(map)); } catch { /* ignore */ }
}

export default function ConversasPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConv, setLoadingConv] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedJid, setSelectedJid] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  // Paginação "carregar anteriores": cresce o limite e re-busca. O polling de
  // 30s usa o mesmo limite, então não apaga o histórico já carregado.
  const msgLimitRef = useRef(500);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  // Preserva a posição do scroll ao carregar mensagens antigas (prepend).
  const preserveScrollRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  // Ponto de leitura capturado ao ABRIR a conversa (pro divisor "Mensagens
  // novas" no thread). O "visto" persistente fica no localStorage (conversas_seen).
  const [unreadBoundaryMs, setUnreadBoundaryMs] = useState(0);
  // Contagem de não-lidas por conversa (calculada no servidor a partir do mapa
  // "visto" do localStorage). Dirige o badge numérico na lista.
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({});

  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  const [showNewGroup, setShowNewGroup] = useState(false);

  // Group sync — pulls every group the connected number is part of and
  // makes them appear in this list (handy for groups created outside the app
  // or before the sync feature existed).
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // Fullscreen image viewer state — populated when the user clicks an image bubble.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // Group info panel — opened from the chat header on group conversations.
  const [showGroupInfoJid, setShowGroupInfoJid] = useState<string | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const lastMessageCount = useRef(0);

  // Busca no servidor a contagem de não-lidas por conversa (msgs recebidas após
  // o "visto" de cada uma), só pras conversas atualmente na lista.
  const refreshUnreadCounts = useCallback(async (convs: Conversation[]) => {
    const seenAll = readSeenMap();
    const seen: Record<string, number> = {};
    for (const c of convs) seen[c.remote_jid] = seenAll[c.remote_jid] || 0;
    try {
      const r = await fetch("/api/whatsapp/unread-counts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seen }),
      });
      if (r.ok) {
        const b = await r.json();
        setUnreadCounts((b.counts || {}) as Record<string, number>);
      }
    } catch {
      // silent
    }
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/whatsapp/conversations");
      const body = await res.json();
      if (res.ok) {
        const convs = (body.conversations || []) as Conversation[];
        setConversations(convs);
        if (typeof window !== "undefined") {
          // Card "Conversas" do dashboard: conta mensagens após este instante.
          localStorage.setItem("conversas_last_seen", new Date().toISOString());
          // Primeira vez (sem baseline): marca a última msg de cada conversa
          // como vista, pra não exibir tudo como "novo" de cara. Depois disso,
          // só mensagens novas viram não-lidas.
          if (localStorage.getItem("conversas_seen") === null) {
            const baseline: Record<string, number> = {};
            for (const c of convs) baseline[c.remote_jid] = Number(c.last_timestamp_ms) || 0;
            writeSeenMap(baseline);
          }
        }
        refreshUnreadCounts(convs);
      }
    } catch {
      // silent — keep previous list
    } finally {
      setLoadingConv(false);
    }
  }, [refreshUnreadCounts]);

  const loadMessages = useCallback(async (jid: string) => {
    setLoadingMsgs(true);
    try {
      const limit = msgLimitRef.current;
      const res = await fetch(`/api/whatsapp/conversations/${encodeURIComponent(jid)}/messages?limit=${limit}`);
      const body = await res.json();
      if (res.ok) {
        const msgs = (body.messages || []) as Message[];
        setMessages(msgs);
        // Voltou menos que o limite pedido → não há mais histórico anterior.
        setHasMoreOlder(msgs.length >= limit);
        // Marca a conversa aberta como lida até a mensagem mais recente.
        const latest = msgs.reduce((mx, mm) => Math.max(mx, Number(mm.timestamp_ms)), 0);
        if (latest > 0) {
          const cur = readSeenMap();
          if ((cur[jid] || 0) < latest) writeSeenMap({ ...cur, [jid]: latest });
        }
      }
    } catch {
      // silent
    } finally {
      setLoadingMsgs(false);
    }
  }, []);

  // Carrega mais histórico aumentando o limite e re-buscando; o efeito de
  // scroll preserva a posição visual depois do prepend.
  const loadOlder = useCallback(() => {
    if (!selectedJid || loadingOlder || !hasMoreOlder) return;
    prevScrollHeightRef.current = threadRef.current?.scrollHeight ?? 0;
    preserveScrollRef.current = true;
    msgLimitRef.current += 500;
    setLoadingOlder(true);
    loadMessages(selectedJid).finally(() => setLoadingOlder(false));
  }, [selectedJid, loadingOlder, hasMoreOlder, loadMessages]);

  // Background polling — kept as a fallback for the SSE stream below.
  // The SSE stream pushes updates the moment Evolution delivers a message;
  // this polling is the safety net for when the SSE connection drops (mobile
  // background, proxy timeout, server restart). Bumped from 5s to 30s now
  // that SSE handles the live case.
  useEffect(() => {
    loadConversations();
    const interval = setInterval(loadConversations, 30000);
    return () => clearInterval(interval);
  }, [loadConversations]);

  useEffect(() => {
    if (!selectedJid) return;
    // Reseta a janela de histórico ao trocar de conversa.
    msgLimitRef.current = 500;
    setHasMoreOlder(true);
    setMessages([]);
    // Captura o ponto de leitura ANTES de marcar como lido (pro divisor de novas).
    setUnreadBoundaryMs(readSeenMap()[selectedJid] || 0);
    setUnreadCounts((prev) => ({ ...prev, [selectedJid]: 0 }));
    loadMessages(selectedJid);
    const interval = setInterval(() => loadMessages(selectedJid), 30000);
    return () => clearInterval(interval);
  }, [selectedJid, loadMessages]);

  // Real-time updates via Server-Sent Events. The webhook emits to an
  // in-process bus on every message persisted, and /api/whatsapp/events
  // streams that out as SSE. When we receive an event we reload the
  // conversation list (so unread counts / last-message previews update) and
  // also reload the open thread if the event matches the JID we're viewing.
  //
  // We stash selectedJid in a ref so the EventSource doesn't need to be
  // recreated every time the user switches conversations — recreating it
  // would lose any in-flight events.
  const selectedJidRef = useRef(selectedJid);
  useEffect(() => { selectedJidRef.current = selectedJid; }, [selectedJid]);

  useEffect(() => {
    const es = new EventSource("/api/whatsapp/events");

    const onMessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { remote_jid?: string };
        loadConversations();
        if (data.remote_jid && data.remote_jid === selectedJidRef.current) {
          loadMessages(data.remote_jid);
        }
      } catch {
        // ignore malformed payloads — the next event will recover
      }
    };

    es.addEventListener("message", onMessage);
    // The browser auto-retries on error; we only need to swallow the noise.
    es.onerror = () => { /* no-op */ };

    return () => {
      es.removeEventListener("message", onMessage);
      es.close();
    };
  }, [loadConversations, loadMessages]);

  // Auto-scroll to bottom when new messages arrive (but not when just polling
  // with the same count, so we don't fight the user's scroll position).
  useEffect(() => {
    const el = threadRef.current;
    if (el) {
      if (preserveScrollRef.current) {
        // Carregamos mensagens antigas (prepend): mantém a posição visual em
        // vez de pular pro fim.
        el.scrollTop = el.scrollHeight - prevScrollHeightRef.current;
        preserveScrollRef.current = false;
      } else if (messages.length > lastMessageCount.current) {
        el.scrollTop = el.scrollHeight;
      }
    }
    lastMessageCount.current = messages.length;
  }, [messages]);

  const filteredConvs = useMemo(() => {
    if (!search.trim()) return conversations;
    const q = search.toLowerCase();
    return conversations.filter((c) =>
      displayName(c).toLowerCase().includes(q) ||
      c.remote_jid.toLowerCase().includes(q)
    );
  }, [conversations, search]);

  const selectedConv = conversations.find((c) => c.remote_jid === selectedJid) || null;

  // Índice da 1ª mensagem recebida após o ponto de leitura — marca o divisor
  // "Mensagens novas" no thread. -1 = sem novas (ou conversa nunca aberta).
  const firstUnreadIdx = unreadBoundaryMs > 0
    ? messages.findIndex((m) => !m.from_me && Number(m.timestamp_ms) > unreadBoundaryMs)
    : -1;

  async function handleDelete() {
    if (!confirmDelete) return;
    setDeleting(true); setDeleteErr(null);
    try {
      const res = await fetch(
        `/api/whatsapp/conversations/${encodeURIComponent(confirmDelete.remote_jid)}`,
        { method: "DELETE" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setConversations((prev) => prev.filter((c) => c.remote_jid !== confirmDelete.remote_jid));
      if (selectedJid === confirmDelete.remote_jid) {
        setSelectedJid(null);
        setMessages([]);
      }
      setConfirmDelete(null);
    } catch (err) {
      setDeleteErr((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/whatsapp/groups/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const parts: string[] = [];
      if (body.added) parts.push(`${body.added} novo(s)`);
      if (body.updated) parts.push(`${body.updated} atualizado(s)`);
      const detail = parts.length ? ` — ${parts.join(", ")}.` : " — nada novo.";
      setSyncMsg({ kind: "ok", text: `${body.total} grupo(s) encontrado(s)${detail}` });
      loadConversations();
    } catch (err) {
      setSyncMsg({ kind: "err", text: (err as Error).message });
    } finally {
      setSyncing(false);
    }
  }

  async function handleReply(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedJid || !reply.trim()) return;
    if (selectedJid.endsWith("@g.us")) {
      setSendErr("Resposta para grupo ainda não suportada — abra a Mensagens e use número direto se precisar.");
      return;
    }
    setSending(true); setSendErr(null);
    try {
      const to = jidToNumber(selectedJid);
      const res = await fetch("/api/whatsapp/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, text: reply }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setReply("");
      loadMessages(selectedJid);
      loadConversations();
    } catch (err) {
      setSendErr((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h1 className="text-2xl font-bold text-text">Conversas 💬</h1>
        <div className="flex gap-2 flex-wrap">
          <Button
            size="sm"
            variant="secondary"
            onClick={handleSync}
            disabled={syncing}
            title="Busca todos os grupos no WhatsApp e adiciona à lista"
          >
            {syncing ? "Sincronizando..." : "↻ Sincronizar grupos"}
          </Button>
          <Button size="sm" onClick={() => setShowNewGroup(true)} className="inline-flex items-center gap-1.5">
            <PlusIcon className="w-4 h-4" /> Novo grupo
          </Button>
        </div>
      </div>
      {syncMsg && (
        <div className={`mb-2 rounded-lg px-3 py-2 text-xs border ${
          syncMsg.kind === "ok"
            ? "bg-emerald-50 border-emerald-200 text-emerald-900"
            : "bg-red-50 border-red-200 text-red-900"
        }`}>
          {syncMsg.text}
        </div>
      )}

      <div className="flex-1 flex gap-3 min-h-0 bg-card rounded-2xl border border-border overflow-hidden">
        <aside
          className={`w-full lg:w-80 shrink-0 lg:border-r border-border flex-col ${
            selectedJid ? "hidden lg:flex" : "flex"
          }`}
        >
          <div className="p-3 border-b border-border">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="🔍 Buscar conversa..."
              className="w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {loadingConv ? (
              <p className="p-4 text-sm text-text-light">Carregando...</p>
            ) : filteredConvs.length === 0 ? (
              <p className="p-4 text-sm text-text-light">
                {search ? "Nenhuma conversa encontrada." : "Nenhuma conversa ainda — quando alguém mandar mensagem pelo WhatsApp, vai aparecer aqui."}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {filteredConvs.map((c) => {
                  const active = c.remote_jid === selectedJid;
                  // Não-lidas: contagem do servidor (msgs recebidas após o visto).
                  const unreadCount = active ? 0 : (unreadCounts[c.remote_jid] || 0);
                  const unread = unreadCount > 0;
                  return (
                    <li key={c.remote_jid} className="group relative">
                      <button
                        type="button"
                        onClick={() => setSelectedJid(c.remote_jid)}
                        className={`w-full text-left px-3 py-2.5 pr-9 transition ${active ? "bg-primary/5 border-l-2 border-primary" : unread ? "bg-emerald-50/50 hover:bg-emerald-50" : "hover:bg-gray-50"}`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className={`text-sm truncate flex items-center gap-1 ${unread ? "font-bold text-text" : "font-medium"}`}>
                            {c.is_group && <span className="text-xs">👥</span>}
                            {displayName(c)}
                          </span>
                          <span className={`text-[10px] shrink-0 ${unread ? "text-emerald-600 font-semibold" : "text-text-light"}`}>
                            {formatTime(c.last_timestamp_ms)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-0.5">
                          <p className={`text-xs truncate ${unread ? "text-text font-medium" : "text-text-light"}`}>
                            {previewLine(c)}
                          </p>
                          {unread && (
                            <span
                              className="shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-emerald-500 text-white text-[10px] font-bold flex items-center justify-center"
                              title={`${unreadCount} mensagem(ns) não lida(s)`}
                            >
                              {unreadCount > 99 ? "99+" : unreadCount}
                            </span>
                          )}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setConfirmDelete(c); }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded text-text-light hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
                        title="Apagar conversa (apenas do sistema)"
                        aria-label="Apagar conversa"
                      >
                        <TrashIcon className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        <section
          className={`flex-1 flex-col min-w-0 ${
            selectedJid ? "flex" : "hidden lg:flex"
          }`}
        >
          {!selectedJid ? (
            <div className="flex-1 flex items-center justify-center text-text-light text-sm px-4 text-center">
              ← Selecione uma conversa pra ver as mensagens
            </div>
          ) : (
            <>
              <header className="border-b border-border px-3 sm:px-4 py-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedJid(null)}
                  className="lg:hidden p-1 -ml-1 rounded hover:bg-gray-100 text-text-light shrink-0"
                  aria-label="Voltar"
                >
                  ←
                </button>
                <div className="flex-1 min-w-0">
                  <h2 className="font-semibold text-sm truncate">{selectedConv ? displayName(selectedConv) : "..."}</h2>
                  <p className="text-xs text-text-light font-mono truncate">
                    {selectedConv?.is_group ? "Grupo" : formatPhone(jidToNumber(selectedJid))}
                  </p>
                </div>
                <span className="text-xs text-text-light shrink-0 hidden sm:inline">
                  {messages.length} {messages.length === 1 ? "mensagem" : "mensagens"}
                </span>
                {selectedConv?.is_group && (
                  <button
                    type="button"
                    onClick={() => setShowGroupInfoJid(selectedJid)}
                    className="shrink-0 p-1.5 rounded text-text-light hover:text-primary hover:bg-primary/10 transition"
                    title="Informações do grupo"
                    aria-label="Informações do grupo"
                  >
                    <span className="text-base leading-none">ℹ️</span>
                  </button>
                )}
                {selectedConv && (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(selectedConv)}
                    className="shrink-0 p-1.5 rounded text-text-light hover:text-red-600 hover:bg-red-50 transition"
                    title="Apagar conversa (apenas do sistema)"
                    aria-label="Apagar conversa"
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                )}
              </header>

              <div ref={threadRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2 bg-[#f0f2f5]">
                {messages.length > 0 && hasMoreOlder && (
                  <div className="flex justify-center pb-1">
                    <button
                      type="button"
                      onClick={loadOlder}
                      disabled={loadingOlder}
                      className="text-xs px-3 py-1.5 rounded-full bg-white border border-border text-text-light hover:bg-gray-50 transition disabled:opacity-50"
                    >
                      {loadingOlder ? "Carregando..." : "↑ Carregar mensagens anteriores"}
                    </button>
                  </div>
                )}
                {loadingMsgs && messages.length === 0 ? (
                  <p className="text-sm text-text-light text-center">Carregando mensagens...</p>
                ) : messages.length === 0 ? (
                  <p className="text-sm text-text-light text-center">Sem mensagens nessa conversa ainda.</p>
                ) : (
                  messages.map((m, idx) => {
                    // Separador de dia (Hoje / Ontem / data) quando vira o dia
                    // no fuso BR — estilo WhatsApp.
                    const prev = idx > 0 ? messages[idx - 1] : null;
                    const showDay = !prev || brDayKey(prev.timestamp_ms) !== brDayKey(m.timestamp_ms);
                    const daySep = showDay ? (
                      <div className="flex justify-center my-2">
                        <span className="bg-white/90 text-[11px] text-gray-600 px-3 py-1 rounded-full shadow-sm uppercase tracking-wide">
                          {dayLabel(m.timestamp_ms)}
                        </span>
                      </div>
                    ) : null;

                    const hasMedia = m.media_mimetype && m.message_type !== "conversation" && m.message_type !== "extendedTextMessage";
                    // Mensagens de "sistema" (estilo WhatsApp: notificações de
                    // grupo, sincronização, add/remove de participante) viram
                    // pílulas centralizadas em cinza — não são bubbles de
                    // conversa.
                    const isSystem =
                      m.message_type === "systemNotice" ||
                      m.message_type === "groupParticipantUpdate";
                    // Cor da pílula de evento de grupo: verde = entrou/adicionado
                    // (➕), vermelho = saiu/removido (➖), azul = admin (⭐/🔻);
                    // amarelo para avisos do sistema (sincronização etc.).
                    const evtText = m.text || "";
                    let pillCls = "bg-[#fef9c3]/80 border-[#fde047]/60";
                    let pillText = "text-amber-900";
                    let pillTime = "text-amber-700/80";
                    if (m.message_type === "groupParticipantUpdate") {
                      if (evtText.startsWith("➕")) { pillCls = "bg-emerald-50 border-emerald-300"; pillText = "text-emerald-800"; pillTime = "text-emerald-700/80"; }
                      else if (evtText.startsWith("➖")) { pillCls = "bg-red-50 border-red-300"; pillText = "text-red-800"; pillTime = "text-red-700/80"; }
                      else { pillCls = "bg-blue-50 border-blue-300"; pillText = "text-blue-800"; pillTime = "text-blue-700/80"; }
                    }
                    const bubble = isSystem ? (
                      <div className="flex justify-center my-1">
                        <div
                          className={`max-w-[85%] border ${pillCls} rounded-lg px-3 py-1 shadow-sm text-center`}
                          title={formatFullDateTime(m.timestamp_ms)}
                        >
                          <p className={`text-[12px] ${pillText} whitespace-pre-wrap break-words`}>
                            {m.text || "(evento sem texto)"}
                          </p>
                          <p className={`text-[9px] ${pillTime} mt-0.5`}>
                            {formatMsgTime(m.timestamp_ms)}
                            {m.push_name && m.message_type === "groupParticipantUpdate" && (
                              <> · por <strong>{m.push_name}</strong></>
                            )}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div className={`flex ${m.from_me ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[70%] rounded-lg px-3 py-2 shadow-sm ${
                          m.from_me ? "bg-[#d9fdd3] text-gray-900" : "bg-white text-gray-900"
                        }`}>
                          {!m.from_me && selectedConv?.is_group && cleanSenderName(m.push_name) && (
                            <p className="text-[10px] font-semibold text-primary mb-0.5">{cleanSenderName(m.push_name)}</p>
                          )}
                          {hasMedia ? (
                            <MediaBubble msg={m} onImageClick={setLightboxSrc} />
                          ) : (
                            <p className="text-sm whitespace-pre-wrap break-words">{m.text || "(vazio)"}</p>
                          )}
                          <p className="text-[10px] text-gray-500 text-right mt-1" title={formatFullDateTime(m.timestamp_ms)}>
                            {formatMsgTime(m.timestamp_ms)}
                          </p>
                        </div>
                      </div>
                    );

                    const showNewDivider = idx === firstUnreadIdx;
                    return (
                      <Fragment key={m.id}>
                        {daySep}
                        {showNewDivider && (
                          <div className="flex justify-center my-2">
                            <span className="bg-emerald-500 text-white text-[10px] font-semibold px-3 py-0.5 rounded-full shadow-sm uppercase tracking-wide">
                              ↓ Mensagens novas
                            </span>
                          </div>
                        )}
                        {bubble}
                      </Fragment>
                    );
                  })
                )}
              </div>

              <form onSubmit={handleReply} className="border-t border-border p-3 flex gap-2">
                <input
                  type="text"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  placeholder="Escreva uma resposta..."
                  disabled={sending}
                  className="flex-1 px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
                />
                <Button type="submit" disabled={sending || !reply.trim()}>
                  {sending ? "..." : "Enviar"}
                </Button>
              </form>
              {sendErr && (
                <p className="px-3 pb-2 text-xs text-red-700">{sendErr}</p>
              )}
            </>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => { setConfirmDelete(null); setDeleteErr(null); }}
        onConfirm={handleDelete}
        title="Apagar conversa?"
        message={
          confirmDelete
            ? `Isso vai apagar todo o histórico de ${displayName(confirmDelete)} (${confirmDelete.message_count} ${confirmDelete.message_count === 1 ? "mensagem" : "mensagens"}) apenas do sistema. O contato continua tendo as mensagens no WhatsApp dele.`
            : ""
        }
        confirmLabel="Apagar"
        variant="danger"
        loading={deleting}
      />
      {deleteErr && (
        <p className="fixed bottom-4 right-4 bg-red-600 text-white text-sm px-3 py-2 rounded shadow-lg">
          {deleteErr}
        </p>
      )}

      <NewGroupModal
        open={showNewGroup}
        onClose={() => setShowNewGroup(false)}
        onCreated={() => {
          setShowNewGroup(false);
          loadConversations();
        }}
      />

      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}

      <GroupInfoModal
        jid={showGroupInfoJid}
        onClose={() => setShowGroupInfoJid(null)}
        onLeft={() => {
          setShowGroupInfoJid(null);
          loadConversations();
          if (selectedJid) loadMessages(selectedJid);
        }}
        onChanged={() => {
          loadConversations();
          if (selectedJid) loadMessages(selectedJid);
        }}
      />
    </div>
  );
}

// ─── Group Info Modal ───────────────────────────────────────────────────────
// Fetched on open from /api/whatsapp/groups/[jid] — shows subject, description,
// creation date, linked ship, and the full participant list with employee
// cross-reference so admins can see who's in each group.
function GroupInfoModal({ jid, onClose, onLeft, onChanged }: { jid: string | null; onClose: () => void; onLeft: () => void; onChanged: () => void }) {
  const { profile } = useAuth();
  const [info, setInfo] = useState<GroupInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Inline "+ Cadastrar" form: key = phone digits of the participant being edited.
  const [addingPhone, setAddingPhone] = useState<string | null>(null);
  const [addingName, setAddingName] = useState("");
  const [addingSaving, setAddingSaving] = useState(false);
  const [addingErr, setAddingErr] = useState<string | null>(null);
  // "Remover participante": confirmação inline por linha (key = phone digits do
  // participante) + chamada ao endpoint de remoção.
  const [confirmRemovePhone, setConfirmRemovePhone] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeErr, setRemoveErr] = useState<string | null>(null);
  // "Sair do grupo": confirmação inline + chamada ao endpoint de leave.
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveErr, setLeaveErr] = useState<string | null>(null);

  const loadInfo = useCallback(async () => {
    if (!jid) return;
    setLoading(true); setErr(null);
    try {
      const res = await fetch(`/api/whatsapp/groups/${encodeURIComponent(jid)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setInfo(body as GroupInfo);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [jid]);

  useEffect(() => {
    if (!jid) { setInfo(null); return; }
    setInfo(null);
    setAddingPhone(null); setAddingName(""); setAddingErr(null);
    setConfirmRemovePhone(null); setRemoving(false); setRemoveErr(null);
    setConfirmingLeave(false); setLeaving(false); setLeaveErr(null);
    loadInfo();
  }, [jid, loadInfo]);

  // Remove um participante (terceiro) do grupo. Recarrega o painel na hora pra
  // refletir a saída; a pílula "➖ saiu do grupo" no thread vem pelo webhook.
  async function handleRemove(phone: string, label: string) {
    if (!jid || !phone) return;
    setRemoving(true); setRemoveErr(null);
    try {
      const res = await fetch(`/api/whatsapp/groups/${encodeURIComponent(jid)}/remove-participant`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, name: label }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setConfirmRemovePhone(null);
      await loadInfo();
      onChanged();
    } catch (e) {
      setRemoveErr((e as Error).message);
    } finally {
      setRemoving(false);
    }
  }

  async function handleLeave() {
    if (!jid) return;
    setLeaving(true); setLeaveErr(null);
    try {
      const res = await fetch(`/api/whatsapp/groups/${encodeURIComponent(jid)}/leave`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onLeft();
    } catch (e) {
      setLeaveErr((e as Error).message);
    } finally {
      setLeaving(false);
    }
  }

  function startAdd(phone: string, suggestedName: string) {
    setAddingPhone(phone);
    setAddingName(suggestedName);
    setAddingErr(null);
  }

  function cancelAdd() {
    setAddingPhone(null);
    setAddingName("");
    setAddingErr(null);
  }

  async function saveAdd() {
    const name = addingName.trim();
    const digits = (addingPhone || "").replace(/\D/g, "");
    if (!name) { setAddingErr("Informe o nome"); return; }
    if (!digits) { setAddingErr("Telefone inválido"); return; }
    setAddingSaving(true); setAddingErr(null);
    try {
      const { error } = await db.from("employees").insert({
        name,
        phone: digits,
        status: "ATIVO",
        updated_by: profile?.full_name || "Sistema",
      } as Record<string, unknown>);
      if (error) throw new Error(error.message);
      cancelAdd();
      await loadInfo();
    } catch (e) {
      setAddingErr((e as Error).message);
    } finally {
      setAddingSaving(false);
    }
  }

  const formatCreation = (ms: number | null) =>
    ms ? new Date(ms).toLocaleString("pt-BR", { day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

  return (
    <Modal open={!!jid} onClose={onClose} title="Informações do grupo" maxWidth="max-w-2xl">
      {loading && !info && <p className="text-sm text-text-light">Carregando informações...</p>}
      {err && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {err}
        </p>
      )}
      {info && (
        <div className="space-y-4">
          {/* Header card */}
          <div className="bg-gray-50 border border-border rounded-xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wider text-text-light font-semibold">Nome do grupo</p>
                <p className="font-semibold text-text mt-0.5 truncate">{info.subject || "(sem nome)"}</p>
              </div>
              <button
                type="button"
                onClick={loadInfo}
                disabled={loading}
                title="Atualizar"
                className="shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-border bg-white hover:bg-gray-100 transition disabled:opacity-50"
              >
                <svg className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M4 10a8 8 0 0114.93-3M20 14a8 8 0 01-14.93 3" />
                </svg>
                {loading ? "Atualizando..." : "Atualizar"}
              </button>
            </div>
            {info.description && (
              <>
                <p className="text-xs uppercase tracking-wider text-text-light font-semibold mt-3">Descrição</p>
                <p className="text-sm text-text whitespace-pre-wrap mt-0.5">{info.description}</p>
              </>
            )}
            <div className="grid grid-cols-2 gap-3 mt-3 text-xs">
              <div>
                <p className="uppercase tracking-wider text-text-light font-semibold">Criado em</p>
                <p className="text-text mt-0.5">{formatCreation(info.created_at_ms)}</p>
              </div>
              <div>
                <p className="uppercase tracking-wider text-text-light font-semibold">Participantes</p>
                <p className="text-text mt-0.5">{info.size}</p>
              </div>
            </div>
          </div>

          {/* Linked ship */}
          <div className={`rounded-xl border p-4 ${
            info.ship
              ? "bg-emerald-50 border-emerald-200"
              : "bg-amber-50 border-amber-200"
          }`}>
            <p className="text-xs uppercase tracking-wider font-semibold text-text-light">Navio vinculado</p>
            {info.ship ? (
              <>
                <a
                  href="/navios"
                  className="block mt-0.5 font-semibold text-emerald-900 hover:underline"
                >
                  🚢 {info.ship.name}
                </a>
                <p className="text-xs text-emerald-800 mt-1">
                  Status: <strong>{info.ship.status}</strong>
                  {info.ship.port && <> · Porto: <strong>{info.ship.port}</strong></>}
                </p>
                <p className="text-[10px] text-emerald-700 mt-1">
                  A escala diária é postada automaticamente neste grupo.
                </p>
              </>
            ) : (
              <p className="text-sm text-amber-900 mt-0.5">
                Nenhum navio vinculado.{" "}
                <span className="text-xs text-amber-800">
                  Vincule este grupo a um navio na aba <strong>Navios</strong> pra ativar o envio automático de escala.
                </span>
              </p>
            )}
          </div>

          {/* Participants */}
          <div>
            <p className="text-xs uppercase tracking-wider text-text-light font-semibold mb-2">
              Participantes ({info.participants.length})
            </p>
            <div className="border border-border rounded-xl divide-y divide-border max-h-72 overflow-y-auto">
              {info.participants.length === 0 ? (
                <p className="px-3 py-4 text-xs text-text-light italic text-center">
                  Nenhum participante retornado pelo WhatsApp.
                </p>
              ) : (
                info.participants.map((p) => {
                  const displayName = p.employee?.name || p.push_name || null;
                  const avatarSeed = displayName || p.phone || "?";
                  const isAdding = addingPhone === p.phone && !!p.phone;
                  const canRegister = !p.employee && !!p.phone;
                  const isConfirmingRemove = confirmRemovePhone === p.phone && !!p.phone;
                  // Só dá pra remover quem tem telefone resolvido (precisamos do
                  // número pra mirar a remoção) e que não seja o dono do grupo —
                  // o WhatsApp não deixa remover o superadmin.
                  const canRemove = !!p.phone && p.admin !== "superadmin";
                  const removeLabel = displayName || formatPhone(p.phone) || p.phone;
                  return (
                  <div key={p.jid || p.phone} className="px-3 py-2 flex flex-col gap-2">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                        <span className="text-xs font-semibold text-primary">
                          {avatarSeed.slice(0, 2).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {displayName || (
                            <span className="text-text-light italic">Não cadastrado</span>
                          )}
                          {!p.employee && p.push_name && (
                            <span className="ml-1 text-[10px] font-normal text-text-light italic">(WhatsApp)</span>
                          )}
                        </p>
                        <p className="text-[10px] text-text-light font-mono">
                          {formatPhone(p.phone) || p.phone}
                          {p.employee?.team && ` · ${p.employee.team}`}
                        </p>
                      </div>
                      {p.admin && (
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0 ${
                          p.admin === "superadmin"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-blue-100 text-blue-800"
                        }`}>
                          {p.admin === "superadmin" ? "Dono" : "Admin"}
                        </span>
                      )}
                      {canRegister && !isAdding && (
                        <button
                          type="button"
                          onClick={() => startAdd(p.phone, p.push_name || "")}
                          className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded-lg border border-primary/30 text-primary hover:bg-primary/10 transition"
                        >
                          + Cadastrar
                        </button>
                      )}
                      {canRemove && !isConfirmingRemove && !isAdding && (
                        <button
                          type="button"
                          onClick={() => { setConfirmRemovePhone(p.phone); setRemoveErr(null); }}
                          className="shrink-0 p-1 rounded text-text-light hover:text-red-600 hover:bg-red-50 transition"
                          title="Remover do grupo"
                          aria-label="Remover do grupo"
                        >
                          <TrashIcon className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    {isAdding && (
                      <div className="ml-11 flex flex-col gap-1.5 bg-primary/5 border border-primary/20 rounded-lg p-2">
                        <p className="text-[10px] uppercase tracking-wider text-text-light font-semibold">
                          Novo colaborador · {formatPhone(p.phone) || p.phone}
                        </p>
                        <input
                          autoFocus
                          type="text"
                          value={addingName}
                          onChange={(e) => setAddingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); saveAdd(); }
                            if (e.key === "Escape") { e.preventDefault(); cancelAdd(); }
                          }}
                          placeholder="Nome completo"
                          className="text-sm px-2 py-1 border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/40"
                          disabled={addingSaving}
                        />
                        {addingErr && (
                          <p className="text-[10px] text-red-700">{addingErr}</p>
                        )}
                        <div className="flex items-center gap-2 justify-end">
                          <button
                            type="button"
                            onClick={cancelAdd}
                            disabled={addingSaving}
                            className="text-[10px] font-semibold px-2 py-1 rounded-md text-text-light hover:bg-gray-100 transition disabled:opacity-50"
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            onClick={saveAdd}
                            disabled={addingSaving || !addingName.trim()}
                            className="text-[10px] font-semibold px-2 py-1 rounded-md bg-primary text-white hover:bg-primary/90 transition disabled:opacity-50"
                          >
                            {addingSaving ? "Salvando..." : "Salvar"}
                          </button>
                        </div>
                        <p className="text-[10px] text-text-light">
                          Salvo como ATIVO. Edite outros campos depois em <strong>Colaboradores</strong>.
                        </p>
                      </div>
                    )}
                    {isConfirmingRemove && (
                      <div className="ml-11 flex flex-col gap-1.5 bg-red-50 border border-red-200 rounded-lg p-2">
                        <p className="text-[11px] text-red-900 font-semibold">
                          Remover {removeLabel} do grupo?
                        </p>
                        <p className="text-[10px] text-red-800">
                          O número sai do grupo no WhatsApp. Pra voltar, alguém precisa
                          adicioná-lo de novo. O histórico de mensagens continua aqui.
                        </p>
                        {removeErr && (
                          <p className="text-[10px] text-red-700">{removeErr}</p>
                        )}
                        <div className="flex items-center gap-2 justify-end">
                          <button
                            type="button"
                            onClick={() => { setConfirmRemovePhone(null); setRemoveErr(null); }}
                            disabled={removing}
                            className="text-[10px] font-semibold px-2 py-1 rounded-md text-text-light hover:bg-white/70 transition disabled:opacity-50"
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemove(p.phone, removeLabel)}
                            disabled={removing}
                            className="text-[10px] font-semibold px-2 py-1 rounded-md bg-red-600 text-white hover:bg-red-700 transition disabled:opacity-50"
                          >
                            {removing ? "Removendo..." : "Remover"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  );
                })
              )}
            </div>
            <p className="text-[10px] text-text-light mt-2">
              Os nomes são casados pelo telefone com a aba <strong>Colaboradores</strong>. Quem aparece como
              &quot;Não cadastrado&quot; ainda não tem registro no sistema (ou o telefone está em outro formato).
              Após cadastrar ou atualizar números, use <strong>Atualizar</strong> para recarregar.
            </p>
          </div>

          {/* Footer: sair do grupo + fechar */}
          <div className="pt-3 border-t border-border">
            {leaveErr && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-2">
                {leaveErr}
              </p>
            )}
            {confirmingLeave ? (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3">
                <p className="text-sm text-red-900 font-semibold">Sair deste grupo?</p>
                <p className="text-xs text-red-800 mt-1">
                  O número do WhatsApp conectado vai deixar o grupo. Pra voltar, alguém
                  precisa adicionar o número de novo lá no WhatsApp. O histórico de
                  mensagens continua aqui no sistema.
                  {info.ship && (
                    <> Além disso, o navio <strong>{info.ship.name}</strong> será desvinculado
                    e a escala automática deixa de ser postada.</>
                  )}
                </p>
                <div className="flex items-center gap-2 justify-end mt-3">
                  <button
                    type="button"
                    onClick={() => setConfirmingLeave(false)}
                    disabled={leaving}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg text-text-light hover:bg-white/70 transition disabled:opacity-50"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={handleLeave}
                    disabled={leaving}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-600 text-white hover:bg-red-700 transition disabled:opacity-50"
                  >
                    {leaving ? "Saindo..." : "🚪 Sair do grupo"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => { setConfirmingLeave(true); setLeaveErr(null); }}
                  className="text-xs font-semibold px-3 py-2 rounded-lg border border-red-200 text-red-700 hover:bg-red-50 transition inline-flex items-center gap-1.5"
                >
                  🚪 Sair do grupo
                </button>
                <Button variant="secondary" onClick={onClose}>Fechar</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ─── Novo Grupo Modal ───────────────────────────────────────────────────────

function NewGroupModal({
  open, onClose, onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [shipId, setShipId] = useState<string>("");
  const [ships, setShips] = useState<ShipOpt[]>([]);
  const [employees, setEmployees] = useState<EmpOpt[]>([]);
  const [selectedEmpIds, setSelectedEmpIds] = useState<Set<number>>(new Set());
  const [empSearch, setEmpSearch] = useState("");
  const [extraNumbers, setExtraNumbers] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSubject(""); setShipId(""); setSelectedEmpIds(new Set());
    setEmpSearch(""); setExtraNumbers(""); setError(null); setWarning(null);
    (async () => {
      try {
        const [shipsRes, empRes] = await Promise.all([
          db.from("ships").select("id, name, whatsapp_group_jid").in("status", ["AGENDADO", "EM_OPERACAO"]).order("name"),
          db.from("employees").select("id, name, phone, status").eq("status", "ATIVO").order("name"),
        ]);
        setShips((shipsRes.data as ShipOpt[]) || []);
        setEmployees((empRes.data as EmpOpt[]) || []);
      } catch (err) {
        setError(`Não foi possível carregar listas: ${(err as Error).message}`);
      }
    })();
  }, [open]);

  const filteredEmps = useMemo(() => {
    const list = employees.filter((e) => e.phone && e.phone.trim().length > 0);
    if (!empSearch.trim()) return list;
    const q = empSearch.toLowerCase();
    return list.filter((e) => e.name.toLowerCase().includes(q));
  }, [employees, empSearch]);

  function toggleEmp(id: number) {
    setSelectedEmpIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Free-text numbers, one per line or comma-separated. Stripped to digits.
  function parseExtraNumbers(raw: string): string[] {
    return raw
      .split(/[\s,;]+/)
      .map((s) => s.replace(/\D/g, ""))
      .filter((s) => s.length >= 10);
  }

  const totalParticipants = useMemo(() => {
    const empPhones = Array.from(selectedEmpIds)
      .map((id) => employees.find((e) => e.id === id)?.phone || "")
      .filter(Boolean);
    return new Set([...empPhones, ...parseExtraNumbers(extraNumbers)]).size;
  }, [selectedEmpIds, employees, extraNumbers]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setWarning(null);
    if (!subject.trim()) { setError("Informe o nome do grupo."); return; }
    if (totalParticipants === 0) { setError("Adicione ao menos um participante."); return; }

    setSaving(true);
    try {
      const empPhones = Array.from(selectedEmpIds)
        .map((id) => employees.find((e) => e.id === id)?.phone || "")
        .filter(Boolean);
      const participants = Array.from(new Set([...empPhones, ...parseExtraNumbers(extraNumbers)]));

      const res = await fetch("/api/whatsapp/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          participants,
          shipId: shipId || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.status === "partial" && body.warning) {
        setWarning(body.warning);
        // Don't auto-close — let the user read the warning.
        return;
      }
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full px-3 py-2 border border-border rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none";

  return (
    <Modal open={open} onClose={onClose} title="Novo grupo do WhatsApp" maxWidth="max-w-xl">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Nome do grupo *</label>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="ex.: MV REVENGER - 12"
            className={inputCls}
            autoFocus
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            Vincular a um navio <span className="text-xs text-text-light font-normal">(opcional)</span>
          </label>
          <select value={shipId} onChange={(e) => setShipId(e.target.value)} className={inputCls}>
            <option value="">— Sem vínculo —</option>
            {ships.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}{s.whatsapp_group_jid ? " (já tem grupo)" : ""}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-text-light mt-1">
            Vinculando, o sistema posta automaticamente a escala diária neste grupo.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            Colaboradores <span className="text-xs text-text-light font-normal">
              ({selectedEmpIds.size} selecionados)
            </span>
          </label>
          <input
            type="text"
            value={empSearch}
            onChange={(e) => setEmpSearch(e.target.value)}
            placeholder="🔍 Buscar colaborador..."
            className={inputCls}
          />
          <div className="mt-2 max-h-56 overflow-y-auto border border-border rounded-lg">
            {filteredEmps.length === 0 ? (
              <p className="px-3 py-3 text-xs text-text-light italic text-center">
                {empSearch.trim()
                  ? "Nenhum colaborador com telefone encontrado."
                  : "Apenas colaboradores ATIVOS com telefone aparecem aqui."}
              </p>
            ) : (
              filteredEmps.map((emp) => {
                const checked = selectedEmpIds.has(emp.id);
                return (
                  <label
                    key={emp.id}
                    className={`flex items-center gap-2 px-3 py-2 border-b border-border last:border-0 cursor-pointer transition ${
                      checked ? "bg-emerald-50 hover:bg-emerald-100" : "hover:bg-blue-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleEmp(emp.id)}
                      className="w-4 h-4 accent-primary"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{emp.name}</p>
                      <p className="text-[10px] text-text-light">{formatPhone(emp.phone || "")}</p>
                    </div>
                  </label>
                );
              })
            )}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            Outros números <span className="text-xs text-text-light font-normal">(opcional, um por linha)</span>
          </label>
          <textarea
            value={extraNumbers}
            onChange={(e) => setExtraNumbers(e.target.value)}
            rows={2}
            placeholder="5513999999999&#10;5513988888888"
            className={inputCls + " font-mono"}
          />
          <p className="text-[10px] text-text-light mt-1">
            Use só dígitos. Sem o 55 inicial o sistema completa automaticamente.
          </p>
        </div>

        {error && (
          <p className="text-xs text-danger bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
        {warning && (
          <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {warning}
          </p>
        )}

        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-text-light">
            Total: <strong className="text-text">{totalParticipants}</strong> participante(s)
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving || totalParticipants === 0 || !subject.trim()}>
              {saving ? "Criando..." : "Criar grupo"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
