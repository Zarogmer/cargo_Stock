// OCR de PDF ESCANEADO (sem camada de texto) — fallback do import de Contas a
// Pagar. Renderiza as primeiras páginas em PNG (pdfjs + @napi-rs/canvas) e
// reconhece com tesseract.js (idioma "por").
//
// Saída no MESMO formato do extrator de texto (texto + itens posicionados em
// coordenadas de PDF, y crescendo pra cima), pra reaproveitar toda a lógica de
// nf-extract.ts (chave de acesso com DV, valor por posição, duplicatas...).
//
// ⚠️ OCR é estimativa: dígitos podem sair trocados. A chave de acesso (DV mod
// 11) e a linha digitável (DVs mod 10) validam sozinhas; o resto é sugestão
// revisável — o chamador marca o título como "lido por OCR, conferir".

import os from "node:os";
import path from "node:path";
import type { PdfItem } from "./pdf";

// Render acima do tamanho nativo (A4 a 72pt vira ~1785×2526 px) — escala 3 dá
// resolução suficiente pro tesseract sem estourar memória.
const RENDER_SCALE = 3;
const MAX_PAGES = 2; // DANFE e boleto têm tudo na 1ª página; 2 por segurança.
const MIN_WORD_CONFIDENCE = 30; // descarta ruído de scan (carimbo, dobra...)

export interface OcrResult {
  text: string;
  items: PdfItem[];
}

interface RenderedPage {
  png: Buffer;
  widthPx: number;
  heightPx: number;
}

async function renderPdfPages(buffer: Buffer): Promise<RenderedPage[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(buffer);
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  // Factory de canvas do próprio pdfjs (usa @napi-rs/canvas no Node).
  const factory = (doc as unknown as { canvasFactory: CanvasFactoryLike }).canvasFactory;
  const pages: RenderedPage[] = [];
  const n = Math.min(doc.numPages, MAX_PAGES);
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const { canvas, context } = factory.create(viewport.width, viewport.height);
    await page.render({ canvas: canvas as unknown as HTMLCanvasElement, viewport }).promise;
    pages.push({
      png: canvas.toBuffer("image/png"),
      widthPx: viewport.width,
      heightPx: viewport.height,
    });
    factory.destroy({ canvas, context });
  }
  await doc.cleanup();
  return pages;
}

interface CanvasFactoryLike {
  create(w: number, h: number): { canvas: CanvasLike; context: unknown };
  destroy(pair: { canvas: CanvasLike; context: unknown }): void;
}
interface CanvasLike {
  toBuffer(mime: "image/png"): Buffer;
}

// Worker do tesseract reutilizado entre requests (carregar o "por" custa
// segundos; o worker vive no processo do servidor).
type TesseractWorker = {
  recognize(
    image: Buffer,
    opts: Record<string, never>,
    output: { blocks: boolean },
  ): Promise<{ data: TesseractPage }>;
  terminate(): Promise<unknown>;
};
interface TesseractBbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface TesseractPage {
  text: string;
  blocks:
    | Array<{
        paragraphs: Array<{
          lines: Array<{
            words: Array<{ text: string; confidence: number; bbox: TesseractBbox }>;
          }>;
        }>;
      }>
    | null;
}

let workerPromise: Promise<TesseractWorker> | null = null;

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = await import("tesseract.js");
      // cachePath: onde o por.traineddata baixado fica (tmp sobrevive ao
      // processo no container; re-baixa só em deploy novo).
      return (await createWorker("por", 1, {
        cachePath: path.join(os.tmpdir()),
      })) as unknown as TesseractWorker;
    })();
    // Falhou (sem rede pro traineddata etc.)? Zera pra tentar de novo depois.
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

// OCR das primeiras páginas do PDF. Lança em erro de render/worker — o
// chamador (nf-extract) trata como "não deu pra ler".
export async function ocrPdf(buffer: Buffer): Promise<OcrResult> {
  const pages = await renderPdfPages(buffer);
  const worker = await getWorker();

  const parts: string[] = [];
  const items: PdfItem[] = [];
  for (let p = 0; p < pages.length; p++) {
    const { data } = await worker.recognize(pages[p].png, {}, { blocks: true });
    parts.push(data.text);
    const pageHeightPx = pages[p].heightPx;
    for (const block of data.blocks ?? []) {
      for (const par of block.paragraphs) {
        for (const line of par.lines) {
          for (const w of line.words) {
            const s = w.text.trim();
            if (!s || w.confidence < MIN_WORD_CONFIDENCE) continue;
            // px (y pra baixo, origem topo) → pontos de PDF (y pra cima,
            // origem base), mesma convenção dos itens do pdfjs. Usa y1
            // (base da palavra) ≈ baseline do texto.
            items.push({
              s,
              x: w.bbox.x0 / RENDER_SCALE,
              y: (pageHeightPx - w.bbox.y1) / RENDER_SCALE,
              page: p + 1,
            });
          }
        }
      }
    }
  }
  return { text: parts.join("\n"), items };
}
