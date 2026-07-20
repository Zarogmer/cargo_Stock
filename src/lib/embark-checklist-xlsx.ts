// Geração da "LISTA DE MATERIAIS EQUIPE" (Check List de embarque) em Excel, no
// mesmo layout da planilha oficial Check List.xlsx: cabeçalho Navio/Porto ×
// Equipe/Produto, tabela dupla Quant./Lista/Ida/Volta e assinaturas no rodapé.
// Mantido separado da rota (sem imports de servidor) pra poder ser reaproveitado
// pelo download (xlsx/pdf) e pelo envio automático no WhatsApp.
//
// Dois modos:
//   "embarque" — PREENCHIDO: navio, porto, equipe, produto e data já saem no
//                cabeçalho (é o documento que vai com a equipe pro navio).
//   "retorno"  — só a lista: cabeçalho em branco pra preencher à mão, itens e
//                quantidades padrão do kit (conferência de volta).
// Comida do Rancho (quando houver) sai numa segunda aba com o mesmo layout.
import * as XLSX from "xlsx-js-style";
import PizZip from "pizzip";
import { unitShort } from "./stock-units";

export interface ChecklistItem {
  name: string;
  qty: number;
  unit?: string | null;
}

export interface ChecklistInfo {
  mode: "embarque" | "retorno";
  shipName?: string | null;
  port?: string | null;
  teamLabel?: string | null; // "Equipe 1" etc.
  cargoType?: string | null; // Produto (carga do navio)
  dateIso?: string | null; // YYYY-MM-DD (data do embarque)
}

// ── Estilo (mesma paleta da Folha de Ponto) ────────────────────────────────────
const NAVY = "1F3864";
const GREY_HEAD = "D9D9D9";
const thin = { style: "thin", color: { rgb: "808080" } };
const borderAll = { top: thin, bottom: thin, left: thin, right: thin };
const F = "Calibri";
const COLS = 8; // A..H: Quant | Lista | Ida | Volta | Quant | Lista | Ida | Volta

function fmtDateBR(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

// "30" / "10 kg" — unidade só quando não for "un" (o template original mostra
// só o número; o "un" em tudo viraria ruído).
function qtyLabel(i: ChecklistItem): string {
  if (!Number.isFinite(i.qty) || i.qty <= 0) return "";
  const n = Number.isInteger(i.qty) ? String(i.qty) : String(i.qty).replace(".", ",");
  const u = unitShort(i.unit);
  return u && u !== "un" ? `${n} ${u}` : n;
}

// Constrói uma aba no layout do Check List (título + cabeçalho + tabela dupla).
function buildSheet(title: string, info: ChecklistInfo, items: ChecklistItem[]): XLSX.WorkSheet {
  const filled = info.mode === "embarque";
  const blankRow = () => Array(COLS).fill(null) as (string | number | null)[];
  const aoa: (string | number | null)[][] = [];

  // 0: empresa · 1: título · 2: branco · 3-5: cabeçalho Navio/Porto/Data ×
  // Equipe/Produto · 6: branco · 7: cabeçalho da tabela · 8+: itens
  aoa.push(["CARGO SHIPS CLEANING", ...Array(COLS - 1).fill(null)]);
  aoa.push([title, ...Array(COLS - 1).fill(null)]);
  aoa.push(blankRow());

  const info1 = blankRow();
  info1[0] = "Navio";
  info1[1] = filled ? (info.shipName || "").toUpperCase() : "";
  info1[4] = "Equipe";
  info1[5] = filled ? info.teamLabel || "" : "";
  aoa.push(info1);

  const info2 = blankRow();
  info2[0] = "Porto";
  info2[1] = filled ? (info.port || "").toUpperCase() : "";
  info2[4] = "Produto";
  info2[5] = filled ? (info.cargoType || "").toUpperCase() : "";
  aoa.push(info2);

  const info3 = blankRow();
  info3[0] = "Data";
  info3[1] = filled ? fmtDateBR(info.dateIso) : "";
  aoa.push(info3);

  aoa.push(blankRow());

  const headRow = blankRow();
  ["Quant.", "Lista", "Ida", "Volta", "Quant.", "Lista", "Ida", "Volta"].forEach((h, i) => (headRow[i] = h));
  aoa.push(headRow);
  const HEAD_ROW = aoa.length - 1;

  // Itens em duas colunas, como no papel: metade esquerda, metade direita.
  const leftCount = Math.ceil(items.length / 2);
  for (let i = 0; i < leftCount; i++) {
    const row = blankRow();
    const l = items[i];
    row[0] = qtyLabel(l);
    row[1] = l.name;
    const r = items[leftCount + i];
    if (r) {
      row[4] = qtyLabel(r);
      row[5] = r.name;
    }
    aoa.push(row);
  }
  const LAST_ITEM_ROW = aoa.length - 1;

  // Rodapé: linhas de assinatura Maquinista / Supervisor (como no original).
  aoa.push(blankRow());
  aoa.push(blankRow());
  const signRow = blankRow();
  signRow[0] = "_______________________________";
  signRow[4] = "_______________________________";
  aoa.push(signRow);
  const SIGN_ROW = aoa.length - 1;
  const signLabel = blankRow();
  signLabel[0] = "Maquinista";
  signLabel[4] = "Supervisor";
  aoa.push(signLabel);
  const SIGN_LABEL_ROW = aoa.length - 1;

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const set = (r: number, c: number, s: Record<string, unknown>) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    // Célula vazia também precisa existir pra receber borda (caixas de Ida/Volta).
    if (!ws[addr]) ws[addr] = { t: "s", v: "" };
    (ws[addr] as { s?: unknown }).s = s;
  };

  set(0, 0, { font: { name: F, sz: 16, bold: true, color: { rgb: NAVY } }, alignment: { horizontal: "center", vertical: "center" } });
  // A borda do título precisa estar em TODAS as células do merge — senão o
  // Excel/LibreOffice desenha a caixa só em volta da primeira célula.
  for (let c = 0; c < COLS; c++) {
    set(1, c, { font: { name: F, sz: 12, bold: true }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll });
  }

  // Cabeçalho Navio/Porto/Data × Equipe/Produto: rótulo cinza + caixa de valor.
  const labelStyle = { font: { name: F, sz: 10, bold: true }, fill: { patternType: "solid", fgColor: { rgb: GREY_HEAD } }, alignment: { horizontal: "left", vertical: "center" }, border: borderAll };
  const valueStyle = { font: { name: F, sz: 10, bold: true, color: { rgb: NAVY } }, alignment: { horizontal: "left", vertical: "center" }, border: borderAll };
  for (const r of [3, 4, 5]) {
    set(r, 0, labelStyle);
    for (let c = 1; c <= 3; c++) set(r, c, valueStyle);
    if (r !== 5) {
      set(r, 4, labelStyle);
      for (let c = 5; c <= 7; c++) set(r, c, valueStyle);
    }
  }

  const headStyle = { font: { name: F, sz: 10, bold: true, color: { rgb: NAVY } }, fill: { patternType: "solid", fgColor: { rgb: GREY_HEAD } }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll };
  for (let c = 0; c < COLS; c++) set(HEAD_ROW, c, headStyle);

  // Linhas de item: quantidade centrada, nome à esquerda, Ida/Volta em branco
  // pra marcar à mão (caixinhas com borda).
  for (let r = HEAD_ROW + 1; r <= LAST_ITEM_ROW; r++) {
    for (const base of [0, 4]) {
      set(r, base, { font: { name: F, sz: 10 }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll });
      set(r, base + 1, { font: { name: F, sz: 10 }, alignment: { horizontal: "left", vertical: "center" }, border: borderAll });
      set(r, base + 2, { border: borderAll });
      set(r, base + 3, { border: borderAll });
    }
  }

  const signStyle = { font: { name: F, sz: 10 }, alignment: { horizontal: "center", vertical: "center" } };
  set(SIGN_ROW, 0, signStyle);
  set(SIGN_ROW, 4, signStyle);
  set(SIGN_LABEL_ROW, 0, { font: { name: F, sz: 10, bold: true }, alignment: { horizontal: "center", vertical: "center" } });
  set(SIGN_LABEL_ROW, 4, { font: { name: F, sz: 10, bold: true }, alignment: { horizontal: "center", vertical: "center" } });

  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: COLS - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: COLS - 1 } },
    { s: { r: 3, c: 1 }, e: { r: 3, c: 3 } },
    { s: { r: 3, c: 5 }, e: { r: 3, c: 7 } },
    { s: { r: 4, c: 1 }, e: { r: 4, c: 3 } },
    { s: { r: 4, c: 5 }, e: { r: 4, c: 7 } },
    { s: { r: 5, c: 1 }, e: { r: 5, c: 3 } },
    { s: { r: SIGN_ROW, c: 0 }, e: { r: SIGN_ROW, c: 3 } },
    { s: { r: SIGN_ROW, c: 4 }, e: { r: SIGN_ROW, c: 7 } },
    { s: { r: SIGN_LABEL_ROW, c: 0 }, e: { r: SIGN_LABEL_ROW, c: 3 } },
    { s: { r: SIGN_LABEL_ROW, c: 4 }, e: { r: SIGN_LABEL_ROW, c: 7 } },
  ];
  ws["!cols"] = [
    { wch: 8 }, { wch: 24 }, { wch: 6 }, { wch: 6 },
    { wch: 8 }, { wch: 24 }, { wch: 6 }, { wch: 6 },
  ];
  const rows: ({ hpt: number } | undefined)[] = [];
  rows[0] = { hpt: 24 };
  rows[1] = { hpt: 20 };
  rows[HEAD_ROW] = { hpt: 18 };
  ws["!rows"] = rows as { hpt: number }[];
  ws["!margins"] = { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 };

  return ws;
}

// Injeta page setup retrato + ajustar à largura em cada aba (o xlsx-js-style não
// escreve <pageSetup>; sem isso o PDF do LibreOffice sai desalinhado).
function injectPageSetup(buf: Buffer): Buffer {
  const zip = new PizZip(buf);
  const files = zip.file(/xl\/worksheets\/sheet\d+\.xml$/);
  const pageSetup = `<pageSetup orientation="portrait" fitToWidth="1" fitToHeight="0" horizontalDpi="300" verticalDpi="300"/>`;
  for (const f of files) {
    let xml = f.asText();
    if (!xml.includes("<pageSetUpPr")) {
      xml = xml.replace(/(<worksheet[^>]*>)/, `$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>`);
    }
    if (/<pageMargins[^>]*\/>/.test(xml)) {
      xml = xml.replace(/(<pageMargins[^>]*\/>)/, `$1${pageSetup}`);
    } else {
      xml = xml.replace(/(<\/worksheet>)/, `${pageSetup}$1`);
    }
    zip.file(f.name, xml);
  }
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

// Workbook completo: aba "Materiais" (layout do Check List) e, se houver comida
// do Rancho, uma aba "Rancho" com o mesmo formato.
export function buildEmbarkChecklistXlsx(
  info: ChecklistInfo,
  materials: ChecklistItem[],
  rancho: ChecklistItem[] = [],
): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildSheet("LISTA DE MATERIAIS EQUIPE", info, materials), "Materiais");
  if (rancho.length > 0) {
    XLSX.utils.book_append_sheet(wb, buildSheet("LISTA DE RANCHO (COMIDA)", info, rancho), "Rancho");
  }
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return injectPageSetup(buf);
}

// Nome de arquivo do documento gerado (sem caracteres proibidos no Windows).
export function checklistFileName(info: ChecklistInfo, ext: "xlsx" | "pdf"): string {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "").trim();
  if (info.mode === "retorno") {
    const ship = info.shipName ? ` - ${safe(info.shipName)}` : "";
    return `Lista de Materiais (Retorno)${ship}.${ext}`;
  }
  const ship = info.shipName ? ` - ${safe(info.shipName)}` : "";
  const team = info.teamLabel ? ` (${safe(info.teamLabel)})` : "";
  return `Lista de Materiais${ship}${team}.${ext}`;
}
