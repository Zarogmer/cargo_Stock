import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import type { Role } from "@/types/database";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Leitura da folha (2 páginas, ~80 linhas manuscritas) leva de 20 s a ~1 min.
export const maxDuration = 120;

// POST /api/embarque/escanear — multipart { files: foto(s)/PDF da folha, mode, items }
//
// "📷 Escanear folha" do Checklist: o maquinista preenche à mão a folha do
// Check List (Quant. · Lista · Ida · Volta) e, em vez de digitar, fotografa.
// O Claude lê os números escritos e casa cada linha com um item da lista do
// navio (`items`, mandada pela tela: id + nome + quanto foi). Não grava nada —
// devolve as linhas pra tela conferir e aplicar:
//   mode=embarque → quanto VAI de cada item (o "Materiais"/"Padrão" do navio)
//   mode=retorno  → quanto VOLTOU (e avariado/perdido, se a folha disser)

const MAX_FILES = 6;
const MAX_BYTES = 20 * 1024 * 1024; // por arquivo (o cliente já reduz as fotos)
const MAX_ITEMS = 1500;

const nullableNumber = { type: ["number", "null"] };

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          written_name: { type: "string" },
          item_id: { type: ["integer", "null"] },
          quantity: nullableNumber,
          returned: nullableNumber,
          broken: nullableNumber,
          lost: nullableNumber,
          note: { type: ["string", "null"] },
        },
        required: ["written_name", "item_id", "quantity", "returned", "broken", "lost", "note"],
        additionalProperties: false,
      },
    },
    warnings: { type: ["string", "null"] },
  },
  required: ["lines", "warnings"],
  additionalProperties: false,
};

interface AiLine {
  written_name: string;
  item_id: number | null;
  quantity: number | null;
  returned: number | null;
  broken: number | null;
  lost: number | null;
  note: string | null;
}
interface AiResult {
  lines: AiLine[];
  warnings: string | null;
}

interface ListItem {
  id: number;
  name: string;
  // Quanto foi/vai pela lista do navio (referência pro "✓" na coluna Volta).
  expected: number;
}

function buildPrompt(mode: "embarque" | "retorno", items: ListItem[]): string {
  const catalog = items.map((i) => `${i.id} | ${i.name} | ${i.expected}`).join("\n");
  const task = mode === "embarque"
    ? `É o EMBARQUE: para cada linha preenchida, "quantity" = quantos daquele item a equipe está LEVANDO (o número escrito em "Quant." ou em "Ida"; se os dois tiverem número, vale o de "Ida"). "returned", "broken" e "lost" ficam null.`
    : `É o RETORNO (a equipe voltou do navio): para cada linha, "returned" = quantos VOLTARAM (coluna "Volta"). "quantity" = o que está em "Quant."/"Ida" (quanto foi), só como referência. Se em "Volta" houver só um visto (✓, X, ok) sem número, considere que voltou tudo: returned = a quantidade que foi (Quant./Ida; se estiver em branco, use a coluna "foi" da lista abaixo). Se estiver escrito que algo voltou quebrado/avariado, preencha "broken"; se não voltou/perdeu/sumiu, "lost". Volta em branco = returned null.`;
  return `Você lê a folha de conferência de material (Check List) de uma empresa de limpeza de navios (Cargo Ships Cleaning). A folha tem colunas "Quant." · "Lista" (nome do item) · "Ida" · "Volta", geralmente em duas metades lado a lado, e pode ter mais de uma página/foto. Os números são escritos à mão.

${task}

Os itens da lista deste navio estão abaixo, no formato "id | nome | foi". Os nomes na folha são os mesmos do sistema (podem estar abreviados, com erro de grafia ou sem acento). Para cada linha da folha que tenha algum número ou marca escrita, devolva:
- written_name: o nome como está na folha.
- item_id: o id do item da lista que corresponde a essa linha; null se nenhum corresponder com segurança (não chute).
- note: observação escrita à mão ao lado do item (ex.: "cabo partido"); null se não houver.

Regras:
- Linhas sem nada preenchido (nem número, nem marca) NÃO entram.
- Número riscado e corrigido: vale a correção. Número impresso substituído por um escrito à mão: vale o escrito à mão.
- Cada item da lista aparece no máximo uma vez; se a folha repetir um item, some as quantidades.
- Números com ponto decimal (1.5), nunca vírgula. Não invente: o que não der para ler fica null e vai para "warnings".
- warnings: em português, curto — o que ficou ilegível, ambíguo ou cortado na foto. null se tudo legível.

Lista do navio (id | nome | foi):
${catalog}`;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasPermission(session.user.role as Role, "EMBARQUE", "embarcar")) {
    return NextResponse.json({ error: "Sem permissão" }, { status: 403 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "A leitura por IA não está configurada no servidor (falta a variável ANTHROPIC_API_KEY no Railway)." },
      { status: 503 },
    );
  }

  const form = await request.formData().catch(() => null);
  const mode = form?.get("mode") === "retorno" ? "retorno" : "embarque";
  let items: ListItem[] = [];
  try {
    const raw = JSON.parse(String(form?.get("items") || "[]"));
    if (Array.isArray(raw)) {
      items = raw
        .filter((i) => i && Number.isInteger(i.id) && typeof i.name === "string" && i.name.trim())
        .map((i) => ({ id: i.id, name: i.name.trim(), expected: Number(i.expected) || 0 }))
        .slice(0, MAX_ITEMS);
    }
  } catch { /* lista inválida → erro abaixo */ }
  if (items.length === 0) return NextResponse.json({ error: "A lista do navio está vazia." }, { status: 400 });

  const files = (form?.getAll("files") || []).filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return NextResponse.json({ error: "Tire ao menos uma foto da folha." }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `Máximo de ${MAX_FILES} fotos por leitura.` }, { status: 400 });

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const f of files) {
    if (f.size > MAX_BYTES) return NextResponse.json({ error: `"${f.name}" passa de 20 MB.` }, { status: 400 });
    const data = Buffer.from(await f.arrayBuffer()).toString("base64");
    if (f.type === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
    } else if (f.type === "image/jpeg" || f.type === "image/png" || f.type === "image/webp" || f.type === "image/gif") {
      content.push({ type: "image", source: { type: "base64", media_type: f.type, data } });
    } else {
      return NextResponse.json({ error: `Formato não suportado: ${f.type || f.name}. Use foto (JPG/PNG) ou PDF.` }, { status: 400 });
    }
  }
  content.push({ type: "text", text: buildPrompt(mode, items) });

  const client = new Anthropic();
  let result: AiResult;
  try {
    const response = await client.beta.messages.create({
      // Opus: número manuscrito + casar ~80 nomes abreviados — erro aqui vira
      // estoque errado, então vale o modelo mais preciso (≈ US$ 0,20 por folha).
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: RESULT_SCHEMA },
      },
      messages: [{ role: "user", content }],
    });
    if (response.stop_reason === "refusal") {
      return NextResponse.json({ error: "A IA não conseguiu analisar estas fotos. Tente outra foto." }, { status: 422 });
    }
    if (response.stop_reason === "max_tokens") {
      return NextResponse.json({ error: "Folha grande demais para ler de uma vez — tente uma página por vez." }, { status: 422 });
    }
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    result = JSON.parse(text) as AiResult;
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json({ error: "Muitas leituras ao mesmo tempo — espere alguns segundos e tente de novo." }, { status: 429 });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return NextResponse.json({ error: "Chave da IA inválida no servidor (ANTHROPIC_API_KEY)." }, { status: 503 });
    }
    if (err instanceof Anthropic.BadRequestError) {
      console.error("[embarque/escanear] bad request:", err.message);
      return NextResponse.json({ error: "A IA recusou o arquivo (imagem corrompida ou grande demais)." }, { status: 400 });
    }
    if (err instanceof Anthropic.APIError) {
      console.error("[embarque/escanear] API error:", err.status, err.message);
      return NextResponse.json({ error: "Serviço de IA indisponível agora — tente de novo em instantes." }, { status: 502 });
    }
    console.error("[embarque/escanear] erro:", err);
    return NextResponse.json({ error: "Não consegui ler a folha — tente outra foto." }, { status: 500 });
  }

  // Normaliza: item_id só vale se for da lista; nome idêntico (sem acento/caixa)
  // casa mesmo quando a IA não ligou; um item aparece uma vez só (soma).
  const key = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const byKey = new Map(items.map((i) => [key(i.name), i.id]));
  const validIds = new Set(items.map((i) => i.id));
  const num = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null);
  const add = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : a + b);

  const merged = new Map<number, AiLine>();
  const unmatched: AiLine[] = [];
  for (const l of Array.isArray(result.lines) ? result.lines : []) {
    if (!l || typeof l.written_name !== "string") continue;
    const line: AiLine = {
      written_name: l.written_name.trim(),
      item_id: l.item_id != null && validIds.has(l.item_id) ? l.item_id : byKey.get(key(l.written_name)) ?? null,
      quantity: num(l.quantity),
      returned: num(l.returned),
      broken: num(l.broken),
      lost: num(l.lost),
      note: l.note?.trim() || null,
    };
    if (line.quantity == null && line.returned == null && line.broken == null && line.lost == null && !line.note) continue;
    if (line.item_id == null) { unmatched.push(line); continue; }
    const prev = merged.get(line.item_id);
    merged.set(line.item_id, prev
      ? {
          ...prev,
          quantity: add(prev.quantity, line.quantity),
          returned: add(prev.returned, line.returned),
          broken: add(prev.broken, line.broken),
          lost: add(prev.lost, line.lost),
          note: [prev.note, line.note].filter(Boolean).join(" · ") || null,
        }
      : line);
  }

  return NextResponse.json({
    mode,
    lines: [...merged.values(), ...unmatched],
    warnings: result.warnings?.trim() || null,
  });
}
