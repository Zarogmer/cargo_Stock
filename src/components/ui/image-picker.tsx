"use client";

import { useState } from "react";
import { fileToCompressedDataUrl } from "@/lib/image";

// Seletor de imagem reutilizável (solicitação, compra, itens do almoxarifado).
// Comprime no cliente e devolve um data URL (base64), ou null quando removida.
export function ImagePicker({ value, onChange, label = "Imagem do produto (opcional)" }: {
  value: string | null; onChange: (dataUrl: string | null) => void; label?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite re-selecionar o mesmo arquivo
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Selecione um arquivo de imagem"); return; }
    setError(null);
    setProcessing(true);
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      onChange(dataUrl);
    } catch (err: any) {
      setError(err?.message || "Falha ao processar imagem");
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      {value ? (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt="Pré-visualização" className="w-20 h-20 rounded-lg object-cover border border-border" />
          <div className="flex flex-col gap-1.5">
            <label className="px-3 py-1.5 text-xs font-medium bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer transition text-center">
              Trocar
              <input type="file" accept="image/*" onChange={handleFile} className="hidden" />
            </label>
            <button type="button" onClick={() => onChange(null)} className="px-3 py-1.5 text-xs font-medium text-danger hover:bg-red-50 rounded-lg transition">
              Remover
            </button>
          </div>
        </div>
      ) : (
        <label className="flex flex-col items-center justify-center gap-1 w-full py-6 border-2 border-dashed border-border rounded-lg cursor-pointer hover:border-primary/50 hover:bg-gray-50 transition text-text-light">
          <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
          <span className="text-xs font-medium">{processing ? "Processando..." : "Adicionar foto"}</span>
          <input type="file" accept="image/*" onChange={handleFile} className="hidden" disabled={processing} />
        </label>
      )}
      {error && <p className="text-xs text-danger mt-1">{error}</p>}
    </div>
  );
}

// Overlay simples pra ver a foto ampliada. Renderiza nada quando src é null.
export function ImageLightbox({ src, onClose }: { src: string | null; onClose: () => void }) {
  if (!src) return null;
  return (
    <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="Imagem do produto" className="max-w-full max-h-[90vh] rounded-lg shadow-2xl" />
      <button onClick={onClose} className="absolute top-4 right-4 text-white/80 hover:text-white text-3xl font-light leading-none" title="Fechar">×</button>
    </div>
  );
}
