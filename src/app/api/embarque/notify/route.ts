import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappTextToGroup,
  sendWhatsappText,
  sendWhatsappDocumentToGroup,
  sendWhatsappDocumentToNumber,
  extractSentMessageId,
} from "@/lib/services/evolution-api";
import { readNotifyConfig } from "@/lib/services/solicitacoes-notify-config";
import { unitShort } from "@/lib/stock-units";
import { xlsxToPdf } from "@/lib/docx-to-pdf";
import { buildEmbarkChecklistXlsx, checklistFileName } from "@/lib/embark-checklist-xlsx";

interface ListItem { name: string; qty: number; unit?: string | null }
interface NotifyBody {
  shipName: string;
  team?: string | null;
  materials: ListItem[];
  rancho?: ListItem[];
  sentBy?: string | null;
  // "lista" (padrão) = botão "Enviar lista"; "embarque" = aviso automático
  // disparado pelo ⚓ Embarcar (muda o cabeçalho da mensagem).
  event?: "lista" | "embarque";
  // true = gera a lista PREENCHIDA em PDF (layout do Check List) e manda como
  // documento junto com o texto. Best-effort: sem LibreOffice, vai só o texto.
  attachPdf?: boolean;
  port?: string | null;
  cargoType?: string | null;
  dateIso?: string | null;
}

const TEAM_LABEL: Record<string, string> = {
  EQUIPE_1: "Equipe 1", EQUIPE_2: "Equipe 2", EQUIPE_3: "Equipe 3", EQUIPE_4: "Equipe Turbo",
};

// Grupo de Manutenção recebe só os materiais — sem a seção de Rancho no texto e
// sem a aba de Rancho no PDF. Identificado pelo nome salvo na config (o rótulo
// que veio do WhatsApp), ignorando acentos/maiúsculas.
function isManutencaoGroup(label: string | null): boolean {
  // "manuten" pega Manutencao com ou sem acento (prefixo puro ASCII).
  return !!label && label.toLowerCase().includes("manuten");
}

// Lista de embarque da equipe: materiais do kit + comida do Rancho, com as
// quantidades que vão pro navio. Vai pro grupo escolhido em Mensagens.
function buildMessage(b: NotifyBody): string {
  const team = b.team ? ` · ${TEAM_LABEL[b.team] || b.team}` : "";
  const fmtQty = (q: number) => (Number.isInteger(q) ? String(q) : String(q).replace(".", ","));
  // "10 kg" / "25 un" — a unidade vem do cadastro do item no Almoxarifado.
  const line = (i: ListItem) => {
    const u = unitShort(i.unit);
    return `• ${i.name} — ${fmtQty(i.qty)}${u ? ` ${u}` : ""}`;
  };
  const mat = (b.materials || []).map(line);
  const ran = (b.rancho || []).map(line);
  const isEmbark = b.event === "embarque";
  const header = isEmbark ? `⚓ *Embarque confirmado*` : `📦 *Lista de embarque*`;
  const by = b.sentBy?.trim()
    ? `\n👤 ${isEmbark ? "Embarcado" : "Enviado"} por: ${b.sentBy.trim()}`
    : "";
  return (
    `${header}\n\n` +
    `🚢 Navio: *${b.shipName}*${team}\n` +
    (mat.length ? `\n🧰 *Materiais (${mat.length})*\n${mat.join("\n")}\n` : "") +
    (ran.length ? `\n🛒 *Rancho (${ran.length})*\n${ran.join("\n")}\n` : "") +
    by
  );
}

// POST /api/embarque/notify — posta a lista de embarque no(s) grupo(s)
// configurado(s) em Mensagens › "Lista de embarque". Best-effort: sempre 200.
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

  if (!body.shipName || !Array.isArray(body.materials)) {
    return NextResponse.json({ error: "shipName e materials são obrigatórios" }, { status: 400 });
  }
  if (body.materials.length === 0 && (!body.rancho || body.rancho.length === 0)) {
    return NextResponse.json({ status: "skipped", sent: 0, warning: "Lista vazia — nada pra enviar." }, { status: 200 });
  }

  const { embarqueLista: cfg } = await readNotifyConfig();
  if (!cfg.enabled) {
    return NextResponse.json({
      status: "skipped",
      sent: 0,
      skipped: "Envio da lista desativado — ligue em Mensagens › Avisos, card \"Lista de embarque\".",
    }, { status: 200 });
  }
  if (cfg.groups.length === 0 && !cfg.dmAdmin) {
    return NextResponse.json({
      status: "skipped",
      sent: 0,
      warning: "Nenhum grupo configurado — escolha um em Mensagens › Avisos, card \"Lista de embarque\".",
    }, { status: 200 });
  }

  // Mensagem completa (materiais + Rancho) e a variante sem Rancho pros grupos
  // de Manutenção — eles só cuidam do material.
  const message = buildMessage(body);
  const hasRancho = Array.isArray(body.rancho) && body.rancho.length > 0;
  const messageSemRancho = hasRancho ? buildMessage({ ...body, rancho: [] }) : message;
  const senderId = session.user.id || null;

  // Lista preenchida em PDF (layout da Relação, com timbrado) pra ir como
  // documento junto do texto. Pros grupos de Manutenção sai uma versão só com a
  // aba de materiais. Best-effort: sem LibreOffice no servidor, segue só o texto.
  interface PdfDoc {
    base64: string;
    fileName: string;
    caption: string;
  }
  let pdfFull: PdfDoc | null = null;
  let pdfSemRancho: PdfDoc | null = null;
  let pdfError: string | null = null;
  const algumaManutencao = cfg.groups.some((g) => isManutencaoGroup(g.label));
  if (body.attachPdf) {
    try {
      const info = {
        mode: "embarque" as const,
        shipName: body.shipName,
        port: body.port ?? null,
        teamLabel: body.team ? TEAM_LABEL[body.team] || body.team : null,
        cargoType: body.cargoType ?? null,
        dateIso: body.dateIso ?? new Date().toISOString().slice(0, 10),
      };
      // Logo do timbrado (best-effort: sem ela o documento sai só com o endereço).
      let logoPng: Buffer | null = null;
      try {
        logoPng = await fs.readFile(path.join(process.cwd(), "public", "cargo-logo.png"));
      } catch {
        logoPng = null;
      }
      const fileName = checklistFileName(info, "pdf");
      const team = body.team ? ` · ${TEAM_LABEL[body.team] || body.team}` : "";
      const caption = `📎 Lista de materiais — ${body.shipName}${team}`;
      const xlsxBuf = buildEmbarkChecklistXlsx(info, body.materials || [], body.rancho || [], logoPng);
      pdfFull = { base64: (await xlsxToPdf(xlsxBuf)).toString("base64"), fileName, caption };
      if (hasRancho && algumaManutencao && body.materials.length > 0) {
        const xlsxMat = buildEmbarkChecklistXlsx(info, body.materials, [], logoPng);
        pdfSemRancho = { base64: (await xlsxToPdf(xlsxMat)).toString("base64"), fileName, caption };
      }
    } catch (err) {
      pdfError = (err as Error).message;
      console.warn("[embarque/notify] PDF generation failed (segue só o texto):", pdfError);
    }
  }
  if (!hasRancho) pdfSemRancho = pdfFull;

  // Registra o envio no histórico da aba Conversas (texto e, se houver, o PDF).
  async function recordStub(jid: string, pushName: string, sentResult: unknown, kind: "text" | "document", text: string) {
    try {
      await prisma.whatsappMessage.create({
        data: {
          message_id: extractSentMessageId(sentResult) ?? `embarque-${kind}-${jid}-${Date.now()}`,
          instance_name: process.env.EVOLUTION_INSTANCE || "default",
          remote_jid: jid,
          from_me: true,
          push_name: pushName,
          message_type: kind === "document" ? "documentMessage" : "conversation",
          text,
          timestamp_ms: BigInt(Date.now()),
          sent_by_user_id: senderId,
          raw_event: { source: "embarque-lista", event: body.event || "lista", shipName: body.shipName },
        },
      });
    } catch (stubErr) {
      console.warn("[embarque/notify] stub insert failed:", (stubErr as Error).message);
    }
  }

  const groupResults: { name: string; ok: boolean; error?: string }[] = [];
  for (const g of cfg.groups) {
    const groupName = g.label || g.jid;
    const semRancho = isManutencaoGroup(g.label);
    if (semRancho && body.materials.length === 0) {
      // Lista só de Rancho: Manutenção não recebe nada.
      groupResults.push({ name: groupName, ok: false, error: "lista só de Rancho — grupo de Manutenção não recebe" });
      continue;
    }
    const groupMsg = semRancho ? messageSemRancho : message;
    const groupPdf = semRancho ? pdfSemRancho : pdfFull;
    try {
      const sentResult = await sendWhatsappTextToGroup(g.jid, groupMsg);
      groupResults.push({ name: groupName, ok: true });
      await recordStub(g.jid, groupName, sentResult, "text", groupMsg);
      if (groupPdf) {
        try {
          const docResult = await sendWhatsappDocumentToGroup(g.jid, groupPdf.base64, groupPdf.caption, groupPdf.fileName);
          await recordStub(g.jid, groupName, docResult, "document", groupPdf.caption);
        } catch (docErr) {
          pdfError = (docErr as Error).message;
          console.warn("[embarque/notify] PDF send to group failed:", pdfError);
        }
      }
    } catch (err) {
      groupResults.push({ name: groupName, ok: false, error: (err as Error).message });
    }
  }

  // Caixinha do card ligada → também manda a lista por DM pro pessoal ATIVO do
  // setor ADMINISTRATIVO (mesma regra do Retorno de material). Não-fatal por
  // pessoa (sem telefone entra como falha no resumo).
  const admins = cfg.dmAdmin
    ? (
        await prisma.employee.findMany({
          where: { sector: "ADMINISTRATIVO" },
          select: { id: true, name: true, phone: true, status: true },
        })
      ).filter((e) => e.status !== "INATIVO")
    : [];
  const dmResults: { target: string; ok: boolean; error?: string }[] = [];
  for (const emp of admins) {
    if (!emp.phone || emp.phone.trim().length < 10) {
      dmResults.push({ target: `dm:${emp.name}`, ok: false, error: "sem telefone válido" });
      continue;
    }
    try {
      await sendWhatsappText(emp.phone, message);
      dmResults.push({ target: `dm:${emp.name}`, ok: true });
      if (pdfFull) {
        try {
          await sendWhatsappDocumentToNumber(emp.phone, pdfFull.base64, pdfFull.caption, pdfFull.fileName);
        } catch (docErr) {
          console.warn(`[embarque/notify] PDF send to dm:${emp.name} failed:`, (docErr as Error).message);
        }
      }
    } catch (err) {
      dmResults.push({ target: `dm:${emp.name}`, ok: false, error: (err as Error).message });
    }
  }
  const dmSent = dmResults.filter((r) => r.ok).length;

  const sent = groupResults.filter((r) => r.ok).length;
  // pdf: "sent" = anexado; "failed" = pedido mas não rolou (segue só o texto).
  const pdfStatus = body.attachPdf ? (pdfFull && !pdfError ? "sent" : "failed") : undefined;
  if (sent === 0 && dmSent === 0) {
    return NextResponse.json({
      status: "error",
      sent: 0,
      dmSent: 0,
      warning: groupResults.length
        ? `Falha ao enviar pro(s) grupo(s): ${groupResults.map((g) => `${g.name} (${g.error})`).join("; ")}`
        : "Ninguém recebeu a lista — confira o grupo e os telefones do Administrativo em Mensagens.",
      results: groupResults,
      dmResults,
      pdf: pdfStatus,
      pdfError: pdfError || undefined,
    }, { status: 200 });
  }
  return NextResponse.json({
    status: "ok",
    sent,
    group: groupResults.filter((r) => r.ok).map((r) => r.name).join(", "),
    results: groupResults,
    dmSent,
    dmResults,
    pdf: pdfStatus,
    pdfError: pdfError || undefined,
  }, { status: 200 });
}
