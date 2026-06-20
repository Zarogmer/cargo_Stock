"use client";

import { useEffect, useState } from "react";

// Prévia de documentos gerados como PDF (DDS, Ficha de EPI, Aviso Médico,
// Recibo). Diferente da Folha de Ponto (HTML nativo), estes vêm de modelos
// Word, então geramos o PDF na API e o exibimos numa iframe. O componente é
// dono do object URL (cria/revoga conforme o blob muda).
export function PdfPreview({
  blob,
  loading,
  onClose,
}: {
  blob: Blob | null;
  loading: boolean;
  onClose: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);

  if (!loading && !blob) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-text">
          Visualização
          {loading && <span className="ml-2 text-xs font-normal text-text-light">gerando…</span>}
        </h4>
        {blob && (
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] font-medium text-text-light hover:text-text"
          >
            Fechar
          </button>
        )}
      </div>
      {url ? (
        <iframe
          src={url}
          title="Prévia do documento"
          className="w-full h-[680px] border border-border rounded-xl bg-white"
        />
      ) : (
        <div className="border border-border rounded-xl bg-card h-40 flex items-center justify-center text-sm text-text-light">
          Gerando prévia em PDF…
        </div>
      )}
    </div>
  );
}
