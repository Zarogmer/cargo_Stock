-- Novo papel "Estágio" (mesmas permissões de TECNOLOGIA — ver rbac).
-- Aplicado à mão em produção (deploy não roda migração — ver deploy-no-auto-migrate).
-- Idempotente: ADD VALUE IF NOT EXISTS é seguro rodar mais de uma vez.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ESTAGIO';
