/**
 * Importa os navios do ano a partir dos fechamentos da diretoria.
 *
 * Fonte oficial: a pasta do servidor
 *   "2 -DIRETORIA/03 - RELATÓRIO DE DESPESAS DE LIMPEZA DE PORÕES"
 * Cada planilha é um navio e começa pelo Nº do ano:
 *   "27 - M/V FEDERAL IMABARI - 5 PORÕES - CIMENTO - PORTO DO AÇU / SANTOS - 12/06/26 À 25/06/26"
 *   "CLIENTE: CONTINENTAL - SUPERVISOR  ELIAS MEDRADO"
 *
 * O que o script faz:
 *   • lê o cabeçalho de cada fechamento (nº, nome, porões, produto, porto, datas,
 *     cliente e serviços);
 *   • navio que JÁ existe no sistema só recebe o `year_number` — nome, cliente,
 *     porto, datas e serviços continuam como o usuário cadastrou;
 *   • navio que falta é criado como CONCLUIDO (histórico), com embarked_at
 *     preenchido pra não cair como "embarque pendente" no Checklist.
 *
 * NÃO cria Job/Pagamento de Navios, escalação nem valores — só o cadastro.
 *
 * Uso (o padrão é simulação; --apply grava):
 *   npx tsx --env-file=.env.local scripts/import-fechamentos-navios.ts
 *   npx tsx --env-file=.env.local scripts/import-fechamentos-navios.ts --apply
 *   ... --dir "C:\caminho\da\pasta" --year 2026
 */
import fs from "fs";
import path from "path";
import XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DEFAULT_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  "CARGO SHIPS CLEANING LTDA",
  "SERVIDOR - Documentos",
  "2 -DIRETORIA",
  "03 - RELATÓRIO DE DESPESAS DE LIMPEZA DE PORÕES",
);

const argv = process.argv.slice(2);

function argOf(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const APPLY = argv.includes("--apply");
const DIR = argOf("--dir") || DEFAULT_DIR;
const YEAR = Number(argOf("--year") || 2026);
const CREATED_BY = "Importação Fechamentos";

// ── Parsing do cabeçalho ────────────────────────────────────────────────────

interface Fechamento {
  file: string;
  number: number;
  name: string;
  arrival: string | null; // YYYY-MM-DD
  departure: string | null; // YYYY-MM-DD
  port: string | null;
  cargo: string | null;
  holds: number | null;
  client: string | null;
  supervisor: string | null;
  services: string[];
}

// Cliente como está escrito na planilha → como o sistema já grava no cadastro.
const CLIENT_MAP: Record<string, string> = {
  DEEP: "Deep",
  CONTINENTAL: "Continental",
  CONTINANETAL: "Continental",
  PLAMAR: "Plamar",
  "WILSON SONS": "Wilson Sons",
  "WILSOM SONS": "Wilson Sons",
  WILSONSONS: "Wilson Sons",
  CARGONAVE: "Cargonave",
  NAABSA: "Naabsa",
  TRANSATLANTICA: "Transatlântica",
};

const CARGO_MAP: Record<string, string> = {
  CARVAO: "CARVÃO",
  CARVÃO: "CARVÃO",
  CIMENTO: "CIMENTO",
  FERTILIZANTE: "FERTILIZANTE",
  UREIA: "UREIA",
  SOJA: "SOJA",
  MILHO: "MILHO",
  AÇUCAR: "AÇÚCAR",
  AÇÚCAR: "AÇÚCAR",
};

// Erros de digitação do cabeçalho das planilhas. O nome certo está no nome do
// arquivo ("05- FECHAMENTO APOGEE ENDEAVOUR - DEEP - COSTADO - OK.xlsx"), mas
// quem manda no cadastro é este mapa — sem ele o navio entra escrito errado e
// não é achado na busca.
const NAME_FIXES: Record<string, string> = {
  "APGOGEE ANDEAVOUR": "APOGEE ENDEAVOUR",
  "MANDARIN KAOHSIUNGE": "MANDARIN KAOHSIUNG",
  "GOLDEN FORTINE": "GOLDEN FORTUNE",
};

const PORT_FIXES: Record<string, string> = {
  "São Francsco do Sul": "São Francisco do Sul",
};

// Siglas de estado no fim do porto ("Mangaratiba Rj") voltam pra caixa alta.
const UF_RE = /(^|[\s-])(RJ|SP|BA|SC|PR|RS|ES|CE|MA|PA|AL|PE|SE|RN|PB|PI|AP|MS|MT|GO)$/i;

/** "SANTOS" → "Santos", preservando barras e hífens do nome do porto. */
function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/([a-zà-ú])([a-zà-ú']*)/g, (_m, a: string, b: string) => a.toUpperCase() + b)
    .replace(/\b(Do|Da|De|Dos|Das|E)\b/g, (m) => m.toLowerCase())
    .replace(UF_RE, (_m, sep: string, uf: string) => sep + uf.toUpperCase());
}

function normalizeName(s: string): string {
  return s
    .toUpperCase()
    .replace(/^M\s*\/?\s*V\s+/, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toIso(d: number, m: number, y: number): string | null {
  const year = y < 100 ? 2000 + y : y;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Datas do cabeçalho. Aceita o erro de digitação "14/0726" (falta uma barra). */
function parseDates(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  const re = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const iso = toIso(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) out.push(iso);
    rest = rest.replace(m[0], " ");
  }
  if (out.length < 2) {
    const re2 = /(\d{1,2})\/(\d{2})(\d{2})(?!\d)/g;
    while ((m = re2.exec(rest))) {
      const iso = toIso(Number(m[1]), Number(m[2]), Number(m[3]));
      if (iso) out.push(iso);
    }
  }
  return out;
}

function parseHeader(file: string, header: string, extraLines: string[]): Fechamento | null {
  const num = /^\s*(\d+)\s*[-–]/.exec(header);
  if (!num) return null;

  const nameMatch = /M\s*\/?\s*V\s+(.+?)\s*[-–]/.exec(header);
  if (!nameMatch) return null;
  const rawName = nameMatch[1].replace(/\s+/g, " ").trim().toUpperCase();
  const name = NAME_FIXES[rawName] || rawName;

  const dates = parseDates(header);
  const arrival = dates[0] || null;
  let departure = dates.length > 1 ? dates[dates.length - 1] : arrival;
  // "13/02/26 À 16/02/25": o ano da saída sai errado à mão — puxa pro da chegada.
  if (arrival && departure && departure < arrival) {
    departure = `${arrival.slice(0, 4)}${departure.slice(4)}`;
    if (departure < arrival) departure = arrival;
  }

  // Tudo que vem antes da 1ª data é "nº - nome - porões - produto - porto".
  const firstDate = /\d{1,2}\/\d{1,2}/.exec(header);
  const head = firstDate ? header.slice(0, firstDate.index) : header;
  const chunks = head
    .split(/[-–]/)
    .map((c) => c.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const holdsM = /(\d+)\s*POR[ÕO]ES/i.exec(header);
  const holds = holdsM ? Number(holdsM[1]) : null;

  // Porto = último pedaço antes da data. "... - BA" (sigla de estado) cola no anterior.
  let port: string | null = null;
  if (chunks.length >= 2) {
    port = chunks[chunks.length - 1];
    if (port.length <= 3 && chunks.length >= 3) port = `${chunks[chunks.length - 2]} - ${port}`;
  }

  // Produto = pedaço logo depois do "X PORÕES", quando não for nome de serviço.
  let cargo: string | null = null;
  const holdsIdx = chunks.findIndex((c) => /POR[ÕO]ES/i.test(c));
  if (holdsIdx >= 0 && holdsIdx + 1 < chunks.length - 1) {
    const c = chunks[holdsIdx + 1];
    if (!/RASPAGEM|PINTURA|LAVAGEM|COSTADO|LIMPEZA/i.test(c)) cargo = c;
  }
  if (cargo) {
    const key = cargo.toUpperCase().replace(/\s+/g, " ").trim();
    cargo = CARGO_MAP[key] || key;
  }

  // Serviços: Costado é excludente; senão lavagem + extras citados no cabeçalho.
  const blob = [header, ...extraLines].join(" ").toUpperCase();
  let services: string[];
  if (/COSTADO/.test(blob)) {
    services = ["COSTADO"];
  } else {
    services = ["LAVAGEM_PORAO"];
    if (/RASPAGEM|RASPASGEM/.test(blob)) services.push("RASPAGEM");
    if (/PINTURA/.test(blob)) services.push("PINTURA");
  }

  // Linha do cliente: "CLIENTE: CONTINENTAL - SUPERVISOR  ELIAS MEDRADO".
  let client: string | null = null;
  let supervisor: string | null = null;
  const clientLine = extraLines.find((l) => /CLIENTE\s*:/i.test(l));
  if (clientLine) {
    const afterLabel = clientLine.replace(/^.*?CLIENTE\s*:\s*/i, "");
    const parts = afterLabel.split(/\s+[-–]\s+/);
    const key = parts[0].replace(/\s+/g, " ").trim().toUpperCase();
    client = CLIENT_MAP[key] || (key ? titleCase(key) : null);
    const sup = parts
      .slice(1)
      .join(" - ")
      .replace(/^\s*SUPERVISOR\s*[-–:]?\s*/i, "")
      .trim();
    supervisor = sup || null;
  }

  return {
    file,
    number: Number(num[1]),
    name,
    arrival,
    departure,
    port: port ? PORT_FIXES[titleCase(port)] || titleCase(port) : null,
    cargo,
    holds: services[0] === "COSTADO" ? null : holds,
    client,
    supervisor,
    services,
  };
}

function readFechamentos(dir: string): Fechamento[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".xlsx") && !f.startsWith("~$"));
  const byNumber = new Map<number, Fechamento>();
  const skipped: string[] = [];
  const isOk = (n: string) => /\bOK\b/i.test(n);

  for (const f of files.sort()) {
    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.readFile(path.join(dir, f), { cellDates: true });
    } catch (e) {
      skipped.push(`${f} (não abriu: ${(e as Error).message})`);
      continue;
    }
    const sheetName =
      wb.SheetNames.find((n) => n.trim().toUpperCase() === "LIMPEZA") || wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[sheetName], {
      header: 1,
      raw: false,
      defval: "",
    });
    const line = (i: number) =>
      (rows[i] || []).map((c) => String(c).trim()).filter(Boolean).join(" ");
    // O cabeçalho mora na linha 10 da planilha; 11 a 14 trazem cliente e extras.
    const header = line(9);
    const fc = parseHeader(f, header, [line(10), line(11), line(12), line(13)]);
    if (!fc) {
      skipped.push(`${f} (cabeçalho não reconhecido: "${header.slice(0, 80)}")`);
      continue;
    }
    if (!fc.arrival || !fc.arrival.startsWith(String(YEAR))) {
      skipped.push(`${f} (fora de ${YEAR}: chegada ${fc.arrival ?? "sem data"})`);
      continue;
    }
    // Duplicata do mesmo nº (o "OK" e o rascunho sem OK): fica o arquivo "OK",
    // que é a versão fechada.
    const prev = byNumber.get(fc.number);
    if (prev) {
      if (isOk(prev.file) && !isOk(fc.file)) {
        skipped.push(`${f} (duplicata do nº ${fc.number})`);
        continue;
      }
      skipped.push(`${prev.file} (duplicata do nº ${fc.number})`);
    }
    byNumber.set(fc.number, fc);
  }

  if (skipped.length) {
    console.log("\nIgnorados:");
    for (const s of skipped) console.log("  -", s);
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

// ── Casamento com os navios já cadastrados ──────────────────────────────────

/** Dice sobre bigramas — "MEGHANA PRESTIGE" x "MEGHNA PRESTIGE" ≈ 0,93. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const bigrams = (s: string) => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hits = 0;
  for (const g of A) if (B.has(g)) hits++;
  return (2 * hits) / (A.size + B.size);
}

function daysApart(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

async function main() {
  if (!fs.existsSync(DIR)) {
    console.error(`Pasta não encontrada: ${DIR}`);
    process.exit(1);
  }
  console.log(`Pasta: ${DIR}`);
  console.log(`Ano:   ${YEAR}`);
  console.log(APPLY ? "Modo:  GRAVANDO (--apply)" : "Modo:  simulação (use --apply pra gravar)");

  const fechamentos = readFechamentos(DIR);
  console.log(`\nFechamentos de ${YEAR}: ${fechamentos.length}`);

  const existing = await prisma.ship.findMany({
    where: {
      arrival_date: { gte: new Date(`${YEAR}-01-01`), lt: new Date(`${YEAR + 1}-01-01`) },
    },
    select: { id: true, name: true, arrival_date: true },
  });

  const used = new Set<string>();
  const updates: { id: string; name: string; fc: Fechamento; score: number }[] = [];
  const creates: Fechamento[] = [];

  for (const fc of fechamentos) {
    const target = normalizeName(fc.name);
    let best: { id: string; name: string; score: number } | null = null;
    for (const e of existing) {
      if (used.has(e.id)) continue;
      const score = similarity(target, normalizeName(e.name));
      const near =
        fc.arrival && e.arrival_date
          ? daysApart(fc.arrival, e.arrival_date.toISOString().slice(0, 10)) <= 5
          : false;
      // Nome idêntico casa sozinho; nome parecido só casa se a data bate.
      const ok = score >= 0.95 || (score >= 0.6 && near);
      if (ok && (!best || score > best.score)) best = { id: e.id, name: e.name, score };
    }
    if (best) {
      used.add(best.id);
      updates.push({ id: best.id, name: best.name, fc, score: best.score });
    } else {
      creates.push(fc);
    }
  }

  const orphans = existing.filter((e) => !used.has(e.id));

  console.log(`\n── Já cadastrados — só recebem o Nº (${updates.length}) ──`);
  for (const u of updates) {
    const flag = u.score < 0.95 ? "   ~casou por data" : "";
    console.log(`  Nº ${String(u.fc.number).padStart(3)}  ${u.name.padEnd(24)} ← ${u.fc.name}${flag}`);
  }

  console.log(`\n── Navios que faltam — serão criados (${creates.length}) ──`);
  for (const c of creates) {
    console.log(
      `  Nº ${String(c.number).padStart(3)}  ${c.name.padEnd(24)} ${c.arrival} → ${c.departure}  ` +
        `${(c.client || "-").padEnd(12)} ${(c.port || "-").padEnd(24)} ` +
        `porões=${String(c.holds ?? "-").padEnd(2)} ${(c.cargo || "-").padEnd(14)} ${c.services.join(",")}`,
    );
  }

  if (orphans.length) {
    console.log(`\n── No sistema sem fechamento na pasta (${orphans.length}) — não são tocados ──`);
    for (const o of orphans) {
      console.log(`  ${o.name} (${o.arrival_date?.toISOString().slice(0, 10)})`);
    }
  }

  if (!APPLY) {
    console.log("\nSimulação — nada foi gravado. Rode de novo com --apply.");
    return;
  }

  let updated = 0;
  for (const u of updates) {
    await prisma.ship.update({ where: { id: u.id }, data: { year_number: u.fc.number } });
    updated++;
  }

  let created = 0;
  for (const c of creates) {
    await prisma.ship.create({
      data: {
        name: c.name,
        year_number: c.number,
        arrival_date: c.arrival ? new Date(`${c.arrival}T00:00:00Z`) : null,
        departure_date: c.departure ? new Date(`${c.departure}T00:00:00Z`) : null,
        port: c.port,
        status: "CONCLUIDO",
        // Navio histórico já embarcou e voltou — sem isso ele reaparece como
        // "embarque pendente" na aba Checklist.
        embarked_at: c.arrival ? new Date(`${c.arrival}T00:00:00Z`) : new Date(),
        cargo_type: c.cargo,
        holds_count: c.holds,
        client_name: c.client,
        services: c.services,
        notes: [
          `Importado do fechamento da diretoria: ${c.file}`,
          c.supervisor ? `Supervisor: ${c.supervisor}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
        created_by: CREATED_BY,
      },
    });
    created++;
  }

  console.log(`\nPronto: ${updated} navios numerados, ${created} criados.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
