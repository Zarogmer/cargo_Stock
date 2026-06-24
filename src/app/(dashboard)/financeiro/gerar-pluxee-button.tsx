"use client";

import { useState } from "react";
import { db } from "@/lib/db";
import { buildPluxeeBeneficiaries, downloadPluxeeXlsx } from "@/lib/pluxee";
import type { Job, JobAllocation, Employee, PluxeeConfig } from "@/types/database";

// Botão "Gerar Pluxee" usado dentro do pagamento (embarque e costado). Carrega
// a config Pluxee na hora, monta a lista do navio e baixa o PLANSIP4C. O fluxo
// completo (escolher navio/data, ver prévia) fica na aba Financeiro › Documentos.
export function GerarPluxeeButton({
  job, allocations, employees, className,
}: {
  job: Job;
  allocations: JobAllocation[]; // alocações deste navio
  employees: Employee[];
  className?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function handle() {
    setBusy(true);
    try {
      const { data, error } = await db.from("pluxee_config").select("*").limit(1);
      if (error) throw new Error(error.message);
      const config = (data as PluxeeConfig[] | null)?.[0];
      if (!config || !config.client_code?.trim()) {
        alert("Configure o Código Cliente Pluxee em Financeiro › Documentos antes de gerar.");
        return;
      }
      const creditDate =
        (job.end_date || job.start_date || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
      const res = buildPluxeeBeneficiaries({ employees, allocations, config, creditDate });
      if (res.beneficiaries.length === 0) {
        alert("Nenhum beneficiário com CPF válido para gerar.");
        return;
      }
      const warns: string[] = [];
      if (res.activeCount === 0) warns.push("• Nenhuma pessoa com valor Pluxee neste navio (a folha já foi importada?).");
      if (res.missingCpf.length) warns.push(`• ${res.missingCpf.length} colaborador(es) sem CPF ficaram de fora.`);
      if (warns.length && !confirm(`Atenção:\n${warns.join("\n")}\n\nGerar o arquivo Pluxee mesmo assim?`)) return;
      await downloadPluxeeXlsx(res.beneficiaries, job.name);
    } catch (e) {
      alert("Falha ao gerar Pluxee: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handle}
      disabled={busy}
      className={className || "text-xs px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-60"}
      title="Gera o arquivo Pluxee (PLANSIP4C) deste navio com o valor do cartão de cada um"
    >
      {busy ? "Gerando…" : "💳 Gerar Pluxee"}
    </button>
  );
}
