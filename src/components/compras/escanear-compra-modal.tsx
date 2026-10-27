"use client";

import { useEffect, useRef, useState } from "react";
import { formatCurrency, parseDecimalBR } from "@/lib/utils";
import { DuplicateWarning, checkPurchaseDuplicates } from "@/components/compras/duplicate-warning";
import type { DuplicateMatch } from "@/lib/services/purchase-duplicates";
import { STOCK_UNITS, isPackUnit, unitShort } from "@/lib/stock-units";
import { PackContentFields } from "@/components/compras/pack-content-fields";

// "Escanear" do Controle de Compras: a câmera abre direto, o usuário tira uma
// ou mais fotos da MESMA compra (nota fiscal, cupom, boleto, recibo — frente,
// verso, NF + boleto), a IA (/api/compras/escanear) lê fornecedor, data,
// valores, pagamento, vencimentos e os ITENS, e o usuário revisa tudo aqui
// antes de salvar. Cada item vira uma compra no Controle; o lote inteiro vira
// um título só no Contas a Pagar (purchase_orders.batch_id).

export interface ScannedPurchaseItem {
  description: string;
  quantity: number;
  unitValue: number;
  // Unidade da nota (UN, CX, PCT, M...) e, sendo embalagem, o que vem dentro
  // ("CX com 30 DZ") — unitValue é sempre o preço de UMA `unit`.
  unit: string;
  packQty: number | null;
  packUnit: string | null;
  // Destino no Almoxarifado (WarehouseDest da página) — "OUTROS" não lança.
  dest: string;
}

export interface ScannedPurchaseDraft {
  supplier: string | null;
  purchaseDate: string; // YYYY-MM-DD
  paymentMethod: string | null;
  // Vencimentos das parcelas (só vale no FATURADO).
  dueDates: string[];
  digitableLine: string | null;
  // Identificação da nota lida (pra verificação de duplicata nas próximas).
  nfNumber: string | null;
  accessKey: string | null;
  notes: string | null;
  shipId: string | null;
  items: ScannedPurchaseItem[];
}

interface ScanResult {
  document_type: string;
  supplier_name: string | null;
  supplier_status: "cadastro" | "novo" | "vinculado" | null;
  supplier_cnpj: string | null;
  issue_date: string | null;
  total_amount: number | null;
  payment_method: string | null;
  due_dates: string[];
  digitable_line: string | null;
  nf_number: string | null;
  access_key: string | null;
  items: {
    description: string; quantity: number | null; unit: string | null;
    pack_qty: number | null; pack_unit: string | null;
    unit_value: number | null; total_value: number | null;
  }[];
  notes: string | null;
  warnings: string | null;
  // Lançamentos parecidos já no sistema (mesma chave/boleto/NF, ou fornecedor
  // + valor + data próxima) — o aviso "esta compra já foi colocada".
  duplicates: DuplicateMatch[];
}

interface Shot {
  id: number;
  blob: Blob;
  name: string;
  // Miniatura (object URL) — PDF não tem miniatura.
  preview: string | null;
}

interface ItemRow {
  key: number;
  include: boolean;
  description: string;
  quantity: string;
  unit: string;
  packQty: string;
  packUnit: string;
  unitValue: string;
  dest: string;
}

const DOC_LABEL: Record<string, string> = {
  NFE: "Nota fiscal (DANFE)", NFCE: "Cupom fiscal (NFC-e)", CUPOM: "Cupom", BOLETO: "Boleto",
  RECIBO: "Recibo", PEDIDO: "Pedido/orçamento", OUTRO: "Documento",
};

// Lado maior das fotos enviadas pra IA: legível pra nota inteira sem estourar
// o upload no 4G (≈ 300–600 KB por foto em JPEG 0,85).
const MAX_SIDE = 2000;

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmtISO(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

function numInput(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return String(Math.round(n * 10000) / 10000).replace(".", ",");
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Falha ao gerar a foto"))), "image/jpeg", 0.85);
  });
}

// Desenha a fonte reduzida pro lado maior = MAX_SIDE e devolve JPEG.
async function downscale(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas indisponível");
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvasToJpeg(canvas);
}

export function EscanearCompraModal({ open, onClose, onSave, suppliers, ships, destinations, paymentMethods, initialFiles }: {
  open: boolean;
  onClose: () => void;
  // "Importar PDF": arquivos já escolhidos (PDF da NF/boleto ou foto da
  // galeria) — pula a câmera e vai direto pra leitura da IA.
  initialFiles?: File[] | null;
  onSave: (draft: ScannedPurchaseDraft) => Promise<void>;
  suppliers: string[];
  ships: { id: string; label: string }[];
  destinations: { value: string; label: string }[];
  paymentMethods: string[];
}) {
  const [stage, setStage] = useState<"camera" | "reading" | "review">("camera");
  const [shots, setShots] = useState<Shot[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [saving, setSaving] = useState(false);
  // Compra parecida já lançada: lista do aviso e a caixinha "não é a mesma".
  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [dupAck, setDupAck] = useState(false);
  const dupRef = useRef<HTMLDivElement>(null);

  // Campos da revisão
  const [supplier, setSupplier] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(todayISO());
  const [paymentMethod, setPaymentMethod] = useState("");
  const [dueDates, setDueDates] = useState<string[]>([]);
  const [digitableLine, setDigitableLine] = useState("");
  const [notes, setNotes] = useState("");
  const [shipId, setShipId] = useState("");
  const [items, setItems] = useState<ItemRow[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const shotSeq = useRef(0);
  const itemSeq = useRef(0);
  const shotsRef = useRef<Shot[]>([]);
  shotsRef.current = shots;

  // Abre zerado a cada vez. Com arquivos importados, já começa lendo.
  useEffect(() => {
    if (!open) return;
    setShots([]); setError(null); setResult(null); setSaving(false);
    setDuplicates([]); setDupAck(false);
    if (initialFiles?.length) {
      setStage("reading");
      void startWithFiles(initialFiles);
    } else {
      setStage("camera");
    }
    // Só ao abrir — os arquivos importados chegam junto com a abertura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Libera as miniaturas ao fechar.
  useEffect(() => {
    if (open) return;
    shotsRef.current.forEach((s) => s.preview && URL.revokeObjectURL(s.preview));
  }, [open]);

  // Câmera ligada só na etapa de fotos; desliga ao sair dela ou fechar.
  useEffect(() => {
    if (!open || stage !== "camera") return;
    let cancelled = false;
    const video = videoRef.current;
    setCameraError(null);
    setCameraReady(false);
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("sem câmera");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
          setCameraReady(true);
        }
      } catch {
        if (!cancelled) {
          setCameraError("Não consegui abrir a câmera. Libere a permissão de câmera pro site — ou use \"Enviar arquivo\" abaixo.");
        }
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (video) video.srcObject = null;
    };
  }, [open, stage]);

  if (!open) return null;

  function addShot(blob: Blob, name: string) {
    const isPdf = blob.type === "application/pdf";
    const shot: Shot = { id: ++shotSeq.current, blob, name, preview: isPdf ? null : URL.createObjectURL(blob) };
    setShots((prev) => [...prev, shot]);
  }

  function removeShot(id: number) {
    setShots((prev) => {
      const s = prev.find((x) => x.id === id);
      if (s?.preview) URL.revokeObjectURL(s.preview);
      return prev.filter((x) => x.id !== id);
    });
  }

  async function takePhoto() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    try {
      const blob = await downscale(video, video.videoWidth, video.videoHeight);
      addShot(blob, `foto-${shotSeq.current + 1}.jpg`);
      setFlash(true);
      setTimeout(() => setFlash(false), 150);
      try { navigator.vibrate?.(60); } catch { /* sem vibração */ }
    } catch {
      setError("Não consegui capturar a foto — tente de novo.");
    }
  }

  // Arquivo escolhido (PDF vai como está; foto é reduzida) → item da lista.
  async function fileToShot(f: File): Promise<Shot> {
    if (f.type === "application/pdf") return { id: ++shotSeq.current, blob: f, name: f.name, preview: null };
    if (!f.type.startsWith("image/")) throw new Error(`"${f.name}" não é foto nem PDF.`);
    try {
      const bmp = await createImageBitmap(f);
      const blob = await downscale(bmp, bmp.width, bmp.height);
      bmp.close();
      return { id: ++shotSeq.current, blob, name: f.name.replace(/\.\w+$/, "") + ".jpg", preview: URL.createObjectURL(blob) };
    } catch {
      throw new Error(`Não consegui abrir "${f.name}" — envie como JPG/PNG ou PDF.`);
    }
  }

  async function addFiles(list: FileList | null) {
    if (!list) return;
    setError(null);
    for (const f of Array.from(list)) {
      try {
        const shot = await fileToShot(f);
        setShots((prev) => [...prev, shot]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }

  // "Importar PDF": prepara os arquivos e já manda pra IA.
  async function startWithFiles(files: File[]) {
    const ready: Shot[] = [];
    for (const f of files) {
      try { ready.push(await fileToShot(f)); } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    setShots(ready);
    if (ready.length > 0) await analyze(ready);
    else setStage("camera");
  }

  async function analyze(list: Shot[] = shots) {
    if (list.length === 0) return;
    setError(null);
    setStage("reading");
    try {
      const fd = new FormData();
      list.forEach((s) => fd.append("files", s.blob, s.name));
      const res = await fetch("/api/compras/escanear", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
      applyResult(data as ScanResult);
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao ler o documento.");
      setStage("camera");
    }
  }

  function applyResult(r: ScanResult) {
    setResult(r);
    setSupplier(r.supplier_name || "");
    setPurchaseDate(r.issue_date || todayISO());
    const pm = r.payment_method || (r.document_type === "BOLETO" ? "BOLETO" : "");
    setPaymentMethod(pm);
    setDueDates(r.due_dates || []);
    setDigitableLine(r.digitable_line || "");
    setShipId("");
    setDuplicates(r.duplicates || []);
    setDupAck(false);
    // Observação: o que a IA destacou + vencimento do boleto (fora do FATURADO
    // a compra não tem vencimento próprio). Nº da NF e chave de acesso vão em
    // campos próprios da compra, não mais aqui.
    const parts: string[] = [];
    if (pm !== "FATURADO" && r.due_dates?.length) parts.push(`Vencimento ${r.due_dates.map(fmtISO).join(", ")}`);
    if (r.notes) parts.push(r.notes);
    setNotes(parts.join(" · "));
    const rows: ItemRow[] = (r.items || []).map((it) => {
      const qty = it.quantity && it.quantity > 0 ? it.quantity : 1;
      const unit = it.unit_value ?? (it.total_value != null ? it.total_value / qty : null);
      return {
        key: ++itemSeq.current,
        include: true,
        description: it.description,
        quantity: numInput(qty),
        unit: it.unit || "UN",
        packQty: numInput(it.pack_qty),
        packUnit: it.pack_unit || "UN",
        unitValue: numInput(unit),
        dest: "OUTROS",
      };
    });
    if (rows.length === 0) {
      rows.push({
        key: ++itemSeq.current, include: true,
        description: r.supplier_name ? `Compra - ${r.supplier_name}` : "",
        quantity: "1", unit: "UN", packQty: "", packUnit: "UN", unitValue: numInput(r.total_amount), dest: "OUTROS",
      });
    }
    setItems(rows);
  }

  function updateItem(key: number, patch: Partial<ItemRow>) {
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }

  const rowTotal = (it: ItemRow) => parseDecimalBR(it.unitValue) * (parseDecimalBR(it.quantity) || 1);
  const included = items.filter((it) => it.include && it.description.trim());
  const itemsTotal = included.reduce((s, it) => s + rowTotal(it), 0);
  const docTotal = result?.total_amount ?? null;
  const diff = docTotal != null ? Math.round((docTotal - itemsTotal) * 100) / 100 : 0;

  async function handleSave() {
    if (included.length === 0) { setError("Inclua ao menos um item com descrição."); return; }
    if (paymentMethod === "FATURADO" && !dueDates.some((d) => d.trim())) {
      setError("FATURADO precisa de ao menos um vencimento de parcela.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      // Reconfere na hora de salvar, com os dados já revisados — pega o caso
      // de outra pessoa ter salvo a mesma nota enquanto esta tela estava
      // aberta. Lançamento novo na lista exige conferir de novo.
      const fresh = await checkPurchaseDuplicates({
        supplier: supplier.trim() || null,
        description: included.length === 1 ? included[0].description.trim() : null,
        nf_number: result?.nf_number ?? null,
        access_key: result?.access_key ?? null,
        digitable_line: digitableLine.replace(/\D/g, "") || null,
        total: itemsTotal,
        purchase_date: purchaseDate || null,
      });
      if (fresh.length > 0) {
        const known = new Set(duplicates.map((d) => d.id));
        const hasNew = fresh.some((d) => !known.has(d.id));
        setDuplicates(fresh);
        if (hasNew) setDupAck(false);
        if (hasNew || !dupAck) {
          setError("Esta compra já foi colocada no sistema. Se for mesmo outra compra, marque a caixinha do aviso e salve de novo.");
          setTimeout(() => dupRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
          return;
        }
      } else if (duplicates.length > 0) {
        setDuplicates([]);
      }
      await onSave({
        supplier: supplier.trim() || null,
        purchaseDate,
        paymentMethod: paymentMethod || null,
        dueDates: paymentMethod === "FATURADO" ? dueDates.filter((d) => d.trim()) : [],
        digitableLine: digitableLine.replace(/\D/g, "") || null,
        nfNumber: result?.nf_number ?? null,
        accessKey: result?.access_key ?? null,
        notes: notes.trim() || null,
        shipId: shipId || null,
        items: included.map((it) => {
          const packQty = isPackUnit(it.unit) ? parseDecimalBR(it.packQty) : 0;
          return {
            description: it.description.trim(),
            quantity: parseDecimalBR(it.quantity) || 1,
            unitValue: parseDecimalBR(it.unitValue),
            unit: it.unit || "UN",
            packQty: packQty > 0 ? packQty : null,
            packUnit: packQty > 0 ? it.packUnit || "UN" : null,
            dest: it.dest,
          };
        }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao salvar.");
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full px-3 py-2.5 border border-border rounded-lg text-base sm:text-sm bg-white focus:ring-2 focus:ring-primary outline-none";
  const supplierInList = suppliers.some((s) => s.trim().toLowerCase() === supplier.trim().toLowerCase());

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex sm:items-center justify-center sm:p-safe-4">
      <div className="bg-white w-full h-full sm:h-auto sm:max-h-[min(92vh,100%)] sm:max-w-2xl sm:rounded-2xl shadow-xl flex flex-col pt-safe sm:pt-0">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-border shrink-0">
          <h2 className="text-lg font-semibold text-text">
            {stage === "review" ? "Conferir compra" : "📷 Escanear compra"}
          </h2>
          <button type="button" onClick={onClose} disabled={saving} className="p-2 -mr-2 text-text-light hover:text-text text-xl leading-none" title="Fechar">
            ✕
          </button>
        </div>

        {/* Corpo */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">{error}</div>
          )}

          {stage === "camera" && (
            <>
              <p className="text-sm text-text-light">
                Fotografe a <strong>nota fiscal, cupom, boleto ou recibo</strong>. Pode tirar várias fotos da
                mesma compra (frente e verso, NF + boleto). A IA lê valores, fornecedor, data e itens.
              </p>
              <div className="relative rounded-xl overflow-hidden bg-black aspect-[3/4] sm:aspect-video max-h-[55vh] mx-auto w-full">
                {/* muted + playsInline: iOS/Android exigem pra autoplay da câmera */}
                <video ref={videoRef} className="w-full h-full object-cover" muted playsInline autoPlay />
                {!cameraReady && !cameraError && (
                  <div className="absolute inset-0 flex items-center justify-center text-white/80 text-sm">Abrindo a câmera…</div>
                )}
                {cameraError && (
                  <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-white/90 text-sm">{cameraError}</div>
                )}
                {flash && <div className="absolute inset-0 bg-white/70" />}
                {cameraReady && (
                  <button
                    type="button"
                    onClick={takePhoto}
                    className="absolute bottom-4 left-1/2 -translate-x-1/2 w-16 h-16 rounded-full bg-white border-4 border-white/50 ring-4 ring-black/20 active:scale-95 transition"
                    title="Tirar foto"
                    aria-label="Tirar foto"
                  />
                )}
                {shots.length > 0 && (
                  <span className="absolute top-3 right-3 bg-black/60 text-white text-xs font-semibold px-2 py-1 rounded-full">
                    {shots.length} foto{shots.length > 1 ? "s" : ""}
                  </span>
                )}
              </div>

              {shots.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {shots.map((s) => (
                    <div key={s.id} className="relative shrink-0 w-16 h-20 rounded-lg overflow-hidden border border-border bg-gray-50">
                      {s.preview ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={s.preview} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[10px] text-text-light p-1 text-center">📄 PDF</div>
                      )}
                      <button
                        type="button"
                        onClick={() => removeShot(s.id)}
                        className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white text-xs leading-5"
                        aria-label="Remover foto"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <label className="inline-block text-sm font-medium text-primary hover:underline cursor-pointer">
                📁 Enviar arquivo (foto ou PDF)
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  className="hidden"
                  onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }}
                />
              </label>
            </>
          )}

          {stage === "reading" && (
            <div className="py-16 flex flex-col items-center gap-3 text-center">
              <div className="w-10 h-10 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
              <p className="font-medium text-text">Lendo o documento com IA…</p>
              <p className="text-xs text-text-light">Leva de 10 a 40 segundos. Não feche esta tela.</p>
            </div>
          )}

          {stage === "review" && result && (
            <>
              <div className="bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 text-xs text-sky-800 space-y-1">
                <p>
                  ✨ <strong>{DOC_LABEL[result.document_type] || "Documento"}</strong> lido pela IA
                  {docTotal != null && <> · total {formatCurrency(docTotal)}</>}. Confira antes de salvar.
                </p>
                {result.supplier_status === "novo" && <p>Fornecedor <strong>{supplier}</strong> cadastrado agora pelo CNPJ (Receita Federal).</p>}
                {result.supplier_status === "vinculado" && <p>CNPJ da nota vinculado ao fornecedor <strong>{supplier}</strong>.</p>}
              </div>
              {result.warnings && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">⚠️ {result.warnings}</div>
              )}
              {duplicates.length > 0 && (
                <div ref={dupRef}>
                  <DuplicateWarning duplicates={duplicates} acknowledged={dupAck} onAcknowledge={setDupAck} />
                </div>
              )}
              {(result.nf_number || result.access_key) && (
                <p className="text-[11px] text-text-light">
                  NF {result.nf_number || "?"}
                  {result.access_key && <> · chave {result.access_key}</>}
                </p>
              )}

              <div>
                <label className="block text-sm font-medium mb-1">Fornecedor</label>
                <input
                  type="text"
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                  list="escanear-fornecedores"
                  placeholder="Nome do fornecedor"
                  className={inputCls}
                />
                <datalist id="escanear-fornecedores">
                  {suppliers.map((s) => <option key={s} value={s} />)}
                </datalist>
                {supplier.trim() && !supplierInList && (
                  <p className="text-[11px] text-text-light mt-1">Fora do cadastro de Fornecedores — a compra guarda o nome assim.</p>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1">Data da compra</label>
                  <input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Forma de pagamento</label>
                  <select
                    value={paymentMethod}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPaymentMethod(v);
                      if (v === "FATURADO" && dueDates.length === 0) setDueDates([""]);
                    }}
                    className={inputCls}
                  >
                    <option value="">Selecionar...</option>
                    {paymentMethods.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>

              {paymentMethod === "FATURADO" && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 space-y-2">
                  <p className="text-sm font-medium">Parcelas — vencimento</p>
                  {dueDates.map((d, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-xs text-text-light w-16 shrink-0">Parcela {i + 1}</span>
                      <input
                        type="date"
                        value={d}
                        min={purchaseDate || undefined}
                        onChange={(e) => setDueDates((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                        className={`${inputCls} flex-1 min-w-0`}
                      />
                      {dueDates.length > 1 && (
                        <button type="button" onClick={() => setDueDates((prev) => prev.filter((_, j) => j !== i))} className="p-2 text-danger shrink-0" aria-label="Remover parcela">✕</button>
                      )}
                    </div>
                  ))}
                  <button type="button" onClick={() => setDueDates((prev) => [...prev, ""])} className="text-xs font-medium text-primary hover:underline">
                    + Adicionar parcela
                  </button>
                </div>
              )}

              {/* Itens */}
              <div className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <p className="text-sm font-semibold">Itens ({included.length})</p>
                  <p className="text-[11px] text-text-light">Cada item vira uma compra no Controle</p>
                </div>
                {items.map((it) => (
                  <div key={it.key} className={`border rounded-xl p-3 space-y-2 ${it.include ? "border-border bg-white" : "border-dashed border-border bg-gray-50 opacity-60"}`}>
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={it.include}
                        onChange={(e) => updateItem(it.key, { include: e.target.checked })}
                        className="mt-3 w-5 h-5 shrink-0 accent-primary"
                        aria-label="Incluir item"
                      />
                      <input
                        type="text"
                        value={it.description}
                        onChange={(e) => updateItem(it.key, { description: e.target.value })}
                        placeholder="Descrição"
                        className={`${inputCls} flex-1 min-w-0`}
                      />
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pl-7">
                      <label className="text-[11px] text-text-light">
                        Qtd
                        <input type="text" inputMode="decimal" value={it.quantity} onChange={(e) => updateItem(it.key, { quantity: e.target.value })} className={inputCls} />
                      </label>
                      <label className="text-[11px] text-text-light">
                        Unidade
                        <select value={it.unit} onChange={(e) => updateItem(it.key, { unit: e.target.value })} className={inputCls}>
                          {STOCK_UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
                        </select>
                      </label>
                      <label className="text-[11px] text-text-light">
                        R$ por {unitShort(it.unit) || "un"}
                        <input type="text" inputMode="decimal" value={it.unitValue} onChange={(e) => updateItem(it.key, { unitValue: e.target.value })} className={inputCls} />
                      </label>
                      <div className="text-[11px] text-text-light">
                        Total
                        <div className="px-2 py-2.5 text-sm font-semibold text-primary truncate">{formatCurrency(rowTotal(it))}</div>
                      </div>
                    </div>
                    {isPackUnit(it.unit) && <PackContentFields {...it} inputCls={inputCls} className="ml-7" onChange={(patch) => updateItem(it.key, patch)} />}
                    <div className="pl-7">
                      <select value={it.dest} onChange={(e) => updateItem(it.key, { dest: e.target.value })} className={`${inputCls} !py-2 !text-sm`} aria-label="Destino no Almoxarifado">
                        {destinations.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                      </select>
                    </div>
                  </div>
                ))}
                <div className="flex flex-wrap gap-3 items-center">
                  <button
                    type="button"
                    onClick={() => setItems((prev) => [...prev, { key: ++itemSeq.current, include: true, description: "", quantity: "1", unit: "UN", packQty: "", packUnit: "UN", unitValue: "", dest: "OUTROS" }])}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    + Adicionar item
                  </button>
                  {docTotal != null && Math.abs(diff) >= 0.01 && included.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setItems((prev) => [...prev, {
                        key: ++itemSeq.current, include: true,
                        description: diff > 0 ? "Frete/acréscimos" : "Desconto",
                        quantity: "1", unit: "UN", packQty: "", packUnit: "UN", unitValue: numInput(diff), dest: "OUTROS",
                      }])}
                      className="text-xs font-medium text-amber-700 hover:underline"
                    >
                      + Lançar diferença ({formatCurrency(diff)}) como item
                    </button>
                  )}
                </div>
                <div className="flex justify-between items-center bg-primary/5 border border-primary/20 rounded-xl px-3 py-2">
                  <span className="text-sm">Total dos itens</span>
                  <span className="text-lg font-bold text-primary">{formatCurrency(itemsTotal)}</span>
                </div>
                {docTotal != null && Math.abs(diff) >= 0.01 && (
                  <p className="text-xs text-amber-700">
                    O documento fecha em {formatCurrency(docTotal)} — diferença de {formatCurrency(diff)} (frete, desconto ou item faltando).
                  </p>
                )}
              </div>

              {/* Opcionais */}
              <div className="pt-3 border-t border-border space-y-3">
                <p className="text-[11px] font-semibold text-text-light uppercase tracking-wide">Opcional</p>
                {ships.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Navio</label>
                    <select value={shipId} onChange={(e) => setShipId(e.target.value)} className={inputCls}>
                      <option value="">— Sem navio</option>
                      {ships.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium mb-1">Linha digitável <span className="text-text-light font-normal">(boleto)</span></label>
                  <input type="text" inputMode="numeric" value={digitableLine} onChange={(e) => setDigitableLine(e.target.value)} className={`${inputCls} font-mono`} />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Observação</label>
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`${inputCls} resize-none`} />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Rodapé fixo — botões sempre à mão no celular */}
        <div className="border-t border-border px-4 sm:px-6 py-3 flex gap-2 justify-end shrink-0 pb-safe-4 sm:pb-3 bg-white sm:rounded-b-2xl">
          {stage === "camera" && (
            <>
              <button type="button" onClick={onClose} className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200">
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => analyze()}
                disabled={shots.length === 0}
                className="flex-1 sm:flex-none px-5 py-2.5 text-sm font-semibold rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-40"
              >
                ✨ Escanear{shots.length > 0 ? ` (${shots.length})` : ""}
              </button>
            </>
          )}
          {stage === "review" && (
            <>
              <button type="button" onClick={() => setStage("camera")} disabled={saving} className="px-4 py-2.5 text-sm font-medium rounded-lg bg-gray-100 hover:bg-gray-200">
                Fotos
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || included.length === 0 || (duplicates.length > 0 && !dupAck)}
                className="flex-1 sm:flex-none px-5 py-2.5 text-sm font-semibold rounded-lg bg-primary text-white hover:opacity-90 disabled:opacity-40"
                title={duplicates.length > 0 && !dupAck ? "Confira o aviso de compra já lançada antes de salvar" : undefined}
              >
                {saving
                  ? "Salvando..."
                  : duplicates.length > 0
                    ? "Salvar mesmo assim"
                    : included.length > 1
                      ? `Salvar ${included.length} compras`
                      : "Salvar compra"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

