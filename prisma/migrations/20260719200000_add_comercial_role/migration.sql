-- Novo papel COMERCIAL: mesmas permissões de EXECUTIVO (ver src/lib/rbac.ts),
-- só uma categoria à parte no cadastro. Enum do Postgres cresce por ADD VALUE.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'COMERCIAL';
