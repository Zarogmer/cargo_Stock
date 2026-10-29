// Service worker do Cargo Stock — faz o app abrir sem internet no celular do
// supervisor (Relatórios de Bordo a bordo do navio).
//
// Registrado como /sw.js?v=<versão do build> (src/components/pwa-register.tsx):
// cada deploy muda a versão, o navegador instala este arquivo de novo e as
// telas em cache são renovadas. Os lançamentos feitos offline NÃO passam por
// aqui — ficam na fila do IndexedDB (src/lib/offline/sync.ts); este arquivo só
// cuida de ter as telas e os arquivos do build à mão.
//
// Caches:
// - cs-pages-<versão>: HTML das telas visitadas (ex.: /relatorios), a sessão
//   (/api/auth/session) e os arquivos públicos (logo, ícones, manifest). Na
//   troca de versão, as telas do cache antigo são buscadas de novo e só então
//   o cache antigo sai — o celular nunca fica sem tela nenhuma.
// - cs-static: chunks do Next (/_next/static, nome com hash, imutáveis).
//   Cache-first, limitado em tamanho. Persistente entre versões: a tela em
//   cache de um build antigo continua achando os chunks dela.
// - cs-photos: fotos dos relatórios já enviadas (/api/relatorios/fotos/<id>),
//   pra galeria aparecer no navio. Cache-first, limitado.

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const PAGES = `cs-pages-${VERSION}`;
const STATIC = "cs-static";
const PHOTOS = "cs-photos";
const STATIC_MAX = 600;
const PHOTOS_MAX = 400;
const SESSION_PATH = "/api/auth/session";
const OFFLINE_PAGE = "/offline.html";
const PRECACHE = [OFFLINE_PAGE, "/manifest.json", "/cargo-logo.png", "/favicon.png", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(PAGES)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const current = await caches.open(PAGES);
      for (const key of keys) {
        if (key === PAGES || key === STATIC || key === PHOTOS) continue;
        if (key.startsWith("cs-pages-")) {
          await carryOverPages(key, current);
        }
        await caches.delete(key); // inclui o "cargo-stock-v1" antigo
      }
      await self.clients.claim();
    })()
  );
});

// Troca de versão: cada tela guardada no cache antigo é buscada de novo (HTML
// do build novo). Se a rede falhar no meio, a versão antiga é copiada — segue
// funcionando offline com os chunks que já estão no cs-static.
async function carryOverPages(oldName, current) {
  const old = await caches.open(oldName);
  const requests = await old.keys();
  for (const req of requests) {
    const url = new URL(req.url);
    if (PRECACHE.includes(url.pathname) || url.pathname === SESSION_PATH) {
      const stale = await old.match(req);
      if (stale && !(await current.match(req))) await current.put(req, stale);
      continue;
    }
    try {
      const fresh = await fetch(req.url, { credentials: "same-origin" });
      if (fresh.ok && !fresh.redirected && isHtml(fresh)) {
        await current.put(req, fresh);
        continue;
      }
    } catch {
      // sem rede: fica com a cópia antiga
    }
    const stale = await old.match(req);
    if (stale) await current.put(req, stale);
  }
}

function isHtml(res) {
  return (res.headers.get("content-type") || "").includes("text/html");
}

function pageKey(url) {
  // Chave sem query: /relatorios?x=1 e /relatorios são a mesma tela.
  return new Request(url.origin + url.pathname, { credentials: "same-origin" });
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  // keys() vem em ordem de inserção: apaga os mais antigos.
  const excess = keys.slice(0, keys.length - max);
  await Promise.all(excess.map((k) => cache.delete(k)));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // gravações passam direto (e a fila cuida do offline)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(handleNavigate(req, url));
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(STATIC, req, STATIC_MAX));
    return;
  }
  if (url.pathname === SESSION_PATH) {
    event.respondWith(networkFirst(PAGES, req, pageKey(url)));
    return;
  }
  if (url.pathname.startsWith("/api/relatorios/fotos/")) {
    event.respondWith(cacheFirst(PHOTOS, req, PHOTOS_MAX));
    return;
  }
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_next/")) return; // dados ao vivo
  // Arquivos públicos (logo, ícones, wasm, templates): cache-first.
  event.respondWith(cacheFirst(PAGES, req, 0));
});

async function handleNavigate(req, url) {
  const key = pageKey(url);
  try {
    const res = await fetch(req);
    if (res.ok && !res.redirected && isHtml(res)) {
      const cache = await caches.open(PAGES);
      cache.put(key, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const cache = await caches.open(PAGES);
    const cached = await cache.match(key);
    if (cached) return cached;
    // Tela nunca visitada: cai nos Relatórios (a tela do supervisor) se ela
    // estiver guardada; senão, a página de "sem conexão".
    const relatorios = await cache.match(pageKey(new URL("/relatorios", url.origin)));
    if (relatorios) return relatorios;
    const offline = await cache.match(OFFLINE_PAGE);
    return offline || new Response("Sem conexão.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}

async function cacheFirst(name, req, max) {
  const cache = await caches.open(name);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    cache.put(req, res.clone()).catch(() => {});
    if (max > 0) trimCache(name, max).catch(() => {});
  }
  return res;
}

async function networkFirst(name, req, key) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(key, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const cached = await cache.match(key);
    if (cached) return cached;
    throw err;
  }
}
