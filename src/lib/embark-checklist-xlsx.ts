// Geração da "LISTA DE MATERIAIS EQUIPE" (Check List de embarque) em Excel,
// inspirada na "Relação de Material" oficial da Cargo: papel timbrado (logo +
// endereço), cabeçalho Navio/Porto × Equipe/Produto e tabela dupla Quant./Lista.
// Mantido separado da rota (sem imports de servidor) pra poder ser reaproveitado
// pelo download (xlsx/pdf) e pelo envio automático no WhatsApp.
//
// Dois modos:
//   "embarque" — PREENCHIDO: navio, porto, equipe, produto e data já saem no
//                cabeçalho (é o documento que vai com a equipe pro navio).
//                Sem colunas Ida/Volta — é só o que está indo.
//   "retorno"  — só a lista: cabeçalho em branco pra preencher à mão, itens e
//                quantidades padrão do kit (conferência de volta). Mantém as
//                caixinhas Ida/Volta pra marcar no papel.
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

// Endereço do papel timbrado oficial (o mesmo do template da Petição).
const LETTERHEAD =
  "Rua: PRAÇA IGUATEMI MARTINS nº 08, Vila Nova\n" +
  "Santos /SP – Cep: 11013-310\n" +
  "Tel.: (13) 3385-8481 - (13) 98816-2379\n" +
  "E-mail.: cargoships@cargoships.com.br\n" +
  "CNPJ: 41.560.212/0002 – 91";

function fmtDateBR(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

// "30" / "10 kg" — nos materiais a unidade só aparece quando não for "un" (o
// "un" em tudo viraria ruído). No Rancho vai SEMPRE que existir no cadastro
// ("10 un", "30 L", "5 kg"), pra ninguém adivinhar se é quilo ou unidade.
function qtyLabel(i: ChecklistItem, unitAlways: boolean): string {
  if (!Number.isFinite(i.qty) || i.qty <= 0) return "";
  const n = Number.isInteger(i.qty) ? String(i.qty) : String(i.qty).replace(".", ",");
  const u = unitShort(i.unit);
  if (!u) return n;
  return unitAlways || u !== "un" ? `${n} ${u}` : n;
}

interface SheetOpts {
  idaVolta: boolean; // true = mantém as caixinhas Ida/Volta (modo retorno)
  unitAlways: boolean; // true = unidade sempre junto da quantidade (Rancho)
}

// Constrói uma aba no layout da Relação (timbrado + título + cabeçalho + tabela dupla).
function buildSheet(title: string, info: ChecklistInfo, items: ChecklistItem[], opts: SheetOpts): XLSX.WorkSheet {
  const filled = info.mode === "embarque";
  const pair = opts.idaVolta ? 4 : 2; // colunas por metade: Quant, Lista [, Ida, Volta]
  const COLS = pair * 2;
  const R = pair; // primeira coluna da metade direita
  const blankRow = () => Array(COLS).fill(null) as (string | number | null)[];
  const aoa: (string | number | null)[][] = [];

  // 0-2: papel timbrado — a logo entra como imagem (injectLogo) na esquerda e o
  // endereço fica à direita · depois: título · branco · cabeçalho Navio/Porto/
  // Data × Equipe/Produto · branco · cabeçalho da tabela · itens
  const lhRow = blankRow();
  lhRow[R] = LETTERHEAD;
  aoa.push(lhRow);
  aoa.push(blankRow());
  aoa.push(blankRow());

  const titleRow = blankRow();
  titleRow[0] = title;
  aoa.push(titleRow);
  const TITLE_ROW = aoa.length - 1;

  aoa.push(blankRow());

  const info1 = blankRow();
  info1[0] = "Navio";
  info1[1] = filled ? (info.shipName || "").toUpperCase() : "";
  info1[R] = "Equipe";
  info1[R + 1] = filled ? info.teamLabel || "" : "";
  aoa.push(info1);
  const INFO_ROW = aoa.length - 1;

  const info2 = blankRow();
  info2[0] = "Porto";
  info2[1] = filled ? (info.port || "").toUpperCase() : "";
  info2[R] = "Produto";
  info2[R + 1] = filled ? (info.cargoType || "").toUpperCase() : "";
  aoa.push(info2);

  const info3 = blankRow();
  info3[0] = "Data";
  info3[1] = filled ? fmtDateBR(info.dateIso) : "";
  aoa.push(info3);

  aoa.push(blankRow());

  const headRow = blankRow();
  const heads = opts.idaVolta ? ["Quant.", "Lista", "Ida", "Volta"] : ["Quant.", "Lista"];
  [...heads, ...heads].forEach((h, i) => (headRow[i] = h));
  aoa.push(headRow);
  const HEAD_ROW = aoa.length - 1;

  // Itens em duas colunas, como no papel: metade esquerda, metade direita.
  const leftCount = Math.ceil(items.length / 2);
  for (let i = 0; i < leftCount; i++) {
    const row = blankRow();
    const l = items[i];
    row[0] = qtyLabel(l, opts.unitAlways);
    row[1] = l.name;
    const r = items[leftCount + i];
    if (r) {
      row[R] = qtyLabel(r, opts.unitAlways);
      row[R + 1] = r.name;
    }
    aoa.push(row);
  }
  const LAST_ITEM_ROW = aoa.length - 1;

  // Rodapé: linhas de assinatura Maquinista / Supervisor (como no original).
  aoa.push(blankRow());
  aoa.push(blankRow());
  const signRow = blankRow();
  signRow[0] = "_______________________________";
  signRow[R] = "_______________________________";
  aoa.push(signRow);
  const SIGN_ROW = aoa.length - 1;
  const signLabel = blankRow();
  signLabel[0] = "Maquinista";
  signLabel[R] = "Supervisor";
  aoa.push(signLabel);
  const SIGN_LABEL_ROW = aoa.length - 1;

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const set = (r: number, c: number, s: Record<string, unknown>) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    // Célula vazia também precisa existir pra receber borda/estilo.
    if (!ws[addr]) ws[addr] = { t: "s", v: "" };
    (ws[addr] as { s?: unknown }).s = s;
  };

  // Endereço do timbrado: fonte pequena, alinhado com a logo.
  set(0, R, {
    font: { name: F, sz: 8 },
    alignment: { horizontal: "left", vertical: "center", wrapText: true },
  });

  // Título em caixa (borda em TODAS as células do merge — senão o
  // Excel/LibreOffice desenha a caixa só em volta da primeira célula).
  for (let c = 0; c < COLS; c++) {
    set(TITLE_ROW, c, { font: { name: F, sz: 12, bold: true }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll });
  }

  // Cabeçalho Navio/Porto/Data × Equipe/Produto: rótulo cinza + caixa de valor.
  const labelStyle = { font: { name: F, sz: 10, bold: true }, fill: { patternType: "solid", fgColor: { rgb: GREY_HEAD } }, alignment: { horizontal: "left", vertical: "center" }, border: borderAll };
  const valueStyle = { font: { name: F, sz: 10, bold: true, color: { rgb: NAVY } }, alignment: { horizontal: "left", vertical: "center" }, border: borderAll };
  for (const r of [INFO_ROW, INFO_ROW + 1, INFO_ROW + 2]) {
    set(r, 0, labelStyle);
    for (let c = 1; c < R; c++) set(r, c, valueStyle);
    if (r !== INFO_ROW + 2) {
      set(r, R, labelStyle);
      for (let c = R + 1; c < COLS; c++) set(r, c, valueStyle);
    }
  }

  const headStyle = { font: { name: F, sz: 10, bold: true, color: { rgb: NAVY } }, fill: { patternType: "solid", fgColor: { rgb: GREY_HEAD } }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll };
  for (let c = 0; c < COLS; c++) set(HEAD_ROW, c, headStyle);

  // Linhas de item: quantidade centrada, nome à esquerda; no modo retorno as
  // caixinhas de Ida/Volta ficam em branco pra marcar à mão.
  for (let r = HEAD_ROW + 1; r <= LAST_ITEM_ROW; r++) {
    for (const base of [0, R]) {
      set(r, base, { font: { name: F, sz: 10 }, alignment: { horizontal: "center", vertical: "center" }, border: borderAll });
      set(r, base + 1, { font: { name: F, sz: 10 }, alignment: { horizontal: "left", vertical: "center" }, border: borderAll });
      if (opts.idaVolta) {
        set(r, base + 2, { border: borderAll });
        set(r, base + 3, { border: borderAll });
      }
    }
  }

  const signStyle = { font: { name: F, sz: 10 }, alignment: { horizontal: "center", vertical: "center" } };
  set(SIGN_ROW, 0, signStyle);
  set(SIGN_ROW, R, signStyle);
  set(SIGN_LABEL_ROW, 0, { font: { name: F, sz: 10, bold: true }, alignment: { horizontal: "center", vertical: "center" } });
  set(SIGN_LABEL_ROW, R, { font: { name: F, sz: 10, bold: true }, alignment: { horizontal: "center", vertical: "center" } });

  const merges = [
    // Endereço do timbrado ocupa a metade direita das 3 primeiras linhas.
    { s: { r: 0, c: R }, e: { r: 2, c: COLS - 1 } },
    { s: { r: TITLE_ROW, c: 0 }, e: { r: TITLE_ROW, c: COLS - 1 } },
    { s: { r: SIGN_ROW, c: 0 }, e: { r: SIGN_ROW, c: R - 1 } },
    { s: { r: SIGN_ROW, c: R }, e: { r: SIGN_ROW, c: COLS - 1 } },
    { s: { r: SIGN_LABEL_ROW, c: 0 }, e: { r: SIGN_LABEL_ROW, c: R - 1 } },
    { s: { r: SIGN_LABEL_ROW, c: R }, e: { r: SIGN_LABEL_ROW, c: COLS - 1 } },
  ];
  if (pair > 2) {
    // Valores do cabeçalho ocupam o resto da metade (só faz sentido com Ida/Volta).
    for (const r of [INFO_ROW, INFO_ROW + 1]) {
      merges.push({ s: { r, c: 1 }, e: { r, c: R - 1 } });
      merges.push({ s: { r, c: R + 1 }, e: { r, c: COLS - 1 } });
    }
    merges.push({ s: { r: INFO_ROW + 2, c: 1 }, e: { r: INFO_ROW + 2, c: R - 1 } });
  }
  ws["!merges"] = merges;

  ws["!cols"] = opts.idaVolta
    ? [
        { wch: 8 }, { wch: 24 }, { wch: 6 }, { wch: 6 },
        { wch: 8 }, { wch: 24 }, { wch: 6 }, { wch: 6 },
      ]
    : [{ wch: 9 }, { wch: 36 }, { wch: 9 }, { wch: 36 }];
  const rows: ({ hpt: number } | undefined)[] = [];
  // Zona do timbrado (a logo flutua sobre essas 3 linhas).
  rows[0] = { hpt: 18 };
  rows[1] = { hpt: 18 };
  rows[2] = { hpt: 18 };
  rows[TITLE_ROW] = { hpt: 20 };
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

// Injeta a logo da Cargo (PNG) no canto superior esquerdo de cada aba, via
// drawingML (o xlsx-js-style não sabe escrever imagem). O LibreOffice renderiza
// a âncora no PDF igual ao Excel.
const LOGO_CX = 2016000; // ~5,6 cm (EMU)
const LOGO_CY = 525000; // proporção do cargo-logo.png (541×141)

function injectLogo(buf: Buffer, png: Buffer): Buffer {
  const zip = new PizZip(buf);
  const sheets = zip.file(/xl\/worksheets\/sheet\d+\.xml$/);
  if (sheets.length === 0) return buf;

  zip.file("xl/media/image1.png", png);

  let overrides = "";
  sheets.forEach((sheet, idx) => {
    const n = idx + 1;
    const drawingXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<xdr:oneCellAnchor>` +
      `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>76200</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>38100</xdr:rowOff></xdr:from>` +
      `<xdr:ext cx="${LOGO_CX}" cy="${LOGO_CY}"/>` +
      `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="Logo Cargo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
      `<xdr:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
      `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${LOGO_CX}" cy="${LOGO_CY}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
      `</xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`;
    zip.file(`xl/drawings/drawing${n}.xml`, drawingXml);
    zip.file(
      `xl/drawings/_rels/drawing${n}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>` +
        `</Relationships>`,
    );

    const sheetBase = sheet.name.replace("xl/worksheets/", "");
    zip.file(
      `xl/worksheets/_rels/${sheetBase}.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdLogo" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${n}.xml"/>` +
        `</Relationships>`,
    );

    let xml = sheet.asText();
    const rootStart = xml.indexOf("<worksheet");
    const rootTag = rootStart >= 0 ? xml.slice(rootStart, xml.indexOf(">", rootStart)) : "";
    if (rootTag && !rootTag.includes("xmlns:r=")) {
      xml = xml.replace(
        /<worksheet /,
        `<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" `,
      );
    }
    xml = xml.replace("</worksheet>", `<drawing r:id="rIdLogo"/></worksheet>`);
    zip.file(sheet.name, xml);

    overrides += `<Override PartName="/xl/drawings/drawing${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`;
  });

  const ctFile = zip.file("[Content_Types].xml");
  if (ctFile) {
    let ct = ctFile.asText();
    if (!ct.includes('Extension="png"')) {
      ct = ct.replace("</Types>", `<Default Extension="png" ContentType="image/png"/></Types>`);
    }
    ct = ct.replace("</Types>", `${overrides}</Types>`);
    zip.file("[Content_Types].xml", ct);
  }

  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}

// Workbook completo: aba "Materiais" e, se houver comida do Rancho, uma aba
// "Rancho" com o mesmo formato (unidade sempre visível). `logoPng` (opcional)
// é o cargo-logo.png lido pela rota — sem ele o documento sai sem a logo.
export function buildEmbarkChecklistXlsx(
  info: ChecklistInfo,
  materials: ChecklistItem[],
  rancho: ChecklistItem[] = [],
  logoPng?: Buffer | null,
): Buffer {
  const idaVolta = info.mode === "retorno";
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    buildSheet("LISTA DE MATERIAIS EQUIPE", info, materials, { idaVolta, unitAlways: false }),
    "Materiais",
  );
  if (rancho.length > 0) {
    XLSX.utils.book_append_sheet(
      wb,
      buildSheet("LISTA DE RANCHO (COMIDA)", info, rancho, { idaVolta, unitAlways: true }),
      "Rancho",
    );
  }
  let buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  buf = injectPageSetup(buf);
  if (logoPng && logoPng.length > 0) buf = injectLogo(buf, logoPng);
  return buf;
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
