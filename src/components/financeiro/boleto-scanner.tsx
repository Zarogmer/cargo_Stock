"use client";

// Scanner de boleto pela câmera (ou foto): lê o código de barras ITF de 44
// dígitos impresso em todo boleto, converte pra linha digitável e valida com o
// MESMO parser do import de PDF (DVs mod10/mod11). Nada de OCR — o código de
// barras funciona até em papel amassado e foto torta. Pensado pro celular
// (navegador aponta a câmera traseira), mas funciona com webcam também.

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import {
  parseLinhaDigitavel,
  barcodeToLinhaDigitavel,
  type BoletoParsed,
} from "@/lib/services/boleto/linha-digitavel";

function buildReader(): BrowserMultiFormatReader {
  const hints = new Map();
  // Boleto usa ITF (Interleaved 2 of 5). TRY_HARDER melhora leitura de foto.
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.ITF]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints);
}

// Código lido → BoletoParsed validado (44 da barra ou 47/48 já digitável).
function tryParse(text: string): BoletoParsed | null {
  const digits = (text || "").replace(/\D/g, "");
  const linha =
    digits.length === 44
      ? barcodeToLinhaDigitavel(digits)
      : digits.length === 47 || digits.length === 48
        ? digits
        : null;
  if (!linha) return null;
  const parsed = parseLinhaDigitavel(linha);
  return parsed && parsed.dvValid ? parsed : null;
}

export function BoletoScannerModal({ open, onClose, onDetected }: {
  open: boolean;
  onClose: () => void;
  onDetected: (boleto: BoletoParsed) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const handledRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [decodingPhoto, setDecodingPhoto] = useState(false);
  const [slowHint, setSlowHint] = useState(false);

  useEffect(() => {
    if (!open) return;
    handledRef.current = false;
    setError(null);
    setSlowHint(false);
    // 8s sem ler nada = provavelmente longe/escuro/tremido — dá a dica em vez
    // de deixar o usuário achando que travou.
    const hintTimer = setTimeout(() => {
      if (!handledRef.current) setSlowHint(true);
    }, 8000);
    let cancelled = false;
    const reader = buildReader();
    (async () => {
      try {
        const controls = await reader.decodeFromConstraints(
          // Sem width/height o iPhone/Android entrega 640x480 e o ITF de 44
          // dígitos (~360 barras) fica com ~1,5px por barra — indecifrável.
          // Full HD dá ~4,5px por barra e a leitura passa a funcionar.
          {
            video: {
              facingMode: "environment",
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
          },
          videoRef.current!,
          (result) => {
            if (!result || handledRef.current) return;
            const parsed = tryParse(result.getText());
            if (!parsed) return;
            handledRef.current = true;
            try { navigator.vibrate?.(150); } catch { /* sem vibração, sem drama */ }
            controlsRef.current?.stop();
            onDetected(parsed);
          },
        );
        if (cancelled) { controls.stop(); return; }
        controlsRef.current = controls;
      } catch {
        setError(
          "Não consegui abrir a câmera. Libere a permissão de câmera pro site, ou use \"Ler de uma foto\" abaixo.",
        );
      }
    })();
    return () => {
      cancelled = true;
      clearTimeout(hintTimer);
      controlsRef.current?.stop();
      controlsRef.current = null;
    };
    // onDetected estável o bastante — religar o scanner só quando abre/fecha.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function handlePhoto(file: File) {
    setDecodingPhoto(true);
    setError(null);
    const url = URL.createObjectURL(file);
    try {
      const reader = buildReader();
      const result = await reader.decodeFromImageUrl(url);
      const parsed = tryParse(result.getText());
      if (parsed) {
        handledRef.current = true;
        controlsRef.current?.stop();
        onDetected(parsed);
      } else {
        setError("Achei um código na foto, mas não é um boleto válido — confira se é o código de barras do boleto.");
      }
    } catch {
      setError("Não achei código de barras na foto. Tente mais perto, com o código inteiro no quadro e boa luz.");
    } finally {
      URL.revokeObjectURL(url);
      setDecodingPhoto(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="📷 Escanear boleto" maxWidth="max-w-md">
      <div className="space-y-3">
        <p className="text-xs text-text-light">
          Aponte a câmera pro <strong>código de barras</strong> do boleto (deitado, inteiro no quadro).
          Valor, vencimento, banco e linha digitável entram sozinhos.
        </p>

        <div className="relative rounded-xl overflow-hidden bg-black">
          {/* muted+playsInline: iOS/Android exigem pra autoplay da câmera */}
          <video ref={videoRef} className="w-full h-64 object-cover" muted playsInline />
          {/* guia de mira */}
          <div className="pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 h-16 border-2 border-emerald-400/80 rounded-lg" />
        </div>

        {error && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">{error}</div>
        )}

        {!error && slowHint && (
          <div className="bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 text-xs text-sky-800">
            Ainda procurando… Aproxime até o código de barras preencher o quadro, segure firme
            e garanta boa luz. Se não pegar, use <strong>Ler de uma foto</strong> aí embaixo.
          </div>
        )}

        <div className="flex items-center justify-between gap-2 flex-wrap">
          <label className={`text-xs font-medium text-primary hover:underline cursor-pointer ${decodingPhoto ? "opacity-50" : ""}`}>
            {decodingPhoto ? "Lendo a foto..." : "📁 Ler de uma foto"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              disabled={decodingPhoto}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handlePhoto(f);
                e.target.value = "";
              }}
            />
          </label>
          <button type="button" onClick={onClose} className="text-xs text-text-light hover:text-text px-3 py-1.5">
            Cancelar
          </button>
        </div>
      </div>
    </Modal>
  );
}
