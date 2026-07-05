# Módulo Financeiro (Contas a Pagar + Conciliação Bancária) — Arquitetura atual do Cargo Stock

> FASE 0 — levantamento feito lendo o código em 2026-07-05. Este documento descreve
> **como o sistema funciona hoje** e onde o novo módulo se encaixa. O plano de
> implementação está em [01-plano.md](01-plano.md).

## 1. Stack confirmada no código

| Camada | O que está no código |
|---|---|
| Framework | Next.js ~15.3.9, App Router, React 19 |
| ORM | Prisma 6.9, provider **postgresql** (`prisma/schema.prisma`) |
| Banco | Postgres no Railway — **atenção: o `.env` local aponta pro banco de PRODUÇÃO** |
| Auth | NextAuth v5 beta, Credentials + bcryptjs, sessão JWT com `maxAge` de 5 min |
| Desktop | Electron 42 — é só uma casca: `electron/main.js` carrega a URL do Railway (`cargostock-production.up.railway.app`). **Nada roda localmente no desktop** |
| Deploy | Railway (NIXPACKS). `railway.json`: build = `npm install && npx prisma generate && npm run build`; start = `npx prisma db push --accept-data-loss && npx next start` |
| Libs úteis já instaladas | `pdfjs-dist` (já usada no client em `financeiro/page.tsx`), `bcryptjs`, `docx`/`docxtemplater`/`xlsx`, `ws` |

Não há framework de testes (sem jest/vitest). Verificação = `npm run lint` + `npx tsc --noEmit` + `npm run build`.

## 2. Autenticação e autorização

- **Login**: NextAuth v5 Credentials em [src/lib/auth.ts](../../src/lib/auth.ts) — busca `User` por email, compara `bcrypt`, retorna `{id, email, name, role}`. `role` é o enum Prisma `Role` (GESTOR, EXECUTIVO, MANUTENCAO, FINANCEIRO, RH, TECNOLOGIA, ESTAGIO).
- **Sessão**: JWT (5 min de `maxAge`), o `role` viaja no token ([src/lib/auth.config.ts](../../src/lib/auth.config.ts)).
- **Middleware** ([src/middleware.ts](../../src/middleware.ts)): usa o `authConfig` leve (sem Prisma, roda no Edge). O callback `authorized` tem uma **allowlist de rotas públicas** — inclui `/api/whatsapp/webhook` e `/api/cron/*`. Qualquer rota nova de webhook/cron precisa entrar nessa lista, senão o middleware redireciona pro login.
- **RBAC** ([src/lib/rbac.ts](../../src/lib/rbac.ts)): matriz estática `Role × Module × Permission`. Já existe o módulo **`FINANCEIRO_MOD`** — visível pra EXECUTIVO, FINANCEIRO, TECNOLOGIA (CRUD completo) e ESTAGIO (só `view`). GESTOR e RH **não** enxergam o Financeiro.
- **Nas rotas de API**: cada route handler chama `await auth()` e valida o role contra uma allowlist local (ex.: [src/app/api/financeiro/jobs/backfill/route.ts](../../src/app/api/financeiro/jobs/backfill/route.ts)). Não há helper central de "exigir permissão X" — o padrão é `session?.user` + `ALLOWED_ROLES.includes(session.user.role)`.
- **Navegação**: `NAV_ITEMS` no rbac.ts define o sidebar. O item "Financeiro" já existe com filhos (`?tab=funcoes|navios|controle|resumo`).

**Como o novo módulo se encaixa**: reaproveitar `FINANCEIRO_MOD` (mesmos papéis que hoje editam o Financeiro). Novas páginas entram como sub-rotas/abas no item "Financeiro" do sidebar. Rotas de API novas em `src/app/api/financeiro/*` seguindo o padrão `auth()` + allowlist de roles. O webhook do Graph (se usado) e endpoints de cron novos precisam entrar na allowlist pública do `auth.config.ts` com validação própria (segredo/assinatura).

## 3. Padrão de rotas e acesso a dados

- **Não existem Server Actions** (`grep "use server"` → zero). O padrão do projeto é **Route Handler** em `src/app/api/**/route.ts` com Prisma direto (singleton em [src/lib/prisma.ts](../../src/lib/prisma.ts)).
- Existe um caminho legado: client components usam `db.from(...)` ([src/lib/db.ts](../../src/lib/db.ts)), um query-builder JSON que bate no proxy genérico [/api/db](../../src/app/api/db/route.ts) (allowlist de tabelas em `TABLE_MAP`). O próprio prd.md orienta: **feature nova = Prisma direto em route handlers tipados**, não ampliar o `db.ts`. O novo módulo segue isso; não vamos adicionar as tabelas novas ao `TABLE_MAP`.
- **Páginas**: client components grandes (`"use client"`) dentro do route group `(dashboard)`, com abas via query string (`?tab=...`) e componentes UI próprios em `src/components/ui/`. Sub-rotas reais também são usadas (ex.: `/escalacao/costado`). Tailwind v4, tema escuro.
- **Anexos/arquivos**: não há storage externo — imagens são guardadas **inline no Postgres** (data URL base64, ver comentários em `StockItem.image_url` e `ToolRequest.image_url`). Para PDFs de boleto, o coerente com a infra é coluna `Bytes` no Postgres (mais eficiente que base64 em texto), com hash SHA-256 pra deduplicação.
- Convenção de schema: **models em inglês** (`Supplier`, `PurchaseOrder`), tabelas snake_case via `@@map`, colunas snake_case, `Decimal @db.Decimal(10,2)` pra dinheiro, `Timestamptz` pra timestamps, comentários em pt-BR explicando regra de negócio. **Já existe `Supplier` (Fornecedores)** — o módulo novo estende esse model (CNPJ etc.) em vez de criar outro.

## 4. Migrations e seed — ⚠️ ponto crítico

- **Não existe `prisma/migrations/`**. O schema é aplicado com `prisma db push` — inclusive no deploy: o `startCommand` do Railway roda `npx prisma db push --accept-data-loss` a cada boot.
- A memória do projeto confirma: coluna nova hoje é aplicada "à mão" no banco (o build não migra; o push acontece no start).
- `npm run db:seed` roda `prisma/seed.ts` via tsx (upsert de usuários). Scripts one-off ficam em `scripts/*.ts` e rodam manualmente **contra produção** — e erro de tipo em `scripts/*.ts` derruba o `next build`.
- Não há staging: local e prod compartilham o mesmo Postgres.

**O que a tarefa exige** (migration Prisma versionada, nunca editar prod sem migration) **muda o pipeline**. Proposta (detalhada no plano, decisão do dono):

1. **Baseline**: gerar `prisma/migrations/0_init/migration.sql` com `prisma migrate diff --from-empty --to-schema-datamodel --script` e marcar como aplicada em prod com `prisma migrate resolve --applied 0_init`.
2. Migrations novas: geradas com `prisma migrate diff` (do estado das migrations pro schema novo) — **não** `migrate dev` direto, porque o único banco disponível é produção e `migrate dev` exige shadow database.
3. Trocar o `startCommand` do railway.json para `npx prisma migrate deploy && npx next start ...` (aditivo e versionado; remove o `--accept-data-loss` do caminho de deploy).

Enquanto essa decisão não for aprovada, nenhuma mudança de schema do módulo será aplicada.

## 5. Worker / cron — como roda background hoje

Dois mecanismos já existem e o módulo novo reaproveita ambos:

1. **Scheduler in-process** ([src/instrumentation.ts](../../src/instrumentation.ts)): o Next 15 chama `register()` uma vez no boot; um `setInterval` de 60s roda os jobs (mensagens agendadas do WhatsApp, aniversários). Guardas importantes: só liga em produção (ou `ENABLE_SCHEDULER=1`), nunca no build, nunca duas vezes no processo — porque `next dev` local aponta pro banco de produção. O Railway roda **uma instância única e persistente** de `next start`, então um tick in-process é confiável o suficiente e não exige infra extra.
2. **Rota de cron com segredo** ([/api/cron/run-scheduled-messages](../../src/app/api/cron/run-scheduled-messages/route.ts)): pública no middleware, protegida por `CRON_SECRET` (query ou header). Serve pra disparo manual/externo e como fallback.

O Electron **não** roda worker nenhum — é só um navegador embutido apontando pro Railway. Todo processamento assíncrono (poll de e-mails, parsing de boleto, sync bancário) roda **no servidor do Railway**, dentro do tick do scheduler ou disparado por rota de cron.

**Fila**: não há Redis nem broker. Para o volume alvo (milhares de e-mails/boletos por **mês** ≈ dezenas–centenas por dia), uma **fila em Postgres** (tabela de jobs + `SELECT ... FOR UPDATE SKIP LOCKED`, consumida pelo tick do scheduler) é a escolha certa: zero infra nova no Railway, jobs idempotentes/deduplicáveis por hash, auditável em SQL. Redis/BullMQ só se o volume crescer ordens de magnitude.

## 6. Segredos e criptografia

- Env vars documentadas em `.env.example` (DATABASE_URL, AUTH_SECRET, AUTH_URL, AISSTREAM, EVOLUTION_*). `CRON_SECRET` é usado no código mas não está no example — o módulo novo adiciona.
- Não existe helper de criptografia simétrica no projeto (só bcrypt pra senha e `randomBytes` utilitário). O módulo novo cria `src/lib/crypto.ts` (AES-256-GCM, chave em `FINANCE_ENCRYPTION_KEY` no env) para tokens do Graph e credenciais bancárias em repouso.
- Certificados mTLS (e-CNPJ A1 convertido) **não entram no repositório**: conteúdo PEM criptografado no banco (ou env var base64), a decidir na fase de APIs bancárias.

## 7. Financeiro existente (não confundir)

O "Financeiro" de hoje é **folha/pagamento de navios** (Jobs, JobAllocation, JobFunction, rateio, Pluxee) — pagamentos a **colaboradores** por embarque/costado. O módulo novo (Contas a Pagar + Conciliação) é sobre **fornecedores e bancos** e convive lado a lado, dentro do mesmo item de menu, sem tocar nos models existentes (exceto estender `Supplier` e, opcionalmente, referenciar `PurchaseOrder`/`Job` num lançamento).
