// Chave de acesso da NF-e/NFC-e (44 dígitos): validação e campos embutidos.
// Módulo puro (sem pdf/ocr) — roda no servidor (leitor de PDF do Contas a
// Pagar/Compras) e no navegador (scanner de câmera do Controle de Compras).

export interface NfeChaveScan {
  chave: string; // 44 dígitos
  cnpjEmitente: string; // 14 dígitos (só números)
  modelo: string; // "55" NF-e, "65" NFC-e (cupom)
  serie: string;
  numero: string; // número da NF, sem zeros à esquerda
  competencia: string; // "YYYY-MM" (ano/mês de emissão, da chave)
  // Valor total da nota — só quando o QR da NFC-e traz o vNF (emissão
  // offline). O CODE-128 do DANFE carrega apenas a chave, sem valor.
  valor: number | null;
}

// DV (mod 11) da chave — calculado sobre os 43 primeiros dígitos.
export function chaveDV(k43: string): number {
  let sum = 0;
  let w = 2;
  for (let i = k43.length - 1; i >= 0; i--) {
    sum += Number(k43[i]) * w;
    w = w === 9 ? 2 : w + 1;
  }
  const dv = 11 - (sum % 11);
  return dv >= 10 ? 0 : dv;
}

// Campos determinísticos embutidos na chave. NÃO valida o DV — o leitor de PDF
// aceita chave de DV errado como fallback (OCR troca dígito), o scanner não.
export function chaveFields(c: string): Omit<NfeChaveScan, "valor"> {
  const aa = c.slice(2, 4);
  const mm = c.slice(4, 6);
  return {
    chave: c,
    cnpjEmitente: c.slice(6, 20),
    modelo: c.slice(20, 22),
    serie: String(Number(c.slice(22, 25))),
    numero: String(Number(c.slice(25, 34))),
    competencia: `20${aa}-${mm}`,
  };
}

// Texto lido pela câmera → chave validada (modelo 55/65 + DV), ou null.
// Aceita o CODE-128 do DANFE (os 44 dígitos puros), o QR code da NFC-e
// (`...?p=chave|versão|...`, com vNF quando a emissão foi offline) e o formato
// antigo do QR por query string (`chNFe=...&vNF=...`).
export function parseNfeScan(text: string): NfeChaveScan | null {
  const t = (text || "").trim();
  let chave: string | null = null;
  let valor: number | null = null;

  // QR v2: `?p=chave|nVersao|tpAmb|...`. Na emissão offline são 8 campos e o
  // 5º é o vNF (decimal com ponto); na online são 5, sem valor.
  const p = t.match(/[?&]p=([^&\s]+)/i);
  if (p) {
    const parts = decodeURIComponent(p[1]).split("|");
    const first = (parts[0] || "").replace(/\D/g, "");
    if (first.length === 44) {
      chave = first;
      const v = parts.length >= 8 ? Number(parts[4]) : NaN;
      if (Number.isFinite(v) && v > 0) valor = v;
    }
  }

  // QR v1 (legado): parâmetros soltos na query.
  if (!chave) {
    const m = t.match(/chNFe=(\d{44})/i);
    if (m) {
      chave = m[1];
      const v = t.match(/[?&]vNF=(\d+(?:\.\d+)?)/i);
      if (v && Number(v[1]) > 0) valor = Number(v[1]);
    }
  }

  // CODE-128 do DANFE: só os 44 dígitos da chave (nunca uma URL).
  if (!chave && !/^https?:/i.test(t)) {
    const digits = t.replace(/\D/g, "");
    if (digits.length === 44) chave = digits;
  }

  if (!chave) return null;
  const modelo = chave.slice(20, 22);
  if (modelo !== "55" && modelo !== "65") return null;
  if (chaveDV(chave.slice(0, 43)) !== Number(chave[43])) return null;
  return { ...chaveFields(chave), valor };
}
