// Classificação do memo de uma movimentação bancária. Calibrado com extratos
// reais de Itaú e Santander (2026). Duas responsabilidades:
//   1. dizer se a linha é marcador de saldo (deve ser DESCARTADA na importação);
//   2. dizer se a linha é conciliável (transferência interna / aplicação
//      automática entram no extrato mas nunca são conciliadas);
//   3. extrair favorecido e CNPJ/CPF do memo, quando o banco os coloca lá.

// Marcadores de saldo do Itaú: "SALDO ANTERIOR", "SALDO TOTAL DISPONÍVEL DIA",
// "SALDO MOVIMENTAÇÃO CONTA", "SALDO APLIC. AUT." — não são movimentação de
// caixa, só fotos do saldo. O extrato do contador não os inclui.
export function isBalanceMarker(memo: string): boolean {
  return /^\s*SALDO\b/i.test(memo);
}

// Transferência interna / aplicação-resgate automático e o rendimento dela.
// Dinheiro que só circula entre a conta e a aplicação automática — o contador
// registra mas nunca marca "ok". Não deve gerar sugestão de conciliação.
const NON_RECONCILABLE_PATTERNS: RegExp[] = [
  /RESGATE\s+CONTAMAX/i,
  /APLICACAO\s+CONTAMAX/i,
  /APLICAÇÃO\s+CONTAMAX/i,
  /\bRES\s+APLIC\s+AUT/i, // "RES APLIC AUT MAIS" (Itaú)
  /\bAPL\s+APLIC\s+AUT/i, // "APL APLIC AUT MAIS" (Itaú)
  /\bAPLIC\s+AUT\s+MAIS/i,
  /RENDIMENTOS\s+REND\s+PAGO\s+APLIC/i, // rendimento do sweep
  /RESGATE\s+CDB/i,
];

export function isReconcilable(memo: string): boolean {
  return !NON_RECONCILABLE_PATTERNS.some((re) => re.test(memo));
}

const CNPJ_RE = /(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/;
const CPF_RE = /(\d{3}\.\d{3}\.\d{3}-\d{2})/;

// Prefixos do Itaú que antecedem o nome do favorecido no memo. Ex.:
//   "PIX ENVIADO LANCHONETE ILHA DE ITAPARICA LTDA 67.506.949/0001-39"
//   "BOLETO PAGO TERRA NOVA A TERRA NOVA ALIMENTOS E BEBIDAS LTDA 51.560.262/..."
//   "PAGAMENTOS PIX QR-CODE AUTORIDADE PORTUARIA DE SANTOS S.A. 44.837.524/..."
const PAYEE_PREFIXES = [
  /^BOLETO PAGO\s+/i,
  /^PIX ENVIADO\s+/i,
  /^PIX RECEBIDO\s+/i,
  /^PAGAMENTOS PIX QR-CODE\s+/i,
  /^PAGAMENTOS CONCESSIONARIA\s+/i,
  /^PAGAMENTOS TRANSF CC ITAU\s+/i,
  /^PAGAMENTOS\s+/i,
];

// Extrai { payeeName, payeeDocument } de um memo. Heurística — quando não dá,
// devolve nulls (o usuário completa depois). O documento é a âncora: nome é o
// texto entre o prefixo e o documento.
export function extractPayee(memo: string): { payeeName: string | null; payeeDocument: string | null } {
  const docMatch = memo.match(CNPJ_RE) || memo.match(CPF_RE);
  const payeeDocument = docMatch ? docMatch[1].replace(/\D/g, "") : null;

  let rest = memo;
  if (docMatch) rest = memo.slice(0, docMatch.index).trim();

  for (const prefix of PAYEE_PREFIXES) {
    if (prefix.test(rest)) {
      rest = rest.replace(prefix, "").trim();
      break;
    }
  }

  // Se sobrou algo curto e sem cara de código, usa como nome.
  const payeeName = docMatch && rest && rest.length >= 3 && rest.length <= 80 ? rest : null;
  return { payeeName, payeeDocument };
}
