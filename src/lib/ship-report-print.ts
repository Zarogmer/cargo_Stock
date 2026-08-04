// Geração dos PDFs dos Relatórios de Bordo (aba Relatórios).
//
// Os três relatórios saem como HTML de impressão numa janela nova — o usuário
// imprime/salva como PDF pelo diálogo do navegador (mesmo caminho no celular).
//   1. Cleaning Report (1 página, conteúdo em inglês pro agente/armador)
//   2. Relatório Fotográfico (capa + 1 foto por página)
//   3. Avaliação de Desempenho (cards com estrelas por colaborador)
//
// O VISUAL é o do Cargo Stock (azul #1e40af + slate + âmbar, títulos alinhados
// à esquerda, faixas claras com filete azul, cartões arredondados) — de
// propósito diferente do modelo navy+dourado de mercado que serviu de
// referência inicial de CONTEÚDO. O nome que assina segue sendo Cargo Ships
// Cleaning. Ao mexer aqui, mantenha essa distância visual.
//
// Todos levam a marca d'água da logo da Cargo: translúcida no fundo de cada
// página, e nas fotos ela já vem queimada desde o upload (src/lib/watermark.ts).

export interface HoldRow {
  label: string;
  status: string; // PENDENTE | EM_ANDAMENTO | COMPLETO
  // Legado: horário geral (relatórios de antes das fases de água).
  start_time: string | null;
  end_time: string | null;
  // Fases da lavagem: água salgada (lavagem) e água doce (enxágue).
  salt_start: string | null;
  salt_end: string | null;
  fresh_start: string | null;
  fresh_end: string | null;
  completion_pct: number;
}

export interface ActivityRow {
  time_range: string | null;
  activity: string;
  hold_label: string | null;
}

export interface PhotoMeta {
  id: number;
  hold_label: string | null;
  stage: string; // ANTES | DURANTE | DEPOIS
  caption: string | null;
}

export interface EvaluationPrintRow {
  name: string;
  function_name: string | null;
  productivity: number;
  quality: number;
  teamwork: number;
  safety: number;
  initiative: number;
  punctuality: number;
  technical: number;
  comments: string | null;
}

export const EVAL_CRITERIA: { key: keyof EvaluationPrintRow; label: string }[] = [
  { key: "productivity", label: "Produtividade" },
  { key: "quality", label: "Qualidade no trabalho" },
  { key: "teamwork", label: "Trabalho em equipe" },
  { key: "safety", label: "Segurança e uso de EPI" },
  { key: "initiative", label: "Iniciativa" },
  { key: "punctuality", label: "Pontualidade" },
  { key: "technical", label: "Habilidade técnica" },
];

// Paleta do Cargo Stock (mesma do app — src/app/globals.css).
const BRAND = "#1e40af";
const BRAND_DK = "#1e3a8a";
const INK = "#0f172a";
const MUTED = "#64748b";
const LINE = "#e2e8f0";
const SOFT = "#f1f5f9";
const AMBER = "#f59e0b";

const FONT = `"Segoe UI", system-ui, Roboto, Helvetica, Arial, sans-serif`;

// Cabeçalho de marca comum aos três relatórios: logo à esquerda, assinatura da
// empresa à direita e filete azul embaixo.
function brandHeader(subtitle: string): string {
  return `
  <div class="brand">
    <img class="brand-logo" src="${logoUrl()}" alt="Cargo Ships Cleaning" />
    <div class="brand-txt">
      <p class="brand-name">CARGO SHIPS CLEANING</p>
      <p class="brand-sub">${esc(subtitle)}</p>
    </div>
  </div>`;
}

function brandCss(): string {
  return `
    .brand { display: flex; align-items: center; gap: 12px; padding-bottom: 10px;
             border-bottom: 3px solid ${BRAND}; }
    .brand-logo { width: 46px; }
    .brand-txt { line-height: 1.3; }
    .brand-name { font-size: 13px; font-weight: bold; color: ${BRAND_DK}; letter-spacing: 1.6px; }
    .brand-sub { font-size: 9.5px; color: ${MUTED}; letter-spacing: 1.2px; text-transform: uppercase; }
  `;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function logoUrl(): string {
  return `${window.location.origin}/cargo-logo.png`;
}

function photoUrl(id: number): string {
  return `${window.location.origin}/api/relatorios/fotos/${id}`;
}

// Marca d'água de página: logo grande, translúcida, centrada. position:fixed
// faz o navegador repetir em TODAS as páginas impressas.
function watermarkCss(): string {
  return `
    .page-watermark {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      width: 62%; opacity: 0.055; z-index: 0; pointer-events: none;
    }
    @media print { .page-watermark { opacity: 0.055; } }
  `;
}

function watermarkImg(): string {
  return `<img class="page-watermark" src="${logoUrl()}" alt="" />`;
}

// No app desktop (Electron) existe um gerador de PDF de verdade: manda o HTML
// pro processo principal, que salva em Downloads e abre o arquivo — sem o
// diálogo de impressão do Windows. Só existe a partir do setup 0.2.4; versões
// antigas não têm `savePdf` e seguem no caminho de impressão do navegador.
type ElectronBridge = {
  savePdf?: (html: string, fileName: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
};

function electronBridge(): ElectronBridge | null {
  return (window as unknown as { electronAPI?: ElectronBridge }).electronAPI || null;
}

// A janela oculta que gera o PDF não tem a sessão do usuário, então as fotos
// (/api/relatorios/fotos/:id) e a logo viram data URL antes de sair daqui.
async function inlineImages(html: string): Promise<string> {
  const urls = [...new Set([...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]))].filter((u) =>
    /^https?:/i.test(u)
  );
  const map = new Map<string, string>();

  await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) return;
        const blob = await res.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(blob);
        });
        map.set(url, dataUrl);
      } catch {
        // imagem que não baixou fica com a URL original (some no PDF, mas o
        // resto do relatório sai).
      }
    })
  );

  return html.replace(/src="([^"]+)"/g, (m, u: string) => (map.has(u) ? `src="${map.get(u)}"` : m));
}

// Primeiro tenta janela nova (navegador comum). Quando o pop-up é bloqueado —
// caso do app desktop (o Electron nega janela filha de about:blank em builds
// antigos) — cai pra um iframe invisível na própria página: o AUTO_PRINT do
// html chama o window.print() do iframe e o diálogo de impressão (com "Salvar
// como PDF") abre do mesmo jeito. O iframe fica montado até a próxima
// impressão — remover cedo demais cancelaria o diálogo aberto.
let printFrame: HTMLIFrameElement | null = null;

function openPrintWindow(html: string, fileName: string) {
  const bridge = electronBridge();
  if (bridge?.savePdf) {
    // O AUTO_PRINT não vai junto: a janela oculta só renderiza, quem gera o
    // arquivo é o printToPDF do Electron.
    inlineImages(html.replace(AUTO_PRINT, ""))
      .then((inlined) => bridge.savePdf!(inlined, fileName))
      .then((res) => {
        if (!res?.ok) throw new Error(res?.error || "falhou");
      })
      .catch(() => printInBrowser(html)); // deu ruim: volta pro diálogo de impressão
    return;
  }
  printInBrowser(html);
}

function printInBrowser(html: string) {
  const win = window.open("", "_blank");
  if (win) {
    win.document.open();
    win.document.write(html);
    win.document.close();
    return;
  }

  printFrame?.remove();
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  // 1x1 no canto (display:none/visibility:hidden deixariam a impressão em
  // branco em alguns engines).
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;";
  document.body.appendChild(frame);
  const doc = frame.contentWindow?.document;
  if (!doc) {
    frame.remove();
    alert("O navegador bloqueou a janela do relatório. Habilite pop-ups e tente de novo.");
    return;
  }
  printFrame = frame;
  doc.open();
  doc.write(html);
  doc.close();
}

const AUTO_PRINT = `<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},500);});</script>`;

function formatDayMonthYear(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-BR");
}

// Locais de foto fora dos porões (PHOTO_PLACES da tela de Relatórios) → inglês
// do PDF. Chave em minúsculas pra casar sem depender de caixa.
const PHOTO_PLACE_EN: Record<string, string> = {
  "carregamento do caminhão": "TRUCK LOADING",
  "embarque de material": "MATERIAL BOARDING",
  "navio": "VESSEL",
  "desembarque do navio": "VESSEL DISEMBARKATION",
  "descarregamento do caminhão": "TRUCK UNLOADING",
};

// Ordem em que os locais aparecem no relatório fotográfico: a sequência real da
// operação, pra o PDF já sair na ordem que o cliente lê —
// caminhão → material → navio → porões 1..N → desembarque → descarregamento.
// Local digitado à mão ("Outro local...") entra depois dos porões, ainda a
// bordo, antes da volta.
const PHOTO_PLACE_ORDER: Record<string, number> = {
  "carregamento do caminhão": 10,
  "embarque de material": 20,
  "navio": 30,
  "desembarque do navio": 900,
  "desembarque de material": 900,
  "descarregamento do caminhão": 910,
};

function placeRank(label: string | null): number {
  const l = (label || "").trim().toLowerCase();
  if (!l) return 0; // Geral / costado sem área
  const m = l.match(/por[aã]o\s*#?\s*(\d+)/);
  if (m) return 100 + Number(m[1]);
  return PHOTO_PLACE_ORDER[l] ?? 500;
}

// "Porão 3" → "CARGO HOLD #3" (os relatórios de lavagem/fotos saem em inglês,
// como os modelos — vão pro agente/armador). Outros rótulos: caixa alta.
function holdLabelEn(label: string | null, kind: "EMBARQUE" | "COSTADO"): string {
  if (!label) return kind === "COSTADO" ? "HULL SIDE" : "GENERAL";
  const m = label.match(/por[aã]o\s*#?\s*(\d+)/i);
  if (m) return `CARGO HOLD #${m[1]}`;
  return PHOTO_PLACE_EN[label.trim().toLowerCase()] || label.toUpperCase();
}

const STAGE_EN: Record<string, string> = {
  ANTES: "BEFORE CLEANING",
  DURANTE: "DURING CLEANING",
  DEPOIS: "AFTER CLEANING",
};

const HOLD_STATUS_EN: Record<string, string> = {
  PENDENTE: "Pending",
  EM_ANDAMENTO: "In progress",
  COMPLETO: "Complete",
};

// ── 1. Cleaning Report (1 página) ────────────────────────────────────────────

export function printCleaningReport(opts: {
  vesselName: string;
  kind: "EMBARQUE" | "COSTADO";
  reportDate: string | null;
  port: string | null;
  complete: boolean;
  holds: HoldRow[];
  activities: ActivityRow[];
  remarks: string | null;
  etcDate: string | null;
  etcTime: string | null;
  supervisorName: string;
}) {
  const isCostado = opts.kind === "COSTADO";
  const title = isCostado ? "Costado (Hull Side) Cleaning Report" : "Cargo Hold Cleaning Report";
  const areaCol = isCostado ? "AREA" : "CARGO HOLD";
  const section1 = isCostado
    ? "1. OPERATIONAL STATUS OF HULL SIDE CLEANING"
    : "1. OPERATIONAL STATUS OF CARGO HOLDS CLEANING";
  const dateStr = formatDayMonthYear(opts.reportDate);
  const statusBadge = opts.complete
    ? `<span class="badge ok">COMPLETE</span>`
    : `<span class="badge warn">IN PROGRESS</span>`;

  // Com qualquer fase de água preenchida, a tabela mostra as duas colunas
  // (salt water wash / fresh water rinse); senão mantém o formato legado
  // START/COMPLETION dos relatórios antigos.
  const hasPhases = opts.holds.some((h) => h.salt_start || h.salt_end || h.fresh_start || h.fresh_end);
  const range = (a: string | null, b: string | null) =>
    a || b ? `${esc(a || "…")} – ${esc(b || "…")}` : "—";

  const holdsHead = hasPhases
    ? `<tr><th>${esc(areaCol)}</th><th>STATUS</th><th class="c">SALT WATER WASH</th><th class="c">FRESH WATER RINSE</th><th class="c">COMPLETION %</th></tr>`
    : `<tr><th>${esc(areaCol)}</th><th>STATUS</th><th class="c">START TIME</th><th class="c">COMPLETION TIME</th><th class="c">COMPLETION %</th></tr>`;

  // No modo com fases, linha SEM fase mas COM horário legado não pode perder o
  // registro: o intervalo legado sai atravessando as duas colunas ("overall").
  const phaseCells = (h: HoldRow) => {
    const hasOwnPhase = h.salt_start || h.salt_end || h.fresh_start || h.fresh_end;
    if (!hasOwnPhase && (h.start_time || h.end_time)) {
      return `<td class="c" colspan="2">${range(h.start_time, h.end_time)} <span class="muted">(overall)</span></td>`;
    }
    return `<td class="c">${range(h.salt_start, h.salt_end)}</td>
            <td class="c">${range(h.fresh_start, h.fresh_end)}</td>`;
  };

  const holdsRows = opts.holds.length
    ? opts.holds
        .map(
          (h) => `<tr>
            <td>${esc(h.label)}</td>
            <td>${esc(HOLD_STATUS_EN[h.status] || h.status)}</td>
            ${
              hasPhases
                ? phaseCells(h)
                : `<td class="c">${esc(h.start_time || "—")}</td>
            <td class="c">${esc(h.end_time || "—")}</td>`
            }
            <td class="c b">${esc(h.completion_pct)}%</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="c muted">No data.</td></tr>`;

  const actRows = opts.activities.length
    ? opts.activities
        .map(
          (a) => `<tr>
            <td>${esc(a.time_range || "—")}</td>
            <td>${esc(a.activity)}</td>
            <td class="c">${esc(a.hold_label || "—")}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="c muted">No activities recorded.</td></tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8" />
<title>${esc(opts.vesselName)} - Cleaning Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @page { size: A4; margin: 10mm; }
  body { font-family: ${FONT}; color: ${INK}; font-size: 11px;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${watermarkCss()}
  ${brandCss()}
  .content { position: relative; z-index: 1; }
  .title { margin-top: 14px; }
  .title h1 { font-size: 22px; color: ${INK}; letter-spacing: -0.2px; }
  .title .rule { width: 54px; height: 4px; background: ${AMBER}; border-radius: 2px; margin-top: 7px; }
  .info { display: flex; gap: 8px; margin-top: 14px; }
  .info > div { flex: 1; background: ${SOFT}; border-radius: 8px; padding: 9px 11px; }
  .lbl { font-size: 8px; color: ${MUTED}; letter-spacing: 0.9px; font-weight: bold; }
  .val { font-size: 12.5px; font-weight: bold; margin-top: 4px; color: ${INK}; }
  .bar { background: ${SOFT}; border-left: 4px solid ${BRAND}; border-radius: 0 7px 7px 0;
         color: ${BRAND_DK}; font-weight: bold; font-size: 10.5px; letter-spacing: 0.4px;
         padding: 8px 12px; margin: 15px 0 7px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { color: ${MUTED}; font-size: 8.5px; letter-spacing: 0.7px; font-weight: bold;
             padding: 0 10px 6px; text-align: left; border-bottom: 2px solid ${BRAND}; }
  tbody td { padding: 7px 10px; border-bottom: 1px solid ${LINE}; font-size: 10.5px; }
  td.c, th.c { text-align: center; }
  td.b { font-weight: bold; color: ${BRAND_DK}; }
  .muted { color: ${MUTED}; }
  .box { border: 1px solid ${LINE}; border-radius: 8px; background: #fff; padding: 11px 12px;
         min-height: 34px; font-size: 10.5px; }
  .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; color: #fff;
           font-size: 9px; font-weight: bold; letter-spacing: 0.3px; }
  .badge.ok { background: #10b981; }
  .badge.warn { background: ${AMBER}; }
  .sig td { padding: 11px 10px; }
  .sig .line { display: inline-block; min-width: 130px; border-bottom: 1px solid ${MUTED}; }
  .footer { display: flex; justify-content: space-between; color: ${MUTED}; font-size: 9px;
            margin-top: 18px; border-top: 1px solid ${LINE}; padding-top: 8px; }
</style></head><body>
${watermarkImg()}
<div class="content">
  ${brandHeader("Marine Operations")}

  <div class="title">
    <h1>${esc(title)}</h1>
    <div class="rule"></div>
  </div>

  <div class="info">
    <div><p class="lbl">VESSEL NAME</p><p class="val">${esc(opts.vesselName)}</p></div>
    <div><p class="lbl">DATE</p><p class="val">${esc(dateStr)}</p></div>
    <div><p class="lbl">PORT / ANCHORAGE</p><p class="val">${esc(opts.port || "—")}</p></div>
    <div><p class="lbl">REPORT STATUS</p><p class="val">${statusBadge}</p></div>
  </div>

  <div class="bar">${esc(section1)}</div>
  <table>
    <thead>${holdsHead}</thead>
    <tbody>${holdsRows}</tbody>
  </table>

  <div class="bar">2. DAILY ACTIVITIES LOG</div>
  <table>
    <thead><tr><th>TIME INTERVAL</th><th>ACTIVITY</th><th class="c">${isCostado ? "AREA" : "HOLD"}</th></tr></thead>
    <tbody>${actRows}</tbody>
  </table>

  <div class="bar">3. REMARKS</div>
  <div class="box">${esc(opts.remarks || "No remarks.")}</div>

  <div class="bar">4. ESTIMATED TIME OF COMPLETION (ETC)</div>
  <div class="info">
    <div><p class="lbl">ETC DATE</p><p class="val">${esc(opts.etcDate || "—")}</p></div>
    <div><p class="lbl">ETC TIME (LT)</p><p class="val">${esc(opts.etcTime || "—")}</p></div>
  </div>

  <div class="bar">5. SIGNATURES</div>
  <table class="sig">
    <thead><tr><th>ROLE</th><th>NAME</th><th>DATE</th><th>SIGNATURE</th></tr></thead>
    <tbody>
      <tr><td>Cleaning Supervisor</td><td>${esc(opts.supervisorName)}</td><td>${esc(dateStr)}</td><td><span class="line"></span></td></tr>
      <tr><td></td><td></td><td></td><td><span class="line"></span></td></tr>
    </tbody>
  </table>

  <div class="footer">
    <span>${esc(opts.vesselName)} &middot; ${esc(opts.port || "")}${opts.port ? " &middot; " : ""}${esc(dateStr)}</span>
    <span>Cargo Ships Cleaning</span>
  </div>
</div>
${AUTO_PRINT}
</body></html>`;

  openPrintWindow(html, `Cleaning Report - ${opts.vesselName} - ${dateStr}`);
}

// ── 2. Relatório Fotográfico (capa + 1 foto por página) ─────────────────────

export function printPhotoReport(opts: {
  vesselName: string;
  kind: "EMBARQUE" | "COSTADO";
  reportDate: string | null;
  photos: PhotoMeta[];
}) {
  const isCostado = opts.kind === "COSTADO";
  const dateStr = formatDayMonthYear(opts.reportDate);

  // Agrupa por porão/área e ordena pela sequência da operação (placeRank):
  // carregamento → embarque de material → navio → porões 1..N → desembarque →
  // descarregamento. Dentro do local, as fases vêm Antes→Durante→Depois.
  const stageOrder = ["ANTES", "DURANTE", "DEPOIS"];
  const groups = new Map<string, PhotoMeta[]>();
  for (const p of opts.photos) {
    const key = `${p.hold_label || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  const groupKeys = [...groups.keys()].sort((a, b) => {
    const diff = placeRank(a) - placeRank(b);
    return diff !== 0 ? diff : a.localeCompare(b, "pt-BR", { numeric: true });
  });

  // "Porões inspecionados" conta só porão mesmo — caminhão/navio não entram.
  const holdKeys = groupKeys.filter((k) => /por[aã]o/i.test(k));
  const inspected = isCostado
    ? groupKeys.filter((k) => k !== "").length || groups.size
    : holdKeys.length;

  let pages = "";
  for (const key of groupKeys) {
    const items = groups.get(key)!;
    // Fotos SEM fase de lavagem (stage GERAL — locais do ciclo: caminhão,
    // embarque de material, navio...) vêm primeiro e sem o sufixo
    // BEFORE/DURING/AFTER; depois as fases na ordem Antes→Durante→Depois.
    const buckets = [
      items.filter((p) => !stageOrder.includes(p.stage)),
      ...stageOrder.map((stage) => items.filter((p) => p.stage === stage)),
    ];
    for (const stageItems of buckets) {
      stageItems.forEach((p, i) => {
        const stageEn = STAGE_EN[p.stage];
        pages += `
  <div class="photo-page">
    <div class="ph-head">
      <span class="ph-title">${esc(holdLabelEn(p.hold_label, opts.kind))}${stageEn ? ` <span class="ph-stage">${esc(stageEn)}</span>` : ""}</span>
      <span class="ph-count">${i + 1} / ${stageItems.length}</span>
    </div>
    <div class="ph-body"><img class="photo" src="${photoUrl(p.id)}" alt="" /></div>
    <div class="ph-foot">
      <span>${p.caption ? esc(p.caption) : `M/V ${esc(bareVesselName(opts.vesselName).toUpperCase())}`}</span>
      <span>${esc(dateStr)}</span>
    </div>
  </div>`;
      });
    }
  }

  const bareVessel = bareVesselName(opts.vesselName);
  const coverTitle = isCostado ? "Costado Cleaning" : "Cargo Hold Cleaning";
  const scopeLabel = isCostado ? "AREAS INSPECTED" : "CARGO HOLDS INSPECTED";

  const html = `<!doctype html><html><head><meta charset="utf-8" />
<title>${esc(opts.vesselName)} - Photographic Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  /* Margem de 10mm → 277mm úteis. As páginas usam 272mm (folga pro
     arredondamento do navegador não gerar página em branco). */
  @page { size: A4; margin: 10mm; }
  body { font-family: ${FONT}; color: ${INK};
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${watermarkCss()}
  ${brandCss()}

  .cover { position: relative; z-index: 1; height: 272mm; display: flex; flex-direction: column;
           page-break-after: always; }
  .cover .kicker { color: ${BRAND}; letter-spacing: 4px; font-size: 11px; font-weight: bold;
                   margin-top: 42mm; }
  .cover h1 { font-size: 44px; line-height: 1.1; color: ${INK}; margin-top: 10px;
              letter-spacing: -0.5px; }
  .cover h1 span { display: block; color: ${BRAND}; }
  .cover .rule { width: 70px; height: 5px; background: ${AMBER}; border-radius: 3px; margin-top: 16px; }
  .cover .sub { color: ${MUTED}; font-size: 13px; margin-top: 14px; letter-spacing: 0.4px; }
  .cover .card { margin-top: 24mm; border: 1px solid ${LINE}; border-radius: 12px; overflow: hidden; }
  .cover .card .row { display: flex; border-bottom: 1px solid ${LINE}; }
  .cover .card .row:last-child { border-bottom: none; }
  .cover .card .k { width: 42%; background: ${SOFT}; color: ${MUTED}; font-size: 9.5px;
                    font-weight: bold; letter-spacing: 1.2px; padding: 13px 16px; }
  .cover .card .v { flex: 1; padding: 13px 16px; font-size: 15px; font-weight: bold; color: ${INK}; }
  .cover .foot { margin-top: auto; border-top: 1px solid ${LINE}; padding-top: 10px;
                 display: flex; justify-content: space-between; color: ${MUTED}; font-size: 10px; }

  /* Página de foto: cabeçalho fixo em cima, rodapé embaixo e a imagem
     centralizada no espaço que sobra (sem folga só de um lado). */
  .photo-page { position: relative; z-index: 1; height: 272mm; display: flex; flex-direction: column;
                page-break-after: always; }
  .photo-page:last-child { page-break-after: auto; }
  .ph-head { display: flex; align-items: center; justify-content: space-between;
             background: ${SOFT}; border-left: 5px solid ${BRAND}; border-radius: 0 8px 8px 0;
             padding: 10px 14px; }
  .ph-title { font-size: 14px; font-weight: bold; color: ${INK}; letter-spacing: 0.3px; }
  .ph-stage { color: ${BRAND}; font-weight: bold; }
  .ph-stage::before { content: "· "; color: ${MUTED}; }
  .ph-count { font-size: 10px; font-weight: bold; color: ${MUTED}; letter-spacing: 1px; }
  .ph-body { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
             padding: 8mm 0; }
  .photo { max-width: 100%; max-height: 232mm; object-fit: contain; border-radius: 6px;
           border: 1px solid ${LINE}; }
  .ph-foot { display: flex; justify-content: space-between; gap: 12px; border-top: 1px solid ${LINE};
             padding-top: 8px; color: ${MUTED}; font-size: 10px; }
  .empty { padding: 24px; color: ${MUTED}; }
</style></head><body>
${watermarkImg()}
<div class="cover">
  ${brandHeader("Photographic Report")}
  <div class="kicker">PHOTOGRAPHIC REPORT</div>
  <h1>${esc(coverTitle)}<span>Report</span></h1>
  <div class="rule"></div>
  <div class="sub">Before, during and after cleaning &middot; operational sequence</div>

  <div class="card">
    <div class="row"><div class="k">VESSEL</div><div class="v">M/V ${esc(bareVessel.toUpperCase())}</div></div>
    <div class="row"><div class="k">DATE</div><div class="v">${esc(dateStr)}</div></div>
    <div class="row"><div class="k">${esc(scopeLabel)}</div><div class="v">${inspected}</div></div>
    <div class="row"><div class="k">PHOTOS</div><div class="v">${opts.photos.length}</div></div>
  </div>

  <div class="foot">
    <span>Cargo Ships Cleaning &middot; Marine Operations</span>
    <span>${esc(dateStr)}</span>
  </div>
</div>
${pages || `<div class="photo-page"><p class="empty">Nenhuma foto adicionada ainda.</p></div>`}
${AUTO_PRINT}
</body></html>`;

  openPrintWindow(html, `Relatorio Fotografico - ${opts.vesselName} - ${dateStr}`);
}

// Muitos navios já vêm cadastrados como "MV FULANO" — tira o prefixo antes de
// estampar "M/V", senão sai "M/V MV FULANO".
function bareVesselName(name: string): string {
  return name.replace(/^m\/?v\.?\s+/i, "");
}

// ── 3. Avaliação de Desempenho ───────────────────────────────────────────────

export function printEvaluationReport(opts: {
  vesselName: string;
  reportDate: string | null;
  rows: EvaluationPrintRow[];
}) {
  const dateStr = formatDayMonthYear(opts.reportDate);

  function stars(n: number): string {
    return "★".repeat(n) + "☆".repeat(5 - n);
  }

  const cards = opts.rows
    .map((r) => {
      const rated = EVAL_CRITERIA.map((c) => ({ label: c.label, value: Number(r[c.key]) || 0 }));
      const withScore = rated.filter((c) => c.value > 0);
      const avg = withScore.length
        ? withScore.reduce((s, c) => s + c.value, 0) / withScore.length
        : 0;
      const weak = withScore.filter((c) => c.value <= 3);

      const rows = rated
        .map(
          (c) => `<tr>
            <td>${esc(c.label)}</td>
            <td class="stars">${c.value > 0 ? `${stars(c.value)} <span class="n">(${c.value})</span>` : `<span class="n">não avaliado</span>`}</td>
          </tr>`
        )
        .join("");

      const weakList = weak.length
        ? `<ul>${weak.map((c) => `<li>${esc(c.label)} (nota ${c.value})</li>`).join("")}</ul>`
        : `<p class="ok">Nenhum ponto crítico — desempenho satisfatório em todos os critérios.</p>`;

      return `
  <div class="card">
    <div class="card-head">
      <p class="name">${esc(r.name)} <span class="fn">— ${esc(r.function_name || "Colaborador")}</span></p>
      <p class="avg">Média: ${avg ? avg.toFixed(1) : "—"}</p>
    </div>
    <table>${rows}</table>
    <p class="sec">Pontos a melhorar:</p>
    <div class="weak">${weakList}</div>
    <p class="sec">Observações do supervisor:</p>
    <div class="obs">${esc(r.comments || "—")}</div>
  </div>`;
    })
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8" />
<title>Avaliação de desempenho - ${esc(opts.vesselName)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @page { size: A4; margin: 12mm; }
  body { font-family: ${FONT}; color: ${INK}; font-size: 12px;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${watermarkCss()}
  ${brandCss()}
  .content { position: relative; z-index: 1; }
  h1 { font-size: 22px; color: ${INK}; margin-top: 14px; letter-spacing: -0.2px; }
  .rule { width: 54px; height: 4px; background: ${AMBER}; border-radius: 2px; margin-top: 7px; }
  .sub { color: ${MUTED}; font-size: 11px; margin: 9px 0 16px; }
  .sub b { color: ${INK}; }
  .card { border: 1px solid ${LINE}; border-left: 4px solid ${BRAND}; border-radius: 10px;
          padding: 14px 16px; margin-bottom: 14px;
          break-inside: avoid; page-break-inside: avoid; background: #fff; }
  .card-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .name { font-size: 15px; font-weight: bold; color: ${INK}; }
  .fn { font-size: 11px; font-weight: normal; color: ${MUTED}; }
  .avg { color: ${BRAND}; font-weight: bold; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 8px; border-bottom: 1px solid ${SOFT}; font-size: 11.5px; }
  td.stars { text-align: right; color: ${AMBER}; letter-spacing: 2px; white-space: nowrap; }
  td.stars .n { color: ${MUTED}; letter-spacing: 0; }
  .sec { font-weight: bold; font-size: 11.5px; margin-top: 9px; color: ${BRAND_DK}; }
  .weak ul { margin: 4px 0 0 20px; color: #b42318; }
  .weak li { margin-bottom: 2px; }
  .ok { color: #047857; margin-top: 4px; }
  .obs { background: ${SOFT}; border-radius: 6px; padding: 8px 10px; margin-top: 4px; min-height: 20px; }
  .footer { display: flex; justify-content: space-between; color: ${MUTED}; font-size: 9px;
            margin-top: 6px; border-top: 1px solid ${LINE}; padding-top: 8px; }
</style></head><body>
${watermarkImg()}
<div class="content">
  ${brandHeader("Recursos Humanos &middot; Bordo")}
  <h1>Avaliação de desempenho</h1>
  <div class="rule"></div>
  <p class="sub">Navio: <b>${esc(opts.vesselName)}</b> &nbsp;•&nbsp; Data: ${esc(dateStr)} &nbsp;•&nbsp; ${opts.rows.length} colaborador(es) avaliado(s)</p>
  ${cards || `<p style="color:${MUTED};">Nenhuma avaliação preenchida ainda.</p>`}
  <div class="footer">
    <span>${esc(opts.vesselName)} &middot; ${esc(dateStr)}</span>
    <span>Cargo Ships Cleaning</span>
  </div>
</div>
${AUTO_PRINT}
</body></html>`;

  openPrintWindow(html, `Avaliacao de Desempenho - ${opts.vesselName} - ${dateStr}`);
}
