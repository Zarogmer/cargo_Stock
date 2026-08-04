// Geração dos PDFs dos Relatórios de Bordo (aba Relatórios).
//
// Os três relatórios saem como HTML de impressão numa janela nova — o usuário
// imprime/salva como PDF pelo diálogo do navegador (mesmo caminho no celular).
// Layouts replicam os modelos de referência aprovados pelo usuário:
//   1. Cleaning Report (1 página, estilo "CARGO HOLD CLEANING REPORT")
//   2. Relatório Fotográfico (capa + 1 foto por página, estilo Deep Water)
//   3. Avaliação de Desempenho (cards com estrelas por colaborador)
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

const NAVY = "#101a33";
const BLUE = "#2d4a8a";
const GOLD = "#c9a44b";

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

function openPrintWindow(html: string) {
  const win = window.open("", "_blank");
  if (!win) {
    alert("O navegador bloqueou a janela do relatório. Habilite pop-ups e tente de novo.");
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
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
  const title = isCostado ? "COSTADO (HULL SIDE) CLEANING REPORT" : "CARGO HOLD CLEANING REPORT";
  const areaCol = isCostado ? "AREA" : "CARGO HOLD";
  const section1 = isCostado
    ? "1. OPERATIONAL STATUS OF HULL SIDE CLEANING"
    : "1. OPERATIONAL STATUS OF CARGO HOLDS CLEANING";
  const dateStr = formatDayMonthYear(opts.reportDate);
  const statusBadge = opts.complete
    ? `<span class="badge ok">✔</span> Complete`
    : `<span class="badge warn">…</span> In progress`;

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
  body { font-family: Arial, Helvetica, sans-serif; color: #1c2333; font-size: 11px;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${watermarkCss()}
  .content { position: relative; z-index: 1; }
  .head { background: ${NAVY}; color: #fff; text-align: center; padding: 16px 12px 12px; }
  .head h1 { font-size: 21px; letter-spacing: 0.5px; }
  .head p { color: #9fb0d8; font-size: 10.5px; margin-top: 5px; }
  .info { display: flex; border: 1px solid #d8dee9; }
  .info > div { flex: 1; padding: 9px 12px; border-right: 1px solid #d8dee9; }
  .info > div:last-child { border-right: none; }
  .lbl { font-size: 8px; color: #7a8699; letter-spacing: 0.8px; font-weight: bold; }
  .val { font-size: 12px; font-weight: bold; margin-top: 4px; }
  .bar { background: ${NAVY}; color: #fff; font-weight: bold; font-size: 10.5px;
         letter-spacing: 0.4px; padding: 7px 12px; margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { background: ${BLUE}; color: #fff; font-size: 9px; letter-spacing: 0.6px;
             padding: 7px 10px; text-align: left; }
  tbody td { padding: 7px 10px; border-bottom: 1px solid #e6eaf2; font-size: 10.5px; }
  tbody tr:nth-child(odd) { background: #f4f6fa; }
  td.c, th.c { text-align: center; }
  td.b { font-weight: bold; }
  .muted { color: #8a94a6; }
  .box { border: 1px solid #d8dee9; background: #f4f6fa; padding: 12px; min-height: 34px;
         font-size: 10.5px; }
  .badge { display: inline-block; width: 13px; height: 13px; border-radius: 3px; color: #fff;
           font-size: 9px; text-align: center; line-height: 13px; margin-right: 4px; }
  .badge.ok { background: #22a06b; }
  .badge.warn { background: #d97706; }
  .sig td { padding: 10px; }
  .sig .line { display: inline-block; min-width: 130px; border-bottom: 1px solid #7a8699; }
  .footer { text-align: center; color: #8a94a6; font-size: 9px; margin-top: 18px; }
</style></head><body>
${watermarkImg()}
<div class="content">
  <div class="head"><h1>${esc(title)}</h1><p>Cargo Ships Cleaning &middot; Marine Operations</p></div>

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

  <p class="footer">${esc(opts.vesselName)} &middot; ${esc(isCostado ? "Costado Cleaning Report" : "Cargo Hold Cleaning Report")} &middot; ${esc(opts.port || "")}${opts.port ? ", " : ""}${esc(dateStr)}</p>
</div>
${AUTO_PRINT}
</body></html>`;

  openPrintWindow(html);
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

  // Agrupa por porão/área (ordem alfabética-numérica) e etapa (Antes→Durante→Depois).
  const stageOrder = ["ANTES", "DURANTE", "DEPOIS"];
  const groups = new Map<string, PhotoMeta[]>();
  for (const p of opts.photos) {
    const key = `${p.hold_label || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  const groupKeys = [...groups.keys()].sort((a, b) =>
    a.localeCompare(b, "pt-BR", { numeric: true })
  );

  const inspected = groupKeys.filter((k) => k !== "").length || groups.size;

  let pages = "";
  for (const key of groupKeys) {
    const items = groups.get(key)!;
    for (const stage of stageOrder) {
      const stageItems = items.filter((p) => p.stage === stage);
      stageItems.forEach((p, i) => {
        const header = `${holdLabelEn(p.hold_label, opts.kind)} — ${STAGE_EN[stage] || stage} (${i + 1}/${stageItems.length})`;
        pages += `
  <div class="photo-page">
    <div class="photo-head">${esc(header)}</div>
    <img class="photo" src="${photoUrl(p.id)}" alt="" />
    ${p.caption ? `<p class="caption">${esc(p.caption)}</p>` : ""}
  </div>`;
      });
    }
  }

  // Muitos navios já vêm cadastrados como "MV FULANO" — tira o prefixo antes
  // de estampar "M/V" na capa, senão sai "M/V MV FULANO".
  const bareVessel = opts.vesselName.replace(/^m\/?v\.?\s+/i, "");
  const coverTitle = isCostado ? "COSTADO<br/>CLEANING REPORT" : "HOLD CLEANING<br/>REPORT";
  const coverFoot = isCostado ? `AREAS INSPECTED: ${inspected}` : `CARGO HOLDS INSPECTED: ${inspected}`;

  const html = `<!doctype html><html><head><meta charset="utf-8" />
<title>${esc(opts.vesselName)} - Photographic Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  @page { size: A4; margin: 8mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1c2333;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${watermarkCss()}
  .cover { position: relative; z-index: 1; height: 96vh; border: 1px solid ${GOLD};
           outline: 3px double #e6d9b8; outline-offset: -8px;
           display: flex; flex-direction: column; align-items: center; text-align: center;
           padding: 48px 24px 32px; page-break-after: always; }
  .cover .logo { width: 170px; margin-bottom: 18px; }
  .cover .kicker { color: ${GOLD}; letter-spacing: 6px; font-size: 12px; font-weight: bold; }
  .cover .rule { width: 90px; border-bottom: 3px solid ${NAVY}; margin: 10px auto 0; }
  .cover h1 { color: ${NAVY}; font-size: 42px; letter-spacing: 3px; margin-top: 110px; line-height: 1.25; }
  .cover .sub { color: #55607a; letter-spacing: 4px; font-size: 13px; margin-top: 12px; }
  .cover .band { background: ${NAVY}; color: #fff; width: 82%; padding: 16px 10px; margin-top: 48px; }
  .cover .band .v { color: ${GOLD}; letter-spacing: 5px; font-size: 10px; font-weight: bold; }
  .cover .band .name { font-size: 30px; font-weight: bold; letter-spacing: 2px; margin-top: 6px; }
  .cover .date { margin-top: 26px; font-size: 15px; font-family: "Courier New", monospace; }
  .cover .foot { margin-top: auto; color: #55607a; letter-spacing: 3px; font-size: 11px;
                 border-top: 1px solid ${GOLD}; padding-top: 12px; min-width: 55%; }
  .photo-page { position: relative; z-index: 1; page-break-after: always; }
  .photo-page:last-child { page-break-after: auto; }
  .photo-head { background: ${NAVY}; color: #fff; font-weight: bold; font-size: 15px;
                letter-spacing: 0.5px; padding: 10px 14px; }
  .photo { width: 100%; margin-top: 4px; }
  .caption { color: #55607a; font-size: 11px; padding: 6px 2px; }
</style></head><body>
${watermarkImg()}
<div class="cover">
  <img class="logo" src="${logoUrl()}" alt="Cargo Ships Cleaning" />
  <div class="kicker">PHOTOGRAPHIC REPORT</div>
  <div class="rule"></div>
  <h1>${coverTitle}</h1>
  <div class="sub">BEFORE &amp; AFTER CLEANING</div>
  <div class="band">
    <div class="v">VESSEL</div>
    <div class="name">M/V ${esc(bareVessel.toUpperCase())}</div>
  </div>
  <div class="date">Date: ${esc(dateStr)}</div>
  <div class="foot">${esc(coverFoot)}</div>
</div>
${pages || `<div class="photo-page"><p style="padding:24px;color:#8a94a6;">Nenhuma foto adicionada ainda.</p></div>`}
${AUTO_PRINT}
</body></html>`;

  openPrintWindow(html);
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
  body { font-family: Arial, Helvetica, sans-serif; color: #24292f; font-size: 12px;
         -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  ${watermarkCss()}
  .content { position: relative; z-index: 1; }
  h1 { font-size: 22px; color: #1c2333; }
  .sub { color: #57606a; font-size: 11px; margin: 6px 0 16px; }
  .sub b { color: #1c2333; }
  .card { border: 1px solid #d8dee9; border-radius: 10px; padding: 14px 16px; margin-bottom: 14px;
          break-inside: avoid; page-break-inside: avoid; background: #fff; }
  .card-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
  .name { font-size: 15px; font-weight: bold; color: #1c2333; }
  .fn { font-size: 11px; font-weight: normal; color: #57606a; }
  .avg { color: ${BLUE}; font-weight: bold; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 8px; border-bottom: 1px solid #eef1f5; font-size: 11.5px; }
  td.stars { text-align: right; color: #b8860b; letter-spacing: 2px; white-space: nowrap; }
  td.stars .n { color: #57606a; letter-spacing: 0; }
  .sec { font-weight: bold; font-size: 11.5px; margin-top: 9px; }
  .weak ul { margin: 4px 0 0 20px; color: #b42318; }
  .weak li { margin-bottom: 2px; }
  .ok { color: #7a4d00; margin-top: 4px; }
  .obs { background: #f4f6fa; border-radius: 6px; padding: 8px 10px; margin-top: 4px; min-height: 20px; }
</style></head><body>
${watermarkImg()}
<div class="content">
  <h1>Avaliação de desempenho</h1>
  <p class="sub">Navio: <b>${esc(opts.vesselName)}</b> &nbsp;•&nbsp; Data: ${esc(dateStr)} &nbsp;•&nbsp; ${opts.rows.length} colaborador(es) avaliado(s)</p>
  ${cards || `<p style="color:#8a94a6;">Nenhuma avaliação preenchida ainda.</p>`}
</div>
${AUTO_PRINT}
</body></html>`;

  openPrintWindow(html);
}
