// Geração da "Listagem de Embarque" (RH > Documentos > Listagem) — a lista de
// funcionários que embarcam, no layout com o logo da Cargo e uma tabela única.
// Duas variantes pela coluna de identificação: SANTOS usa ISPS CODE (exigência
// dos terminais de Santos) e FORA usa RG. Os dados (CPF, RG/ISPS, nascimento)
// vêm da aba Colaboradores — aqui só montamos o documento.
//
// Construído com a lib `docx` (não a partir de template) para ter controle das
// centralizações e larguras de coluna; depois a rota converte para PDF via
// LibreOffice (docxToPdf).
import { promises as fs } from "fs";
import path from "path";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  VerticalAlign,
  WidthType,
  BorderStyle,
  TableLayoutType,
} from "docx";

export type ListagemVariant = "SANTOS" | "FORA";

export interface ListagemEmployee {
  name: string;
  cpf: string | null;
  rg: string | null;
  isps_code: string | null;
  birth_date: string | null;
}

// Azul da marca (cabeçalho da tabela) e cinza das bordas.
const BRAND_BLUE = "2E5496";
const BORDER_GREY = "BFBFBF";
const FONT = "Arial";

// Logo 541x141 (proporção 3.837). Largura fixa em pt; altura derivada.
const LOGO_RATIO = 541 / 141;
const LOGO_WIDTH = 230;
const LOGO_HEIGHT = Math.round(LOGO_WIDTH / LOGO_RATIO);

// Larguras das colunas em twips (A4 retrato, margens de 1"): ~9020 úteis.
// Nome largo; CPF / identificação / nascimento centralizados.
const COL_WIDTHS = [4150, 1800, 1440, 1630];

// "yyyy-mm-dd..." -> "dd/mm/yyyy" (mantém vazio se não parsear).
function isoToBr(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = String(iso).slice(0, 10);
  const [y, m, d] = s.split("-");
  if (!y || !m || !d) return "";
  return `${d}/${m}/${y}`;
}

// Dígitos -> "366.434.208-90"; mantém o valor original se não tiver 11 dígitos.
function formatCpf(raw: string | null | undefined): string {
  const digits = (raw || "").replace(/\D/g, "").slice(0, 11);
  if (digits.length !== 11) return (raw || "").trim();
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: BORDER_GREY };
const CELL_BORDERS = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

function headerCell(text: string, colIdx: number): TableCell {
  return new TableCell({
    width: { size: COL_WIDTHS[colIdx], type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    shading: { fill: BRAND_BLUE, color: "auto", type: "clear" },
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    borders: CELL_BORDERS,
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text, bold: true, color: "FFFFFF", font: FONT, size: 21 })],
      }),
    ],
  });
}

function dataCell(text: string, colIdx: number, align: (typeof AlignmentType)[keyof typeof AlignmentType]): TableCell {
  return new TableCell({
    width: { size: COL_WIDTHS[colIdx], type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 40, bottom: 40, left: 90, right: 90 },
    borders: CELL_BORDERS,
    children: [
      new Paragraph({
        alignment: align,
        children: [new TextRun({ text, font: FONT, size: 20 })],
      }),
    ],
  });
}

export async function buildListagemDocx(
  employees: ListagemEmployee[],
  variant: ListagemVariant,
): Promise<Buffer> {
  const logoBuf = await fs.readFile(path.join(process.cwd(), "public", "cargo-logo.png"));

  const idHeader = variant === "SANTOS" ? "ISPS CODE" : "RG";
  const idValue = (e: ListagemEmployee) =>
    ((variant === "SANTOS" ? e.isps_code : e.rg) || "").trim();

  const ordered = [...employees].sort((a, b) =>
    a.name.localeCompare(b.name, "pt-BR"),
  );

  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      headerCell("FUNCIONARIOS", 0),
      headerCell("CPF", 1),
      headerCell(idHeader, 2),
      headerCell("Data de nascimento", 3),
    ],
  });

  const dataRows = ordered.map(
    (e) =>
      new TableRow({
        children: [
          dataCell(e.name.toUpperCase(), 0, AlignmentType.LEFT),
          dataCell(formatCpf(e.cpf), 1, AlignmentType.CENTER),
          dataCell(idValue(e), 2, AlignmentType.CENTER),
          dataCell(isoToBr(e.birth_date), 3, AlignmentType.CENTER),
        ],
      }),
  );

  const table = new Table({
    layout: TableLayoutType.FIXED,
    columnWidths: COL_WIDTHS,
    width: { size: COL_WIDTHS.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    borders: {
      top: cellBorder,
      bottom: cellBorder,
      left: cellBorder,
      right: cellBorder,
      insideHorizontal: cellBorder,
      insideVertical: cellBorder,
    },
    rows: [headerRow, ...dataRows],
  });

  const doc = new Document({
    creator: "Cargo Stock",
    title: "Listagem de Embarque",
    styles: {
      default: {
        document: { run: { font: FONT, size: 20 } },
      },
    },
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 320 },
            children: [
              new ImageRun({
                type: "png",
                data: logoBuf,
                transformation: { width: LOGO_WIDTH, height: LOGO_HEIGHT },
              }),
            ],
          }),
          table,
        ],
      },
    ],
  });

  return (await Packer.toBuffer(doc)) as Buffer;
}
