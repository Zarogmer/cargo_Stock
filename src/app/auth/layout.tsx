import type { Viewport } from "next";

// Mesmo tratamento do /login: páginas de auth usam o gradiente azul, então
// theme-color e fundo do documento acompanham pra não sobrar faixa branca.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#1e3a8a",
};

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <style>{`html, body { background-color: #1e3a8a; }`}</style>
      {children}
    </>
  );
}
