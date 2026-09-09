import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaRegister } from "@/components/pwa-register";
import { SessionProvider } from "next-auth/react";

const SITE_URL = "https://cargostock.app";
const SITE_TITLE = "Cargo Stock";
const SITE_DESCRIPTION =
  "Sistema de gestão da Cargo Ships Cleaning: navios, escalação de equipes, almoxarifado, RH e financeiro em um só lugar.";

export const metadata: Metadata = {
  // metadataBase resolve as URLs relativas (imagem OG) pro domínio oficial —
  // sem isso o Next cai em localhost e a prévia do link sai sem imagem.
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: SITE_TITLE,
  },
  // Prévia ao compartilhar o link (WhatsApp, Instagram, Facebook, Telegram).
  // O robô deles cai no /login (a home redireciona), que herda estas tags do
  // layout raiz. A imagem vive em /icons/ porque esse caminho é público no
  // middleware de login (src/middleware.ts); na raiz o robô seria mandado pro
  // login e a prévia sairia sem foto. 1200×630, gerada por
  // scripts/gen-og-image.ts (não editar à mão).
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_TITLE,
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    locale: "pt_BR",
    images: [
      { url: "/icons/og-cargo-stock.png", width: 1200, height: 630, alt: "Cargo Stock — Cargo Ships Cleaning" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    images: ["/icons/og-cargo-stock.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  // cover: a pagina passa por baixo das barras de vidro do Safari (iOS 26) e da
  // barra de gestos do Android; quem precisa se afastar delas usa as classes
  // *-safe (env(safe-area-inset-*)) do globals.css.
  viewportFit: "cover",
  // Branco = cor do header mobile e do conteúdo; as rotas azuis (login/auth)
  // sobrescrevem no layout delas pras barras do navegador acompanharem a página.
  themeColor: "#ffffff",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <head>
        <link rel="icon" href="/favicon.png" type="image/png" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      </head>
      <body className="antialiased">
        <SessionProvider>
          <PwaRegister />
          {children}
        </SessionProvider>
      </body>
    </html>
  );
}
