"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { formatPhone } from "@/lib/utils";

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

// "5513999999999@s.whatsapp.net" → "5513999999999"
function jidToNumber(jid: string): string {
  return jid.replace(/@.*$/, "");
}

function displayName(c: Conversation): string {
  if (c.push_name && c.push_name.trim()) return c.push_name;
  if (c.is_group) return "Grupo";
  return formatPhone(jidToNumber(c.remote_jid)) || c.remote_jid;
}

function formatTime(ms: string | number): string {
  const date = new Date(Number(ms));
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  if (isYesterday) return "Ontem";
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function formatFullDateTime(ms: string | number): string {
  return new Date(Number(ms)).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function previewLine(c: Conversation): string {
  const prefix = c.last_from_me ? "Você: " : "";
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

function MediaBubble({ msg }: { msg: Message }) {
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
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="imagem" className="max-w-xs rounded-lg" />;
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

export default function ConversasPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConv, setLoadingConv] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedJid, setSelectedJid] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  const threadRef = useRef<HTMLDivElement>(null);
  const lastMessageCount = useRef(0);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/whatsapp/conversations");
      const body = await res.json();
      if (res.ok) setConversations(body.conversations || []);
    } catch {
      // silent — keep previous list
    } finally {
      setLoadingConv(false);
    }
  }, []);

  const loadMessages = useCallback(async (jid: string) => {
    setLoadingMsgs(true);
    try {
      const res = await fetch(`/api/whatsapp/conversations/${encodeURIComponent(jid)}/messages`);
      const body = await res.json();
      if (res.ok) setMessages(body.messages || []);
    } catch {
      // silent
    } finally {
      setLoadingMsgs(false);
    }
  }, []);

  useEffect(() => {
    loadConversations();
    const interval = setInterval(loadConversations, 5000);
    return () => clearInterval(interval);
  }, [loadConversations]);

  useEffect(() => {
    if (!selectedJid) return;
    loadMessages(selectedJid);
    const interval = setInterval(() => loadMessages(selectedJid), 5000);
    return () => clearInterval(interval);
  }, [selectedJid, loadMessages]);

  // Auto-scroll to bottom when new messages arrive (but not when just polling
  // with the same count, so we don't fight the user's scroll position).
  useEffect(() => {
    if (messages.length > lastMessageCount.current && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
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
      // Webhook will deliver the from_me event shortly; trigger a refresh now too
      loadMessages(selectedJid);
      loadConversations();
    } catch (err) {
      setSendErr((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="h-[calc(100vh-120px)] flex flex-col">
      <h1 className="text-2xl font-bold text-text mb-3">Conversas 💬</h1>

      <div className="flex-1 flex gap-3 min-h-0 bg-card rounded-2xl border border-border overflow-hidden">
        {/* Sidebar */}
        <aside className="w-80 shrink-0 border-r border-border flex flex-col">
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
                  return (
                    <li key={c.remote_jid}>
                      <button
                        type="button"
                        onClick={() => setSelectedJid(c.remote_jid)}
                        className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition ${active ? "bg-primary/5 border-l-2 border-primary" : ""}`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="font-medium text-sm truncate flex items-center gap-1">
                            {c.is_group && <span className="text-xs">👥</span>}
                            {displayName(c)}
                          </span>
                          <span className="text-[10px] text-text-light shrink-0">
                            {formatTime(c.last_timestamp_ms)}
                          </span>
                        </div>
                        <p className="text-xs text-text-light truncate mt-0.5">
                          {previewLine(c)}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* Thread */}
        <section className="flex-1 flex flex-col min-w-0">
          {!selectedJid ? (
            <div className="flex-1 flex items-center justify-center text-text-light text-sm">
              ← Selecione uma conversa pra ver as mensagens
            </div>
          ) : (
            <>
              <header className="border-b border-border px-4 py-3 flex items-baseline justify-between">
                <div>
                  <h2 className="font-semibold text-sm">{selectedConv ? displayName(selectedConv) : "..."}</h2>
                  <p className="text-xs text-text-light font-mono">
                    {selectedConv?.is_group ? "Grupo" : formatPhone(jidToNumber(selectedJid))}
                  </p>
                </div>
                <span className="text-xs text-text-light">
                  {messages.length} {messages.length === 1 ? "mensagem" : "mensagens"}
                </span>
              </header>

              <div ref={threadRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2 bg-[#f0f2f5]">
                {loadingMsgs && messages.length === 0 ? (
                  <p className="text-sm text-text-light text-center">Carregando mensagens...</p>
                ) : messages.length === 0 ? (
                  <p className="text-sm text-text-light text-center">Sem mensagens nessa conversa ainda.</p>
                ) : (
                  messages.map((m) => {
                    const hasMedia = m.media_mimetype && m.message_type !== "conversation" && m.message_type !== "extendedTextMessage";
                    return (
                      <div key={m.id} className={`flex ${m.from_me ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[70%] rounded-lg px-3 py-2 shadow-sm ${
                          m.from_me ? "bg-[#d9fdd3] text-gray-900" : "bg-white text-gray-900"
                        }`}>
                          {!m.from_me && m.push_name && selectedConv?.is_group && (
                            <p className="text-[10px] font-semibold text-primary mb-0.5">{m.push_name}</p>
                          )}
                          {hasMedia ? (
                            <MediaBubble msg={m} />
                          ) : (
                            <p className="text-sm whitespace-pre-wrap break-words">{m.text || "(vazio)"}</p>
                          )}
                          <p className="text-[10px] text-gray-500 text-right mt-1" title={formatFullDateTime(m.timestamp_ms)}>
                            {formatTime(m.timestamp_ms)}
                          </p>
                        </div>
                      </div>
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
    </div>
  );
}
