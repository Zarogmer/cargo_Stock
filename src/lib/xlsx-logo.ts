// Escreve um XLSX (montado com xlsx-js-style) com o logo da empresa no topo.
//
// O SheetJS não grava imagens, então a planilha sai dele sem o logo e aqui a
// gente abre o .xlsx (que é um zip OOXML) e acrescenta as partes do desenho:
// a imagem em xl/media, o drawing1.xml que a posiciona e os relacionamentos.
// Sem isso o cabeçalho da folha de pagamento ficaria só com texto.
//
// Se o logo não puder ser baixado (offline, arquivo fora do ar), a planilha é
// baixada do mesmo jeito, só sem a imagem — melhor que derrubar a exportação.

// 1 pixel (96 dpi) = 9525 EMU, a unidade do OOXML.
const EMU_PER_PX = 9525;

export type XlsxLogoAnchor = {
  /** Coluna (0 = A) onde o canto superior esquerdo da imagem encosta. */
  col: number;
  /** Linha (0 = 1) onde o canto superior esquerdo da imagem encosta. */
  row: number;
  /** Tamanho da imagem em pixels (mantenha a proporção do arquivo). */
  widthPx: number;
  heightPx: number;
  /** Respiro em pixels dentro da célula âncora. */
  offsetXPx?: number;
  offsetYPx?: number;
};

const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const SHEET_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}"><Relationship Id="rIdLogoDr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`;
const DRAWING_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${REL_NS}"><Relationship Id="rIdLogoImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>`;

function drawingXml(a: XlsxLogoAnchor): string {
  const cx = Math.round(a.widthPx * EMU_PER_PX);
  const cy = Math.round(a.heightPx * EMU_PER_PX);
  const dx = Math.round((a.offsetXPx ?? 0) * EMU_PER_PX);
  const dy = Math.round((a.offsetYPx ?? 0) * EMU_PER_PX);
  // oneCellAnchor: a imagem gruda na célula âncora e mantém o tamanho fixo,
  // então mexer na largura das colunas não distorce o logo.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:oneCellAnchor><xdr:from><xdr:col>${a.col}</xdr:col><xdr:colOff>${dx}</xdr:colOff><xdr:row>${a.row}</xdr:row><xdr:rowOff>${dy}</xdr:rowOff></xdr:from><xdr:ext cx="${cx}" cy="${cy}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="1" name="Logo" descr="Cargo Ships Cleaning"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rIdLogoImg"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`;
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Gera o arquivo e dispara o download, com o logo ancorado onde `anchor` diz.
 * Só funciona com workbook de UMA planilha (a imagem vai em sheet1).
 */
export async function writeXlsxWithLogo(
  wb: any,
  fileName: string,
  anchor: XlsxLogoAnchor,
  logoUrl = "/cargo-logo.png",
): Promise<void> {
  const XLSX = (await import("xlsx-js-style")).default;
  const raw: ArrayBuffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  try {
    const [{ default: PizZip }, png] = await Promise.all([
      import("pizzip"),
      fetch(logoUrl).then((r) => {
        if (!r.ok) throw new Error(`logo ${r.status}`);
        return r.arrayBuffer();
      }),
    ]);
    const zip = new PizZip(raw);
    const sheetPath = "xl/worksheets/sheet1.xml";
    const sheet = zip.file(sheetPath)?.asText();
    const types = zip.file("[Content_Types].xml")?.asText();
    if (!sheet || !types) throw new Error("xlsx inesperado");

    zip.file("xl/media/image1.png", png, { binary: true });
    zip.file("xl/drawings/drawing1.xml", drawingXml(anchor));
    zip.file("xl/drawings/_rels/drawing1.xml.rels", DRAWING_RELS);
    zip.file("xl/worksheets/_rels/sheet1.xml.rels", SHEET_RELS);
    // <drawing/> é o último filho de <worksheet> no schema — entra colado no
    // fechamento pra não quebrar a ordem dos elementos (Excel recusa o arquivo).
    zip.file(sheetPath, sheet.replace("</worksheet>", `<drawing r:id="rIdLogoDr"/></worksheet>`));
    zip.file(
      "[Content_Types].xml",
      types.replace(
        "</Types>",
        `<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`,
      ),
    );
    download(new Blob([zip.generate({ type: "arraybuffer" })], { type: XLSX_MIME }), fileName);
  } catch {
    download(new Blob([raw], { type: XLSX_MIME }), fileName);
  }
}
