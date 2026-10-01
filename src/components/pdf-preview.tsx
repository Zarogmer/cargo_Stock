"use client";

// Preview de PDF renderizado em canvas com pdf.js — não depende do
// visualizador nativo do Chromium. No app Electron o plugin de PDF está
// desligado (iframe com PDF fica cinza), e o Setup não se atualiza sozinho;
// desenhar as páginas aqui funciona no desktop, na web e no celular igual.

import { useEffect, useRef, useState } from "react";

export function PdfPreview({ url, className = "" }: { url: string; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [pages, setPages] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";
    setStatus("loading");
    setError("");
    setPages(0);

    (async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Erro ${res.status}`);
        }
        const data = await res.arrayBuffer();
        const pdfjs: typeof import("pdfjs-dist") = await import("pdfjs-dist");
        (pdfjs as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
        const doc = await pdfjs.getDocument({ data }).promise;
        if (cancelled) return;
        setPages(doc.numPages);

        // Largura disponível do container menos o padding; a página escala
        // pra caber. devicePixelRatio deixa o texto nítido em tela HiDPI.
        const width = Math.max(320, container.clientWidth - 32);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const viewport = page.getViewport({ scale: scale * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
          canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
          canvas.className = "block mx-auto mb-4 bg-white shadow-md rounded";
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("Canvas indisponível");
          container.appendChild(canvas);
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        }
        if (!cancelled) setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Não foi possível abrir o PDF.");
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className={`relative overflow-auto bg-gray-100 ${className}`}>
      {status === "loading" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-text-light animate-pulse">
          Gerando preview...
        </div>
      )}
      {status === "error" && (
        <div className="m-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">⚠️ {error}</div>
      )}
      <div ref={containerRef} className={`p-4 ${status === "ready" ? "" : "invisible"}`} />
      {status === "ready" && pages > 0 && (
        <p className="text-center text-xs text-text-light pb-3">
          {pages} página{pages === 1 ? "" : "s"}
        </p>
      )}
    </div>
  );
}
