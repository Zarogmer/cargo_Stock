import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeightRule,
  Packer,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  Footer,
} from "docx";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface DdsEmployee {
  name: string;
  cpf?: string | null;
}

interface DdsRequestBody {
  shipName?: string;
  shipNumber?: string;
  documentDate?: string; // dd/mm/yyyy
  periodStart?: string; // dd/mm/yyyy
  periodEnd?: string; // dd/mm/yyyy
  motivo?: string;
  employees?: DdsEmployee[];
}

const COMPANY_INFO = {
  name: "Cargo Ships Cleaning Ltda",
  address: "rua Praça Iguatemi Martins nº 08, Santos/SP",
  cnpj: "41.560.212/0001-00",
  footerAddress: "Praça Iguatemi Martins, 08",
  footerCity: "Vila Nova, Santos/SP",
  footerCep: "CEP: 11013-310",
  footerEmail: "CARGOSHIPS@CARGOSHIPS.COM.BR",
};

const HEADER_FILL = "8EAADB";
const SUBHEADER_FILL = "D8D8D8";

function arial(text: string, opts: { bold?: boolean; size?: number; color?: string } = {}) {
  return new TextRun({
    text,
    font: "Arial",
    bold: opts.bold,
    size: opts.size ?? 22, // half-points (default 11pt)
    color: opts.color,
  });
}

function timesBold(text: string, size = 44) {
  return new TextRun({
    text,
    font: "Times New Roman",
    bold: true,
    size,
  });
}

function p(children: TextRun[], opts: { alignment?: typeof AlignmentType[keyof typeof AlignmentType]; spacingAfter?: number } = {}) {
  return new Paragraph({
    children,
    alignment: opts.alignment,
    spacing: { after: opts.spacingAfter ?? 120 },
  });
}

function cell(opts: {
  children: Paragraph[];
  fill?: string;
  width: number;
  bold?: boolean;
  align?: typeof AlignmentType[keyof typeof AlignmentType];
  columnSpan?: number;
}): TableCell {
  return new TableCell({
    width: { size: opts.width, type: WidthType.DXA },
    columnSpan: opts.columnSpan,
    shading: opts.fill
      ? { fill: opts.fill, type: ShadingType.CLEAR, color: "auto" }
      : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    children: opts.children,
  });
}

const FULL_BORDER = {
  top: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
  bottom: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
  left: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
  right: { style: BorderStyle.SINGLE, size: 8, color: "000000" },
};

function todayPtBr(): string {
  const d = new Date();
  return d.toLocaleDateString("pt-BR");
}

function safe(s?: string | null): string {
  return (s || "").trim();
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: DdsRequestBody;
  try {
    body = (await request.json()) as DdsRequestBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const shipName = safe(body.shipName) || "—";
  const shipNumber = safe(body.shipNumber);
  const documentDate = safe(body.documentDate) || todayPtBr();
  const periodStart = safe(body.periodStart) || todayPtBr();
  const periodEnd = safe(body.periodEnd) || todayPtBr();
  const motivo = safe(body.motivo) || "Utilização do Material de EPI's";
  const employees = (body.employees || []).filter((e) => safe(e.name));

  if (employees.length === 0) {
    return NextResponse.json(
      { error: "Inclua pelo menos um funcionário." },
      { status: 400 }
    );
  }

  // ── Page setup (portrait A4-ish, 1" margins) ─────────────────────────────
  const PAGE_WIDTH = 12240; // 8.5" in DXA
  const MARGIN = 1080; // 0.75" margins to allow wider table
  const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

  // ── Top blue banner: "DDS  {ship}_{n}#{date}" ────────────────────────────
  const headerNumberPart = shipNumber
    ? `_${shipNumber}#${documentDate}`
    : `#${documentDate}`;

  const bannerTable = new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [CONTENT_WIDTH],
    borders: FULL_BORDER,
    rows: [
      new TableRow({
        height: { value: 900, rule: HeightRule.ATLEAST },
        children: [
          cell({
            width: CONTENT_WIDTH,
            fill: HEADER_FILL,
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  timesBold("DDS", 44),
                  timesBold("    ", 44),
                  timesBold(shipName.toUpperCase(), 44),
                  timesBold(headerNumberPart, 32),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });

  // ── Intro paragraph (company info) ───────────────────────────────────────
  const introPara = new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { before: 240, after: 240 },
    children: [
      arial("A ", {}),
      arial(COMPANY_INFO.name, { bold: true }),
      arial(", situada na "),
      arial(COMPANY_INFO.address, { bold: true }),
      arial(", no CNPJ "),
      arial(COMPANY_INFO.cnpj, { bold: true }),
      arial("."),
    ],
  });

  // ── Motivo / Navio / Período block (table with grey label cells) ─────────
  const labelCol = 2400;
  const valueCol = CONTENT_WIDTH - labelCol;

  function infoRow(label: string, value: string): TableRow {
    return new TableRow({
      children: [
        cell({
          width: labelCol,
          fill: SUBHEADER_FILL,
          children: [p([arial(label, { bold: true })])],
        }),
        cell({
          width: valueCol,
          children: [p([arial(value)])],
        }),
      ],
    });
  }

  const infoTable = new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [labelCol, valueCol],
    borders: FULL_BORDER,
    rows: [
      infoRow("Motivo:", motivo),
      infoRow("Navio:", shipName),
      infoRow("Período:", `${periodStart} A ${periodEnd}`),
    ],
  });

  // ── Long declaration paragraph ───────────────────────────────────────────
  const declaration = new Paragraph({
    alignment: AlignmentType.JUSTIFIED,
    spacing: { before: 320, after: 320, line: 300 },
    children: [
      arial(
        "Declaro que recebi gratuitamente o(s) Equipamento(s) de Proteção Individual - EPI(s) conforme Portaria 3214/78 - NR06 para utilização em função dos agentes existentes em meu local de trabalho e principalmente para neutralização dos agentes agressivos. Declaro ainda que fui treinado e tenho ciência da obrigatoriedade do uso, que em caso de extravio ou inutilização ficarei obrigado a reembolsar a empresa o correspondente custo, em época hábil acrescido dos custos legais. Possuo ainda conhecimento que o não cumprimento dos padrões estabelecidos é passível de medida disciplinar interna."
      ),
    ],
  });

  // ── Employees table: FUNCIONARIOS | CPF | ASSINATURA ─────────────────────
  const cFuncionario = Math.floor(CONTENT_WIDTH * 0.45);
  const cCpf = Math.floor(CONTENT_WIDTH * 0.2);
  const cAss = CONTENT_WIDTH - cFuncionario - cCpf;

  const headerRow = new TableRow({
    tableHeader: true,
    height: { value: 500, rule: HeightRule.ATLEAST },
    children: [
      cell({
        width: cFuncionario,
        fill: HEADER_FILL,
        children: [p([arial("FUNCIONÁRIOS", { bold: true })], { alignment: AlignmentType.CENTER, spacingAfter: 0 })],
      }),
      cell({
        width: cCpf,
        fill: HEADER_FILL,
        children: [p([arial("CPF", { bold: true })], { alignment: AlignmentType.CENTER, spacingAfter: 0 })],
      }),
      cell({
        width: cAss,
        fill: HEADER_FILL,
        children: [p([arial("ASSINATURA", { bold: true })], { alignment: AlignmentType.CENTER, spacingAfter: 0 })],
      }),
    ],
  });

  const employeeRows = employees.map((e) =>
    new TableRow({
      height: { value: 600, rule: HeightRule.ATLEAST },
      children: [
        cell({
          width: cFuncionario,
          children: [p([arial(e.name.toUpperCase())], { spacingAfter: 0 })],
        }),
        cell({
          width: cCpf,
          children: [p([arial(safe(e.cpf))], { spacingAfter: 0 })],
        }),
        cell({
          width: cAss,
          children: [p([arial("")], { spacingAfter: 0 })],
        }),
      ],
    })
  );

  const employeesTable = new Table({
    width: { size: CONTENT_WIDTH, type: WidthType.DXA },
    columnWidths: [cFuncionario, cCpf, cAss],
    borders: FULL_BORDER,
    rows: [headerRow, ...employeeRows],
  });

  // ── Footer (company contact) ─────────────────────────────────────────────
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          arial(COMPANY_INFO.name.toUpperCase() + ".", { bold: true, size: 18 }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          arial(`${COMPANY_INFO.footerAddress}, ${COMPANY_INFO.footerCity}, ${COMPANY_INFO.footerCep}`, { size: 18 }),
        ],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [arial(COMPANY_INFO.footerEmail, { size: 18, bold: true })],
      }),
    ],
  });

  const doc = new Document({
    creator: COMPANY_INFO.name,
    title: `DDS ${shipName}`,
    styles: {
      default: {
        document: { run: { font: "Arial", size: 22 } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: PAGE_WIDTH,
              height: 15840,
              orientation: PageOrientation.PORTRAIT,
            },
            margin: { top: MARGIN, right: MARGIN, bottom: 1440, left: MARGIN },
          },
        },
        footers: { default: footer },
        children: [
          bannerTable,
          new Paragraph({ children: [] }),
          introPara,
          infoTable,
          declaration,
          employeesTable,
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);

  // Filename: DDS MV BARROW ISLAND.docx style
  const safeName = shipName
    .toUpperCase()
    .replace(/[\\/:*?"<>|]+/g, "")
    .trim()
    .replace(/\s+/g, " ");
  const filename = `DDS ${safeName}.docx`;
  // RFC 5987: provide ASCII-safe filename + UTF-8 percent-encoded filename*.
  const asciiFallback = filename.replace(/[^\x20-\x7E]+/g, "_");

  return new NextResponse(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
}
