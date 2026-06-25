"use client";

import { useEffect, useMemo, useState } from "react";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import {
  buildPluxeeBeneficiaries,
  downloadPluxeeXlsx,
  pluxeeFileName,
  pluxeeCreditDate,
  type PluxeeBuildResult,
} from "@/lib/pluxee";
import type { Job, JobAllocation, Employee, PluxeeConfig } from "@/types/database";

const brl = (n: number) =>
  n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function jobDateISO(j: Job): string {
  return (j.end_date || j.start_date || "").slice(0, 10);
}

// Linha vazia de config (usada se a tabela ainda não tiver registro).
const EMPTY_CONFIG: PluxeeConfig = {
  id: 1, client_code: "", order_type: "001 - Pedido Normal", product: "603903 - Carteira Gift",
  delivery_place: "Matriz", cep: "", address: "", number: "", complement: "", reference: "",
  neighborhood: "", city: "", uf: "", responsible_name: "", responsible_ddd: "",
  responsible_phone: "", inactive_value: 1, updated_at: "", updated_by: null,
};

// Campo de texto do formulário de config. Componente de módulo (identidade
// estável) pra não remontar e perder o foco a cada tecla.
function CfgField({
  label, value, onChange, placeholder, mono, disabled, fieldCls,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  fieldCls: string;
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-text-light uppercase tracking-wider">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={`${fieldCls} ${mono ? "font-mono" : ""} disabled:bg-gray-100 disabled:text-text-light`}
      />
    </div>
  );
}

export function DocumentosTab({
  jobs, allocations, employees, canEdit, profileName,
}: {
  jobs: Job[];
  allocations: JobAllocation[];
  employees: Employee[];
  canEdit: boolean;
  profileName: string;
}) {
  const [config, setConfig] = useState<PluxeeConfig | null>(null);
  const [hasRow, setHasRow] = useState(false);
  const [loadingCfg, setLoadingCfg] = useState(true);

  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const [creditDate, setCreditDate] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  // Carrega a config Pluxee (linha única id=1).
  useEffect(() => {
    let active = true;
    (async () => {
      const { data } = await db.from("pluxee_config").select("*").limit(1);
      if (!active) return;
      const row = (data as PluxeeConfig[] | null)?.[0];
      setConfig(row || EMPTY_CONFIG);
      setHasRow(!!row);
      setLoadingCfg(false);
    })();
    return () => { active = false; };
  }, []);

  // Navios (pagamentos) ordenados do mais recente pro mais antigo.
  const sortedJobs = useMemo(
    () => [...jobs].sort((a, b) => jobDateISO(b).localeCompare(jobDateISO(a))),
    [jobs],
  );

  // Default: seleciona o navio mais recente e a data de crédito = data do navio.
  useEffect(() => {
    if (!selectedJobId && sortedJobs.length > 0) {
      setSelectedJobId(sortedJobs[0].id);
      setCreditDate(pluxeeCreditDate(sortedJobs[0].end_date));
    }
  }, [sortedJobs, selectedJobId]);

  const selectedJob = jobs.find((j) => j.id === selectedJobId) || null;
  const jobAllocs = useMemo(
    () => allocations.filter((a) => a.job_id === selectedJobId),
    [allocations, selectedJobId],
  );

  // Prévia: monta a lista (sem baixar) pra mostrar contagens e avisos.
  const preview: PluxeeBuildResult | null = useMemo(() => {
    if (!config || !selectedJobId) return null;
    return buildPluxeeBeneficiaries({ employees, allocations: jobAllocs, config, creditDate });
  }, [config, selectedJobId, employees, jobAllocs, creditDate]);

  async function handleGenerate() {
    setError(null);
    if (!config || !selectedJob) { setError("Selecione um navio."); return; }
    if (!config.client_code?.trim()) {
      setError("Falta o Código Cliente Pluxee — preencha em Configurações Pluxee abaixo.");
      setShowConfig(true);
      return;
    }
    if (!preview || preview.beneficiaries.length === 0) {
      setError("Nenhum beneficiário com CPF válido para gerar.");
      return;
    }
    setGenerating(true);
    try {
      await downloadPluxeeXlsx(preview.beneficiaries, selectedJob.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }

  const fieldCls =
    "mt-1 w-full px-3 py-2 text-sm border border-border rounded-lg bg-card focus:outline-none focus:ring-2 focus:ring-primary/30";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-text">Navios PLUXEE 💳</h2>
        <p className="text-sm text-text-light mt-0.5">
          Gera o arquivo oficial <strong>PLANSIP4C</strong> pra subir no Pluxee. O valor do cartão de
          cada pessoa é o <strong>líquido − folha</strong> (pluxee) do pagamento do navio. Todos os
          colaboradores entram: a tripulação do navio como <strong>Ativo</strong> com o valor; os
          demais como <strong>Inativo</strong> ({brl(Number(config?.inactive_value ?? 1))}).
        </p>
      </div>

      {/* ── Gerador ─────────────────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">
              Navio (pagamento)
            </label>
            <select
              value={selectedJobId}
              onChange={(e) => {
                setSelectedJobId(e.target.value);
                const j = jobs.find((x) => x.id === e.target.value);
                if (j) setCreditDate(pluxeeCreditDate(j.end_date));
              }}
              className={fieldCls}
            >
              <option value="">— Selecionar navio —</option>
              {sortedJobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name || "Pagamento"} · {jobDateISO(j).split("-").reverse().join("/") || "sem data"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">
              Data de crédito
            </label>
            <input
              type="date"
              value={creditDate}
              onChange={(e) => setCreditDate(e.target.value)}
              className={fieldCls}
            />
            <p className="text-[11px] text-text-light mt-1">Quando o valor cai no cartão — padrão: 20 dias após o término do navio (navio ainda aberto fica sem data).</p>
          </div>
        </div>

        {/* Prévia */}
        {preview && selectedJob && (
          <div className="rounded-lg border border-border bg-gray-50/70 p-3 space-y-2">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-text-light font-semibold">Ativos (recebem)</p>
                <p className="text-xl font-bold text-emerald-700">{preview.activeCount}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-text-light font-semibold">Inativos (R$ {Number(config?.inactive_value ?? 1).toFixed(2)})</p>
                <p className="text-xl font-bold text-text-light">{preview.inactiveCount}</p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-text-light font-semibold">Total no cartão</p>
                <p className="text-xl font-bold text-text">{brl(preview.totalCredit)}</p>
              </div>
            </div>
            {preview.activeCount === 0 && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                ⚠️ Nenhuma pessoa com valor Pluxee neste navio. Confira se a folha já foi importada no
                pagamento (o pluxee sai de <strong>total − folha</strong>).
              </p>
            )}
            {preview.missingCpf.length > 0 && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                ⚠️ {preview.missingCpf.length} colaborador(es) sem CPF válido ficaram de fora:{" "}
                {preview.missingCpf.slice(0, 6).join(", ")}{preview.missingCpf.length > 6 ? "…" : ""}.
              </p>
            )}
            {preview.missingBirth.length > 0 && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                ⚠️ {preview.missingBirth.length} sem data de nascimento (campo obrigatório no Pluxee):{" "}
                {preview.missingBirth.slice(0, 6).join(", ")}{preview.missingBirth.length > 6 ? "…" : ""}.
              </p>
            )}
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-300 rounded-lg p-3 text-sm text-red-700 whitespace-pre-line">
            ⚠️ {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-text-light">
            Arquivo: <strong>{selectedJob ? pluxeeFileName(selectedJob.name) : "—"}</strong>
          </p>
          <Button onClick={handleGenerate} disabled={generating || !selectedJobId}>
            {generating ? "Gerando…" : "📥 Gerar arquivo Pluxee (.xlsx)"}
          </Button>
        </div>
      </div>

      {/* ── Configurações Pluxee (dados fixos) ──────────────────────────── */}
      <div className="bg-card border border-border rounded-xl">
        <button
          type="button"
          onClick={() => setShowConfig((v) => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <div>
            <h3 className="font-semibold text-text">⚙️ Configurações Pluxee</h3>
            <p className="text-xs text-text-light mt-0.5">
              Dados fixos da empresa que se repetem em todo arquivo (cliente, carteira, endereço de
              entrega, responsável).
            </p>
          </div>
          <span className="text-text-light text-sm">{showConfig ? "▲" : "▼"}</span>
        </button>
        {showConfig && (
          <div className="border-t border-border p-4">
            {loadingCfg ? (
              <p className="text-sm text-text-light">Carregando…</p>
            ) : (
              <ConfigForm
                config={config || EMPTY_CONFIG}
                hasRow={hasRow}
                canEdit={canEdit}
                profileName={profileName}
                fieldCls={fieldCls}
                onSaved={(saved) => { setConfig(saved); setHasRow(true); }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Formulário de configuração (linha única) ───────────────────────────────

function ConfigForm({
  config, hasRow, canEdit, profileName, fieldCls, onSaved,
}: {
  config: PluxeeConfig;
  hasRow: boolean;
  canEdit: boolean;
  profileName: string;
  fieldCls: string;
  onSaved: (c: PluxeeConfig) => void;
}) {
  const [form, setForm] = useState<PluxeeConfig>(config);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setForm(config); }, [config]);

  function upd<K extends keyof PluxeeConfig>(key: K, val: PluxeeConfig[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  async function handleSave() {
    setErr(null); setMsg(null); setSaving(true);
    const inactive = Number(String(form.inactive_value ?? "1").replace(",", ".")) || 1;
    const payload = {
      client_code: form.client_code?.trim() || null,
      order_type: form.order_type?.trim() || null,
      product: form.product?.trim() || null,
      delivery_place: form.delivery_place?.trim() || null,
      cep: form.cep?.trim() || null,
      address: form.address?.trim() || null,
      number: form.number?.trim() || null,
      complement: form.complement?.trim() || null,
      reference: form.reference?.trim() || null,
      neighborhood: form.neighborhood?.trim() || null,
      city: form.city?.trim() || null,
      uf: form.uf?.trim().toUpperCase() || null,
      responsible_name: form.responsible_name?.trim() || null,
      responsible_ddd: form.responsible_ddd?.trim() || null,
      responsible_phone: form.responsible_phone?.trim() || null,
      inactive_value: inactive,
      updated_by: profileName,
    };
    try {
      const res = hasRow
        ? await db.from("pluxee_config").update(payload).eq("id", 1)
        : await db.from("pluxee_config").insert({ id: 1, ...payload });
      if (res.error) throw new Error(res.error.message);
      onSaved({ ...form, ...payload, inactive_value: inactive, id: 1, updated_at: new Date().toISOString() });
      setMsg("Configurações salvas.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const F = (k: keyof PluxeeConfig, label: string, placeholder?: string, mono?: boolean) => (
    <CfgField
      label={label}
      value={(form[k] as string) ?? ""}
      onChange={(v) => upd(k, v as PluxeeConfig[typeof k])}
      placeholder={placeholder}
      mono={mono}
      disabled={!canEdit}
      fieldCls={fieldCls}
    />
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {F("client_code", "Código Cliente Pluxee", "3705075", true)}
        {F("product", "Produto (carteira)", "603903 - Carteira Gift")}
        {F("order_type", "Tipo do pedido", "001 - Pedido Normal")}
      </div>

      <div className="border-t border-border pt-3">
        <p className="text-[11px] font-semibold text-text-light uppercase tracking-wider mb-2">Endereço de entrega</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {F("delivery_place", "Local de entrega", "Matriz")}
          {F("cep", "CEP", "11013310", true)}
          {F("address", "Endereço", "RUA IGUATEMI MARTINS")}
          {F("number", "Número", "8")}
          {F("complement", "Complemento")}
          {F("reference", "Referência")}
          {F("neighborhood", "Bairro", "VILA NOVA")}
          {F("city", "Cidade", "Santos")}
          {F("uf", "UF", "SP")}
        </div>
      </div>

      <div className="border-t border-border pt-3">
        <p className="text-[11px] font-semibold text-text-light uppercase tracking-wider mb-2">Responsável pelo recebimento</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {F("responsible_name", "Nome", "CAMILA FERREIRA DA SILVA")}
          {F("responsible_ddd", "DDD", "13", true)}
          {F("responsible_phone", "Telefone", "974114551", true)}
        </div>
      </div>

      <div className="border-t border-border pt-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-semibold text-text-light uppercase tracking-wider">Valor dos Inativos (R$)</label>
            <input
              type="text"
              value={String(form.inactive_value ?? "1")}
              onChange={(e) => upd("inactive_value", e.target.value as unknown as PluxeeConfig["inactive_value"])}
              disabled={!canEdit}
              className={`${fieldCls} disabled:bg-gray-100 disabled:text-text-light`}
            />
            <p className="text-[11px] text-text-light mt-1">Valor simbólico de quem não recebe no navio (padrão R$ 1,00).</p>
          </div>
        </div>
      </div>

      {err && <p className="text-sm text-red-700 bg-red-50 border border-red-300 rounded-lg px-3 py-2">⚠️ {err}</p>}
      {msg && <p className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-300 rounded-lg px-3 py-2">✓ {msg}</p>}

      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>{saving ? "Salvando…" : "Salvar configurações"}</Button>
        </div>
      )}
    </div>
  );
}
