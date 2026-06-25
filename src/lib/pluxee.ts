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

function colLetter(i: number): string {
  let s = "", n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function escapeXml(v: string): string {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Gera e baixa o .xlsx PLANSIP4C (client-side). Em vez de RECONSTRUIR o arquivo
// (o que apagava logo, cores, abas e comentários do modelo — saía todo branco),
// abre o .xlsx como zip e injeta SÓ os valores nas células de dados que já
// existem no modelo, preservando o estilo (s=) de cada uma. Todo o resto do
// arquivo fica intacto — é o que o Pluxee exige ("não exclua/oculte/renomeie").
export async function downloadPluxeeXlsx(
  beneficiaries: PluxeeBeneficiary[],
  shipName: string,
): Promise<void> {
  const PizZip = (await import("pizzip")).default;
  const res = await fetch(TEMPLATE_URL);
  if (!res.ok) throw new Error("Não consegui carregar o modelo PLANSIP4C (public/templates).");
  const zip = new PizZip(await res.arrayBuffer());
  // sheet1.xml é a aba "Dados dos Beneficiários" (cabeçalho nas linhas 1-7,
  // dados a partir da 8). As demais abas/recursos não são tocados.
  const sheetPath = "xl/worksheets/sheet1.xml";
  const file = zip.file(sheetPath);
  if (!file) throw new Error("Modelo PLANSIP4C inválido: planilha de dados não encontrada.");
  let xml = file.asText();

  beneficiaries.forEach((b, i) => {
    const R = DATA_START_ROW + i;
    // Preenche uma célula que JÁ EXISTE no modelo, mantendo seus atributos (s=);
    // só troca o vazio `<c .../>` por `<c ...>valor</c>`. Texto entra como
    // inlineStr (não mexe no sharedStrings); o valor entra como número.
    const fill = (c: number, inner: string, inlineStr: boolean) => {
      const ref = `${colLetter(c)}${R}`;
      const re = new RegExp(`<c r="${ref}"([^>]*)/>`);
      xml = xml.replace(re, inlineStr
        ? `<c r="${ref}"$1 t="inlineStr">${inner}</c>`
        : `<c r="${ref}"$1>${inner}</c>`);
    };
    const put = (c: number, v: string) => {
      if (v != null && v !== "") fill(c, `<is><t xml:space="preserve">${escapeXml(v)}</t></is>`, true);
    };
    put(COL.client, b.client);
    put(COL.situacao, b.situacao);
    put(COL.nome, b.nome);
    put(COL.cpf, b.cpf);
    put(COL.nascimento, b.nascimento);
    put(COL.tipoPedido, b.tipoPedido);
    put(COL.produto, b.produto);
    if (Number.isFinite(b.valor)) fill(COL.valor, `<v>${b.valor}</v>`, false);
    put(COL.dataCredito, b.dataCredito);
    put(COL.localEntrega, b.localEntrega);
    put(COL.cep, b.cep);
    put(COL.endereco, b.endereco);
    put(COL.numero, b.numero);
    put(COL.complemento, b.complemento);
    put(COL.referencia, b.referencia);
    put(COL.bairro, b.bairro);
    put(COL.cidade, b.cidade);
    put(COL.uf, b.uf);
    put(COL.responsavel, b.responsavel);
    put(COL.ddd, b.ddd);
    put(COL.telefone, b.telefone);
  });

  zip.file(sheetPath, xml);
  const blob = zip.generate({
    type: "blob",
    compression: "DEFLATE",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }) as Blob;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = pluxeeFileName(shipName);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
