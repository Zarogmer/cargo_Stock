// Normalização do payload do Cleaning Report (cabeçalho + porões + atividades)
// que chega da tela. Usado pela versão do escritório (ship_reports.office_version):
// o JSON gravado tem exatamente este formato, e a leitura passa pelo mesmo
// filtro — registro salvo por cliente antigo nunca derruba o PDF.

import { HoldPeriod, parsePeriods } from "./report-format";

export interface OfficeHold {
  label: string;
  status: string; // PENDENTE | EM_ANDAMENTO | COMPLETO
  periods: HoldPeriod[];
  completion_pct: number;
}

export interface OfficeActivity {
  time_range: string | null;
  activity: string;
  hold_label: string | null;
}

export interface OfficeVersion {
  report_date: string | null; // yyyy-mm-dd
  port: string | null;
  remarks: string | null;
  etc_date: string | null;
  etc_time: string | null;
  holds: OfficeHold[];
  activities: OfficeActivity[];
}

// Mesmos tetos do PUT /api/relatorios/[jobId]: navio real tem no máximo uns 9
// porões e algumas dezenas de atividades.
const MAX_ROWS = 60;
const clip = (v: unknown, max: number) => (v ? String(v).slice(0, max) : null);

export function normalizeOfficeVersion(body: unknown): OfficeVersion {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const r = (b.report && typeof b.report === "object" ? b.report : {}) as Record<string, unknown>;
  const rawHolds = (Array.isArray(b.holds) ? b.holds : []).slice(0, MAX_ROWS) as Record<string, unknown>[];
  const rawActs = (Array.isArray(b.activities) ? b.activities : []).slice(0, MAX_ROWS) as Record<string, unknown>[];

  const dateMatch = String(r.report_date ?? "").match(/^\d{4}-\d{2}-\d{2}/);
  return {
    report_date: dateMatch ? dateMatch[0] : null,
    port: clip(r.port, 120),
    remarks: clip(r.remarks, 4000),
    etc_date: clip(r.etc_date, 60),
    etc_time: clip(r.etc_time, 60),
    holds: rawHolds
      .filter((h) => String(h.label || "").trim())
      .map((h) => {
        const completion_pct = Math.max(0, Math.min(100, Number(h.completion_pct) || 0));
        const rawStatus = ["PENDENTE", "EM_ANDAMENTO", "COMPLETO"].includes(String(h.status))
          ? String(h.status)
          : "PENDENTE";
        return {
          label: String(h.label).trim().slice(0, 120),
          status: completion_pct >= 100 ? "COMPLETO" : rawStatus,
          periods: parsePeriods(h.periods).slice(0, MAX_ROWS),
          completion_pct,
        };
      }),
    activities: rawActs
      .filter((a) => String(a.activity || "").trim())
      .map((a) => ({
        time_range: clip(a.time_range, 40),
        activity: String(a.activity).trim().slice(0, 300),
        hold_label: clip(a.hold_label, 120),
      })),
  };
}

// Lê o JSON da coluna. Qualquer coisa que não seja objeto = sem versão.
export function parseOfficeVersion(v: unknown): OfficeVersion | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return normalizeOfficeVersion(v);
}
