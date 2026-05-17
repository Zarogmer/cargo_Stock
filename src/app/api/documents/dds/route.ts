import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface DdsEmployee {
  name: string;
  cpf?: string | null;
}

interface DdsRequestBody {
  shipName?: string;
  documentDate?: string; // dd/mm/yyyy
  periodStart?: string; // dd/mm/yyyy
  periodEnd?: string; // dd/mm/yyyy
  holdsCount?: number | string | null;
  employees?: DdsEmployee[];
}

function safe(s?: string | null): string {
  return (s || "").toString().trim();
}

function todayPtBr(): string {
  return new Date().toLocaleDateString("pt-BR");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Build a <w:r> with Arial 10pt text suitable for the employees table cells.
function makeCellRun(text: string): string {
  const t = escapeXml(text);
  return (
    `<w:r>` +
    `<w:rPr>` +
    `<w:rFonts w:ascii="Arial" w:eastAsia="Times New Roman" w:hAnsi="Arial" w:cs="Arial"/>` +
    `<w:sz w:val="20"/>` +
    `<w:szCs w:val="20"/>` +
    `<w:lang w:val="pt-BR" w:eastAsia="pt-BR"/>` +
    `</w:rPr>` +
    `<w:t xml:space="preserve">${t}</w:t>` +
    `</w:r>`
  );
}

// Take one empty row from the employees table and inject name + cpf into the
// first two cells. The third cell (assinatura) stays empty.
function buildEmployeeRow(rowTemplate: string, name: string, cpf: string): string {
  let cellIndex = 0;
  return rowTemplate.replace(/<w:tc>([\s\S]*?)<\/w:tc>/g, (_match, inner) => {
    const text = cellIndex === 0 ? name : cellIndex === 1 ? cpf : "";
    cellIndex++;
    if (!text) {
      return `<w:tc>${inner}</w:tc>`;
    }
    // Inject the run just before the paragraph's closing tag.
    const injected = inner.replace(/<\/w:p>(?![\s\S]*<\/w:p>)/, `${makeCellRun(text)}</w:p>`);
    return `<w:tc>${injected}</w:tc>`;
  });
}

// Rewrite the second <w:tbl> (employees table) so it has one row per employee
// plus the original header row. Keeps the rest of the document intact.
function rewriteEmployeesTable(xml: string, employees: DdsEmployee[]): string {
  const tblRegex = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
  const tables: { start: number; end: number; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = tblRegex.exec(xml)) !== null) {
    tables.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  if (tables.length < 2) return xml; // safety — template not as expected

  const empTbl = tables[tables.length - 1];
  const empText = empTbl.text;

  const rowRegex = /<w:tr[\s>][\s\S]*?<\/w:tr>/g;
  const rows: string[] = [];
  let rm: RegExpExecArray | null;
  while ((rm = rowRegex.exec(empText)) !== null) {
    rows.push(rm[0]);
  }
  if (rows.length < 2) return xml;

  const headerRow = rows[0];
  const rowTemplate = rows[1];

  // Beginning of table up to the first <w:tr>, and the closing tags after the
  // last </w:tr>.
  const firstRowIdx = empText.indexOf(rows[0]);
  const lastRowEnd = empText.lastIndexOf(rows[rows.length - 1]) + rows[rows.length - 1].length;
  const tblOpen = empText.substring(0, firstRowIdx);
  const tblClose = empText.substring(lastRowEnd);

  const employeeRowsXml = employees
    .map((e) => buildEmployeeRow(rowTemplate, safe(e.name), safe(e.cpf)))
    .join("");

  const newEmpTbl = `${tblOpen}${headerRow}${employeeRowsXml}${tblClose}`;
  return xml.substring(0, empTbl.start) + newEmpTbl + xml.substring(empTbl.end);
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
  const documentDate = safe(body.documentDate) || todayPtBr();
  const periodStart = safe(body.periodStart) || todayPtBr();
  const periodEnd = safe(body.periodEnd) || todayPtBr();
  const holdsRaw = body.holdsCount;
  const holdsValue =
    holdsRaw == null || holdsRaw === ""
      ? ""
      : String(holdsRaw).trim();

  const employees = (body.employees || []).filter((e) => safe(e.name));
  if (employees.length === 0) {
    return NextResponse.json(
      { error: "Inclua pelo menos um funcionário." },
      { status: 400 }
    );
  }

  // ── Load template ────────────────────────────────────────────────────────
  let templateBuffer: Buffer;
  try {
    const templatePath = path.join(process.cwd(), "src/lib/templates/dds-template.docx");
    templateBuffer = await fs.readFile(templatePath);
  } catch (err) {
    return NextResponse.json(
      { error: "Template DDS não encontrado no servidor.", detail: String(err) },
      { status: 500 }
    );
  }

  const zip = new PizZip(templateBuffer);

  // ── Fill placeholders with docxtemplater ────────────────────────────────
  // The template uses {NOME_NAVIO}, {PORÃO}, {DATA ATUAL}, {15/05/2026},
  // {19/05/2026}. The header has "{NOME_NAVIO }" with a trailing space inside
  // braces, so we map both keys to the same value.
  let doc: Docxtemplater;
  try {
    doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: "{", end: "}" },
      nullGetter: () => "",
    });

    // The template places some placeholders with whitespace inside the braces
    // (e.g. "{NOME_NAVIO }" in the header collapses to " NOME_NAVIO " as a tag).
    // Normalize the key on lookup so leading/trailing spaces do not matter.
    const dataMap: Record<string, string> = {
      NOME_NAVIO: shipName,
      "PORÃO": holdsValue,
      "DATA ATUAL": documentDate,
      "15/05/2026": periodStart,
      "19/05/2026": periodEnd,
    };
    const dataProxy = new Proxy({} as Record<string, string>, {
      get: (_target, key) => {
        if (typeof key !== "string") return undefined;
        return dataMap[key.trim()] ?? "";
      },
      has: () => true,
    });
    doc.render(dataProxy);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Falha ao renderizar o template DDS.", detail },
      { status: 500 }
    );
  }

  // ── Inject employee rows directly in document.xml ────────────────────────
  const rendered = doc.getZip();
  const docFile = rendered.file("word/document.xml");
  if (docFile) {
    const xml = docFile.asText();
    const newXml = rewriteEmployeesTable(xml, employees);
    rendered.file("word/document.xml", newXml);
  }

  const buffer = rendered.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;

  // Filename: DDS MV BARROW ISLAND.docx
  const safeName = shipName
    .toUpperCase()
    .replace(/[\\/:*?"<>|]+/g, "")
    .trim()
    .replace(/\s+/g, " ");
  const filename = `DDS ${safeName}.docx`;
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
