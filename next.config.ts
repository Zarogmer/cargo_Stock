import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `ws` is a Node-only library — keep it external so Next.js doesn't try
  // to bundle it for any non-Node target. `pdfjs-dist` roda no servidor pra
  // ler boletos (src/lib/services/boleto/pdf.ts) — externalizar evita que o
  // bundler quebre a resolução do worker embutido.
  // `tesseract.js` (OCR de PDF escaneado) e `@napi-rs/canvas` (render da página
  // pra imagem) também são Node-only, com worker_threads e binário nativo.
  serverExternalPackages: ["ws", "pdfjs-dist", "tesseract.js", "@napi-rs/canvas"],

  // Don't fail the production build on ESLint warnings/errors. Type errors
  // still block the build via tsc.
  eslint: {
    ignoreDuringBuilds: true,
  },

  // PWA headers
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
