import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getReportActor } from "@/lib/report-scope";
import {
  getInstanceNumber,
  isEvolutionConfigured,
  normalizeBRNumber,
} from "@/lib/services/evolution-api";

// GET /api/relatorios/whats-target — número do WhatsApp da empresa pro botão
// "Enviar pro WhatsApp" dos Relatórios de Bordo. O supervisor NÃO tem o número
// da empresa nos contatos: a tela abre wa.me/<numero>?text=<relatório> e o
// WhatsApp do celular dele já cai na conversa certa com a mensagem pronta.
// Origem do número: app_settings "report_whatsapp_number" (override manual,
// sem UI — só se um dia precisar apontar pra outro chip) ou, no padrão, o
// próprio número conectado na instância Evolution (aba Conversas).
export async function GET() {
  const actor = await getReportActor();
  if (!actor) return NextResponse.json({ error: "Sem permissão" }, { status: 403 });

  const row = await prisma.appSetting
    .findUnique({ where: { key: "report_whatsapp_number" } })
    .catch(() => null);
  const fromSetting = normalizeBRNumber(row?.value || "");
  if (fromSetting) return NextResponse.json({ data: { number: fromSetting } });

  if (isEvolutionConfigured()) {
    try {
      const number = await getInstanceNumber();
      if (number) return NextResponse.json({ data: { number } });
    } catch {
      // instância fora do ar — devolve null e o botão explica
    }
  }
  return NextResponse.json({ data: { number: null } });
}
