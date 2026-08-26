// Geração dos PDFs dos Relatórios de Bordo NO SERVIDOR, com pdf-lib.
//
// Antes o relatório saía por uma janela de impressão do navegador (o usuário
// tinha que achar "Salvar como PDF"). Agora o servidor devolve o arquivo
// pronto e o navegador baixa — igual aos documentos do RH (Listagem, Recibo,
// Folha de Ponto). No celular o app oferece compartilhar; no desktop cai em
// Downloads; no app Electron abre o "Salvar como".
//
// O visual é o do Cargo Stock (azul #1e40af + slate + âmbar, títulos à
// esquerda, faixas claras com filete azul) — de propósito diferente do modelo
// navy+dourado de mercado que serviu de referência inicial de CONTEÚDO. O nome
// que assina segue sendo Cargo Ships Cleaning. Ao mexer aqui, mantenha essa
// distância visual.

import { readFile } from "fs/promises";
import path from "path";
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from "pdf-lib";
import {
  ActivityRow,
  EVAL_CRITERIA,
  EvaluationPrintRow,
  HoldRow,
  HOLD_STATUS_EN,
  PhotoMeta,
  REPORT_KINDS,
  ReportKindName,
  SectionMeta,
  bareVesselName,
  formatDayMonthYear,
  formatEtcDate,
  holdLabelEn,
  photoBlockKey,
  photoPlaceRank,
  stageEn,
} from "./report-format";

// ── Medidas e paleta ────────────────────────────────────────────────────────

const A4_W = 595.28;
const A4_H = 841.89;
const M = 28.35; // 10mm
const CONTENT_W = A4_W - M * 2;

const BRAND = rgb(0.118, 0.251, 0.686); // #1e40af
const BRAND_DK = rgb(0.118, 0.227, 0.541); // #1e3a8a
const INK = rgb(0.059, 0.09, 0.165); // #0f172a
const MUTED = rgb(0.392, 0.455, 0.545); // #64748b
const LINE = rgb(0.886, 0.91, 0.941); // #e2e8f0
const SOFT = rgb(0.945, 0.961, 0.976); // #f1f5f9
const AMBER = rgb(0.961, 0.62, 0.043); // #f59e0b
const GREEN = rgb(0.063, 0.725, 0.506);
const RED = rgb(0.706, 0.137, 0.094);
const WHITE = rgb(1, 1, 1);

// As fontes padrão do PDF são WinAnsi: acento passa, mas travessão/estrela/emoji
// não. Tudo que sai em texto passa por aqui. Exportado porque a Nota de
// Débito/Crédito (fiscal-note-pdf.ts) usa a mesma stack e o mesmo filtro.
export function safe(value: unknown): string {
  return String(value ?? "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

type TextOpts = {
  size?: number;
  bold?: boolean;
  color?: ReturnType<typeof rgb>;
};

class Doc {
  doc!: PDFDocument;
  font!: PDFFont;
  boldFont!: PDFFont;
  logo: PDFImage | null = null;
  page!: PDFPage;
  y = 0;

  static async create(): Promise<Doc> {
    const d = new Doc();
    d.doc = await PDFDocument.create();
    d.font = await d.doc.embedFont(StandardFonts.Helvetica);
    d.boldFont = await d.doc.embedFont(StandardFonts.HelveticaBold);
    try {
      const bytes = await readFile(path.join(process.cwd(), "public", "cargo-logo.png"));
      d.logo = await d.doc.embedPng(bytes);
    } catch {
      d.logo = null; // sem logo o relatório sai igual, só sem a marca
    }
    return d;
  }

  fontFor(bold?: boolean): PDFFont {
    return bold ? this.boldFont : this.font;
  }

  // Página nova já com a marca d'água da logo ao fundo.
  newPage(): PDFPage {
    const page = this.doc.addPage([A4_W, A4_H]);
    if (this.logo) {
      const w = A4_W * 0.62;
      const h = (w * this.logo.height) / this.logo.width;
      page.drawImage(this.logo, { x: (A4_W - w) / 2, y: (A4_H - h) / 2, width: w, height: h, opacity: 0.055 });
    }
    this.page = page;
    this.y = A4_H - M;
    return page;
  }

  width(text: string, o: TextOpts = {}): number {
    return this.fontFor(o.bold).widthOfTextAtSize(safe(text), o.size ?? 10);
  }

  text(text: string, x: number, y: number, o: TextOpts = {}) {
    this.page.drawText(safe(text), {
      x,
      y,
      size: o.size ?? 10,
      font: this.fontFor(o.bold),
      color: o.color ?? INK,
    });
  }

  textRight(text: string, right: number, y: number, o: TextOpts = {}) {
    this.text(text, right - this.width(text, o), y, o);
  }

  // Quebra o texto na largura dada (sem hifenizar — palavra maior que a linha
  // fica sozinha e estoura, caso raro em nome de porão/atividade).
  wrap(text: string, maxWidth: number, o: TextOpts = {}): string[] {
    const words = safe(text).split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (this.width(candidate, o) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  rect(x: number, y: number, w: number, h: number, color?: ReturnType<typeof rgb>, border?: ReturnType<typeof rgb>) {
    this.page.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      color,
      borderColor: border,
      borderWidth: border ? 0.7 : undefined,
    });
  }

  // Cabeçalho de marca — igual nos três relatórios. Devolve o y logo abaixo.
  brandHeader(subtitle: string): number {
    const top = A4_H - M;
    let x = M;
    if (this.logo) {
      const h = 22;
      const w = (h * this.logo.width) / this.logo.height;
      this.page.drawImage(this.logo, { x: M, y: top - h, width: w, height: h });
      x = M + w + 10;
    }
    this.text("CARGO SHIPS CLEANING", x, top - 10, { size: 12, bold: true, color: BRAND_DK });
    this.text(subtitle.toUpperCase(), x, top - 20.5, { size: 7.5, color: MUTED });
    const lineY = top - 29;
    this.rect(M, lineY, CONTENT_W, 2.5, BRAND);
    return lineY - 20;
  }

  // Título de seção: faixa clara com filete azul à esquerda.
  sectionBar(title: string, y: number): number {
    const h = 19;
    this.rect(M, y - h, CONTENT_W, h, SOFT);
    this.rect(M, y - h, 4, h, BRAND);
    this.text(title, M + 12, y - 13, { size: 9.5, bold: true, color: BRAND_DK });
    return y - h - 9;
  }

  footer(left: string, right: string) {
    this.rect(M, M + 16, CONTENT_W, 0.7, LINE);
    this.text(left, M, M + 6, { size: 8, color: MUTED });
    this.textRight(right, A4_W - M, M + 6, { size: 8, color: MUTED });
  }
}

// ── 1. Cleaning Report ──────────────────────────────────────────────────────

export async function buildCleaningReportPdf(opts: {
  vesselName: string;
  kind: ReportKindName;
  reportDate: string | null;
  port: string | null;
  complete: boolean;
  holds: HoldRow[];
  activities: ActivityRow[];
  remarks: string | null;
  etcDate: string | null;
  etcTime: string | null;
  supervisorName: string;
}): Promise<Uint8Array> {
  const isCostado = opts.kind === "COSTADO";
  const info = REPORT_KINDS[opts.kind];
  const dateStr = formatDayMonthYear(opts.reportDate);
  const d = await Doc.create();
  d.newPage();

  const footerLeft = `${opts.vesselName}${opts.port ? ` \xB7 ${opts.port}` : ""} \xB7 ${dateStr}`;
  const paginate = (needed: number) => {
    if (d.y - needed > M + 34) return;
    d.footer(footerLeft, "Cargo Ships Cleaning");
    d.newPage();
    d.y = d.brandHeader("Marine Operations");
  };

  d.y = d.brandHeader("Marine Operations");

  // Título
  d.text(isCostado ? "Costado (Hull Side) Cleaning Report" : `${info.titleEn} Report`, M, d.y - 17, {
    size: 19,
    bold: true,
  });
  d.rect(M, d.y - 27, 48, 3.5, AMBER);
  d.y -= 44;

  // Fichas do topo
  const chips: [string, string][] = [
    ["VESSEL NAME", opts.vesselName],
    ["DATE", dateStr],
    ["PORT / ANCHORAGE", opts.port || "-"],
    ["REPORT STATUS", opts.complete ? "Complete" : "In progress"],
  ];
  const chipW = (CONTENT_W - 3 * 6) / 4;
  chips.forEach(([label, value], i) => {
    const x = M + i * (chipW + 6);
    d.rect(x, d.y - 36, chipW, 36, SOFT);
    d.text(label, x + 9, d.y - 14, { size: 6.5, bold: true, color: MUTED });
    if (label === "REPORT STATUS") {
      const badge = value.toUpperCase();
      const w = d.width(badge, { size: 8, bold: true }) + 14;
      d.rect(x + 9, d.y - 31, w, 13, opts.complete ? GREEN : AMBER);
      d.text(badge, x + 16, d.y - 27.5, { size: 8, bold: true, color: WHITE });
    } else {
      d.text(value, x + 9, d.y - 28, { size: 10.5, bold: true });
    }
  });
  d.y -= 48;

  // 1. Status dos porões/áreas
  const areaCol = isCostado ? "AREA" : "CARGO HOLD";
  d.y = d.sectionBar(
    isCostado
      ? "1. OPERATIONAL STATUS OF HULL SIDE CLEANING"
      : `1. OPERATIONAL STATUS OF ${info.titleEn.replace(/^Cargo Hold /, "CARGO HOLDS ").toUpperCase()}`,
    d.y
  );

  // Raspagem e pintura não têm fase de água — a tabela sai com início/término.
  const hasPhases =
    info.waterPhases && opts.holds.some((h) => h.salt_start || h.salt_end || h.fresh_start || h.fresh_end);
  const range = (a: string | null, b: string | null) => (a || b ? `${a || "..."} - ${b || "..."}` : "-");
  const holdCols = [0.26, 0.16, 0.21, 0.21, 0.16].map((f) => f * CONTENT_W);
  const holdHead = hasPhases
    ? [areaCol, "STATUS", "SALT WATER WASH", "FRESH WATER RINSE", "COMPLETION %"]
    : [areaCol, "STATUS", "START TIME", "COMPLETION TIME", "COMPLETION %"];

  const drawRow = (cells: string[], cols: number[], y: number, o: { head?: boolean; center?: number[] } = {}) => {
    let x = M;
    cells.forEach((cell, i) => {
      const center = (o.center || []).includes(i);
      const opts2: TextOpts = o.head
        ? { size: 7, bold: true, color: MUTED }
        : { size: 9, color: i === cells.length - 1 ? BRAND_DK : INK, bold: i === cells.length - 1 };
      const w = d.width(cell, opts2);
      d.text(cell, center ? x + (cols[i] - w) / 2 : x + 4, y, opts2);
      x += cols[i];
    });
  };

  drawRow(holdHead, holdCols, d.y - 8, { head: true, center: [2, 3, 4] });
  d.rect(M, d.y - 13, CONTENT_W, 1.2, BRAND);
  d.y -= 15;

  if (opts.holds.length === 0) {
    d.text("No data.", M + 4, d.y - 12, { size: 9, color: MUTED });
    d.y -= 20;
  }
  for (const h of opts.holds) {
    paginate(24);
    const phases = hasPhases
      ? [range(h.salt_start, h.salt_end), range(h.fresh_start, h.fresh_end)]
      : [h.start_time || "-", h.end_time || "-"];
    // Linha sem fase mas com horário legado: o intervalo geral não pode sumir.
    if (hasPhases && !(h.salt_start || h.salt_end || h.fresh_start || h.fresh_end) && (h.start_time || h.end_time)) {
      phases[0] = `${range(h.start_time, h.end_time)} (overall)`;
      phases[1] = "";
    }
    drawRow([h.label, HOLD_STATUS_EN[h.status] || h.status, phases[0], phases[1], `${h.completion_pct}%`], holdCols, d.y - 12, {
      center: [2, 3, 4],
    });
    d.rect(M, d.y - 17, CONTENT_W, 0.7, LINE);
    d.y -= 19;
  }

  // 2. Atividades
  d.y -= 8;
  paginate(60);
  d.y = d.sectionBar("2. DAILY ACTIVITIES LOG", d.y);
  const actCols = [0.22, 0.58, 0.2].map((f) => f * CONTENT_W);
  drawRow(["TIME INTERVAL", "ACTIVITY", isCostado ? "AREA" : "HOLD"], actCols, d.y - 8, { head: true, center: [2] });
  d.rect(M, d.y - 13, CONTENT_W, 1.2, BRAND);
  d.y -= 15;

  if (opts.activities.length === 0) {
    d.text("No activities recorded.", M + 4, d.y - 12, { size: 9, color: MUTED });
    d.y -= 20;
  }
  for (const a of opts.activities) {
    const lines = d.wrap(a.activity, actCols[1] - 8, { size: 9 });
    paginate(14 + lines.length * 11);
    d.text(a.time_range || "-", M + 4, d.y - 12, { size: 9 });
    lines.forEach((l, i) => d.text(l, M + actCols[0] + 4, d.y - 12 - i * 11, { size: 9 }));
    const holdText = a.hold_label || "-";
    d.text(holdText, M + actCols[0] + actCols[1] + (actCols[2] - d.width(holdText, { size: 9 })) / 2, d.y - 12, { size: 9 });
    d.y -= 12 + lines.length * 11 - 5;
    d.rect(M, d.y, CONTENT_W, 0.7, LINE);
    d.y -= 7;
  }

  // 3. Observações
  d.y -= 8;
  const remarkLines = d.wrap(opts.remarks || "No remarks.", CONTENT_W - 24, { size: 9 });
  paginate(50 + remarkLines.length * 12);
  d.y = d.sectionBar("3. REMARKS", d.y);
  const boxH = Math.max(34, 16 + remarkLines.length * 12);
  d.rect(M, d.y - boxH, CONTENT_W, boxH, undefined, LINE);
  remarkLines.forEach((l, i) => d.text(l, M + 12, d.y - 16 - i * 12, { size: 9 }));
  d.y -= boxH + 14;

  // 4. ETC
  paginate(80);
  d.y = d.sectionBar("4. ESTIMATED TIME OF COMPLETION (ETC)", d.y);
  [["ETC DATE", formatEtcDate(opts.etcDate) || "-"], ["ETC TIME (LT)", opts.etcTime || "-"]].forEach(([label, value], i) => {
    const w = (CONTENT_W - 6) / 2;
    const x = M + i * (w + 6);
    d.rect(x, d.y - 34, w, 34, SOFT);
    d.text(label, x + 9, d.y - 13, { size: 6.5, bold: true, color: MUTED });
    d.text(value, x + 9, d.y - 27, { size: 10.5, bold: true });
  });
  d.y -= 48;

  // 5. Assinaturas
  paginate(90);
  d.y = d.sectionBar("5. SIGNATURES", d.y);
  const sigCols = [0.26, 0.3, 0.2, 0.24].map((f) => f * CONTENT_W);
  drawRow(["ROLE", "NAME", "DATE", "SIGNATURE"], sigCols, d.y - 8, { head: true });
  d.rect(M, d.y - 13, CONTENT_W, 1.2, BRAND);
  d.y -= 15;
  for (const row of [
    // "Cleaning Supervisor" / "Scraping Supervisor" / "Painting Supervisor".
    [`${info.stageEn.charAt(0)}${info.stageEn.slice(1).toLowerCase()} Supervisor`, opts.supervisorName, dateStr],
    ["", "", ""],
  ]) {
    drawRow([row[0], row[1], row[2], ""], sigCols, d.y - 14, {});
    // Linha pra assinar à mão
    d.rect(M + sigCols[0] + sigCols[1] + sigCols[2] + 4, d.y - 17, sigCols[3] - 12, 0.7, MUTED);
    d.rect(M, d.y - 24, CONTENT_W, 0.7, LINE);
    d.y -= 26;
  }

  d.footer(footerLeft, "Cargo Ships Cleaning");
  return d.doc.save();
}

// ── 2. Relatório Fotográfico ────────────────────────────────────────────────

export async function buildPhotoReportPdf(opts: {
  vesselName: string;
  kind: ReportKindName;
  reportDate: string | null;
  photos: (PhotoMeta & { image_data: string })[];
  sections: SectionMeta[];
}): Promise<Uint8Array> {
  const isCostado = opts.kind === "COSTADO";
  const info = REPORT_KINDS[opts.kind];
  const dateStr = formatDayMonthYear(opts.reportDate);
  const captionOf = new Map(opts.sections.map((s) => [s.label, (s.caption || "").trim()]));
  const orderOf = new Map(opts.sections.map((s) => [s.label, s.sort_order]));

  // Agrupa por bloco na ordem da operação; dentro do bloco, Antes/Durante/Depois.
  const stageOrder = ["ANTES", "DURANTE", "DEPOIS"];
  const groups = new Map<string, typeof opts.photos>();
  for (const p of opts.photos) {
    const key = photoBlockKey(p.hold_label);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  const groupKeys = [...groups.keys()].sort((a, b) => {
    const diff = photoPlaceRank(a, orderOf.get(a) ?? 0) - photoPlaceRank(b, orderOf.get(b) ?? 0);
    return diff !== 0 ? diff : a.localeCompare(b, "pt-BR", { numeric: true });
  });

  const d = await Doc.create();
  const bareVessel = bareVesselName(opts.vesselName).toUpperCase();
  const holdKeys = groupKeys.filter((k) => /por[aã]o/i.test(k));
  const inspected = isCostado ? groupKeys.filter((k) => k !== "Geral").length : holdKeys.length;

  // ── Capa ──
  d.newPage();
  let y = d.brandHeader("Marine Operations");
  y -= 90;
  d.text("PHOTOGRAPHIC REPORT", M, y, { size: 10, bold: true, color: BRAND });
  y -= 40;
  d.text(isCostado ? "Costado Cleaning" : info.titleEn, M, y, { size: 31, bold: true });
  y -= 34;
  d.text("Report", M, y, { size: 31, bold: true, color: BRAND });
  y -= 22;
  d.rect(M, y, 62, 4.5, AMBER);
  y -= 22;
  d.text(
    `Before, during and after ${info.stageEn.toLowerCase()} \xB7 operational sequence`,
    M,
    y,
    { size: 11, color: MUTED }
  );

  y -= 60;
  const rows: [string, string][] = [
    ["VESSEL", `M/V ${bareVessel}`],
    ["DATE", dateStr],
    [isCostado ? "AREAS INSPECTED" : "CARGO HOLDS INSPECTED", String(inspected)],
    ["PHOTOS", String(opts.photos.length)],
  ];
  const rowH = 34;
  const keyW = CONTENT_W * 0.42;
  d.rect(M, y - rows.length * rowH, CONTENT_W, rows.length * rowH, undefined, LINE);
  rows.forEach(([k, v], i) => {
    const top = y - i * rowH;
    d.rect(M, top - rowH, keyW, rowH, SOFT);
    d.text(k, M + 14, top - 21, { size: 8, bold: true, color: MUTED });
    d.text(v, M + keyW + 14, top - 22, { size: 13, bold: true });
    if (i > 0) d.rect(M, top, CONTENT_W, 0.7, LINE);
  });
  d.footer("Cargo Ships Cleaning \xB7 Marine Operations", dateStr);

  // ── Uma foto por página ──
  for (const key of groupKeys) {
    const items = groups.get(key)!;
    const buckets = [
      items.filter((p) => !stageOrder.includes(p.stage)),
      ...stageOrder.map((stage) => items.filter((p) => p.stage === stage)),
    ];
    const blockCaption = captionOf.get(key) || "";

    for (const stageItems of buckets) {
      for (let i = 0; i < stageItems.length; i++) {
        const p = stageItems[i];
        const image = await embedPhoto(d.doc, p.image_data);
        if (!image) continue; // formato que o PDF não aceita: pula a foto

        d.newPage();
        const top = A4_H - M;
        const bandH = blockCaption ? 44 : 32;
        d.rect(M, top - bandH, CONTENT_W, bandH, SOFT);
        d.rect(M, top - bandH, 4.5, bandH, BRAND);

        const title = holdLabelEn(p.hold_label, opts.kind);
        const titleY = top - (blockCaption ? 18 : 21);
        d.text(title, M + 14, titleY, { size: 13, bold: true });
        const stageLabel = stageEn(p.stage, opts.kind);
        if (stageLabel) {
          const x = M + 14 + d.width(title, { size: 13, bold: true });
          d.text(` \xB7 `, x, titleY, { size: 13, color: MUTED });
          d.text(stageLabel, x + d.width(" \xB7 ", { size: 13 }), titleY, { size: 13, bold: true, color: BRAND });
        }
        d.textRight(`${i + 1} / ${stageItems.length}`, A4_W - M - 12, titleY, { size: 9, bold: true, color: MUTED });
        if (blockCaption) {
          d.text(d.wrap(blockCaption, CONTENT_W - 40, { size: 9 })[0], M + 14, top - 33, { size: 9, color: MUTED });
        }

        // Foto centralizada no espaço entre cabeçalho e rodapé.
        const areaTop = top - bandH - 18;
        const areaBottom = M + 30;
        const availW = CONTENT_W;
        const availH = areaTop - areaBottom;
        const scale = Math.min(availW / image.width, availH / image.height);
        const w = image.width * scale;
        const h = image.height * scale;
        d.page.drawImage(image, {
          x: M + (availW - w) / 2,
          y: areaBottom + (availH - h) / 2,
          width: w,
          height: h,
        });

        d.footer(p.caption ? p.caption : `M/V ${bareVessel}`, dateStr);
      }
    }
  }

  if (groupKeys.length === 0) {
    d.newPage();
    d.brandHeader("Photographic Report");
    d.text("Nenhuma foto adicionada ainda.", M, A4_H - M - 70, { size: 11, color: MUTED });
  }

  return d.doc.save();
}

// Foto → imagem embutida. JPEG e PNG entram direto; webp (e qualquer coisa que
// o pdf-lib não leia) passa pelo canvas e vira JPEG.
async function embedPhoto(doc: PDFDocument, dataUrl: string): Promise<PDFImage | null> {
  const match = String(dataUrl || "").match(/^data:(image\/[a-z+]+);base64,(.+)$/);
  if (!match) return null;
  const bytes = Buffer.from(match[2], "base64");
  try {
    if (match[1] === "image/jpeg" || match[1] === "image/jpg") return await doc.embedJpg(bytes);
    if (match[1] === "image/png") return await doc.embedPng(bytes);
  } catch {
    // segue pra conversão
  }
  try {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(bytes);
    const canvas = createCanvas(img.width, img.height);
    canvas.getContext("2d").drawImage(img, 0, 0);
    return await doc.embedJpg(canvas.toBuffer("image/jpeg"));
  } catch {
    return null;
  }
}

// ── 3. Avaliação de Desempenho ──────────────────────────────────────────────

// Estrela em path SVG (caixa 24x24) — as fontes padrão do PDF não têm o
// caractere, então ela é desenhada.
const STAR_PATH =
  "M12 2 L15.09 8.26 L22 9.27 L17 14.14 L18.18 21.02 L12 17.77 L5.82 21.02 L7 14.14 L2 9.27 L8.91 8.26 Z";

export async function buildEvaluationPdf(opts: {
  vesselName: string;
  reportDate: string | null;
  rows: EvaluationPrintRow[];
}): Promise<Uint8Array> {
  const dateStr = formatDayMonthYear(opts.reportDate);
  const d = await Doc.create();
  d.newPage();
  d.y = d.brandHeader("Recursos Humanos");

  d.text("Avaliação de desempenho", M, d.y - 17, { size: 19, bold: true });
  d.rect(M, d.y - 27, 48, 3.5, AMBER);
  d.y -= 40;
  d.text(
    `Navio: ${opts.vesselName}  \xB7  Data: ${dateStr}  \xB7  ${opts.rows.length} colaborador(es) avaliado(s)`,
    M,
    d.y,
    { size: 9.5, color: MUTED }
  );
  d.y -= 20;

  const drawStars = (value: number, right: number, y: number) => {
    const size = 10.5;
    const gap = 2;
    const total = 5 * (size + gap);
    let x = right - total;
    for (let i = 1; i <= 5; i++) {
      const filled = i <= value;
      d.page.drawSvgPath(STAR_PATH, {
        x,
        y: y + size,
        scale: size / 24,
        color: filled ? AMBER : undefined,
        borderColor: filled ? undefined : LINE,
        borderWidth: filled ? undefined : 0.8,
      });
      x += size + gap;
    }
  };

  for (const r of opts.rows) {
    const rated = EVAL_CRITERIA.map((c) => ({ label: c.label, value: Number(r[c.key]) || 0 }));
    const withScore = rated.filter((c) => c.value > 0);
    const avg = withScore.length ? withScore.reduce((s, c) => s + c.value, 0) / withScore.length : 0;
    const weak = withScore.filter((c) => c.value <= 3);
    const commentLines = d.wrap(r.comments || "-", CONTENT_W - 44, { size: 9 });

    // Tem que bater com o desenho abaixo, senão a caixa de observações vaza pra
    // fora da borda do cartão.
    const obsH = Math.max(18, commentLines.length * 12 + 8);
    const cardH =
      34 + // cabeçalho (nome + média)
      rated.length * 15 +
      24 + // "Pontos a melhorar:"
      (weak.length || 1) * 12 +
      22 + // "Observações do supervisor:"
      obsH +
      12; // respiro embaixo

    if (d.y - cardH < M + 30) {
      d.footer(`${opts.vesselName} \xB7 ${dateStr}`, "Cargo Ships Cleaning");
      d.newPage();
      d.y = d.brandHeader("Recursos Humanos") - 4;
    }

    const cardTop = d.y;
    d.rect(M, cardTop - cardH, CONTENT_W, cardH, undefined, LINE);
    d.rect(M, cardTop - cardH, 3.5, cardH, BRAND);

    let y = cardTop - 18;
    d.text(r.name, M + 14, y, { size: 12.5, bold: true });
    const fnX = M + 14 + d.width(r.name, { size: 12.5, bold: true }) + 6;
    d.text(`- ${r.function_name || "Colaborador"}`, fnX, y, { size: 9, color: MUTED });
    d.textRight(`Média: ${avg ? avg.toFixed(1) : "-"}`, A4_W - M - 14, y, { size: 10.5, bold: true, color: BRAND });
    y -= 16;

    for (const c of rated) {
      d.text(c.label, M + 14, y - 8, { size: 9.5 });
      if (c.value > 0) {
        d.textRight(`(${c.value})`, A4_W - M - 14, y - 8, { size: 9, color: MUTED });
        drawStars(c.value, A4_W - M - 14 - d.width(`(${c.value})`, { size: 9 }) - 6, y - 9);
      } else {
        d.textRight("não avaliado", A4_W - M - 14, y - 8, { size: 9, color: MUTED });
      }
      d.rect(M + 14, y - 13, CONTENT_W - 28, 0.5, SOFT);
      y -= 15;
    }

    y -= 4;
    d.text("Pontos a melhorar:", M + 14, y - 8, { size: 9.5, bold: true, color: BRAND_DK });
    y -= 20;
    if (weak.length) {
      for (const c of weak) {
        d.text(`\xB7 ${c.label} (nota ${c.value})`, M + 20, y, { size: 9, color: RED });
        y -= 12;
      }
    } else {
      d.text("Nenhum ponto crítico - desempenho satisfatório em todos os critérios.", M + 20, y, {
        size: 9,
        color: rgb(0.016, 0.47, 0.341),
      });
      y -= 12;
    }

    y -= 4;
    d.text("Observações do supervisor:", M + 14, y - 8, { size: 9.5, bold: true, color: BRAND_DK });
    y -= 18;
    d.rect(M + 14, y - obsH, CONTENT_W - 28, obsH, SOFT);
    commentLines.forEach((l, i) => d.text(l, M + 20, y - 13 - i * 12, { size: 9 }));

    d.y = cardTop - cardH - 12;
  }

  if (opts.rows.length === 0) {
    d.text("Nenhuma avaliação preenchida ainda.", M, d.y - 10, { size: 10, color: MUTED });
  }

  d.footer(`${opts.vesselName} \xB7 ${dateStr}`, "Cargo Ships Cleaning");
  return d.doc.save();
}
