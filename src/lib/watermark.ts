// Marca d'água da Cargo nas fotos dos Relatórios de Bordo.
//
// Ao selecionar as fotos do porão/costado, cada imagem é redimensionada e
// recebe o logo oficial queimado no canto inferior direito (estilo do
// relatório da Deep Water que serviu de referência) — tudo no navegador, via
// canvas. O resultado sai como data URL JPEG compacta, pronta pra subir pro
// /api/relatorios/[jobId]/fotos e ficar inline no Postgres.
//
// (A aba Marketing › Marca d'água continua existindo pra uso avulso; aqui a
// aplicação é automática e padronizada.)

const LOGO_SRC = "/cargo-logo.png";

// Lado maior da foto final. 1600px imprime bem em A4 e mantém o JPEG na casa
// de 200-500KB — importante porque a imagem vive inline no banco.
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.82;

// Logo com ~18% da largura da foto, levemente translúcido, margem de 2%.
const LOGO_WIDTH_PCT = 18;
const LOGO_OPACITY = 0.9;

let logoPromise: Promise<HTMLImageElement> | null = null;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Falha ao carregar imagem: ${src}`));
    img.src = src;
  });
}

function getLogo(): Promise<HTMLImageElement> {
  if (!logoPromise) logoPromise = loadImage(LOGO_SRC);
  return logoPromise;
}

/**
 * Descobre o formato pelos primeiros bytes do arquivo. A galeria do iPhone
 * entrega foto com `type` vazio ou errado com alguma frequência, e aí o
 * <img> se recusa a decodificar — por isso a gente olha o conteúdo.
 */
export function sniffImageType(bytes: Uint8Array): string {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57) return "image/webp";
  // ISO-BMFF: "....ftyp<marca>" — HEIC/HEIF do iPhone e AVIF.
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand.startsWith("hei") || brand.startsWith("mif") || brand.startsWith("msf") || brand === "hevc" || brand === "hevx") {
      return "image/heic";
    }
  }
  return "";
}

type Decoded = { source: CanvasImageSource; width: number; height: number; release: () => void };

/**
 * Decodifica a foto tentando os dois caminhos do navegador: createImageBitmap
 * (mais tolerante e fora da thread principal) e, se falhar, <img> + blob URL.
 * No iPhone um dos dois costuma dar conta do HEIC da galeria.
 */
async function decodeImage(blob: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(blob);
      if (bmp.width > 0 && bmp.height > 0) {
        return { source: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
      }
      bmp.close();
    } catch {
      // segue pro <img>
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    if (!img.naturalWidth || !img.naturalHeight) throw new Error("imagem vazia");
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * Redimensiona a foto pra no máximo MAX_DIMENSION no lado maior e queima o
 * logo da Cargo no canto inferior direito. Retorna data URL JPEG.
 *
 * Aceita File ou Blob: a tela de fotos copia os bytes do arquivo antes de
 * chamar aqui (ver handleFiles), porque o File que a galeria do iPhone entrega
 * pode ficar ilegível no meio do envio.
 */
export async function processReportPhoto(blob: Blob): Promise<string> {
  let decoded: Decoded;
  try {
    decoded = await decodeImage(blob);
  } catch {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const type = sniffImageType(head) || blob.type;
    if (type === "image/heic" || type === "image/heif") {
      throw new Error(
        "formato HEIC não abre neste navegador — no iPhone: Ajustes › Câmera › Formatos › Mais Compatível, ou envie a foto pelo app da câmera"
      );
    }
    throw new Error(`não deu pra abrir a imagem${type ? ` (${type})` : ""}`);
  }

  try {
    const logo = await getLogo();

    const scale = Math.min(1, MAX_DIMENSION / Math.max(decoded.width, decoded.height));
    const w = Math.max(1, Math.round(decoded.width * scale));
    const h = Math.max(1, Math.round(decoded.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas indisponível");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(decoded.source, 0, 0, w, h);

    const lw = Math.max(48, (w * LOGO_WIDTH_PCT) / 100);
    const lh = lw * (logo.naturalHeight / logo.naturalWidth);
    const margin = Math.round(Math.max(12, w * 0.02));
    ctx.globalAlpha = LOGO_OPACITY;
    ctx.drawImage(logo, w - lw - margin, h - lh - margin, lw, lh);
    ctx.globalAlpha = 1;

    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    // Canvas estourado (foto gigante em celular sem memória) devolve "data:,".
    if (!dataUrl.startsWith("data:image/jpeg")) throw new Error("foto grande demais pro navegador processar");
    return dataUrl;
  } finally {
    decoded.release();
  }
}
