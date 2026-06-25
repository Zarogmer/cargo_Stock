// Geração do arquivo Pluxee "Navios PLUXEE" (formato oficial PLANSIP4C).
//
// O que muda por navio é só o VALOR do cartão de cada pessoa, que é o
// pluxee_value da alocação (= líquido − folha, já calculado no Financeiro).
// Todo o resto (lista de beneficiários, endereço de entrega, responsável,
// carteira) se repete e vem da PluxeeConfig.
//
// A lista segue a planilha atual da empresa: TODOS os colaboradores entram —
// quem recebeu no navio fica "Ativo" com o valor; os demais ficam "Inativo"
// com o valor simbólico (R$ 1,00). O arquivo é montado em cima do modelo
// oficial em /public/templates (linhas 1-7 = cabeçalho fixo, dados a partir da 8).

import type { Employee, JobAllocation, PluxeeConfig } from "@/types/database";

export const PLUXEE_SHEET = "Dados dos Beneficiários";
const DATA_START_ROW = 8; // 1-based; linhas 1-7 são o cabeçalho fixo do modelo
const TEMPLATE_URL = "/templates/plansip4c-template.xlsx";

// Índice (0-based) de cada coluna do PLANSIP4C.
const COL = {
  client: 0, situacao: 1, nome: 2, cpf: 3, nascimento: 4, gravacao: 5,
  matricula: 6, depto: 7, codDepto: 8, centroCusto: 9, tipoPedido: 10,
  produto: 11, valor: 12, dataCredito: 13, mesRef: 14, localEntrega: 15,
  cep: 16, endereco: 17, numero: 18, complemento: 19, referencia: 20,
  bairro: 21, cidade: 22, uf: 23, responsavel: 24, ddd: 25, telefone: 26, email: 27,
};

export interface PluxeeBeneficiary {
  client: string;
  situacao: "Ativo" | "Inativo";
  nome: string;
  cpf: string;
  nascimento: string; // DD/MM/AAAA
  tipoPedido: string;
  produto: string;
  valor: number;
  dataCredito: string; // DD/MM/AAAA
  localEntrega: string;
  cep: string;
  endereco: string;
  numero: string;
  complemento: string;
  referencia: string;
  bairro: string;
  cidade: string;
  uf: string;
  responsavel: string;
  ddd: string;
  telefone: string;
}

export interface PluxeeBuildResult {
  beneficiaries: PluxeeBeneficiary[];
  activeCount: number;
  inactiveCount: number;
  totalCredit: number;
  missingCpf: string[]; // sem CPF válido → não entram (Pluxee exige CPF)
  missingBirth: string[]; // sem nascimento → entram, mas faltando dado obrigatório
}

function onlyDigits(s: string | null | undefined): string {
  return (s || "").replace(/\D/g, "");
}

// "YYYY-MM-DD..." → "DD/MM/AAAA" (formato exigido pelo Pluxee).
function fmtDateBR(iso: string | null | undefined): string {
  if (!iso) return "";
  const p = iso.slice(0, 10).split("-");
  if (p.length !== 3 || !p[0] || !p[1] || !p[2]) return "";
  return `${p[2]}/${p[1]}/${p[0]}`;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Monta a lista de beneficiários pro arquivo de um navio (job).
export function buildPluxeeBeneficiaries({
  employees,
  allocations,
  config,
  creditDate,
}: {
  employees: Employee[];
  allocations: JobAllocation[]; // já filtradas pro job do navio
  config: PluxeeConfig;
  creditDate: string; // YYYY-MM-DD
}): PluxeeBuildResult {
  // Pluxee por funcionário, somando só alocações ativas do navio.
  const pluxeeByEmp = new Map<number, number>();
  for (const a of allocations) {
    if (a.status !== "ATIVO" || a.employee_id == null) continue;
    pluxeeByEmp.set(a.employee_id, (pluxeeByEmp.get(a.employee_id) || 0) + Number(a.pluxee_value || 0));
  }

  // Beneficiários = todos os não-demitidos + quem recebeu pluxee (mesmo que
  // já tenha sido demitido depois — ganhou no navio, tem que receber).
  const relevant = new Map<number, Employee>();
  for (const e of employees) {
    if ((e.status || "ATIVO") !== "INATIVO") relevant.set(e.id, e);
  }
  for (const [empId, v] of pluxeeByEmp) {
    if (v > 0 && !relevant.has(empId)) {
      const e = employees.find((x) => x.id === empId);
      if (e) relevant.set(empId, e);
    }
  }

  const inactiveValue = round2(Number(config.inactive_value ?? 1) || 1);
  const dataCredito = fmtDateBR(creditDate);
  const client = (config.client_code || "").trim();

  const missingCpf: string[] = [];
  const missingBirth: string[] = [];
  const beneficiaries: PluxeeBeneficiary[] = [];

  const sorted = Array.from(relevant.values()).sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  for (const e of sorted) {
    const cpf = onlyDigits(e.cpf);
    if (cpf.length !== 11) {
      missingCpf.push(e.name); // sem CPF válido não dá pra ser beneficiário Pluxee
      continue;
    }
    const nascimento = fmtDateBR(e.birth_date);
    if (!nascimento) missingBirth.push(e.name);
    const pluxee = round2(pluxeeByEmp.get(e.id) || 0);
    const ativo = pluxee > 0;
    beneficiaries.push({
      client,
      situacao: ativo ? "Ativo" : "Inativo",
      nome: e.name.trim().toUpperCase(),
      cpf,
      nascimento,
      tipoPedido: (config.order_type || "001 - Pedido Normal").trim(),
      produto: (config.product || "603903 - Carteira Gift").trim(),
      valor: ativo ? pluxee : inactiveValue,
      dataCredito,
      localEntrega: (config.delivery_place || "").trim(),
      cep: onlyDigits(config.cep),
      endereco: (config.address || "").trim(),
      numero: (config.number || "").trim(),
      complemento: (config.complement || "").trim(),
      referencia: (config.reference || "").trim(),
      bairro: (config.neighborhood || "").trim(),
      cidade: (config.city || "").trim(),
      uf: (config.uf || "").trim().toUpperCase(),
      responsavel: (config.responsible_name || "").trim(),
      ddd: onlyDigits(config.responsible_ddd),
      telefone: onlyDigits(config.responsible_phone),
    });
  }

  const activeCount = beneficiaries.filter((b) => b.situacao === "Ativo").length;
  const totalCredit = round2(
    beneficiaries.filter((b) => b.situacao === "Ativo").reduce((s, b) => s + b.valor, 0),
  );
  return {
    beneficiaries,
    activeCount,
    inactiveCount: beneficiaries.length - activeCount,
    totalCredit,
    missingCpf,
    missingBirth,
  };
}

// Data de crédito do Pluxee = 20 dias após o término (end_date) do navio. Se o
// navio ainda não foi fechado (sem end_date), retorna "" → o arquivo sai sem
// data de crédito. Vale pra embarque e costado.
export function pluxeeCreditDate(endDate: string | null | undefined): string {
  const iso = (endDate || "").slice(0, 10);
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return "";
  const dt = new Date(Date.UTC(y, m - 1, d + 20));
  return dt.toISOString().slice(0, 10);
}

// Nome do arquivo Pluxee = só o nome do navio (ex.: "MV GCL PARADIP.xlsx").
// Remove apenas os caracteres inválidos pra nome de arquivo, preservando
// espaços e acentos. Fallback "Pluxee" se vier vazio.
export function pluxeeFileName(shipName: string): string {
  const safe = (shipName || "").replace(/[\\/:*?"<>|]/g, "").trim();
  return `${safe || "Pluxee"}.xlsx`;
}

// Gera e baixa o .xlsx no formato PLANSIP4C (client-side). Carrega o modelo
// oficial e injeta as linhas de dados a partir da linha 8, preservando o
// cabeçalho fixo e as abas auxiliares do modelo.
export async function downloadPluxeeXlsx(
  beneficiaries: PluxeeBeneficiary[],
  shipName: string,
): Promise<void> {
  // xlsx-js-style + cellStyles preservam as cores/formatação do modelo no
  // round-trip (o "xlsx" puro descarta os estilos e o arquivo sai todo branco).
  const XLSX = (await import("xlsx-js-style")).default;
  const res = await fetch(TEMPLATE_URL);
  if (!res.ok) throw new Error("Não consegui carregar o modelo PLANSIP4C (public/templates).");
  const wb = XLSX.read(await res.arrayBuffer(), { cellStyles: true });
  const ws = wb.Sheets[PLUXEE_SHEET];
  if (!ws) throw new Error(`Aba "${PLUXEE_SHEET}" não encontrada no modelo.`);

  const set = (r: number, c: number, v: string | number, t: "s" | "n" = "s", z?: string) => {
    const addr = XLSX.utils.encode_cell({ r, c });
    if (v === "" || v === null || v === undefined) { delete ws[addr]; return; }
    // Preserva o estilo (cor/borda) que a célula já tinha no modelo.
    const prev = ws[addr] as Record<string, unknown> | undefined;
    ws[addr] = z ? { ...prev, t, v, z } : { ...prev, t, v };
  };

  beneficiaries.forEach((b, i) => {
    const r = DATA_START_ROW - 1 + i; // 0-based
    set(r, COL.client, b.client);
    set(r, COL.situacao, b.situacao);
    set(r, COL.nome, b.nome);
    set(r, COL.cpf, b.cpf);
    set(r, COL.nascimento, b.nascimento);
    set(r, COL.tipoPedido, b.tipoPedido);
    set(r, COL.produto, b.produto);
    set(r, COL.valor, b.valor, "n", "0.00");
    set(r, COL.dataCredito, b.dataCredito);
    set(r, COL.localEntrega, b.localEntrega);
    set(r, COL.cep, b.cep);
    set(r, COL.endereco, b.endereco);
    set(r, COL.numero, b.numero);
    set(r, COL.complemento, b.complemento);
    set(r, COL.referencia, b.referencia);
    set(r, COL.bairro, b.bairro);
    set(r, COL.cidade, b.cidade);
    set(r, COL.uf, b.uf);
    set(r, COL.responsavel, b.responsavel);
    set(r, COL.ddd, b.ddd);
    set(r, COL.telefone, b.telefone);
  });

  const lastRow = DATA_START_ROW - 1 + Math.max(beneficiaries.length, 1);
  ws["!ref"] = `A1:AC${lastRow + 1}`;

  XLSX.writeFile(wb, pluxeeFileName(shipName));
}
