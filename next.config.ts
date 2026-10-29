import type { NextConfig } from "next";

// Versão do build pro service worker (public/sw.js): no Railway é o commit do
// deploy; fora dele, a hora do build. Vai inlined no bundle do cliente.
const APP_VERSION = (process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 12) || String(Date.now());

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: APP_VERSION,
  },

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

  // www.cargostock.app → cargostock.app: o sistema vive num host só. AUTH_URL e
  // os cookies do login são do domínio sem www, então no www o login não
  // "pegaria". O Railway precisa ter o www cadastrado como domínio custom pra
  // esta regra chegar a rodar (senão ele responde 404 antes do app).
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.cargostock.app" }],
        destination: "https://cargostock.app/:path*",
        permanent: true,
      },
    ];
  },

  // PWA headers
  async headers() {
    return [
      {
        // O service worker nunca pode ficar preso em cache (Cloudflare/navegador):
        // o registro usa ?v=<build>, mas o arquivo em si também sai sem cache.
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, max-age=0, must-revalidate" }],
      },
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
