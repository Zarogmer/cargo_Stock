"use client";

// Scanner de documento pela câmera (ou foto): lê o código de barras ITF de 44
// dígitos impresso em todo boleto (convertido pra linha digitável e validado
// com o MESMO parser do import de PDF — DVs mod10/mod11) e, no modo NF, também
// o CODE-128 do DANFE (chave de acesso de 44 dígitos) e o QR code da NFC-e.
// Funciona com o documento no papel ou mostrado na tela de um monitor.
//
// Motor: zxing-wasm (o zxing-cpp compilado pra WebAssembly). O port JS antigo
// (@zxing/browser) NÃO decodificava o CODE-128 de DANFEs reais nem em imagem
// perfeita — testado com as NFs de dez/2025 (Astro, Santhiago, Hortifruti,
// Caribe): o wasm leu todas, inclusive PDF escaneado. O .wasm (~1,1 MB) mora
// em public/wasm com a versão no nome (ao atualizar o zxing-wasm no package,
// copie o arquivo de node_modules/zxing-wasm/dist/reader e ajuste WASM_PATH) e
// só é baixado quando o scanner abre de fato.

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import {
  prepareZXingModule,
  readBarcodes,
  type ReadResult,
  type ReaderOptions,
} from "zxing-wasm/reader";
import {
  parseLinhaDigitavel,
  barcodeToLinhaDigitavel,
  type BoletoParsed,
} from "@/lib/services/boleto/linha-digitavel";
import { parseNfeScan, type NfeChaveScan } from "@/lib/services/boleto/nfe-chave";

// Versão presa no package.json (--save-exact); o arquivo em public acompanha.
const WASM_PATH = "/wasm/zxing_reader-3.1.3.wasm";
prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? WASM_PATH : prefix + path,
  },
});

// Resultado do scanner unificado: boleto OU nota fiscal.
export type DocScan =
  | { kind: "BOLETO"; boleto: BoletoParsed }
  | { kind: "NFE"; nfe: NfeChaveScan };

// Boleto usa ITF (Interleaved 2 of 5); o DANFE imprime a chave em CODE-128 e a
// NFC-e usa QR. tryHarder liga rotação/inversão/afins do zxing-cpp.
function readerOptions(withNfe: boolean): ReaderOptions {
  return {
    formats: withNfe ? ["ITF", "Code128", "QRCode"] : ["ITF"],
    tryHarder: true,
    maxNumberOfSymbols: 4,
  };
}

// Código lido → documento validado, ou null. O FORMATO desambigua os 44
// dígitos: ITF é boleto; CODE-128/QR é nota fiscal (chave com modelo e DV
// conferidos) — ambos validam DV, então um não passa pelo parser do outro.
function tryParse(r: ReadResult, withNfe: boolean): DocScan | null {
  if (r.format === "Code128" || r.format === "QRCode") {
    if (!withNfe) return null;
    const nfe = parseNfeScan(r.text);
    return nfe ? { kind: "NFE", nfe } : null;
  }
  const digits = (r.text || "").replace(/\D/g, "");
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

// Primeiro resultado do wasm que vira um documento válido.
function firstScan(results: ReadResult[], withNfe: boolean): DocScan | null {
  for (const r of results) {
    if (!r.isValid || !r.text) continue;
    const scan = tryParse(r, withNfe);
    if (scan) return scan;
  }
  return null;
}

function ScannerModal({ open, onClose, onScan, withNfe }: {
  open: boolean;
  onClose: () => void;
  onScan: (scan: DocScan) => void;
  withNfe: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
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
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // O <video> vive enquanto o modal está aberto — capturado aqui pra usar o
    // MESMO elemento no loop e no cleanup.
    const video = videoRef.current;
    // Frame da câmera → canvas → ImageData → wasm. Um tick por vez (o próximo
    // só agenda depois do decode terminar), então celular lento não acumula.
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    async function tick() {
      if (cancelled || handledRef.current || !video || !ctx) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        try {
          const results = await readBarcodes(
            ctx.getImageData(0, 0, canvas.width, canvas.height),
            readerOptions(withNfe),
          );
          if (cancelled || handledRef.current) return;
          const scan = firstScan(results, withNfe);
          if (scan) {
            handledRef.current = true;
            try { navigator.vibrate?.(150); } catch { /* sem vibração, sem drama */ }
            onScan(scan);
            return;
          }
        } catch { /* frame ruim/wasm carregando — tenta no próximo */ }
      }
      if (!cancelled) timer = setTimeout(tick, 250);
    }

    (async () => {
      try {
        // Resolução alta = mais pixels por barra — essencial pro CODE-128 da
        // chave (277 módulos) lido de longe ou da tela do monitor.
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 2560 },
            height: { ideal: 1440 },
          },
        });
        if (cancelled || !video) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();
        timer = setTimeout(tick, 300);
      } catch {
        setError(
          "Não consegui abrir a câmera. Libere a permissão de câmera pro site, ou use \"Ler de uma foto\" abaixo.",
        );
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(hintTimer);
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    };
    // onScan estável o bastante — religar o scanner só quando abre/fecha.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, withNfe]);

  async function handlePhoto(file: File) {
    setDecodingPhoto(true);
    setError(null);
    try {
      const results = await readBarcodes(file, readerOptions(withNfe));
      const scan = firstScan(results, withNfe);
      if (scan) {
        handledRef.current = true;
        onScan(scan);
      } else if (results.length > 0) {
        setError(
          withNfe
            ? "Achei um código na foto, mas não é um boleto nem uma chave de NF válida — confira se pegou o código certo."
            : "Achei um código na foto, mas não é um boleto válido — confira se é o código de barras do boleto.",
        );
      } else {
        setError("Não achei código de barras na foto. Tente mais perto, com o código inteiro no quadro e boa luz.");
      }
    } catch {
      setError("Não consegui ler a foto — tente outra imagem.");
    } finally {
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
              pro <strong>QR code</strong> da NFC-e (cupom). Vale papel ou tela do monitor; aproxime
              até o código preencher o quadro. Boleto entra com valor e vencimento; NF entra com
              fornecedor, número e chave.
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
