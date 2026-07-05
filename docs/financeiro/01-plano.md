# Módulo Financeiro (Contas a Pagar + Conciliação Bancária) — Plano incremental

> Baseado no levantamento em [00-arquitetura.md](00-arquitetura.md). Prioridade
> declarada: **conciliação bancária** — por isso a importação por arquivo (OFX/CNAB)
> e o motor de matching vêm antes da captura de e-mail e das APIs bancárias.
> Estimativas em "sessões" = um bloco de trabalho focado de ~2-4h (uma sessão de
> Claude Code + teste manual). Cada fase termina com lint + `tsc --noEmit` + build,
> commit e uma lista do que testar manualmente.

## Decisões que precisam do seu OK antes da Fase 1

1. **Migrations versionadas (exigência da tarefa).** Proposta: baseline `0_init`
   marcada como aplicada em prod (`prisma migrate resolve`), migrations novas geradas
   com `prisma migrate diff`, e trocar o `startCommand` do railway.json de
   `db push --accept-data-loss` para `prisma migrate deploy`. É uma mudança de
   pipeline de deploy — segura (a baseline não altera nada no banco), mas quero seu
   OK explícito. Alternativa (não recomendada): manter `db push` e versionar só o SQL
   em `docs/`, como é feito hoje à mão.
2. **PDFs de boleto no Postgres** (coluna `Bytes` + hash SHA-256), coerente com a
   infra atual sem storage externo. Milhares de boletos/mês ×  ~100-300 KB ≈ centenas
   de MB/ano no banco — aceitável no Railway, mas é bom estar ciente.
3. **Graph por delta query (polling), não webhook**, como padrão inicial. O webhook
   (subscription) exige endpoint público com renovação a cada ~3 dias e validação de
   handshake; o delta query a cada tick do scheduler (60s) entrega latência de ~1 min
   com muito menos superfície de falha. Webhook pode ser adicionado depois sem
   retrabalho (mesmo pipeline de ingestão).
4. **Fila em Postgres** (tabela `finance_jobs` + `FOR UPDATE SKIP LOCKED` consumida
   pelo scheduler in-process), sem Redis. Justificativa no 00-arquitetura §5.
5. **Onde fica na UI**: sub-rotas reais `/financeiro/contas` e `/financeiro/conciliacao`
   (páginas novas, sem inchar o `financeiro/page.tsx` que já é gigante), adicionadas
   como filhos do item "Financeiro" no sidebar, visíveis pros mesmos papéis do
   `FINANCEIRO_MOD`.

---

## Fase 1 — Fundações: schema + migrations + crypto + esqueleto de UI (~2 sessões)

**Entrega**: tabelas criadas por migration versionada, helper de criptografia, páginas vazias navegáveis.

- Baseline de migrations (decisão 1) e ajuste do `railway.json`.
- Novos models no `prisma/schema.prisma` (inglês + `@@map` snake_case, seguindo o padrão):
  - `Supplier` (existente) ganha `cnpj @unique`, `email`, `bank_info`.
  - `PayableInvoice` (ContaPagar): valor, vencimento, fornecedor, origem (EMAIL/MANUAL),
    `status PayableStatus` — enum `RECEBIDO | AGUARDANDO_APROVACAO | APROVADO | PAGO | CANCELADO`,
    linha digitável, código de barras, trilha `approved_by/at`, `paid_by/at`, `created_by`.
  - `InvoiceAttachment` (AnexoBoleto): `pdf Bytes`, `sha256 @unique`, filename, origem
    (message id do e-mail), N:1 com `PayableInvoice`.
  - `BankAccount` (ContaBancaria): banco (ITAU/SANTANDER/OUTRO), agência, conta, apelido,
    provider habilitado.
  - `BankTransaction` (MovimentacaoBancaria): data, valor (signed), descrição, favorecido,
    documento (CNPJ/CPF), `fitid`/id externo, fonte (`OFX_FILE | CNAB_FILE | API_ITAU | API_SANTANDER`),
    **`@@unique([bank_account_id, external_id])`** + hash de dedupe pra fontes sem id.
  - `Reconciliation` (Conciliacao): 1:1 transação ⇄ conta a pagar, score, motivo do match,
    `matched_by` (AUTO/usuário), status (SUGERIDA/CONFIRMADA/REJEITADA).
  - `IntegrationLog` (LogIntegracao): provider, operação, ok/erro, payload resumido.
  - `EmailIntegrationAccount` (ContaEmailIntegrada): mailbox, tenant, tokens **criptografados**,
    delta token, habilitada.
  - `FinanceJob` (fila): tipo, payload JSON, status, tentativas, `dedupe_key @unique`.
- `src/lib/crypto.ts` (AES-256-GCM, `FINANCE_ENCRYPTION_KEY`), `.env.example` atualizado
  (inclui `CRON_SECRET` que já era usado e não estava lá).
- Páginas stub `/financeiro/contas` e `/financeiro/conciliacao` + sidebar.

**Teste manual**: menu novo aparece pros papéis certos; ESTAGIO vê e não edita; migration aplicada sem tocar em dados.

## Fase 2 — Contas a Pagar (núcleo manual) (~2-3 sessões)

**Entrega**: dá pra operar contas a pagar de ponta a ponta sem nenhuma integração.

- Rotas `src/app/api/financeiro/contas/*` (padrão `auth()` + allowlist de roles): CRUD de
  lançamento, upload de PDF (dedupe por SHA-256), vínculo com fornecedor.
- **Máquina de estados** em `src/lib/services/payable-status.ts`: transições válidas
  (`RECEBIDO → AGUARDANDO_APROVACAO → APROVADO → PAGO`; `CANCELADO` de qualquer estado
  não-pago); rota rejeita transição inválida; auditoria de quem aprovou/pagou.
- Regra de aprovação automática opcional (ex.: fornecedor confiável + valor ≤ teto configurável
  em `AppSetting`).
- UI `/financeiro/contas`: lista com filtros por status/vencimento, detalhe com PDF embutido,
  botões de transição conforme permissão.

**Teste manual**: criar → aprovar → pagar; tentar pular estado (deve bloquear); anexar o mesmo PDF duas vezes (deve deduplicar).

## Fase 3 — Importação de extrato por arquivo: OFX + CNAB (~2-3 sessões) ← destrava a conciliação

**Entrega**: extrato do Itaú e do Santander dentro do sistema, idempotente, sem depender de banco/API.

- Interface `BancoProvider` em `src/lib/services/banking/provider.ts`:
  `listarMovimentacoes(conta, inicio, fim)` → `BankTransaction[]` normalizadas. Tudo que
  entra no motor de conciliação passa por aqui — arquivo e API são só implementações.
- `OfxFileProvider`: parser OFX próprio (OFX 1.x é SGML; parser tolerante, testado com
  arquivos reais dos dois bancos — vou pedir 1 arquivo de cada pra você).
- `CnabFileProvider`: retorno CNAB 240 (Febraban) e 400 (layouts Itaú/Santander) de
  pagamentos — posições fixas, foco nos segmentos J/J-52 (títulos).
- Rota de upload + dedupe (`fitid` do OFX; hash conta+data+valor+doc quando não houver id).
- UI `/financeiro/conciliacao` aba "Extrato": upload, lista por conta/período, badge da fonte.

**Teste manual**: importar o mesmo OFX duas vezes (segunda não duplica nada); conferir datas/valores contra o PDF do extrato.

## Fase 4 — Motor de conciliação (matching) (~2-3 sessões)

**Entrega**: conciliação automática com fila de revisão manual.

- `src/lib/services/reconciliation/engine.ts`, independente de provider:
  - candidatos por valor exato + janela de data configurável (± N dias em `AppSetting`);
  - score ponderado: valor, proximidade de data, CNPJ do favorecido, similaridade de nome,
    linha digitável (match forte);
  - score ≥ teto → `Reconciliation` CONFIRMADA automática (conta vira PAGO com trilha);
    intermediário → SUGERIDA (fila de revisão); baixo → sem match.
  - grava motivo, score e provider de origem; idempotente (transação já conciliada nunca
    entra de novo — constraint 1:1 no banco).
- UI: fila de revisão (aceitar/rejeitar/casar manualmente), títulos conciliados × pendentes.

**Teste manual**: caso exato (auto), caso valor igual/data deslocada (fila), rejeitar sugestão e casar manualmente.

## Fase 5 — Captura de boletos por e-mail (Microsoft Graph) (~3-4 sessões)

**Entrega**: boleto que chega na caixa vira `PayableInvoice` RECEBIDO com PDF anexo, sozinho.

- OAuth2 Graph (authorization code + refresh) — múltiplas caixas em `EmailIntegrationAccount`,
  tokens AES-GCM em repouso; callback `/api/financeiro/email/callback`.
- Ingestão por **delta query** no tick do scheduler (guardas iguais às do instrumentation:
  só produção/flag explícita — o .env local aponta pra prod!). Cada mensagem nova vira
  `FinanceJob` (dedupe por message id); worker baixa anexos PDF.
- **Extração determinística FEBRABAN** em `src/lib/services/boleto/parse.ts`:
  - pdfjs-dist (server-side) extrai o texto; regex acha linha digitável (47 dígitos,
    boleto bancário) ou 48 (arrecadação/convênio, começa com 8);
  - validação dos DVs (mód. 10 por campo; mód. 11 do código de barras) — **valor e
    vencimento saem do código** (fator de vencimento base 1997-10-07 + wrap 2025), não do
    texto livre;
  - fornecedor/CNPJ por heurística no texto (CNPJ perto de "Beneficiário"), casando com
    `Supplier` por CNPJ; OCR fica fora do escopo inicial (registrado como fallback futuro).
- Dedupe global por SHA-256 do PDF **e** por linha digitável (mesmo boleto reenviado não
  duplica lançamento). `IntegrationLog` em cada passo.
- UI: aba "Boletos recebidos" + tela de contas de e-mail integradas (conectar/desconectar).

**Teste manual**: enviar boleto real pra caixa monitorada → lançamento certo em ~1 min; reenviar o mesmo e-mail (não duplica); PDF sem boleto (ignora e loga).

## Fase 6 — Providers de API bancária: Itaú e Santander (~3-4 sessões + homologação externa)

**Entrega**: código pronto dos dois providers rodando contra **mock/sandbox**; produção liga quando você concluir a homologação com os gerentes (pré-requisito externo, fora do meu alcance — não vou burlar).

- `SantanderProvider` e `ItauProvider` implementando `BancoProvider`:
  - mTLS com `https.Agent` (cert/key PEM vindos de env/banco, criptografados em repouso)
    + OAuth2 client_credentials; refresh e retry/backoff;
  - Santander devolve OFX → reusa o parser da Fase 3; Itaú devolve JSON (cash management)
    → normalização própria;
  - mesma dedupe da Fase 3 (id externo por transação).
- `MockBankProvider` + fixtures pra desenvolver e testar o pipeline completo sem credencial.
- Sync agendado por conta habilitada (tick do scheduler + rota de cron com `CRON_SECRET`
  como fallback manual). `IntegrationLog` por chamada.

**Teste manual**: sync com mock alimenta o motor da Fase 4 igual ao arquivo; erros de credencial aparecem na auditoria, não derrubam o tick.

## Fase 7 — Dashboard financeiro + auditoria + polimento (~2 sessões)

- Visão geral: boletos recebidos, a pagar por vencimento, conciliados × pendentes, extrato,
  auditoria de integrações (IntegrationLog navegável).
- Cards de alerta (vencendo em X dias, fila de revisão não vazia) no padrão visual do Dashboard.
- Revisão de permissões fim-a-fim, `.env.example` final, atualização deste docs/ e do prd.md.

---

## Resumo de esforço

| Fase | Conteúdo | Estimativa |
|---|---|---|
| 1 | Schema + migrations + crypto + stubs | ~2 sessões |
| 2 | Contas a Pagar manual + máquina de estados | ~2-3 sessões |
| 3 | Import OFX/CNAB (`BancoProvider`) | ~2-3 sessões |
| 4 | Motor de conciliação + fila de revisão | ~2-3 sessões |
| 5 | Graph + parsing FEBRABAN | ~3-4 sessões |
| 6 | APIs Itaú/Santander (mock até homologar) | ~3-4 sessões + homologação sua |
| 7 | Dashboard + auditoria | ~2 sessões |

**Total ≈ 16-21 sessões.** Conciliação funcionando de verdade (com extrato por arquivo) ao fim da Fase 4.

## O que eu preciso de você

1. OK (ou veto) nas 5 decisões do topo — a nº 1 (migrations/deploy) é bloqueante.
2. Um OFX de cada banco (Itaú e Santander) e, se tiver, um retorno CNAB — anonimizados ou não, só pra calibrar os parsers.
3. Mais adiante (Fase 5): app registration no Azure AD (client id/secret/tenant) da caixa de e-mail; (Fase 6): credenciais/certificados quando a homologação com os gerentes sair.
