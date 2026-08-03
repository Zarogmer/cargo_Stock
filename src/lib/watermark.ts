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
 * Lê um File de imagem, redimensiona pra no máximo MAX_DIMENSION no lado maior
 * e queima o logo da Cargo no canto inferior direito. Retorna data URL JPEG.
 * Lança erro em formato que o navegador não decodifica (ex.: HEIC).
 */
export async function processReportPhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const [img, logo] = await Promise.all([loadImage(url), getLogo()]);

    const scale = Math.min(1, MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, w, h);

    const lw = Math.max(48, (w * LOGO_WIDTH_PCT) / 100);
    const lh = lw * (logo.naturalHeight / logo.naturalWidth);
    const margin = Math.round(Math.max(12, w * 0.02));
    ctx.globalAlpha = LOGO_OPACITY;
    ctx.drawImage(logo, w - lw - margin, h - lh - margin, lw, lh);
    ctx.globalAlpha = 1;

    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    URL.revokeObjectURL(url);
  }
}
