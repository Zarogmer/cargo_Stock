# PRD — Cargo Stock

> Documento de contexto do projeto **Cargo Stock**. Use este arquivo como briefing inicial ao pedir ajuda em assistentes (ChatGPT, etc). Tudo aqui foi extraído do código real em `2026-05-04`.

---

## 1. Visão geral

**Cargo Stock** é um sistema interno de **gestão de estoque, equipamentos, EPIs e operações de embarcações**. Voltado para uma operação portuária/marítima onde existem:

- Itens de estoque (compras, carnes, feira, suprimentos)
- EPIs e uniformes entregues a colaboradores
- Ferramentas e maquinários alocados a equipes
- Navios com janelas de operação (atracação, embarque, conclusão)
- Solicitações internas de ferramentas
- Fornecedores e links de produtos
- Controle de acessos por papel (RBAC)

O sistema é **web** (Next.js) com **wrapper Electron** opcional para empacotamento desktop Windows.

---

## 2. Stack

| Camada | Tecnologia |
|---|---|
| Framework | Next.js 15.3 (App Router, React 19) |
| Linguagem | TypeScript 5 |
| Estilo | Tailwind CSS v4 (`@tailwindcss/postcss`) |
| ORM | Prisma 6.9 |
| Banco | PostgreSQL (Railway) |
| Auth | NextAuth.js v5 beta (Credentials provider, bcryptjs) |
| Desktop | Electron 33 + electron-builder (alvo Windows) |
| Hospedagem | Railway (build NIXPACKS, auto-deploy do GitHub) |
| Node | >= 20 |

---

## 3. Arquitetura e estrutura

```
cargo-stock/
├── electron/              # Wrapper desktop (main.js, preload.js)
├── prisma/
│   ├── schema.prisma      # Schema completo (sem migrations versionadas)
│   └── seed.ts            # Seed de dados iniciais
├── public/                # Assets estáticos + PWA
├── src/
│   ├── app/
│   │   ├── (dashboard)/   # Rotas autenticadas (route group)
│   │   │   ├── page.tsx           # Dashboard principal (~556 LOC)
│   │   │   ├── layout.tsx         # Layout com sidebar
│   │   │   ├── colaboradores/     # CRUD colaboradores + EPIs/uniformes (~625 LOC)
│   │   │   ├── embarque/          # Operações de embarque (~284 LOC)
│   │   │   ├── equipamentos/      # Ferramentas + maquinários (~277 LOC)
│   │   │   ├── estoque/           # Estoque + movimentações (~625 LOC)
│   │   │   ├── financeiro/        # Stub (~19 LOC)
│   │   │   ├── navios/            # Navios + agenda (~660 LOC)
│   │   │   ├── solicitacoes/      # Solicitações + fornecedores + links (~810 LOC)
│   │   │   └── debug/             # Página interna
│   │   ├── api/
│   │   │   ├── auth/[...nextauth]/    # Handler NextAuth
│   │   │   ├── auth/reset-password/   # Reset de senha
│   │   │   ├── db/                    # Endpoint genérico de DB (proxy SQL)
│   │   │   ├── seed/                  # Seed users
│   │   │   └── seed-stock/            # Seed de stock_items
│   │   ├── auth/reset-password/   # Página de reset
│   │   ├── login/                 # Página de login
│   │   ├── layout.tsx
│   │   └── globals.css
│   ├── components/
│   │   ├── sidebar.tsx
│   │   ├── icons.tsx
│   │   ├── pwa-register.tsx
│   │   └── ui/             # button, modal, tabs, data-table, confirm-dialog
│   ├── lib/
│   │   ├── auth.ts         # NextAuth config (Credentials + bcrypt)
│   │   ├── auth.config.ts
│   │   ├── auth-context.tsx
│   │   ├── prisma.ts       # Singleton Prisma client
│   │   ├── db.ts           # Wrapper estilo Supabase em cima do /api/db
│   │   ├── rbac.ts         # Matriz de permissões + nav items
│   │   └── utils.ts
│   ├── types/
│   │   ├── database.ts
│   │   └── next-auth.d.ts
│   └── middleware.ts       # Proteção de rotas via NextAuth
├── .env.example
├── electron-builder.yml
├── next.config.ts
├── package.json
├── railway.json
├── supabase-schema.sql     # Histórico (origem foi Supabase, migrado pra Prisma/Railway)
└── tsconfig.json
```

**Notas arquiteturais relevantes:**

- O cliente acessa o banco via **`src/lib/db.ts`**, um *query builder* estilo Supabase que monta um `QuerySpec` JSON e dispara contra **`/api/db/route.ts`** (proxy genérico). Resquício da migração Supabase → Prisma. **Se for criar feature nova, prefira chamar Prisma diretamente em route handlers tipados** (mais seguro), e considerar refatorar `db.ts` em paralelo.
- Não existe pasta `prisma/migrations/`. O schema é aplicado via `prisma db push` direto (ver §7).
- `(dashboard)` é um *route group* — não aparece na URL, serve só pra agrupar rotas autenticadas sob um layout comum.
- Páginas têm muito código (várias > 600 LOC): client components com formulários grandes e múltiplas modais. Há espaço pra extrair componentes.

---

## 4. Modelo de dados (Prisma)

Todas as tabelas usam `snake_case` via `@@map`. Resumo (campos mais importantes):

### Enums
- `Role`: `GESTOR | EXECUTIVO | MANUTENCAO | FINANCEIRO | RH | TECNOLOGIA`
- `StockCategory`: `COMPRAS | CARNES | CARNE | FEIRA | SUPRIMENTOS | OUTROS`
- `MovementType`: `ENTRADA | BAIXA | AJUSTE`
- `EpiMovementType`: `ENTREGA | DEVOLUCAO`
- `ToolStatus`: `DISPONIVEL | EQUIPE_1 | EQUIPE_2 | MANUTENCAO`
- `ToolMovementType`: `EQUIPE_1 | EQUIPE_2 | DEVOLUCAO | MANUTENCAO`
- `AssetType`: `FERRAMENTA | MAQUINARIO`
- `ShipStatus`: `AGENDADO | EM_OPERACAO | CONCLUIDO | CANCELADO`

### Modelos
| Modelo | Função | Observação |
|---|---|---|
| `User` | Usuários do sistema | `password_hash` (bcrypt), `role` |
| `StockItem` / `StockMovement` | Itens de estoque + histórico | min_quantity, expiry_date, team |
| `Employee` | Colaboradores | dados pessoais + bancários + flags (vacina, CNH) |
| `Epi` / `EpiMovement` | EPIs + entregas/devoluções | ca_code, size, stock_qty |
| `Uniform` / `UniformMovement` | Uniformes (mesma estrutura de EPIs) | |
| `Tool` / `ToolMovement` | Ferramentas e maquinários | discriminado por `asset_type` |
| `MissionStandardItem` | Itens padrão por embarcação | base de checklist |
| `Ship` | Navios e operações | status enumerado |
| `LoginLog` | Auditoria de login/logout | |
| `ToolRequest` | Solicitações de ferramentas | status string livre (`PENDENTE`, etc) |
| `Supplier` | Fornecedores | feature recente |
| `ProductLink` | Links externos de produtos | feature recente |

> **Observação:** `StockCategory` tem `CARNES` E `CARNE` (provavelmente legado / typo histórico). Vale checar antes de mexer.

---

## 5. RBAC e navegação

Matriz definida em **`src/lib/rbac.ts`**. Resumo do que cada papel acessa:

| Papel | Acesso |
|---|---|
| `GESTOR` | Tudo exceto Financeiro |
| `EXECUTIVO` | Tudo, incluindo Financeiro |
| `MANUTENCAO` | Tudo operacional, sem Embarque/Financeiro |
| `FINANCEIRO` | Visualização ampla + CRUD em Solicitações + Financeiro |
| `RH` | Apenas Dashboard, EPI (Colaboradores) e Navios (visualização) |
| `TECNOLOGIA` | Tudo, incluindo Financeiro |

API:
- `hasPermission(role, module, permission)` — checagem fina
- `hasModuleAccess(role, module)` — checagem de visualização
- `getNavItemsForRole(role)` — itens do sidebar visíveis pro papel

**Módulos (Module type):** `DASHBOARD | EMBARQUE | ESTOQUE | EPI | FERRAMENTAS | MAQUINARIO | NAVIOS | FINANCEIRO_MOD | SOLICITACOES`.

**Permissões (Permission type):** `view | create | edit | delete | baixar | entregar | devolver | embarcar | emprestar | manutencao`.

---

## 6. Autenticação

- **NextAuth v5 (beta)** com **Credentials** provider (email + senha).
- Senhas armazenadas em `password_hash` com **bcryptjs**.
- `src/lib/auth.ts` valida credenciais via Prisma + `bcrypt.compare`.
- Reset de senha: `src/app/auth/reset-password/page.tsx` + `api/auth/reset-password/route.ts`.
- Variáveis: `AUTH_SECRET`, `AUTH_URL`.
- `src/middleware.ts` protege rotas autenticadas.

---

## 7. Deploy e pipeline

Arquivo: `railway.json`.

```json
{
  "build": { "buildCommand": "npm install && npx prisma generate && npm run build" },
  "deploy": {
    "startCommand": "npx prisma db push --accept-data-loss && npx next start -H 0.0.0.0 -p 3000"
  }
}
```

**Fluxo de deploy:**
1. Push em `main` no GitHub (`Zarogmer/cargo_Stock`).
2. Railway detecta o push e roda build (NIXPACKS).
3. Aplica `prisma db push --accept-data-loss` direto na base.
4. Sobe Next.js em `0.0.0.0:3000`.

### ⚠️ Pontos críticos do pipeline

1. **`--accept-data-loss` está ativo.** Qualquer alteração em `prisma/schema.prisma` que cause perda de dados (drop de coluna, mudança de tipo incompatível, remover enum, etc) é **aplicada sem aviso na base de produção**. Não há migrations versionadas (`prisma/migrations/` não existe).
2. **Não existe ambiente de staging.** Existe um único Postgres no Railway, compartilhado por todos os devs. Local + prod usam a mesma base.
3. **Deploy é automático no push em `main`.** Trabalhar sempre em branch e abrir PR.

### Recomendações (não implementadas)

- Criar `prisma/migrations/` e mudar deploy para `prisma migrate deploy`.
- Criar serviço Postgres separado pra staging/dev.
- Remover `--accept-data-loss` ou pelo menos restringi-lo.

---

## 8. Setup local

```bash
# 1. Dependências
npm install

# 2. Variáveis de ambiente (.env)
DATABASE_URL="<DATABASE_PUBLIC_URL do Railway>"
AUTH_SECRET="<gerar com: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\">"
AUTH_URL="http://localhost:3000"

# 3. Prisma client
npx prisma generate

# 4. Dev server
npm run dev
# http://localhost:3000
```

**Scripts disponíveis:**
- `npm run dev` — Next dev server
- `npm run build` — `prisma generate && next build`
- `npm start` — produção local
- `npm run lint`
- `npm run db:push` — ⚠️ **aplica schema na base configurada (NÃO RODAR contra prod sem alinhamento)**
- `npm run db:seed` — seed via `prisma/seed.ts`
- `npm run db:migrate` — `prisma migrate deploy` (não usado hoje, sem migrations)
- `npm run electron:dev` — abre Electron apontando pro Next dev
- `npm run electron:build` / `dist` — empacota .exe Windows

---

## 9. Histórico recente (últimos commits)

```
2e6436d Restore all movement types in dashboard, remove only Qtd column
5f598ab Restrict dashboard logs to 3 users, show only login/logout, 5min session
f5d4cfa Always show phone field on supplier cards
401e27a Simplify EPI form and improve Fornecedores mobile layout
39f5351 Add Fornecedores tab and fix date handling for Prisma
```

Trabalho recente concentrado em: dashboard de logs, layout mobile, módulo Fornecedores (recém-adicionado), EPIs.

---

## 10. Convenções e estilo

- **Idioma:** UI em **português**, código (variáveis, tipos, comentários) em **inglês ou português** misturado. Páginas em pt-br (`colaboradores`, `embarque`, `navios`, etc).
- **Componentes UI:** primitivos próprios em `src/components/ui/` (button, modal, tabs, data-table, confirm-dialog) — não há shadcn/ui formalmente.
- **Ícones:** componente único `src/components/icons.tsx` (centralizado).
- **Tema:** tema escuro como padrão (a julgar pelo print do Railway e estética do sidebar).
- **Tailwind v4:** sintaxe nova (`@theme`, `@tailwindcss/postcss`).
- **Acesso a dados em client component:** via `db.from(...)` (wrapper Supabase em `src/lib/db.ts`) que bate em `/api/db`. Em **server components** ou route handlers novos, prefira **Prisma direto**.

---

## 11. Pendências e sugestões abertas

Coisas que valem revisar quando der oportunidade (não são bugs urgentes):

1. **Adicionar Prisma migrations versionadas** e remover `--accept-data-loss`.
2. **Separar ambiente de dev** (segundo Postgres no Railway ou Docker local).
3. **Limpar enum `StockCategory`** (`CARNES` vs `CARNE` — possível duplicidade).
4. **Refatorar páginas grandes** (`solicitacoes/page.tsx` com 810 LOC, `navios` com 660, `colaboradores` e `estoque` com 625) — extrair modais e formulários para componentes.
5. **Migrar gradualmente `lib/db.ts` + `/api/db`** para route handlers Prisma tipados (mais seguro, melhor DX).
6. **Página `financeiro/page.tsx`** está em stub (19 LOC) — feature não implementada.
7. **`ToolRequest.status`** é string livre — considerar enum.
8. **PWA registrada** (`pwa-register.tsx`) — verificar se está ativa em produção.

---

## 12. Como pedir ajuda usando este PRD

Ao usar este documento como contexto para uma pergunta:

1. Cole o PRD inteiro ou as seções relevantes.
2. Indique **qual módulo** está mexendo (`ESTOQUE`, `EPI`, `NAVIOS`, etc).
3. Avise se a tarefa **toca o schema** (`prisma/schema.prisma`) — isso muda o nível de cuidado por causa do `--accept-data-loss`.
4. Diga se quer **server component (Prisma direto)** ou **client component (db.ts wrapper)**.
5. Cite o(s) arquivo(s) que vai editar pra a IA não inventar paths.

---

*Última atualização: 2026-05-04. Para checar o estado atual do código, sempre prefira ler os arquivos diretamente.*
