// Extração de NOTA FISCAL (DANFE / NF-e) a partir do PDF, e unificação com o
// boleto num único "documento" pra o import de Contas a Pagar.
//
// Precisão:
//   - Chave de acesso (44 díg) é DETERMINÍSTICA — dela saem CNPJ do emitente
//     (fornecedor), número da NF, série e competência (AAMM). Mesmo espírito do
//     parser de linha digitável do boleto.
//   - Valor total: lido POR POSIÇÃO (o número fica na linha abaixo do rótulo
//     "VALOR TOTAL DA NOTA"); regex de texto puro não resolve por causa da
//     ordem em que o DANFE joga os itens. É uma sugestão revisável.
//   - PDF escaneado (sem camada de texto) não dá pra ler sem OCR → cai no manual.

import { extractPdfItems, type PdfItem } from "./pdf";
import { findLinhaDigitavel, type BoletoParsed } from "./linha-digitavel";
import { chaveDV, chaveFields } from "./nfe-chave";
import { ocrPdf } from "./ocr";

export interface NfeDuplicata {
  numero: string | null; // "001", "002"...
  vencimento: string; // "YYYY-MM-DD"
  valor: number | null;
}

// Linha do quadro DADOS DO PRODUTO/SERVIÇO do DANFE (melhor esforço, por
// posição — layout varia por emissor; linha sem quantidade E sem unitário é
// descartada).
export interface NfeProduto {
  descricao: string;
  quantidade: number | null;
  valorUnit: number | null;
  valorTotal: number | null; // quantidade × unitário (arredondado)
  unidade: string | null; // "UN", "KG"...
}

export interface NfeParsed {
  chave: string; // 44 dígitos
  cnpjEmitente: string; // 14 dígitos
  numero: string; // número da NF (sem zeros à esquerda)
  serie: string;
  modelo: string; // "55" NF-e, "65" NFC-e
  competencia: string; // "YYYY-MM" (da chave)
  emissao: string | null; // "YYYY-MM-DD" (do texto, quando achado)
  emitenteName: string | null;
  valor: number | null; // valor total da nota (sugerido)
  duplicatas: NfeDuplicata[]; // quadro FATURA/DUPLICATA (vazio se a NF não fatura)
  produtos: NfeProduto[]; // itens da nota (vazio quando o layout não deixou ler)
}

export interface DocExtract {
  kind: "BOLETO" | "NFE" | "DESCONHECIDO";
  scanned: boolean; // PDF sem texto legível E que o OCR também não decifrou
  ocr: boolean; // campos vieram de OCR (scan) — sugerir conferência ao usuário
  boleto: BoletoParsed | null;
  nfe: NfeParsed | null;
  cnpj: string | null; // melhor palpite do CNPJ do fornecedor
  amount: number | null; // valor sugerido (boleto: da linha; NF: total)
  dueDate: string | null; // "YYYY-MM-DD" (só boleto)
  digitableLine: string | null;
  suggestedDescription: string;
}

// ── Chave de acesso (DV e campos em ./nfe-chave, compartilhado com o scanner) ─

// Acha a chave: o DANFE imprime como 11 grupos de 4 dígitos. Pegamos o grupo
// com modelo válido (55/65); preferimos o de DV correto.
function findChave(text: string): string | null {
  const flat = text.replace(/\s+/g, " ");
  const cands = (flat.match(/\b\d{4}(?:[\s.]\d{4}){10}\b/g) || [])
    .map((g) => g.replace(/\D/g, ""))
    .filter((x) => x.length === 44);
  for (const c of flat.match(/\d{44}/g) || []) cands.push(c);

  const valid = cands.filter((c) => {
    const modelo = c.slice(20, 22);
    return modelo === "55" || modelo === "65";
  });
  const dvOk = valid.find((c) => chaveDV(c.slice(0, 43)) === Number(c[43]));
  return dvOk ?? valid[0] ?? null;
}

// ── Valor total por posição ─────────────────────────────────────────────────

function brNum(s: string): number | null {
  if (!/^\d{1,3}(?:\.\d{3})*,\d{2}$|^\d+,\d{2}$/.test(s)) return null;
  return parseFloat(s.replace(/\./g, "").replace(",", "."));
}

// Acha o rótulo "VALOR TOTAL DA NOTA" e pega o primeiro número NÃO-ZERO na
// linha imediatamente abaixo (as células vizinhas de imposto costumam ser 0,00).
function valorPorPosicao(items: PdfItem[]): number | null {
  let label: PdfItem | null = null;
  for (let i = 0; i < items.length; i++) {
    if (items[i].s.toUpperCase().includes("TOTAL DA NOTA")) {
      label = items[i];
      break;
    }
  }
  if (!label) {
    for (let i = 0; i + 3 < items.length; i++) {
      const seq = `${items[i].s} ${items[i + 1].s} ${items[i + 2].s} ${items[i + 3].s}`.toUpperCase();
      if (seq.includes("VALOR TOTAL DA NOTA")) {
        label = items[i + 3];
        break;
      }
    }
  }
  if (!label) return null;
  const lbl = label;
  const cands = items
    .filter((it) => it.page === lbl.page && brNum(it.s) != null && it.y < lbl.y && lbl.y - it.y < 40)
    .map((it) => ({ v: brNum(it.s) as number, dx: Math.abs(it.x - lbl.x), dy: lbl.y - it.y }))
    .filter((it) => it.dx < 130)
    .sort((a, b) => a.dy - b.dy || a.dx - b.dx);
  if (cands.length === 0) return null;
  const nonZero = cands.find((c) => c.v > 0);
  return nonZero ? nonZero.v : cands[0].v;
}

// ── Duplicatas (quadro FATURA/DUPLICATA do DANFE) ───────────────────────────
//
// O vencimento da NF fica nas duplicatas, e o layout varia (colunas lado a
// lado ou pilhas verticais). Estratégia POR POSIÇÃO: âncora no rótulo
// "FATURA"/"DUPLICATA", pega as DATAS logo abaixo dele e casa cada data com o
// valor e o número de parcela mais próximos. NF sem esse quadro (venda à
// vista/sem fatura) simplesmente não tem vencimento no PDF.

function parseDateBR(s: string): string | null {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${mo}-${d}`;
}

function duplicatasPorPosicao(items: PdfItem[]): NfeDuplicata[] {
  const label = items.find((it) => /FATURA|DUPLICATA/i.test(it.s));
  if (!label) return [];
  // Região abaixo do rótulo (o quadro tem ~75pt de altura nos layouts comuns).
  const region = items.filter(
    (it) => it.page === label.page && it.y < label.y && label.y - it.y < 75
  );
  const dups: NfeDuplicata[] = [];
  for (const dateIt of region) {
    const venc = parseDateBR(dateIt.s);
    if (!venc) continue;
    // Valor: número BR mais próximo da data (mesma coluna ou célula ao lado).
    const valorIt = region
      .filter((it) => it !== dateIt && brNum(it.s) != null)
      .map((it) => ({ it, dx: Math.abs(it.x - dateIt.x), dy: Math.abs(it.y - dateIt.y) }))
      .filter((c) => c.dx < 80 && c.dy < 20)
      .sort((a, b) => a.dx + a.dy - (b.dx + b.dy))[0];
    // Número da parcela: 1-3 dígitos puros perto da data.
    const numIt = region
      .filter((it) => it !== dateIt && /^\d{1,3}$/.test(it.s))
      .map((it) => ({ it, dx: Math.abs(it.x - dateIt.x), dy: Math.abs(it.y - dateIt.y) }))
      .filter((c) => c.dx < 60 && c.dy < 20)
      .sort((a, b) => a.dx + a.dy - (b.dx + b.dy))[0];
    dups.push({
      numero: numIt ? numIt.it.s : null,
      vencimento: venc,
      valor: valorIt ? brNum(valorIt.it.s) : null,
    });
  }
  dups.sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  return dups;
}

// Fallback por texto: layouts que rotulam cada vencimento ("Dt. Vencimento 03/02/2026").
function duplicatasPorTexto(text: string): NfeDuplicata[] {
  const dups: NfeDuplicata[] = [];
  const re = /Dt\.?\s*Venc[a-zç]*\.?\s*:?\s*(\d{2}\/\d{2}\/\d{4})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const venc = parseDateBR(m[1]);
    if (venc) dups.push({ numero: null, vencimento: venc, valor: null });
  }
  dups.sort((a, b) => a.vencimento.localeCompare(b.vencimento));
  return dups;
}

// ── Produtos (quadro DADOS DO PRODUTO/SERVIÇO) ──────────────────────────────
//
// POR POSIÇÃO, como o valor total: âncora nos rótulos do cabeçalho da tabela
// (DESCRIÇÃO, QUANT, VLR/VALOR UNIT...) e leitura das linhas abaixo, casando
// cada célula pela coluna (x) mais próxima. Layout varia por emissor — linha
// que não tem quantidade nem unitário legível fica de fora; é sugestão
// revisável, nunca substitui a conferência.

// Valor unitário BR: 2 a 6 decimais com vírgula ("38,9900", "2,37833").
function brUnit(s: string): number | null {
  if (!/^\d{1,3}(?:\.\d{3})*,\d{2,6}$|^\d+,\d{2,6}$/.test(s)) return null;
  const v = parseFloat(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

// Quantidade BR: aceita também inteiros ("50", "400") e milhar ("1.000").
function brQty(s: string): number | null {
  if (!/^\d{1,3}(?:\.\d{3})*(?:,\d{1,6})?$|^\d{1,6}(?:,\d{1,6})?$/.test(s)) return null;
  const v = parseFloat(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function produtosPorPosicao(items: PdfItem[]): NfeProduto[] {
  // Âncora: rótulo DESCRIÇÃO da tabela de itens.
  const header =
    items.find((it) => /^DESCRI/i.test(it.s.trim()) && /PRODUTO|SERVI/i.test(it.s)) ||
    items.find((it) => /^DESCRI[ÇC][ÃA]O/i.test(it.s.trim()));
  if (!header) return [];
  const page = items.filter((it) => it.page === header.page);
  // Rótulos de coluna na MESMA faixa do cabeçalho (vários layouts quebram o
  // rótulo em duas linhas — "VALOR" em cima, "UNIT"/"UNITARIO" embaixo — por
  // isso a tolerância de 12pt e os fallbacks só com a 2ª linha).
  const headerRow = (re: RegExp) =>
    page.find((it) => Math.abs(it.y - header.y) < 12 && re.test(it.s.trim()));
  const quantH = headerRow(/^QUANT\.?$/i) || headerRow(/^QUANT(?!IDADE)/i);
  const unitH =
    headerRow(/^(VLR|VALOR)\.?\s*UNIT/i) || headerRow(/^UNIT[ÁA]RIO$/i) || headerRow(/^UNIT\.?$/i);
  const unH = headerRow(/^UN(ID)?\.?$/i);
  const ncmH = headerRow(/^NCM/i);
  if (!quantH || !unitH) return [];

  // Fim da tabela: rótulo do quadro seguinte (ou 520pt abaixo do cabeçalho).
  const bottom = page
    .filter((it) => it.y < header.y - 4 && /DADOS ADICIONAIS|INFORMA[ÇC][ÕO]ES COMPLEMENTARES|C[ÁA]LCULO DO ISSQN/i.test(it.s))
    .sort((a, b) => b.y - a.y)[0];
  const yMin = bottom ? bottom.y + 6 : header.y - 520;
  const body = page.filter((it) => it.y < header.y - 4 && it.y > yMin);

  // Agrupa em linhas por y (5pt de tolerância — descrição e números da mesma
  // linha às vezes vêm 2-3pt deslocados).
  const rows: { y: number; items: PdfItem[] }[] = [];
  for (const it of body.slice().sort((a, b) => b.y - a.y)) {
    const row = rows.find((r) => Math.abs(r.y - it.y) < 5);
    if (row) row.items.push(it);
    else rows.push({ y: it.y, items: [it] });
  }

  // Descrição: tudo à esquerda da coluna seguinte (NCM ou QUANT) que não seja
  // número puro — o código do produto/EAN é numérico e fica de fora sozinho.
  // Não ancora no x do rótulo DESCRIÇÃO: ele é centralizado e o texto das
  // linhas começa mais à esquerda.
  const descEndX = (ncmH ? ncmH.x : quantH.x) - 8;
  const cell = (row: PdfItem[], x: number, tol: number) =>
    row
      .map((it) => ({ it, dx: Math.abs(it.x - x) }))
      .filter((c) => c.dx < tol)
      .sort((a, b) => a.dx - b.dx)[0]?.it;

  const out: NfeProduto[] = [];
  for (const row of rows) {
    // Quantidade PRIMEIRO e fora dos candidatos a unitário: em colunas
    // alinhadas à direita a quantidade cai mais perto do rótulo "VALOR
    // UNITÁRIO" que o próprio unitário.
    const quantIt = cell(row.items, quantH.x, 40);
    const unitIt = cell(row.items.filter((it) => it !== quantIt), unitH.x, 45);
    const valorUnit = unitIt ? brUnit(unitIt.s.trim()) : null;
    // Unitário é o sinal mais forte de "linha de produto" — sem ele é linha de
    // continuação (GTIN/EAN, lote) ou cabeçalho de outra coluna.
    if (valorUnit == null) continue;
    const quantidade = quantIt ? brQty(quantIt.s.trim()) : null;
    const descricao = row.items
      .filter((it) => it.x < descEndX && !/^[\d.,/]+$/.test(it.s.trim()))
      .sort((a, b) => a.x - b.x)
      .map((it) => it.s.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!descricao) continue;
    const unIt = unH ? cell(row.items, unH.x, 15) : undefined;
    out.push({
      descricao: descricao.slice(0, 120),
      quantidade,
      valorUnit,
      valorTotal:
        quantidade != null ? Math.round(quantidade * valorUnit * 100) / 100 : null,
      unidade: unIt && /^[A-Za-zÇç]{1,4}\d?$/.test(unIt.s.trim()) ? unIt.s.trim().toUpperCase() : null,
    });
    if (out.length >= 40) break;
  }
  return out;
}

// Resumo pro campo Observações — compartilhado pelas rotas de análise/import.
export function nfeNoteSummary(nfe: NfeParsed): string {
  let s = `NF ${nfe.numero} série ${nfe.serie} · emissão ${nfe.emissao || nfe.competencia} · chave ${nfe.chave}`;
  if (nfe.duplicatas.length > 1) {
    const parcelas = nfe.duplicatas
      .map((d) => {
        const [y, mo, dd] = d.vencimento.split("-");
        const data = `${dd}/${mo}/${y}`;
        return d.valor != null ? `${data} R$ ${d.valor.toFixed(2).replace(".", ",")}` : data;
      })
      .join(" + ");
    s += ` · ${nfe.duplicatas.length} parcela(s): ${parcelas}`;
  }
  return s;
}

// Fallback de valor por texto (alguns layouts trazem "VALOR TOTAL: R$ ... nn,nn").
function valorPorTexto(text: string): number | null {
  const pats = [
    /VALOR\s+TOTAL\s*:?\s*R\$[^\d]{0,30}(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i,
    /VALOR\s+A\s+PAGAR[^\d]{0,15}R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i,
    /Valor\s+pago\s*R?\$?:?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i,
    /VALOR\s+TOTAL\s+DOS\s+PRODUTOS[^\d]{0,15}(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i,
    /Total\s*:?\s*R?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/i,
  ];
  for (const re of pats) {
    const m = text.match(re);
    if (m) {
      const v = parseFloat(m[1].replace(/\./g, "").replace(",", "."));
      if (v > 0) return v;
    }
  }
  return null;
}

// ── Outros campos do texto ──────────────────────────────────────────────────

function parseEmissao(text: string): string | null {
  const m = text.match(/EMISS[ÃA]O\s*:?\s*(\d{2})\/(\d{2})\/(\d{2,4})/i);
  if (!m) return null;
  const [, d, mo, y] = m;
  const yyyy = y.length === 2 ? `20${y}` : y;
  return `${yyyy}-${mo}-${d}`;
}

function parseEmitente(text: string): string | null {
  const m = text.match(/RECEBEMOS DE\s+(.+?)\s+OS PRODUTOS/i);
  if (m && m[1]) return m[1].replace(/&AMP;/gi, "&").replace(/\s+/g, " ").trim().slice(0, 120);
  return null;
}

// ── Extração unificada ──────────────────────────────────────────────────────

export async function extractDocumentFromPdf(buffer: Buffer): Promise<DocExtract> {
  let text = "";
  let items: PdfItem[] = [];
  let viaOcr = false;
  try {
    const r = await extractPdfItems(buffer);
    text = r.text;
    items = r.items;
  } catch {
    text = "";
    items = [];
  }

  // Sem camada de texto (scan/foto) → tenta OCR antes de desistir.
  if (text.replace(/\s/g, "").length < 20) {
    try {
      const r = await ocrPdf(buffer);
      text = r.text;
      items = r.items;
      viaOcr = true;
    } catch {
      return blank("DESCONHECIDO", true);
    }
    if (text.replace(/\s/g, "").length < 20) return blank("DESCONHECIDO", true);
  }

  const doc = extractFromContent(text, items, viaOcr);
  // OCR que não achou NADA aproveitável = continua "escaneado, preencher à mão".
  if (viaOcr && doc.kind === "DESCONHECIDO" && !doc.cnpj && doc.amount == null) {
    return blank("DESCONHECIDO", true);
  }
  return doc;
}

function extractFromContent(text: string, items: PdfItem[], viaOcr: boolean): DocExtract {
  // 1) Boleto? (linha digitável dá valor + vencimento com precisão)
  const boleto = findLinhaDigitavel(text);
  if (boleto) {
    const cnpj = firstCnpj(text);
    // Linha sem valor/vencimento (boleto "contra apresentação" ou arrecadação):
    // cai pro texto impresso no documento.
    const amount = boleto.amount ?? valorPorTexto(text);
    let dueDate = boleto.dueDate ? boleto.dueDate.toISOString().slice(0, 10) : null;
    if (!dueDate) {
      const m = text.match(/VENCIMENTO\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);
      if (m) dueDate = parseDateBR(m[1]);
    }
    return {
      kind: "BOLETO",
      scanned: false,
      ocr: viaOcr,
      boleto,
      nfe: null,
      cnpj,
      amount,
      dueDate,
      digitableLine: boleto.digits,
      suggestedDescription: cnpj ? `Boleto ${formatCnpj(cnpj)}` : "Boleto",
    };
  }

  // 2) Nota fiscal? (chave de acesso)
  const chave = findChave(text);
  if (chave) {
    const base = chaveFields(chave);
    const valor = valorPorPosicao(items) ?? valorPorTexto(text);
    const emitenteName = parseEmitente(text);
    const posDups = duplicatasPorPosicao(items);
    const duplicatas = posDups.length > 0 ? posDups : duplicatasPorTexto(text);
    const nfe: NfeParsed = {
      ...base,
      emissao: parseEmissao(text),
      emitenteName,
      valor,
      duplicatas,
      produtos: produtosPorPosicao(items),
    };
    const nome = emitenteName || formatCnpj(base.cnpjEmitente);
    return {
      kind: "NFE",
      scanned: false,
      ocr: viaOcr,
      boleto: null,
      nfe,
      cnpj: base.cnpjEmitente,
      amount: valor,
      // Vencimento = 1ª duplicata do quadro FATURA (NF sem fatura não tem data).
      dueDate: duplicatas[0]?.vencimento ?? null,
      digitableLine: null,
      suggestedDescription: `NF ${base.numero} - ${nome}`,
    };
  }

  // 3) Documento sem chave nem linha (pedido, recibo...) — tenta só valor/CNPJ.
  const cnpj = firstCnpj(text);
  return {
    kind: "DESCONHECIDO",
    scanned: false,
    ocr: viaOcr,
    boleto: null,
    nfe: null,
    cnpj,
    amount: valorPorTexto(text),
    dueDate: null,
    digitableLine: null,
    suggestedDescription: cnpj ? `Documento ${formatCnpj(cnpj)}` : "Documento",
  };
}

function blank(kind: DocExtract["kind"], scanned: boolean): DocExtract {
  return {
    kind,
    scanned,
    ocr: false,
    boleto: null,
    nfe: null,
    cnpj: null,
    amount: null,
    dueDate: null,
    digitableLine: null,
    suggestedDescription: scanned ? "Documento escaneado (preencher à mão)" : "Documento",
  };
}

// Primeiro CNPJ do emitente: preferimos o que NÃO é o da própria Cargo Ships
// (destinatária), pegando o primeiro CNPJ formatado que não seja o dela.
const CARGO_CNPJS = new Set(["41560212000100"]); // CARGO SHIPS CLEANING LTDA
function firstCnpj(text: string): string | null {
  const all = (text.match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g) || []).map((c) => c.replace(/\D/g, ""));
  // Só o CNPJ da própria Cargo no documento (scan em que o OCR pegou apenas a
  // destinatária) = fornecedor desconhecido, não "Cargo fornecendo pra Cargo".
  return all.find((c) => !CARGO_CNPJS.has(c)) ?? null;
}

function formatCnpj(d: string): string {
  if (d.length !== 14) return d;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}
