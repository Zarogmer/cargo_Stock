import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappTextToGroup,
  sendWhatsappText,
  extractSentMessageId,
} from "@/lib/services/evolution-api";
import { readNotifyConfig } from "@/lib/services/solicitacoes-notify-config";
import { notifyTemplateFor, renderNotifyTemplate } from "@/lib/notify-message-templates";
import { formatCurrency, formatQty } from "@/lib/utils";
import { unitShort } from "@/lib/stock-units";

interface NotifyBody {
  purchaseIds: string[];
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
export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isEvolutionConfigured()) {
    return NextResponse.json({ skipped: "Evolution API não configurada", sent: 0 }, { status: 200 });
  }

  let body: NotifyBody;
  try {
    body = (await request.json()) as NotifyBody;
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
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
      payment_term_days: true, ship_name: true, created_by: true, unit: true,
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
  for (const g of cfg.groups) {
    const groupName = g.label || g.jid;
    try {
      const sentResult = await sendWhatsappTextToGroup(g.jid, groupMessage);
      groupResults.push({ name: groupName, ok: true });
      try {
        await prisma.whatsappMessage.create({
          data: {
            message_id: extractSentMessageId(sentResult) ?? `compras-${g.jid}-${Date.now()}`,
            instance_name: process.env.EVOLUTION_INSTANCE || "default",
            remote_jid: g.jid,
            from_me: true,
            push_name: groupName,
            message_type: "conversation",
            text: groupMessage,
            timestamp_ms: BigInt(Date.now()),
            sent_by_user_id: session.user.id || null,
            raw_event: { source: "compras-registradas", purchaseIds: ids },
          },
        });
      } catch (stubErr) {
        console.warn("[compras/notify] stub insert failed:", (stubErr as Error).message);
      }
    } catch (err) {
      groupResults.push({ name: groupName, ok: false, error: (err as Error).message });
    }
  }

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
    }
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
    }
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
  }, { status: 200 });
}
