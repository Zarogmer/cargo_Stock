"use client";

import { useEffect, useRef, useState } from "react";
import { TrashIcon } from "@/components/icons";

// ─── Marca d'água ─────────────────────────────────────────────────────────────
// Aplica o logo oficial da Cargo Ships Cleaning como marca d'água em qualquer
// imagem selecionada. Tudo acontece no navegador via canvas — a foto não é
// enviada pra servidor nenhum e o arquivo original não muda (o resultado sai
// como cópia pra download). Ao selecionar (clique, arrastar ou Ctrl+V) a marca
// já é aplicada automaticamente; posição/tamanho/opacidade/cor são ajustáveis.

const LOGO_SRC = "/cargo-logo.png";

type Position =
  | "centro"
  | "inferior-direito"
  | "inferior-esquerdo"
  | "superior-direito"
  | "superior-esquerdo"
  | "mosaico";

const POSITIONS: { value: Position; label: string }[] = [
  { value: "centro", label: "Centro" },
  { value: "inferior-direito", label: "Inf. direito" },
  { value: "inferior-esquerdo", label: "Inf. esquerdo" },
  { value: "superior-direito", label: "Sup. direito" },
  { value: "superior-esquerdo", label: "Sup. esquerdo" },
  { value: "mosaico", label: "Mosaico" },
];

interface Settings {
  position: Position;
  sizePct: number; // largura do logo em % da largura da imagem
  opacity: number;
  white: boolean; // logo pintado de branco (lê melhor em fotos escuras)
}

const DEFAULT_SETTINGS: Settings = { position: "centro", sizePct: 50, opacity: 40, white: false };

interface SourceImage {
  img: HTMLImageElement;
  name: string;
  mime: string;
}

interface WatermarkItem {
  id: number;
  fileName: string;
  outName: string;
  outUrl: string;
  width: number;
  height: number;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Falha ao carregar imagem: ${src}`));
    img.src = src;
  });
}

export function WatermarkPanel() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [items, setItems] = useState<WatermarkItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [skipped, setSkipped] = useState<string[]>([]);

  // Originais decodificados ficam em ref (não em state) pra reprocessar rápido
  // quando qualquer configuração muda, sem re-ler os arquivos.
  const sourcesRef = useRef<Map<number, SourceImage>>(new Map());
  const nextIdRef = useRef(1);
  // Geração de processamento: se o usuário mexer nos controles no meio de um
  // processamento, o resultado atrasado é descartado em vez de sobrescrever.
  const genRef = useRef(0);
  const logoRef = useRef<Promise<HTMLImageElement> | null>(null);
  const whiteLogoRef = useRef<HTMLCanvasElement | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  function getLogo(): Promise<HTMLImageElement> {
    if (!logoRef.current) logoRef.current = loadImage(LOGO_SRC);
    return logoRef.current;
  }

  // Logo branco = mesmo desenho preenchido de branco (source-in preserva o alpha).
  function getWhiteLogo(logo: HTMLImageElement): HTMLCanvasElement {
    if (whiteLogoRef.current) return whiteLogoRef.current;
    const c = document.createElement("canvas");
    c.width = logo.naturalWidth;
    c.height = logo.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(logo, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    whiteLogoRef.current = c;
    return c;
  }

  async function renderOne(
    id: number,
    src: SourceImage,
    s: Settings,
    logo: HTMLImageElement,
  ): Promise<WatermarkItem> {
    const { img, name, mime } = src;
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);

    const mark: CanvasImageSource = s.white ? getWhiteLogo(logo) : logo;
    const lw = Math.max(24, (w * s.sizePct) / 100);
    const lh = lw * (logo.naturalHeight / logo.naturalWidth);
    ctx.globalAlpha = s.opacity / 100;

    if (s.position === "mosaico") {
      // Ladrilhos inclinados cobrindo a diagonal inteira (estilo "documento protegido").
      const stepX = lw * 1.6;
      const stepY = lh * 3;
      const half = Math.hypot(w, h) / 2;
      ctx.translate(w / 2, h / 2);
      ctx.rotate(-Math.PI / 6);
      let row = 0;
      for (let y = -half - lh; y < half + lh; y += stepY, row++) {
        const off = row % 2 === 0 ? 0 : stepX / 2;
        for (let x = -half - lw; x < half + lw; x += stepX) {
          ctx.drawImage(mark, x + off, y, lw, lh);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      const m = Math.round(Math.max(16, w * 0.02));
      let x = (w - lw) / 2;
      let y = (h - lh) / 2;
      if (s.position === "inferior-direito") {
        x = w - lw - m;
        y = h - lh - m;
      } else if (s.position === "inferior-esquerdo") {
        x = m;
        y = h - lh - m;
      } else if (s.position === "superior-direito") {
        x = w - lw - m;
        y = m;
      } else if (s.position === "superior-esquerdo") {
        x = m;
        y = m;
      }
      ctx.drawImage(mark, x, y, lw, lh);
    }
    ctx.globalAlpha = 1;

    // Foto JPEG continua JPEG; o resto sai PNG (preserva transparência).
    const outMime = mime === "image/jpeg" ? "image/jpeg" : "image/png";
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Falha ao gerar a imagem"))), outMime, 0.92),
    );
    const base = name.replace(/\.[^.]+$/, "");
    return {
      id,
      fileName: name,
      outName: `${base}-marca-dagua.${outMime === "image/jpeg" ? "jpg" : "png"}`,
      outUrl: URL.createObjectURL(blob),
      width: w,
      height: h,
    };
  }

  async function reprocessAll() {
    const gen = ++genRef.current;
    if (sourcesRef.current.size === 0) return;
    setBusy(true);
    try {
      const logo = await getLogo();
      const s = settingsRef.current;
      const results: WatermarkItem[] = [];
      for (const [id, src] of sourcesRef.current) {
        try {
          results.push(await renderOne(id, src, s, logo));
        } catch {
          // imagem que falhou no canvas fica de fora sem derrubar as demais
        }
      }
      if (gen !== genRef.current) {
        results.forEach((r) => URL.revokeObjectURL(r.outUrl));
        return;
      }
      setItems((prev) => {
        prev.forEach((p) => URL.revokeObjectURL(p.outUrl));
        return results;
      });
    } finally {
      if (gen === genRef.current) setBusy(false);
    }
  }

  async function addFiles(files: File[] | null | undefined) {
    if (!files || files.length === 0) return;
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    const errs = files.filter((f) => !f.type.startsWith("image/")).map((f) => f.name);
    setBusy(true);
    for (const f of imgs) {
      const url = URL.createObjectURL(f);
      try {
        const img = await loadImage(url);
        sourcesRef.current.set(nextIdRef.current++, { img, name: f.name || "imagem", mime: f.type });
      } catch {
        errs.push(f.name); // formato que o navegador não decodifica (ex.: HEIC)
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    setSkipped(errs);
    await reprocessAll();
  }

  // Ctrl+V cola imagem direto (print de tela, imagem copiada do WhatsApp etc.).
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (files && files.length > 0) addFilesRef.current(Array.from(files));
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // Mexeu em qualquer controle → reaplica em tudo (debounce leve pros sliders).
  useEffect(() => {
    const t = setTimeout(() => {
      reprocessAll();
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // Saiu da aba → libera os object URLs pra não vazar memória.
  useEffect(() => {
    return () => {
      genRef.current++;
      itemsRef.current.forEach((p) => URL.revokeObjectURL(p.outUrl));
    };
  }, []);

  function download(it: WatermarkItem) {
    const a = document.createElement("a");
    a.href = it.outUrl;
    a.download = it.outName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function downloadAll() {
    // Intervalo entre cliques — navegador bloqueia downloads simultâneos demais.
    items.forEach((it, i) => setTimeout(() => download(it), i * 400));
  }

  function removeItem(id: number) {
    sourcesRef.current.delete(id);
    setItems((prev) => {
      const gone = prev.find((p) => p.id === id);
      if (gone) URL.revokeObjectURL(gone.outUrl);
      return prev.filter((p) => p.id !== id);
    });
  }

  function clearAll() {
    genRef.current++;
    sourcesRef.current.clear();
    setItems((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.outUrl));
      return [];
    });
    setSkipped([]);
    setBusy(false);
  }

  const pillClass = (active: boolean) =>
    `px-3 py-1.5 rounded-lg border text-xs font-medium transition ${
      active
        ? "border-primary bg-primary/10 text-primary"
        : "border-border text-text-light hover:border-primary/50"
    }`;

  return (
    <div className="space-y-4">
      {/* Configurações */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm font-semibold text-text">Configurações da marca d&apos;água</p>
          <div className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={LOGO_SRC} alt="Logo Cargo Ships Cleaning" className="h-6" />
            <span className="text-xs text-text-light">logo oficial, aplicado automaticamente</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-text-light uppercase tracking-wider mb-2">
              Posição
            </label>
            <div className="flex flex-wrap gap-1.5">
              {POSITIONS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setSettings((s) => ({ ...s, position: p.value }))}
                  className={pillClass(settings.position === p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-text-light uppercase tracking-wider mb-2">
                Tamanho <span className="normal-case">({settings.sizePct}%)</span>
              </label>
              <input
                type="range"
                min={10}
                max={90}
                value={settings.sizePct}
                onChange={(e) => setSettings((s) => ({ ...s, sizePct: Number(e.target.value) }))}
                className="w-full accent-primary"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-text-light uppercase tracking-wider mb-2">
                Opacidade <span className="normal-case">({settings.opacity}%)</span>
              </label>
              <input
                type="range"
                min={10}
                max={100}
                value={settings.opacity}
                onChange={(e) => setSettings((s) => ({ ...s, opacity: Number(e.target.value) }))}
                className="w-full accent-primary"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-xs font-medium text-text-light uppercase tracking-wider mb-2">
                Cor do logo
              </label>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setSettings((s) => ({ ...s, white: false }))}
                  className={pillClass(!settings.white)}
                >
                  Original
                </button>
                <button
                  type="button"
                  onClick={() => setSettings((s) => ({ ...s, white: true }))}
                  className={pillClass(settings.white)}
                >
                  Branco
                </button>
                <span className="text-xs text-text-light ml-1">branco lê melhor em fotos escuras</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Seleção de imagens */}
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(Array.from(e.dataTransfer.files));
        }}
        className={`block bg-card rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition ${
          dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/60"
        }`}
      >
        <input
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : null;
            e.target.value = "";
            addFiles(files);
          }}
        />
        <p className="text-4xl mb-2">💧</p>
        <p className="text-sm font-medium text-text">Selecione ou arraste imagens aqui</p>
        <p className="text-xs text-text-light mt-1">
          A marca d&apos;água é aplicada na hora, direto no navegador — nada é enviado pra fora e a
          foto original não muda. Também dá pra colar com Ctrl+V.
        </p>
      </label>

      {skipped.length > 0 && (
        <p className="text-xs text-danger">
          Não deu pra ler: {skipped.join(", ")} (formato não suportado pelo navegador).
        </p>
      )}

      {items.length === 0 && busy && (
        <div className="bg-card rounded-xl border border-border p-8 text-center">
          <p className="text-sm text-text-light animate-pulse">Aplicando marca d&apos;água...</p>
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm text-text-light">
              {items.length} {items.length === 1 ? "imagem" : "imagens"}
              {busy && <span className="ml-2 animate-pulse">aplicando marca d&apos;água...</span>}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={clearAll}
                className="px-3 py-1.5 text-sm font-medium text-text-light hover:text-text transition"
              >
                Limpar
              </button>
              <button
                onClick={downloadAll}
                className="px-4 py-2 bg-primary text-white rounded-lg hover:bg-primary-dark transition text-sm font-medium shadow-sm"
              >
                {items.length > 1 ? `Baixar todas (${items.length})` : "Baixar"}
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((it) => (
              <div key={it.id} className="bg-card rounded-xl border border-border overflow-hidden">
                <div className="bg-gray-100 flex items-center justify-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={it.outUrl} alt={it.fileName} className="w-full h-52 object-contain" />
                </div>
                <div className="p-3 space-y-2">
                  <div>
                    <p className="text-sm font-medium text-text truncate" title={it.fileName}>
                      {it.fileName}
                    </p>
                    <p className="text-xs text-text-light">
                      {it.width} × {it.height}px
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => download(it)}
                      className="flex-1 px-3 py-1.5 bg-primary text-white rounded-lg hover:bg-primary-dark transition text-xs font-medium"
                    >
                      Baixar
                    </button>
                    <button
                      onClick={() => removeItem(it.id)}
                      title="Remover"
                      className="p-1.5 text-text-light hover:text-danger hover:bg-danger/10 rounded-lg transition"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
