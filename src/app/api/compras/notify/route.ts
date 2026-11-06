import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappTextToGroup,
  sendWhatsappText,
  sendWhatsappMediaToGroup,
  sendWhatsappMediaToNumber,
  sendWhatsappDocumentToGroup,
  sendWhatsappDocumentToNumber,
  extractSentMessageId,
} from "@/lib/services/evolution-api";
import { readNotifyConfig } from "@/lib/services/solicitacoes-notify-config";
import { notifyTemplateFor, renderNotifyTemplate } from "@/lib/notify-message-templates";
import { formatCurrency, formatQty } from "@/lib/utils";
import { unitShort } from "@/lib/stock-units";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Com fotos são vários envios de mídia em sequência (um por foto e destino).
export const maxDuration = 120;

interface NotifyBody {
  purchaseIds: string[];
}

// Foto/PDF do Escanear que acompanha o aviso (mesmos limites da leitura).
const MAX_FILES = 8;
const MAX_BYTES = 20 * 1024 * 1024;

interface NotifyMedia {
  kind: "image" | "document";
  mime: string;
  dataUrl: string;
  fileName: string;
}

// Lê os arquivos do multipart: imagem vai como foto, PDF como documento; o
// resto (e o que passar do limite) é ignorado — o aviso de texto sai igual.
async function readMedia(form: FormData): Promise<NotifyMedia[]> {
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  const out: NotifyMedia[] = [];
  for (const f of files.slice(0, MAX_FILES)) {
    if (f.size > MAX_BYTES) continue;
    const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
    const isImage = f.type.startsWith("image/");
    if (!isPdf && !isImage) continue;
    const mime = isPdf ? "application/pdf" : f.type;
    const base64 = Buffer.from(await f.arrayBuffer()).toString("base64");
    out.push({
      kind: isPdf ? "document" : "image",
      mime,
      dataUrl: `data:${mime};base64,${base64}`,
      fileName: f.name || (isPdf ? "nota.pdf" : "nota.jpg"),
    });
  }
  return out;
}

type Purchase = {
  description: string;
  supplier: string | null;
  purchase_date: Date | null;
  unit_value: number;
  quantity: number;
  total_value: number;
  payment_method: string | null;
  payment_terms: number[];
  payment_term_days: number | null;
  ship_name: string | null;
  created_by: string | null;
  unit: string | null;
};

// DD/MM/AAAA de uma coluna @db.Date (meia-noite UTC — não converter fuso).
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10).split("-").reverse().join("/");
}

// Igual ao rótulo da listagem do Controle de Compras: FATURADO mostra os
// vencimentos das parcelas (compra + dias).
function paymentLabel(p: Purchase): string | null {
  if (!p.payment_method) return null;
  if (p.payment_method === "FATURADO") {
    const terms = p.payment_terms?.length ? p.payment_terms : p.payment_term_days ? [p.payment_term_days] : [];
    if (terms.length > 0) {
      if (!p.purchase_date) return `FATURADO ${terms.join("/")} dias`;
      const base = p.purchase_date.getTime();
      const dues = terms.map((d) => fmtDate(new Date(base + d * 86_400_000)).slice(0, 5));
      return `FATURADO ${dues.join(", ")}`;
    }
  }
  return p.payment_method;
}

// Quantidade com a unidade quando não é UN ("9,335 KG", "10 PAR", "3").
function qtyLabel(p: Purchase): string {
  const u = p.unit && p.unit !== "UN" ? unitShort(p.unit) : "";
  return u ? `${formatQty(p.quantity)} ${u}` : formatQty(p.quantity);
}

// Uma mensagem por lote salvo (as compras de uma nota têm o mesmo cabeçalho;
// a Nova Compra manda uma só). Cabeçalho sai da 1ª compra. O texto segue o
// modelo do card "Compras registradas" em Mensagens (ou o padrão): `kind`
// escolhe a versão — com valores (pessoas/Administrativo) ou a dos grupos
// (só item e quantidade). As variáveis são as mesmas nos dois.
function buildMessage(
  items: Purchase[],
  kind: "compraRegistrada" | "compraRegistradaGrupo",
  template: string | null,
): string {
  const head = items[0];
  const total = items.reduce((s, p) => s + (p.total_value || 0), 0);
  const lines = items.map((p) => {
    const qty = p.quantity !== 1 ? `${qtyLabel(p)} × ${formatCurrency(p.unit_value)} = ` : "";
    return `• ${p.description} — ${qty}${formatCurrency(p.total_value)}`;
  });
  const linesNoValue = items.map((p) => `• ${p.description} — ${qtyLabel(p)}`);
  return renderNotifyTemplate(notifyTemplateFor(kind, template), {
    titulo: items.length === 1 ? "Compra registrada" : `${items.length} compras registradas`,
    fornecedor: head.supplier,
    data: head.purchase_date ? fmtDate(head.purchase_date) : null,
    navio: head.ship_name,
    pagamento: paymentLabel(head),
    itens: lines.join("\n"),
    itens_sem_valor: linesNoValue.join("\n"),
    qtd_itens: String(items.length),
    total: formatCurrency(total),
    registrado_por: head.created_by,
  });
}

// POST /api/compras/notify — chamado pelo Controle de Compras depois de salvar
// compra(s) nova(s): posta a lista SEM valores nos grupos do card "Compras
// registradas" em Mensagens e manda a versão COM valores e total por DM pras
// pessoas marcadas no card (ex.: Rose do Executivo) e, com a caixinha ligada,
// pro setor ADMINISTRATIVO. Best-effort: sempre 200, nunca fatal (a compra já
// foi salva).
//
// Body: JSON { purchaseIds } ou, no Escanear, multipart { purchaseIds (JSON),
// files (fotos/PDF da nota) }. As fotos vão logo depois do texto: sempre pras
// pessoas/Administrativo; pros grupos só com a caixinha "foto da nota nos
// grupos" do card (a foto mostra os valores que o texto do grupo esconde).
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isEvolutionConfigured()) {
    return NextResponse.json({ skipped: "Evolution API não configurada", sent: 0 }, { status: 200 });
  }

  let body: NotifyBody;
  let media: NotifyMedia[] = [];
  try {
    if ((request.headers.get("content-type") || "").includes("multipart/form-data")) {
      const form = await request.formData();
      body = { purchaseIds: JSON.parse(String(form.get("purchaseIds") || "[]")) };
      media = await readMedia(form);
    } else {
      body = (await request.json()) as NotifyBody;
    }
  } catch {
    return NextResponse.json({ error: "Corpo inválido" }, { status: 400 });
  }
  const ids = Array.isArray(body.purchaseIds) ? body.purchaseIds.filter((x) => typeof x === "string") : [];
  if (ids.length === 0) {
    return NextResponse.json({ error: "purchaseIds é obrigatório" }, { status: 400 });
  }

  const { compraRegistrada: cfg } = await readNotifyConfig();
  if (!cfg.enabled) {
    return NextResponse.json({ status: "skipped", sent: 0, skipped: "Aviso de compras desativado em Mensagens." }, { status: 200 });
  }
  if (cfg.groups.length === 0 && !cfg.dmAdmin && cfg.people.length === 0) {
    return NextResponse.json({ status: "skipped", sent: 0, skipped: "Nenhum grupo nem pessoa configurados em Mensagens › \"Compras registradas\"." }, { status: 200 });
  }

  const rows = await prisma.purchaseOrder.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, description: true, supplier: true, purchase_date: true, unit_value: true,
      quantity: true, total_value: true, payment_method: true, payment_terms: true,
      payment_term_days: true, ship_name: true, created_by: true, unit: true, nf_number: true,
    },
  });
  if (rows.length === 0) {
    return NextResponse.json({ status: "skipped", sent: 0, warning: "Compras não encontradas." }, { status: 200 });
  }
  // Mantém a ordem em que foram salvas (= ordem da nota).
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  // Grupos: só item e quantidade. DMs: com valores e total.
  const groupMessage = buildMessage(rows, "compraRegistradaGrupo", cfg.groupTemplate);
  const message = buildMessage(rows, "compraRegistrada", cfg.template);
  const groupResults: { name: string; ok: boolean; error?: string }[] = [];

  // Fotos da nota (Escanear), mandadas logo depois do texto de cada destino.
  // Legenda curta e sem valores (serve pra grupo e pra DM). Falha de foto não
  // derruba o aviso: o destino entra em photoErrors e o texto já foi.
  const head = rows[0];
  const captionBase = `📷 Nota da compra${head.supplier ? ` — ${head.supplier}` : ""}${head.nf_number ? ` · NF ${head.nf_number}` : ""}`;
  const captionOf = (i: number) => (media.length > 1 ? `${captionBase} (${i + 1}/${media.length})` : captionBase);
  let photoTargets = 0;
  const photoErrors: string[] = [];
  async function sendPhotos(
    name: string,
    send: (m: NotifyMedia, caption: string) => Promise<unknown>,
    onSent?: (m: NotifyMedia, caption: string, result: unknown, index: number) => Promise<void>,
  ) {
    if (media.length === 0) return;
    let failed = false;
    for (let i = 0; i < media.length; i++) {
      try {
        const result = await send(media[i], captionOf(i));
        if (onSent) await onSent(media[i], captionOf(i), result, i);
      } catch (err) {
        failed = true;
        console.warn(`[compras/notify] foto ${i + 1} não enviada pra ${name}:`, (err as Error).message);
      }
    }
    if (failed) photoErrors.push(name);
    else photoTargets++;
  }

  for (const g of cfg.groups) {
    const groupName = g.label || g.jid;
    // Grava na aba Conversas (não-fatal: a mensagem já saiu).
    const stub = async (data: { message_id: string; message_type: string; text: string; media_mimetype?: string }) => {
      try {
        await prisma.whatsappMessage.create({
          data: {
            ...data,
            instance_name: process.env.EVOLUTION_INSTANCE || "default",
            remote_jid: g.jid,
            from_me: true,
            push_name: groupName,
            timestamp_ms: BigInt(Date.now()),
            sent_by_user_id: session.user.id || null,
            raw_event: { source: "compras-registradas", purchaseIds: ids },
          },
        });
      } catch (stubErr) {
        console.warn("[compras/notify] stub insert failed:", (stubErr as Error).message);
      }
    };
    try {
      const sentResult = await sendWhatsappTextToGroup(g.jid, groupMessage);
      groupResults.push({ name: groupName, ok: true });
      await stub({
        message_id: extractSentMessageId(sentResult) ?? `compras-${g.jid}-${Date.now()}`,
        message_type: "conversation",
        text: groupMessage,
      });
    } catch (err) {
      groupResults.push({ name: groupName, ok: false, error: (err as Error).message });
      continue;
    }
    if (cfg.photoToGroups) {
      await sendPhotos(
        groupName,
        (m, caption) => m.kind === "document"
          ? sendWhatsappDocumentToGroup(g.jid, m.dataUrl, caption, m.fileName, m.mime)
          : sendWhatsappMediaToGroup(g.jid, m.dataUrl, caption, m.fileName),
        (m, caption, result, i) => stub({
          message_id: extractSentMessageId(result) ?? `compras-foto-${g.jid}-${Date.now()}-${i}`,
          message_type: m.kind === "document" ? "documentMessage" : "imageMessage",
          text: caption,
          media_mimetype: m.mime,
        }),
      );
    }
  }
  const sendPhotosToNumber = (name: string, phone: string) => sendPhotos(
    name,
    (m, caption) => m.kind === "document"
      ? sendWhatsappDocumentToNumber(phone, m.dataUrl, caption, m.fileName, m.mime)
      : sendWhatsappMediaToNumber(phone, m.dataUrl, caption, m.fileName),
  );

  const admins = cfg.dmAdmin
    ? (
        await prisma.employee.findMany({
          where: { sector: "ADMINISTRATIVO" },
          select: { name: true, phone: true, status: true },
        })
      ).filter((e) => e.status !== "INATIVO")
    : [];
  const dmResults: { target: string; ok: boolean; error?: string }[] = [];
  // Pessoas marcadas no card (recebem com valores e total). Quem veio da lista
  // de colaboradores usa o telefone ATUAL do cadastro; número à mão vai como
  // está. Não repete quem também é do Administrativo.
  const sentDigits = new Set<string>();
  const digitsOf = (phone: string | null | undefined) => (phone || "").replace(/\D/g, "");
  const peopleIds = cfg.people.map((p) => p.employeeId).filter((id): id is number => id != null);
  const peopleEmps = peopleIds.length > 0
    ? await prisma.employee.findMany({ where: { id: { in: peopleIds } }, select: { id: true, name: true, phone: true } })
    : [];
  for (const person of cfg.people) {
    const emp = person.employeeId != null ? peopleEmps.find((e) => e.id === person.employeeId) : null;
    const phone = emp?.phone?.trim() || person.phone;
    const name = emp?.name || person.name;
    if (!phone || phone.trim().length < 10) {
      dmResults.push({ target: `dm:${name}`, ok: false, error: "sem telefone válido" });
      continue;
    }
    if (sentDigits.has(digitsOf(phone))) continue;
    sentDigits.add(digitsOf(phone));
    try {
      await sendWhatsappText(phone, message);
      dmResults.push({ target: `dm:${name}`, ok: true });
    } catch (err) {
      dmResults.push({ target: `dm:${name}`, ok: false, error: (err as Error).message });
      continue;
    }
    await sendPhotosToNumber(name, phone);
  }
  for (const emp of admins) {
    if (!emp.phone || emp.phone.trim().length < 10) {
      dmResults.push({ target: `dm:${emp.name}`, ok: false, error: "sem telefone válido" });
      continue;
    }
    if (sentDigits.has(digitsOf(emp.phone))) continue;
    sentDigits.add(digitsOf(emp.phone));
    try {
      await sendWhatsappText(emp.phone, message);
      dmResults.push({ target: `dm:${emp.name}`, ok: true });
    } catch (err) {
      dmResults.push({ target: `dm:${emp.name}`, ok: false, error: (err as Error).message });
      continue;
    }
    await sendPhotosToNumber(emp.name, emp.phone);
  }

  const sent = groupResults.filter((r) => r.ok).length;
  const dmSent = dmResults.filter((r) => r.ok).length;
  return NextResponse.json({
    status: sent === 0 && dmSent === 0 ? "error" : "ok",
    sent,
    group: groupResults.filter((r) => r.ok).map((r) => r.name).join(", "),
    results: groupResults,
    dmSent,
    dmResults,
    // Destinos que receberam todas as fotos / que ficaram sem alguma.
    photoTargets,
    photoErrors,
  }, { status: 200 });
}
