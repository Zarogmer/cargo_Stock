"use client";

import { useEffect } from "react";

// Registra o service worker (public/sw.js) com a versão do build na URL: a
// cada deploy a URL muda, o navegador baixa o arquivo de novo e renova as
// telas em cache. updateViaCache "none" garante que o próprio sw.js nunca
// venha do cache HTTP (o Cloudflare também recebe no-cache pra ele, ver
// next.config.ts).
const VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "dev";

export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register(`/sw.js?v=${encodeURIComponent(VERSION)}`, { updateViaCache: "none" })
      .catch(() => {
        // sem service worker (navegador antigo / contexto inseguro): segue só online
      });
  }, []);

  return null;
}
