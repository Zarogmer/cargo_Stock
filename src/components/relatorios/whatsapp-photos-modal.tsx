"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { formatPhone, matchSearch } from "@/lib/utils";

// Modal "Enviar para WhatsApp" da aba Fotos dos Relatórios de Bordo: escolhe o
// destinatário (conversa/grupo já existente no WhatsApp do sistema ou um número
// digitado) e manda TODAS as fotos do bloco em sequência pelo backend
// (POST /api/relatorios/[jobId]/fotos/whatsapp — mesma instância Evolution da
// aba Conversas). Primeiro sai a mensagem de abertura, depois uma foto por vez
// com a legenda; erro numa foto não trava as outras.
//
// O último destinatário escolhido fica no sessionStorage — mandar os blocos
// de um navio pro mesmo cliente em seguida é o uso normal.

export interface WhatsappPhotoItem {
  id: number;
  caption: string;
}

export interface WhatsappSendBlock {
  jobId: string;
  kind: string;
  label: string;
  opening: string;
  photos: WhatsappPhotoItem[];
}

interface Conversation {
  remote_jid: string;
  push_name: string | null;
  is_group: boolean;
}

const LAST_TO_KEY = "relatorios_wa_last_to";

function readLastTo(): { to: string; name: string } | null {
  try {
    const raw = sessionStorage.getItem(LAST_TO_KEY);
    return raw ? (JSON.parse(raw) as { to: string; name: string }) : null;
  } catch {
    return null;
  }
}

function saveLastTo(value: { to: string; name: string }) {
  try {
    sessionStorage.setItem(LAST_TO_KEY, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function conversationName(c: Conversation): string {
  if (c.push_name && c.push_name.trim()) return c.push_name.trim();
  if (c.is_group) return "Grupo";
  return formatPhone(c.remote_jid.replace(/@.*$/, ""));
}

type Phase = "pick" | "sending" | "done";

export function WhatsappPhotosModal({ block, onClose }: { block: WhatsappSendBlock | null; onClose: () => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  // null = ainda carregando; false = o papel não vê a lista (SUPERVISOR) — só
  // número digitado.
  const [listAvailable, setListAvailable] = useState<boolean | null>(null);
  const [search, setSearch] = useState("");
  const [number, setNumber] = useState("");
  const [selected, setSelected] = useState<{ to: string; name: string } | null>(null);
  const [phase, setPhase] = useState<Phase>("pick");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [errors, setErrors] = useState<string[]>([]);
  const [sentOk, setSentOk] = useState(0);

  // Reset a cada abertura (o modal é montado com o bloco escolhido).
  useEffect(() => {
    if (!block) return;
    setPhase("pick");
    setProgress({ done: 0, total: 0 });
    setErrors([]);
    setSentOk(0);
    setSearch("");
    const last = readLastTo();
    setSelected(last);
    setNumber(last && !last.to.includes("@") ? last.to : "");
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/whatsapp/conversations");
        if (cancelled) return;
        if (!res.ok) {
          setListAvailable(false);
          return;
        }
        const body = await res.json();
        setConversations((body.conversations || []) as Conversation[]);
        setListAvailable(true);
      } catch {
        if (!cancelled) setListAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [block]);

  const filtered = useMemo(() => {
    const q = search.trim();
    const list = q
      ? conversations.filter((c) => matchSearch(`${conversationName(c)} ${c.remote_jid}`, q))
      : conversations;
    return list.slice(0, 60);
  }, [conversations, search]);

  const numberDigits = number.replace(/\D/g, "");
  const canSend = !!selected && (selected.to.includes("@") || selected.to.replace(/\D/g, "").length >= 10);

  function pickNumber(value: string) {
    setNumber(value);
    const digits = value.replace(/\D/g, "");
    setSelected(digits.length >= 10 ? { to: digits, name: formatPhone(digits) } : null);
  }

  async function send() {
    if (!block || !selected) return;
    saveLastTo(selected);
    setPhase("sending");
    const total = block.photos.length + 1;
    setProgress({ done: 0, total });
    const errs: string[] = [];
    let ok = 0;

    const post = async (payload: Record<string, unknown>) => {
      const res = await fetch(`/api/relatorios/${block.jobId}/fotos/whatsapp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: block.kind, to: selected.to, label: selected.name, ...payload }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Erro ${res.status}`);
    };

    try {
      await post({ text: block.opening });
      ok++;
    } catch (err) {
      errs.push(`Mensagem de abertura: ${(err as Error).message}`);
    }
    setProgress({ done: 1, total });

    for (let i = 0; i < block.photos.length; i++) {
      const p = block.photos[i];
      try {
        await post({ photoId: p.id, caption: p.caption });
        ok++;
      } catch (err) {
        errs.push(`Foto ${i + 1}: ${(err as Error).message}`);
      }
      setProgress({ done: i + 2, total });
      setErrors([...errs]);
    }
    setSentOk(ok);
    setErrors(errs);
    setPhase("done");
  }

  if (!block) return null;
  const n = block.photos.length;
  const sending = phase === "sending";
  const inputCls =
    "w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30";

  return (
    <Modal open onClose={sending ? () => {} : onClose} title="📲 Enviar para WhatsApp" maxWidth="max-w-md">
      <div className="space-y-4">
        <div className="bg-bg rounded-lg border border-border p-3 text-sm">
          <p className="font-semibold text-text">{block.label}</p>
          <p className="text-text-light text-xs mt-0.5">
            {n} foto{n !== 1 ? "s" : ""} — vão em sequência, com a mensagem de abertura antes.
          </p>
        </div>

        {phase === "pick" && (
          <>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-text-light">Número (DDD + número)</label>
              <input
                type="tel"
                value={number}
                onChange={(e) => pickNumber(e.target.value)}
                placeholder="Ex.: 13 99999-9999"
                className={inputCls}
              />
            </div>

            {listAvailable !== false && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-text-light">Ou escolha uma conversa</label>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar contato ou grupo..."
                  className={inputCls}
                />
                <div className="max-h-56 overflow-y-auto border border-border rounded-lg divide-y divide-border">
                  {listAvailable === null ? (
                    <p className="text-xs text-text-light p-3">Carregando conversas...</p>
                  ) : filtered.length === 0 ? (
                    <p className="text-xs text-text-light p-3">Nenhuma conversa encontrada.</p>
                  ) : (
                    filtered.map((c) => {
                      const name = conversationName(c);
                      const to = c.is_group ? c.remote_jid : c.remote_jid.replace(/@.*$/, "");
                      const active = selected?.to === to;
                      return (
                        <button
                          key={c.remote_jid}
                          type="button"
                          onClick={() => {
                            setSelected({ to, name });
                            setNumber("");
                          }}
                          className={`w-full text-left px-3 py-2 text-sm transition ${
                            active ? "bg-primary/10 text-primary font-medium" : "hover:bg-gray-50 text-text"
                          }`}
                        >
                          <span className="mr-1.5">{c.is_group ? "👥" : "👤"}</span>
                          {name}
                          {!c.is_group && name !== formatPhone(to) && (
                            <span className="text-xs text-text-light ml-1.5">{formatPhone(to)}</span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            <p className="text-xs text-text-light">
              Destinatário:{" "}
              {selected ? (
                <span className="font-medium text-text">{selected.name}</span>
              ) : numberDigits.length > 0 ? (
                "número incompleto"
              ) : (
                "nenhum escolhido"
              )}
            </p>

            <div className="flex gap-3 justify-end">
              <Button variant="secondary" onClick={onClose}>
                Cancelar
              </Button>
              <Button variant="success" onClick={send} disabled={!canSend || n === 0}>
                Enviar {n} foto{n !== 1 ? "s" : ""}
              </Button>
            </div>
          </>
        )}

        {(phase === "sending" || phase === "done") && (
          <div className="space-y-3">
            <p className="text-sm text-text">
              {sending
                ? `Enviando ${Math.min(progress.done + 1, progress.total)} de ${progress.total} para ${selected?.name}...`
                : errors.length === 0
                  ? `✅ Tudo enviado para ${selected?.name} (${sentOk - 1} foto${sentOk - 1 !== 1 ? "s" : ""}).`
                  : `Enviado para ${selected?.name}: ${Math.max(sentOk - 1, 0)} de ${n} fotos.`}
            </p>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
              />
            </div>
            {errors.length > 0 && (
              <div className="bg-danger/10 border border-danger/30 rounded-lg p-3 space-y-1">
                <p className="text-xs font-semibold text-danger">⚠️ Não deu pra enviar:</p>
                <ul className="text-xs text-danger space-y-0.5">
                  {errors.map((e, i) => (
                    <li key={i}>• {e}</li>
                  ))}
                </ul>
              </div>
            )}
            {phase === "done" && (
              <div className="flex justify-end">
                <Button variant="secondary" onClick={onClose}>
                  Fechar
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
