// Mensagem automática de aniversário (parabéns) enviada ao próprio colaborador
// no dia do seu aniversário, às 10h (horário de São Paulo). Vale pra ATIVO e
// PENDENCIA — só demitidos (INATIVO) ficam de fora, igual à tabelinha de
// aniversariantes do dashboard. O texto é editável na aba Mensagens.
//
// Disparado pelo mesmo scheduler in-process das agendas (src/instrumentation.ts,
// tick de 60s) e também pela rota /api/cron/run-scheduled-messages. Um "claim"
// atômico por dia (linha em app_settings) garante 1 execução por dia, mesmo com
// ticks sobrepostos — sem risco de mandar parabéns duas vezes.

import { prisma } from "@/lib/prisma";
import {
  isEvolutionConfigured,
  sendWhatsappText,
  normalizeBRNumber,
  extractSentMessageId,
} from "@/lib/services/evolution-api";

const SP_TZ = "America/Sao_Paulo";

// Chave da config (JSON) e do controle de "já rodou hoje" em app_settings.
export const BIRTHDAY_CONFIG_KEY = "birthday_message_config";
export const BIRTHDAY_LAST_RUN_KEY = "birthday_message_last_run_date";

// Hora local de SP em que os parabéns saem. Fixo a pedido do usuário (10h).
export const BIRTHDAY_HOUR = 10;

export interface BirthdayConfig {
  enabled: boolean;
  template: string;
}

// Placeholders aceitos no texto:
//   {nome}          → primeiro nome do colaborador
//   {nome_completo} → nome completo
//   {idade}         → idade que está completando (vazio se não dá pra calcular)
export const DEFAULT_BIRTHDAY_TEMPLATE = [
  "🎉 *Feliz aniversário, {nome}!* 🎂",
  "",
  "A família Cargo Ships Cleaning deseja a você um dia especial, cheio de saúde, alegria e conquistas. Obrigado por fazer parte do nosso time! 💙",
  "",
  "Um grande abraço! 🥳",
].join("\n");

export function defaultBirthdayConfig(): BirthdayConfig {
  return { enabled: true, template: DEFAULT_BIRTHDAY_TEMPLATE };
}

// Valida/normaliza um payload arbitrário, caindo nos defaults pro que faltar ou
// for inválido. Usado na leitura (parse do banco) e no PUT (sanitiza o front).
export function sanitizeBirthdayConfig(raw: unknown): BirthdayConfig {
  const def = defaultBirthdayConfig();
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const template = typeof r.template === "string" && r.template.trim() ? r.template.slice(0, 4000) : def.template;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : def.enabled,
    template,
  };
}

// Lê a config do banco (app_settings). Nunca lança: na ausência ou JSON inválido
// devolve os defaults.
export async function readBirthdayConfig(): Promise<BirthdayConfig> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: BIRTHDAY_CONFIG_KEY } });
    if (!row?.value) return defaultBirthdayConfig();
    return sanitizeBirthdayConfig(JSON.parse(row.value));
  } catch {
    return defaultBirthdayConfig();
  }
}

export async function writeBirthdayConfig(cfg: BirthdayConfig, updatedBy: string | null): Promise<void> {
  const value = JSON.stringify(sanitizeBirthdayConfig(cfg));
  await prisma.appSetting.upsert({
    where: { key: BIRTHDAY_CONFIG_KEY },
    update: { value, updated_by: updatedBy },
    create: { key: BIRTHDAY_CONFIG_KEY, value, updated_by: updatedBy },
  });
}

// Substitui {placeholder} por valor literal (split/join — sem regex/escape).
function fill(text: string, key: string, value: string): string {
  return text.split(`{${key}}`).join(value);
}

// "IVAN" → "Ivan". Os nomes vêm em caixa alta do cadastro; no primeiro nome a
// capitalização simples fica boa ("Feliz aniversário, Ivan!" em vez de "IVAN!").
function capitalizeFirstName(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
}

export function renderBirthdayMessage(template: string, p: { fullName: string; age: number | null }): string {
  const full = (p.fullName || "").trim();
  const first = capitalizeFirstName(full.split(/\s+/)[0] || full);
  let out = fill(template, "nome", first);
  out = fill(out, "primeiro_nome", first);
  out = fill(out, "nome_completo", full);
  out = fill(out, "idade", p.age != null && p.age > 0 ? String(p.age) : "");
  return out;
}

// Hora local de SP agora, via Intl (sem lib de data) — o servidor roda em UTC.
function spNowParts(): { y: number; mo: number; d: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SP_TZ,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0; // Intl às vezes devolve "24" pra meia-noite
  return { y: get("year"), mo: get("month"), d: get("day"), hour };
}

export interface BirthdayRunResult {
  ran: boolean;
  sent: number;
  failed: number;
  skipped: number; // aniversariantes sem telefone cadastrado
  reason?: string;
}

// Processa os parabéns do dia. Idempotente por dia (claim atômico em
// app_settings). Um erro de envio num colaborador nunca trava os outros.
export async function runDueBirthdayMessages(): Promise<BirthdayRunResult> {
  const cfg = await readBirthdayConfig();
  if (!cfg.enabled) return { ran: false, sent: 0, failed: 0, skipped: 0, reason: "disabled" };

  const sp = spNowParts();
  if (sp.hour < BIRTHDAY_HOUR) return { ran: false, sent: 0, failed: 0, skipped: 0, reason: "too-early" };
  // Evolution não configurada → não "queima" o dia; tenta de novo no próximo tick.
  if (!isEvolutionConfigured()) return { ran: false, sent: 0, failed: 0, skipped: 0, reason: "evolution-not-configured" };

  const today = `${sp.y}-${String(sp.mo).padStart(2, "0")}-${String(sp.d).padStart(2, "0")}`;

  // Claim atômico do dia: garante a linha existir e depois flipa o valor pra hoje
  // SÓ se ainda não estiver em hoje. Um tick concorrente casa count=0 e desiste.
  await prisma.appSetting.upsert({
    where: { key: BIRTHDAY_LAST_RUN_KEY },
    create: { key: BIRTHDAY_LAST_RUN_KEY, value: "" },
    update: {},
  });
  const claim = await prisma.appSetting.updateMany({
    where: { key: BIRTHDAY_LAST_RUN_KEY, NOT: { value: today } },
    data: { value: today },
  });
  if (claim.count === 0) return { ran: false, sent: 0, failed: 0, skipped: 0, reason: "already-ran-today" };

  // Aniversariantes de hoje: ATIVO ou PENDENCIA (demitidos fora), com nascimento.
  // Mês/dia comparados em UTC (igual à tabelinha do dashboard) — datas só-data
  // ficam na meia-noite UTC, então UTC preserva o dia pretendido.
  const emps = await prisma.employee.findMany({
    where: { status: { in: ["ATIVO", "PENDENCIA"] }, birth_date: { not: null } },
    select: { id: true, name: true, phone: true, birth_date: true },
  });

  let sent = 0, failed = 0, skipped = 0;
  for (const e of emps) {
    const d = e.birth_date ? new Date(e.birth_date) : null;
    if (!d || Number.isNaN(d.getTime())) continue;
    if (d.getUTCMonth() + 1 !== sp.mo || d.getUTCDate() !== sp.d) continue; // não é hoje
    if (!e.phone || !e.phone.replace(/\D/g, "")) { skipped++; continue; } // sem telefone

    const birthYear = d.getUTCFullYear();
    const age = birthYear > 1900 ? sp.y - birthYear : null;
    const text = renderBirthdayMessage(cfg.template, { fullName: e.name, age });

    try {
      const sentMsg = await sendWhatsappText(e.phone, text);
      sent++;
      // Stub pra aparecer em Conversas (best-effort, não-fatal).
      try {
        const jid = `${normalizeBRNumber(e.phone)}@s.whatsapp.net`;
        await prisma.whatsappMessage.create({
          data: {
            message_id: extractSentMessageId(sentMsg) ?? `birthday-${e.id}-${Date.now()}`,
            instance_name: process.env.EVOLUTION_INSTANCE || "default",
            remote_jid: jid,
            from_me: true,
            push_name: e.name,
            message_type: "conversation",
            text,
            timestamp_ms: BigInt(Date.now()),
            raw_event: { source: "birthday", employeeId: e.id },
          },
        });
      } catch (stubErr) {
        console.warn("[birthday] stub falhou:", (stubErr as Error).message);
      }
    } catch (err) {
      failed++;
      console.warn(`[birthday] envio falhou p/ ${e.name}:`, (err as Error).message);
    }
  }

  console.log(`[birthday] ${today}: enviados=${sent} falhas=${failed} sem-telefone=${skipped}`);
  return { ran: true, sent, failed, skipped };
}
