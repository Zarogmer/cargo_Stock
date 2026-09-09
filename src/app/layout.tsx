import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PwaRegister } from "@/components/pwa-register";
import { SessionProvider } from "next-auth/react";

export const metadata: Metadata = {
  title: "Cargo Stock",
  description: "Sistema de gestão de estoque e equipamentos para embarcações",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Cargo Stock",
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
