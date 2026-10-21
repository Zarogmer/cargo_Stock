"use client";

import { useEffect, useRef, useState } from "react";

// "📷 Escanear folha" do Checklist (Embarque e Retorno): o maquinista fotografa
// a folha do Check List preenchida à mão, a IA (/api/embarque/escanear) lê os
// números e casa cada linha com um item da lista do navio, e aqui ele confere
// antes de aplicar — sem digitar item por item.
//   Embarque → quanto VAI de cada item (grava o ajuste do navio, igual digitar)
//   Retorno  → Voltou / Avariado / Perdido (só preenche a tela; o Confirmar
//              Retorno continua sendo o passo que grava)

export interface ScanListItem {
  id: number; // stock_item_id
  name: string;
  group: string; // "Materiais", "Rancho", "Estoque (fora da lista)"
  // Quanto foi/vai pela lista (vai pra IA como referência do "✓" na Volta).
  expected: number;
  // Valor que a tela tem agora no campo que o escaneamento preenche.
  current: number | null;
}

export interface ScanAppliedRow {
  id: number;
  quantity: number | null;
  returned: number | null;
  broken: number | null;
  lost: number | null;
  note: string | null;
}

interface ScanLine {
  written_name: string;
  item_id: number | null;
  quantity: number | null;
  returned: number | null;
  broken: number | null;
  lost: number | null;
  note: string | null;
}

interface Shot {
  id: number;
  blob: Blob;
  name: string;
  preview: string | null; // PDF não tem miniatura
}

interface Row {
  key: number;
  include: boolean;
  writtenName: string;
  itemId: string; // "" = sem item
  quantity: string;
  returned: string;
  broken: string;
  lost: string;
  note: string;
}

// Lado maior da foto enviada: a folha inteira legível sem estourar o 4G.
const MAX_SIDE = 2400;

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Falha ao gerar a foto"))), "image/jpeg", 0.85);
  });
}

async function downscale(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas indisponível");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvasToJpeg(canvas);
}

const numStr = (n: number | null | undefined) => (n == null ? "" : String(n));
const parseNum = (s: string): number | null => {
  const v = parseFloat(s.replace(",", "."));
  return Number.isFinite(v) && v >= 0 ? v : null;
};

export function EscanearChecklistModal({ open, onClose, mode, shipName, items, onApply }: {
  open: boolean;
  onClose: () => void;
  mode: "embarque" | "retorno";
  shipName: string;
  items: ScanListItem[];
  onApply: (rows: ScanAppliedRow[]) => Promise<void>;
}) {
  const [stage, setStage] = useState<"camera" | "reading" | "review">("camera");
  const [shots, setShots] = useState<Shot[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [warnings, setWarnings] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [applying, setApplying] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const shotSeq = useRef(0);
  const rowSeq = useRef(0);
  const shotsRef = useRef<Shot[]>([]);
  shotsRef.current = shots;

  const isRetorno = mode === "retorno";
  const itemById = new Map(items.map((i) => [i.id, i]));
  const groups = [...new Set(items.map((i) => i.group))];

  // Abre zerado a cada vez.
  useEffect(() => {
    if (!open) return;
    setShots([]); setError(null); setWarnings(null); setRows([]); setApplying(false);
    setStage("camera");
  }, [open]);

  // Libera as miniaturas ao fechar.
  useEffect(() => {
    if (open) return;
    shotsRef.current.forEach((s) => s.preview && URL.revokeObjectURL(s.preview));
  }, [open]);

  // Câmera ligada só na etapa de fotos; desliga ao sair dela ou fechar.
  useEffect(() => {
    if (!open || stage !== "camera") return;
    let cancelled = false;
    const video = videoRef.current;
    setCameraError(null);
    setCameraReady(false);
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("sem câmera");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
          setCameraReady(true);
        }
      } catch {
        if (!cancelled) {
          setCameraError("Não consegui abrir a câmera. Libere a permissão de câmera pro site — ou use \"Enviar arquivo\" abaixo.");
        }
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (video) video.srcObject = null;
    };
  }, [open, stage]);

  if (!open) return null;

  function removeShot(id: number) {
    setShots((prev) => {
      const s = prev.find((x) => x.id === id);
      if (s?.preview) URL.revokeObjectURL(s.preview);
      return prev.filter((x) => x.id !== id);
    });
  }

  async function takePhoto() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    try {
      const blob = await downscale(video, video.videoWidth, video.videoHeight);
      const shot: Shot = { id: ++shotSeq.current, blob, name: `folha-${shotSeq.current}.jpg`, preview: URL.createObjectURL(blob) };
      setShots((prev) => [...prev, shot]);
      setFlash(true);
      setTimeout(() => setFlash(false), 150);
      try { navigator.vibrate?.(60); } catch { /* sem vibração */ }
    } catch {
      setError("Não consegui capturar a foto — tente de novo.");
    }
  }

  async function addFiles(list: FileList | null) {
    if (!list) return;
    setError(null);
    for (const f of Array.from(list)) {
      try {
        if (f.type === "application/pdf") {
          const shot: Shot = { id: ++shotSeq.current, blob: f, name: f.name, preview: null };
          setShots((prev) => [...prev, shot]);
          continue;
        }
        if (!f.type.startsWith("image/")) throw new Error(`"${f.name}" não é foto nem PDF.`);
        const bmp = await createImageBitmap(f);
        const blob = await downscale(bmp, bmp.width, bmp.height);
        bmp.close();
        const shot: Shot = { id: ++shotSeq.current, blob, name: f.name.replace(/\.\w+$/, "") + ".jpg", preview: URL.createObjectURL(blob) };
        setShots((prev) => [...prev, shot]);
      } catch (err) {
        setError(err instanceof Error ? err.message : `Não consegui abrir "${f.name}".`);
      }
    }
  }

  async function analyze() {
    if (shots.length === 0) return;
    setError(null);
    setStage("reading");
    try {
      const fd = new FormData();
      shots.forEach((s) => fd.append("files", s.blob, s.name));
      fd.append("mode", mode);
      fd.append("items", JSON.stringify(items.map((i) => ({ id: i.id, name: i.name, expected: i.expected }))));
      const res = await fetch("/api/embarque/escanear", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
      const lines = (data.lines || []) as ScanLine[];
      setWarnings(data.warnings || null);
      setRows(lines.map((l) => {
        const item = l.item_id != null ? itemById.get(l.item_id) : undefined;
        const value = isRetorno ? l.returned : l.quantity;
        return {
          key: ++rowSeq.current,
          // Sem item casado não aplica; com item, só marca o que muda algo.
          include: !!item && (value !== item.current || l.broken != null || l.lost != null || !!l.note),
          writtenName: l.written_name,
          itemId: item ? String(item.id) : "",
          quantity: numStr(l.quantity),
          returned: numStr(l.returned),
          broken: numStr(l.broken),
          lost: numStr(l.lost),
          note: l.note || "",
        };
      }));
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao ler a folha.");
      setStage("camera");
    }
  }

  function updateRow(key: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  const included = rows.filter((r) => r.include && r.itemId);
  const readIds = new Set(rows.map((r) => Number(r.itemId)).filter(Boolean));
  // Itens da lista que a folha não trouxe — aviso pra não passar batido.
  const missingFromSheet = items.filter((i) => i.group !== "Estoque (fora da lista)" && i.expected > 0 && !readIds.has(i.id));
  const unmatchedCount = rows.filter((r) => !r.itemId).length;

  async function handleApply() {
    if (included.length === 0) { setError("Marque ao menos uma linha com item."); return; }
    setError(null);
    setApplying(true);
    try {
      await onApply(included.map((r) => ({
        id: Number(r.itemId),
        quantity: parseNum(r.quantity),
        returned: parseNum(r.returned),
        broken: parseNum(r.broken),
        lost: parseNum(r.lost),
        note: r.note.trim() || null,
      })));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao aplicar.");
    } finally {
      setApplying(false);
    }
  }

  const inputCls = "w-full px-2 py-2 border border-border rounded-lg text-base sm:text-sm bg-white focus:ring-2 focus:ring-primary outline-none";

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex sm:items-center justify-center sm:p-safe-4">
      <div className="bg-white w-full h-full sm:h-auto sm:max-h-[min(92vh,100%)] sm:max-w-3xl sm:rounded-2xl shadow-xl flex flex-col pt-safe sm:pt-0">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-border shrink-0">
          <h2 className="text-lg font-semibold text-text">
            {stage === "review" ? "Conferir a folha" : `📷 Escanear folha — ${isRetorno ? "Retorno" : "Embarque"}`}
            <span className="block text-xs font-normal text-text-light">{shipName}</span>
          </h2>
          <button type="button" onClick={onClose} disabled={applying} className="p-2 -mr-2 text-text-light hover:text-text text-xl leading-none" title="Fechar">
            ✕
          </button>
        </div>

        {/* Corpo */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">{error}</div>
          )}

          {stage === "camera" && (
            <>
              <p className="text-sm text-text-light">
                Fotografe a <strong>folha do Check List</strong> preenchida{isRetorno ? " (com a coluna Volta)" : ""}.
                Se tiver 2 páginas, tire uma foto de cada. A IA lê os números e já casa com os itens da lista.
              </p>
              <div className="relative rounded-xl overflow-hidden bg-black aspect-[3/4] sm:aspect-video max-h-[55vh] mx-auto w-full">
                {/* muted + playsInline: iOS/Android exigem pra autoplay da câmera */}
                <video ref={videoRef} className="w-full h-full object-cover" muted playsInline autoPlay />
                {!cameraReady && !cameraError && (
                  <div className="absolute inset-0 flex items-center justify-center text-white/80 text-sm">Abrindo a câmera…</div>
                )}
                {cameraError && (
                  <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-white/90 text-sm">{cameraError}</div>
                )}
                {flash && <div className="absolute inset-0 bg-white/70" />}
                {cameraReady && (
                  <button
                    type="button"
                    onClick={takePhoto}
                    className="absolute bottom-4 left-1/2 -translate-x-1/2 w-16 h-16 rounded-full bg-white border-4 border-white/50 ring-4 ring-black/20 active:scale-95 transition"
                    title="Tirar foto"
                    aria-label="Tirar foto"
                  />
                )}
                {shots.length > 0 && (
                  <span className="absolute top-3 right-3 bg-black/60 text-white text-xs font-semibold px-2 py-1 rounded-full">
                    {shots.length} foto{shots.length > 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {shots.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {shots.map((s) => (
                    <div key={s.id} className="relative shrink-0 w-16 h-20 rounded-lg overflow-hidden border border-border bg-gray-50">
                      {s.preview ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.preview} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[10px] text-text-light p-1 text-center">📄 PDF</div>
                      )}
                      <button
                        type="button"
                        onClick={() => removeShot(s.id)}
                        className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white text-xs leading-5"
                        aria-label="Remover foto"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <label className="inline-block text-sm font-medium text-primary hover:underline cursor-pointer">
                📁 Enviar arquivo (foto ou PDF)
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
                />
              </label>
            </>
          )}

          {stage === "reading" && (
            <div className="py-16 flex flex-col items-center gap-3 text-center">
              <div className="w-10 h-10 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
              <p className="font-medium text-text">Lendo a folha com IA…</p>
              <p className="text-xs text-text-light">Leva de 20 segundos a 1 minuto. Não feche esta tela.</p>
            </div>
          )}

          {stage === "review" && (
            <>
              <div className="bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 text-xs text-sky-800 space-y-1">
                <p>
                  ✨ A IA leu <strong>{rows.length}</strong> linha(s) da folha. Confira os números e marque o que aplicar
                  {isRetorno
                    ? <> — vai preencher o <strong>Voltou/Avariado/Perdido</strong>; depois é só <strong>Confirmar Retorno</strong>.</>
                    : <> — vai gravar quanto <strong>vai</strong> de cada item neste navio.</>}
                </p>
                {unmatchedCount > 0 && <p>{unmatchedCount} linha(s) sem item reconhecido — escolha o item na lista ou deixe desmarcado.</p>}
              </div>
              {warnings && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">⚠️ {warnings}</div>
              )}

              {rows.length === 0 ? (
                <p className="text-sm text-text-light text-center py-6">Nenhuma linha preenchida encontrada na folha. Tente outra foto, mais de perto e com boa luz.</p>
              ) : (
                <div className="space-y-2">
                  {rows.map((r) => {
                    const item = r.itemId ? itemById.get(Number(r.itemId)) : undefined;
                    const changed = item && (isRetorno ? parseNum(r.returned) : parseNum(r.quantity)) !== item.current;
                    return (
                      <div key={r.key} className={`border rounded-xl p-3 space-y-2 ${r.include && r.itemId ? "border-border bg-white" : "border-dashed border-border bg-gray-50 opacity-70"}`}>
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            checked={r.include}
                            disabled={!r.itemId}
                            onChange={(e) => updateRow(r.key, { include: e.target.checked })}
                            className="mt-2.5 w-5 h-5 shrink-0 accent-primary"
                            aria-label="Aplicar esta linha"
                          />
                          <div className="flex-1 min-w-0 space-y-1">
                            <select
                              value={r.itemId}
                              onChange={(e) => updateRow(r.key, { itemId: e.target.value, include: !!e.target.value })}
                              className={`${inputCls} ${!r.itemId ? "border-amber-300" : ""}`}
                              aria-label="Item do sistema"
                            >
                              <option value="">— Não reconhecido (escolha o item)</option>
                              {groups.map((g) => (
                                <optgroup key={g} label={g}>
                                  {items.filter((i) => i.group === g).map((i) => (
                                    <option key={i.id} value={i.id}>{i.name}</option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                            <p className="text-[11px] text-text-light truncate">
                              Na folha: <span className="font-medium text-text">“{r.writtenName}”</span>
                              {item && (isRetorno
                                ? <> · foi {item.expected}{item.current != null ? ` · na tela: voltou ${item.current}` : ""}</>
                                : <> · na tela: {item.current ?? 0}</>)}
                              {changed && <span className="ml-1 text-amber-700 font-semibold">· muda</span>}
                            </p>
                          </div>
                        </div>
                        <div className={`grid gap-2 pl-7 ${isRetorno ? "grid-cols-3" : "grid-cols-1 sm:grid-cols-[8rem_1fr]"}`}>
                          {isRetorno ? (
                            <>
                              <label className="text-[11px] text-text-light">
                                Voltou
                                <input type="text" inputMode="decimal" value={r.returned} onChange={(e) => updateRow(r.key, { returned: e.target.value })} className={inputCls} />
                              </label>
                              <label className="text-[11px] text-text-light">
                                Avariado
                                <input type="text" inputMode="decimal" value={r.broken} onChange={(e) => updateRow(r.key, { broken: e.target.value })} className={inputCls} />
                              </label>
                              <label className="text-[11px] text-text-light">
                                Perdido
                                <input type="text" inputMode="decimal" value={r.lost} onChange={(e) => updateRow(r.key, { lost: e.target.value })} className={inputCls} />
                              </label>
                            </>
                          ) : (
                            <label className="text-[11px] text-text-light">
                              Vai
                              <input type="text" inputMode="decimal" value={r.quantity} onChange={(e) => updateRow(r.key, { quantity: e.target.value })} className={inputCls} />
                            </label>
                          )}
                          <label className={`text-[11px] text-text-light ${isRetorno ? "col-span-3" : ""}`}>
                            Obs.
                            <input type="text" value={r.note} onChange={(e) => updateRow(r.key, { note: e.target.value })} className={inputCls} />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {missingFromSheet.length > 0 && (
                <details className="text-xs text-text-light">
                  <summary className="cursor-pointer">
                    {missingFromSheet.length} item(ns) da lista não apareceram preenchidos na folha (ficam como estão)
                  </summary>
                  <p className="mt-1">{missingFromSheet.map((i) => i.name).join(", ")}</p>
                </details>
              )}
            </>
          )}
        </div>

        {/* Rodapé fixo — botões sempre à mão no celular */}
        <div className="border-t border-border px-4 sm:px-6 py-3 flex gap-2 justify-end shrink-0 pb-safe-4 sm:pb-3 bg-white sm:rounded-b-2xl">
          {stage === "camera" && (
            <>
              <button type="button" onClick={onClose} className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200">
                Cancelar
              </button>
              <button
                type="button"
                onClick={analyze}
                disabled={shots.length === 0}
                className="flex-1 sm:flex-none px-5 py-2.5 text-sm font-semibold rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-40"
              >
                ✨ Ler folha{shots.length > 0 ? ` (${shots.length})` : ""}
              </button>
            </>
          )}
          {stage === "review" && (
            <>
              <button type="button" onClick={() => setStage("camera")} disabled={applying} className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200">
                Fotos
              </button>
              <button
                type="button"
                onClick={handleApply}
                disabled={applying || included.length === 0}
                className="flex-1 sm:flex-none px-5 py-2.5 text-sm font-semibold rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-40"
              >
                {applying ? "Aplicando..." : `Aplicar ${included.length} item(ns)`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
