/**
 * Gera a imagem de prévia do link (Open Graph) em public/icons/og-cargo-stock.png.
 *
 * É a "foto" que WhatsApp, Instagram, Facebook e Telegram mostram quando alguém
 * compartilha https://cargostock.app. 1200×630 (padrão OG) e PNG enxuto (< 300 KB,
 * limite do WhatsApp). Fica em /icons/ porque esse caminho é público no middleware
 * de login (src/middleware.ts) — na raiz o robô seria mandado pro /login.
 *
 * Rodar (Windows, usa Segoe UI/Arial do sistema):  npx tsx scripts/gen-og-image.ts
 * As tags que apontam pra ela estão em src/app/layout.tsx (metadata.openGraph).
 */
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { writeFileSync, statSync } from "node:fs";
import path from "node:path";

const W = 1200;
const H = 630;
const OUT = path.resolve(__dirname, "../public/icons/og-cargo-stock.png");
const FONT = '"Segoe UI", Arial, sans-serif';

// Diminui a fonte até o texto caber em maxWidth (evita cortar no fim da imagem).
function fitText(ctx: SKRSContext2D, text: string, weight: string, size: number, maxWidth: number): number {
  let s = size;
  for (;;) {
    ctx.font = `${weight} ${s}px ${FONT}`;
    if (ctx.measureText(text).width <= maxWidth || s <= 12) return s;
    s -= 1;
  }
}

async function main() {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Fundo: azul-marinho da sidebar + dois círculos suaves (mesma família de cores do app).
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = "#1e3a8a";
  ctx.beginPath(); ctx.arc(1130, 40, 520, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = "#3b82f6";
  ctx.beginPath(); ctx.arc(60, 640, 300, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;

  // Ícone do app (já vem com o cantinho arredondado) à esquerda, centralizado na altura.
  const icon = await loadImage(path.resolve(__dirname, "../public/icons/icon-512.png"));
  const ICON = 320;
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  ctx.drawImage(icon, 90, (H - ICON) / 2, ICON, ICON);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Texto à direita.
  const X = 470;
  const MAXW = W - X - 60;
  ctx.textBaseline = "alphabetic";

  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${fitText(ctx, "Cargo Stock", "bold", 96, MAXW)}px ${FONT}`;
  ctx.fillText("Cargo Stock", X, 285);

  ctx.fillStyle = "#cbd5e1";
  const tagline = "Sistema de gestão da Cargo Ships Cleaning";
  ctx.font = `normal ${fitText(ctx, tagline, "normal", 38, MAXW)}px ${FONT}`;
  ctx.fillText(tagline, X, 345);

  ctx.fillStyle = "#93c5fd";
  const modules = "Navios · Escalação · Almoxarifado · RH · Financeiro";
  ctx.font = `normal ${fitText(ctx, modules, "normal", 30, MAXW)}px ${FONT}`;
  ctx.fillText(modules, X, 400);

  ctx.fillStyle = "#60a5fa";
  ctx.font = `bold 30px ${FONT}`;
  ctx.fillText("cargostock.app", 90, 580);

  // Logo da empresa em branco no canto inferior direito: desenha o PNG azul num
  // canvas à parte e pinta por cima com source-in (só onde o logo tem pixel).
  const logo = await loadImage(path.resolve(__dirname, "../public/cargo-logo.png"));
  const LW = 300;
  const LH = Math.round((logo.height / logo.width) * LW);
  const off = createCanvas(LW, LH);
  const octx = off.getContext("2d");
  octx.drawImage(logo, 0, 0, LW, LH);
  octx.globalCompositeOperation = "source-in";
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, LW, LH);
  ctx.globalAlpha = 0.9;
  ctx.drawImage(off, W - LW - 70, H - LH - 52);
  ctx.globalAlpha = 1;

  const png = await canvas.encode("png");
  writeFileSync(OUT, png);
  const kb = Math.round(statSync(OUT).size / 1024);
  console.log(`ok: ${path.relative(process.cwd(), OUT)} (${W}x${H}, ${kb} KB)`);
  if (kb > 300) console.warn("AVISO: acima de 300 KB — o WhatsApp pode ignorar a imagem");
}

main().catch((e) => { console.error(e); process.exit(1); });
