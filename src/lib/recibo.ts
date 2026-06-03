// Helpers do Recibo de Pagamento (RH > Documentos). Funções puras, usadas tanto
// no servidor (rota que gera o .docx/.pdf) quanto no cliente (pré-visualização
// do valor por extenso e do período). Sem dependências externas.

const UNIDADES = [
  "zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove",
];
const DEZ_DEZENOVE = [
  "dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove",
];
const DEZENAS = [
  "", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa",
];
const CENTENAS = [
  "", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos",
];

export const MESES = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

// 0..999 por extenso (sem o "e" de ligação entre grupos maiores).
function ate999(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "cem";
  const parts: string[] = [];
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c > 0) parts.push(CENTENAS[c]);
  if (resto > 0) {
    if (resto < 10) parts.push(UNIDADES[resto]);
    else if (resto < 20) parts.push(DEZ_DEZENOVE[resto - 10]);
    else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      parts.push(u === 0 ? DEZENAS[d] : `${DEZENAS[d]} e ${UNIDADES[u]}`);
    }
  }
  return parts.join(" e ");
}

// Inteiro por extenso (até centenas de milhão — mais que suficiente p/ recibos).
function inteiroExtenso(n: number): string {
  if (n === 0) return "zero";
  const milhoes = Math.floor(n / 1_000_000);
  const milhares = Math.floor((n % 1_000_000) / 1000);
  const centenas = n % 1000;

  const grupos: string[] = [];
  if (milhoes > 0) grupos.push(milhoes === 1 ? "um milhão" : `${ate999(milhoes)} milhões`);
  if (milhares > 0) grupos.push(milhares === 1 ? "mil" : `${ate999(milhares)} mil`);
  if (centenas > 0) grupos.push(ate999(centenas));

  if (grupos.length === 0) return "zero";
  if (grupos.length === 1) return grupos[0];

  // Liga o último grupo com "e" quando ele é < 100 ou múltiplo exato de 100
  // (ex.: "mil e quinhentos", "dois mil e duzentos", mas "mil novecentos e ...").
  const ultimo = centenas;
  const usaE = ultimo !== 0 && (ultimo < 100 || ultimo % 100 === 0);
  const cabeca = grupos.slice(0, -1).join(" ");
  const cauda = grupos[grupos.length - 1];
  return `${cabeca}${usaE ? " e " : " "}${cauda}`;
}

// Title Case mantendo o "e" de ligação em minúsculo ("Mil e Quinhentos Reais").
function titleCaseExtenso(s: string): string {
  return s
    .split(" ")
    .map((w) => (w === "e" ? "e" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// "500,00" -> "Quinhentos Reais"; "1976,28" -> "Mil Novecentos e Setenta e
// Seis Reais e Vinte e Oito Centavos".
export function valorPorExtenso(valor: number): string {
  if (!Number.isFinite(valor) || valor < 0) return "";
  const reais = Math.floor(valor);
  const centavos = Math.round((valor - reais) * 100);
  const partes: string[] = [];
  if (reais > 0 || centavos === 0) {
    partes.push(`${inteiroExtenso(reais)} ${reais === 1 ? "real" : "reais"}`);
  }
  if (centavos > 0) {
    partes.push(`${inteiroExtenso(centavos)} ${centavos === 1 ? "centavo" : "centavos"}`);
  }
  return titleCaseExtenso(partes.join(" e "));
}

// Número -> "500,00" / "1.976,28" (pt-BR, 2 casas).
export function formatValorBR(valor: number): string {
  return valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// "yyyy-mm-dd" -> "02 de junho de 2026".
export function formatDataExtenso(iso: string): string {
  const [y, m, d] = (iso || "").slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "";
  return `${String(d).padStart(2, "0")} de ${MESES[m - 1]} de ${y}`;
}

// Mês anterior ao da data -> "maio de 2026" (data em jun/2026). Jan volta p/ dez
// do ano anterior.
export function formatPeriodoAnterior(iso: string): string {
  const [y, m] = (iso || "").slice(0, 10).split("-").map(Number);
  if (!y || !m) return "";
  let mes = m - 1; // 0-based do mês anterior (m é 1-based; m-1 vira o índice do anterior)
  let ano = y;
  if (mes < 1) {
    mes = 12;
    ano -= 1;
  }
  return `${MESES[mes - 1]} de ${ano}`;
}

// Dígitos -> "366.434.208-90" (mantém o valor original se não tiver 11 dígitos).
export function formatCpf(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "").slice(0, 11);
  if (digits.length !== 11) return raw || "";
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}
