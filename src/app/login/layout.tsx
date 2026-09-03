import type { Viewport } from "next";

// O login é azul (gradiente primary-dark → primary). theme-color e o fundo do
// documento precisam acompanhar, senão o iOS pinta topo/rodapé/overscroll de branco.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#1e3a8a",
};

export default function LoginLayout({
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
