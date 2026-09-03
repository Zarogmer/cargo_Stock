"use client";

// Scanner de documento pela câmera (ou foto): lê o código de barras ITF de 44
// dígitos impresso em todo boleto (convertido pra linha digitável e validado
// com o MESMO parser do import de PDF — DVs mod10/mod11) e, no modo NF, também
// o CODE-128 do DANFE (chave de acesso de 44 dígitos) e o QR code da NFC-e.
// Nada de OCR — código de barras funciona até em papel amassado e foto torta.
// Pensado pro celular (navegador aponta a câmera traseira), mas funciona com
// webcam também.

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import {
  parseLinhaDigitavel,
  barcodeToLinhaDigitavel,
  type BoletoParsed,
} from "@/lib/services/boleto/linha-digitavel";
import { parseNfeScan, type NfeChaveScan } from "@/lib/services/boleto/nfe-chave";

// Resultado do scanner unificado: boleto OU nota fiscal.
export type DocScan =
  | { kind: "BOLETO"; boleto: BoletoParsed }
  | { kind: "NFE"; nfe: NfeChaveScan };

function buildReader(withNfe: boolean): BrowserMultiFormatReader {
  const hints = new Map();
  // Boleto usa ITF (Interleaved 2 of 5); o DANFE imprime a chave em CODE-128 e
  // a NFC-e usa QR. TRY_HARDER melhora leitura de foto.
  hints.set(
    DecodeHintType.POSSIBLE_FORMATS,
    withNfe
      ? [BarcodeFormat.ITF, BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE]
      : [BarcodeFormat.ITF],
  );
  hints.set(DecodeHintType.TRY_HARDER, true);
  return new BrowserMultiFormatReader(hints);
}

// Código lido → documento validado, ou null. O FORMATO desambigua os 44
// dígitos: ITF é boleto; CODE-128/QR é nota fiscal (chave com modelo e DV
// conferidos). Sem formato conhecido tenta os dois — ambos validam DV, então
// um não passa pelo parser do outro.
function tryParse(text: string, format: BarcodeFormat | null, withNfe: boolean): DocScan | null {
  const isNfeFormat = format === BarcodeFormat.CODE_128 || format === BarcodeFormat.QR_CODE;
  if (withNfe && (isNfeFormat || format == null)) {
    const nfe = parseNfeScan(text);
    if (nfe) return { kind: "NFE", nfe };
  }
  if (isNfeFormat) return null;
  const digits = (text || "").replace(/\D/g, "");
  const linha =
    digits.length === 44
      ? barcodeToLinhaDigitavel(digits)
      : digits.length === 47 || digits.length === 48
        ? digits
        : null;
  if (!linha) return null;
  const parsed = parseLinhaDigitavel(linha);
  return parsed && parsed.dvValid ? { kind: "BOLETO", boleto: parsed } : null;
}

function ScannerModal({ open, onClose, onScan, withNfe }: {
  open: boolean;
  onClose: () => void;
  onScan: (scan: DocScan) => void;
  withNfe: boolean;
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
    const reader = buildReader(withNfe);
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
            const parsed = tryParse(result.getText(), result.getBarcodeFormat() ?? null, withNfe);
            if (!parsed) return;
            handledRef.current = true;
            try { navigator.vibrate?.(150); } catch { /* sem vibração, sem drama */ }
            controlsRef.current?.stop();
            onScan(parsed);
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
    // onScan estável o bastante — religar o scanner só quando abre/fecha.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, withNfe]);

  async function handlePhoto(file: File) {
    setDecodingPhoto(true);
    setError(null);
    const url = URL.createObjectURL(file);
    try {
      const reader = buildReader(withNfe);
      const result = await reader.decodeFromImageUrl(url);
      const parsed = tryParse(result.getText(), result.getBarcodeFormat() ?? null, withNfe);
      if (parsed) {
        handledRef.current = true;
        controlsRef.current?.stop();
        onScan(parsed);
      } else {
        setError(
          withNfe
            ? "Achei um código na foto, mas não é um boleto nem uma chave de NF válida — confira se pegou o código certo."
            : "Achei um código na foto, mas não é um boleto válido — confira se é o código de barras do boleto.",
        );
      }
    } catch {
      setError("Não achei código de barras na foto. Tente mais perto, com o código inteiro no quadro e boa luz.");
    } finally {
      URL.revokeObjectURL(url);
      setDecodingPhoto(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={withNfe ? "📷 Escanear boleto ou NF" : "📷 Escanear boleto"} maxWidth="max-w-md">
      <div className="space-y-3">
        <p className="text-xs text-text-light">
          {withNfe ? (
            <>
              Aponte a câmera pro <strong>código de barras</strong> do boleto ou da NF (DANFE) — ou
              pro <strong>QR code</strong> da NFC-e (cupom). Boleto entra com valor e vencimento;
              NF entra com fornecedor, número e chave.
            </>
          ) : (
            <>
              Aponte a câmera pro <strong>código de barras</strong> do boleto (deitado, inteiro no quadro).
              Valor, vencimento, banco e linha digitável entram sozinhos.
            </>
          )}
        </p>

        <div className="relative rounded-xl overflow-hidden bg-black">
          {/* muted+playsInline: iOS/Android exigem pra autoplay da câmera */}
          <video ref={videoRef} className="w-full h-64 object-cover" muted playsInline />
          {/* guia de mira — mais alta no modo NF, que também lê QR code */}
          <div className={`pointer-events-none absolute inset-x-6 top-1/2 -translate-y-1/2 ${withNfe ? "h-28" : "h-16"} border-2 border-emerald-400/80 rounded-lg`} />
        </div>

        {error && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">{error}</div>
        )}

        {!error && slowHint && (
          <div className="bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 text-xs text-sky-800">
            Ainda procurando… Aproxime até o código preencher o quadro, segure firme
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

// Scanner só de boleto — Contas a Pagar (a conta lá nasce do boleto).
export function BoletoScannerModal({ open, onClose, onDetected }: {
  open: boolean;
  onClose: () => void;
  onDetected: (boleto: BoletoParsed) => void;
}) {
  return (
    <ScannerModal
      open={open}
      onClose={onClose}
      withNfe={false}
      onScan={(s) => { if (s.kind === "BOLETO") onDetected(s.boleto); }}
    />
  );
}

// Scanner de boleto + NF — Controle de Compras.
export function DocScannerModal({ open, onClose, onDetected }: {
  open: boolean;
  onClose: () => void;
  onDetected: (scan: DocScan) => void;
}) {
  return <ScannerModal open={open} onClose={onClose} withNfe onScan={onDetected} />;
}
