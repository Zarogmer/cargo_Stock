-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('GESTOR', 'EXECUTIVO', 'MANUTENCAO', 'FINANCEIRO', 'RH', 'TECNOLOGIA', 'ESTAGIO');

-- CreateEnum
CREATE TYPE "StockCategory" AS ENUM ('COMPRAS', 'CARNES', 'CARNE', 'FEIRA', 'SUPRIMENTOS', 'OUTROS');

-- CreateEnum
CREATE TYPE "MovementType" AS ENUM ('ENTRADA', 'BAIXA', 'AJUSTE');

-- CreateEnum
CREATE TYPE "EpiMovementType" AS ENUM ('ENTREGA', 'DEVOLUCAO');

-- CreateEnum
CREATE TYPE "ToolStatus" AS ENUM ('DISPONIVEL', 'EQUIPE_1', 'EQUIPE_2', 'MANUTENCAO');

-- CreateEnum
CREATE TYPE "ToolMovementType" AS ENUM ('EQUIPE_1', 'EQUIPE_2', 'DEVOLUCAO', 'MANUTENCAO');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('FERRAMENTA', 'MAQUINARIO', 'ELETRICA');

-- CreateEnum
CREATE TYPE "ShipStatus" AS ENUM ('AGENDADO', 'EM_OPERACAO', 'CONCLUIDO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "ScheduleTemplateKind" AS ENUM ('EPI', 'UNIFORME', 'PRONTIDAO', 'COMPRAS', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ScheduleFrequency" AS ENUM ('DAILY', 'WEEKLY');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'RH',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_items" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "category" "StockCategory" NOT NULL DEFAULT 'OUTROS',
    "unit" TEXT NOT NULL DEFAULT 'UN',
    "location" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "default_quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "team" TEXT,
    "assigned_team" TEXT,
    "expiry_date" DATE,
    "min_quantity" INTEGER NOT NULL DEFAULT 0,
    "image_url" TEXT,
    "notes" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embark_kit_items" (
    "id" SERIAL NOT NULL,
    "team" TEXT NOT NULL,
    "stock_item_id" INTEGER NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embark_kit_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" SERIAL NOT NULL,
    "stock_item_id" INTEGER NOT NULL,
    "movement_type" "MovementType" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "movement_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employees" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "team" TEXT,
    "birth_date" DATE,
    "phone" TEXT,
    "email" TEXT,
    "family_phone" TEXT,
    "notes" TEXT,
    "bank_name" TEXT,
    "bank_agency" TEXT,
    "bank_account" TEXT,
    "bank_account_type" TEXT,
    "has_vaccination_card" BOOLEAN DEFAULT false,
    "has_cnh" BOOLEAN DEFAULT false,
    "cpf" TEXT,
    "rg" TEXT,
    "isps_code" TEXT,
    "e_social" TEXT,
    "subestipulante" INTEGER,
    "modulo" INTEGER,
    "status" TEXT DEFAULT 'ATIVO',
    "sector" TEXT,
    "role" TEXT,
    "salary" DECIMAL(10,2),
    "admission_date" DATE,
    "vacation_limit_date" DATE,
    "dismissal_date" DATE,
    "contract_type" TEXT,
    "nrs_training" TEXT,
    "meio_ambiente_training" TEXT,
    "lifeguard_training" BOOLEAN DEFAULT false,
    "rubber_boot" BOOLEAN DEFAULT false,
    "boot_size" TEXT,
    "shirt_size" TEXT,
    "bermuda_size" TEXT,
    "last_aso_date" TEXT,
    "aso_status" TEXT,
    "realiza_limpeza" BOOLEAN DEFAULT false,
    "does_costado" BOOLEAN DEFAULT false,
    "escala_unavailable" BOOLEAN DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pluxee_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "client_code" TEXT,
    "order_type" TEXT DEFAULT '001 - Pedido Normal',
    "product" TEXT DEFAULT '603903 - Carteira Gift',
    "delivery_place" TEXT DEFAULT 'Matriz',
    "cep" TEXT,
    "address" TEXT,
    "number" TEXT,
    "complement" TEXT,
    "reference" TEXT,
    "neighborhood" TEXT,
    "city" TEXT,
    "uf" TEXT,
    "responsible_name" TEXT,
    "responsible_ddd" TEXT,
    "responsible_phone" TEXT,
    "inactive_value" DECIMAL(10,2) DEFAULT 1,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "pluxee_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "epis" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "ca_code" TEXT,
    "size" TEXT,
    "stock_qty" INTEGER NOT NULL DEFAULT 0,
    "min_quantity" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "epis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "epi_movements" (
    "id" SERIAL NOT NULL,
    "epi_id" INTEGER NOT NULL,
    "employee_name" TEXT NOT NULL,
    "movement_type" "EpiMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "movement_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "epi_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uniforms" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "size" TEXT,
    "stock_qty" INTEGER NOT NULL DEFAULT 0,
    "min_quantity" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "uniforms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uniform_movements" (
    "id" SERIAL NOT NULL,
    "uniform_id" INTEGER NOT NULL,
    "employee_name" TEXT NOT NULL,
    "movement_type" "EpiMovementType" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "movement_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "uniform_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tools" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ToolStatus" NOT NULL DEFAULT 'DISPONIVEL',
    "location" TEXT,
    "notes" TEXT,
    "asset_type" "AssetType" NOT NULL DEFAULT 'FERRAMENTA',
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "tools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_movements" (
    "id" SERIAL NOT NULL,
    "tool_id" INTEGER NOT NULL,
    "employee_name" TEXT NOT NULL,
    "movement_type" "ToolMovementType" NOT NULL,
    "movement_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "locked_conversations" (
    "remote_jid" TEXT NOT NULL,
    "locked_by" TEXT,
    "locked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locked_conversations_pkey" PRIMARY KEY ("remote_jid")
);

-- CreateTable
CREATE TABLE "mission_standard_items" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "embark_name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "required_qty" INTEGER NOT NULL DEFAULT 0,
    "display_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "mission_standard_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ships" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "arrival_date" DATE,
    "departure_date" DATE,
    "port" TEXT,
    "status" "ShipStatus" NOT NULL DEFAULT 'AGENDADO',
    "assigned_team" TEXT,
    "notes" TEXT,
    "cargo_type" TEXT,
    "holds_count" INTEGER,
    "client_name" TEXT,
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "boarding_situation" TEXT,
    "boarding_scheduled_at" TIMESTAMPTZ,
    "boarding_custom_text" TEXT,
    "whatsapp_group_jid" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "externalShipId" TEXT,

    CONSTRAINT "ships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "boarding_situation_templates" (
    "id" SERIAL NOT NULL,
    "text" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "boarding_situation_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_functions" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "default_rate" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL DEFAULT 'POR_NAVIO',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "job_functions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_function_rates" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "function_id" INTEGER NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "employee_function_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_function_rates" (
    "id" SERIAL NOT NULL,
    "function_id" INTEGER NOT NULL,
    "rate" DECIMAL(10,2) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_until" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_function_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ship_id" UUID,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "status" TEXT NOT NULL DEFAULT 'ABERTO',
    "contract_value" DECIMAL(12,2),
    "notes" TEXT,
    "client" TEXT,
    "supervisor" TEXT,
    "cargo_type" TEXT,
    "holds_count" INTEGER,
    "port" TEXT,
    "verified_at" TIMESTAMPTZ,
    "verified_by" TEXT,
    "closed_at" TIMESTAMPTZ,
    "closed_by" TEXT,
    "payroll_value" DECIMAL(12,2),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "created_by" TEXT NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_allocations" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "function_id" INTEGER NOT NULL,
    "employee_id" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "rate" DECIMAL(10,2) NOT NULL,
    "pluxee_value" DECIMAL(10,2) DEFAULT 0,
    "extra_value" DECIMAL(10,2) DEFAULT 0,
    "extra_reason" TEXT,
    "notes" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'EMBARQUE',
    "function_locked" BOOLEAN NOT NULL DEFAULT false,
    "shift_date" DATE,
    "shift_period" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ATIVO',
    "replaces_id" INTEGER,
    "added_by" TEXT NOT NULL DEFAULT '',
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_by" TEXT,
    "removed_at" TIMESTAMPTZ,
    "removal_reason" TEXT,

    CONSTRAINT "job_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "costado_period_status" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "shift_date" DATE NOT NULL,
    "shift_period" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NAO_REQUISITADO',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "costado_period_status_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_adjustments" (
    "id" SERIAL NOT NULL,
    "job_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_ships" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "imo" TEXT,
    "mmsi" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "status" TEXT,
    "eta" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'marinetraffic',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_ships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_logs" (
    "id" SERIAL NOT NULL,
    "user_id" UUID,
    "full_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "event_type" TEXT NOT NULL DEFAULT 'LOGIN',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_requests" (
    "id" UUID NOT NULL,
    "tool_name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "requested_by" TEXT NOT NULL,
    "responded_by" TEXT,
    "response_notes" TEXT,
    "image_url" TEXT,
    "product_url" TEXT,
    "estimated_value" DECIMAL(10,2),
    "supplier" TEXT,
    "department" TEXT,
    "code" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tool_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "department" TEXT,
    "code" TEXT,
    "supplier" TEXT,
    "purchase_date" DATE,
    "unit_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "total_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "payment_method" TEXT,
    "notes" TEXT,
    "image_url" TEXT,
    "product_url" TEXT,
    "request_id" UUID,
    "ship_id" UUID,
    "ship_name" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "address" TEXT,
    "category" TEXT,
    "website" TEXT,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" TEXT NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_links" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'Outros',
    "description" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "message_id" TEXT,
    "instance_name" TEXT NOT NULL,
    "remote_jid" TEXT NOT NULL,
    "from_me" BOOLEAN NOT NULL DEFAULT false,
    "push_name" TEXT,
    "message_type" TEXT NOT NULL,
    "text" TEXT,
    "media_mimetype" TEXT,
    "media_filename" TEXT,
    "timestamp_ms" BIGINT NOT NULL,
    "sent_by_user_id" TEXT,
    "raw_event" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_lid_aliases" (
    "lid" TEXT NOT NULL,
    "phone" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_lid_aliases_pkey" PRIMARY KEY ("lid")
);

-- CreateTable
CREATE TABLE "marketing_clients" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "company" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "cnpj" TEXT,
    "city" TEXT,
    "state" TEXT,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "marketing_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_messages" (
    "id" UUID NOT NULL,
    "group_jid" TEXT NOT NULL,
    "group_label" TEXT,
    "template" "ScheduleTemplateKind" NOT NULL,
    "team" TEXT,
    "header_text" TEXT,
    "body_text" TEXT,
    "frequency" "ScheduleFrequency" NOT NULL,
    "weekday" INTEGER,
    "hour" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMPTZ,
    "last_run_at" TIMESTAMPTZ,
    "last_status" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "stock_items_category_idx" ON "stock_items"("category");

-- CreateIndex
CREATE INDEX "embark_kit_items_team_idx" ON "embark_kit_items"("team");

-- CreateIndex
CREATE UNIQUE INDEX "embark_kit_items_team_stock_item_id_key" ON "embark_kit_items"("team", "stock_item_id");

-- CreateIndex
CREATE INDEX "stock_movements_stock_item_id_idx" ON "stock_movements"("stock_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "employees_cpf_key" ON "employees"("cpf");

-- CreateIndex
CREATE INDEX "epi_movements_epi_id_idx" ON "epi_movements"("epi_id");

-- CreateIndex
CREATE INDEX "uniform_movements_uniform_id_idx" ON "uniform_movements"("uniform_id");

-- CreateIndex
CREATE INDEX "tools_asset_type_idx" ON "tools"("asset_type");

-- CreateIndex
CREATE INDEX "tools_status_idx" ON "tools"("status");

-- CreateIndex
CREATE INDEX "tool_movements_tool_id_idx" ON "tool_movements"("tool_id");

-- CreateIndex
CREATE INDEX "mission_standard_items_embark_name_idx" ON "mission_standard_items"("embark_name");

-- CreateIndex
CREATE UNIQUE INDEX "job_functions_name_key" ON "job_functions"("name");

-- CreateIndex
CREATE INDEX "employee_function_rates_function_id_idx" ON "employee_function_rates"("function_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_function_rates_employee_id_function_id_key" ON "employee_function_rates"("employee_id", "function_id");

-- CreateIndex
CREATE INDEX "job_function_rates_function_id_valid_from_idx" ON "job_function_rates"("function_id", "valid_from");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_start_date_idx" ON "jobs"("start_date");

-- CreateIndex
CREATE INDEX "job_allocations_job_id_idx" ON "job_allocations"("job_id");

-- CreateIndex
CREATE INDEX "job_allocations_status_idx" ON "job_allocations"("status");

-- CreateIndex
CREATE INDEX "job_allocations_kind_idx" ON "job_allocations"("kind");

-- CreateIndex
CREATE INDEX "job_allocations_shift_date_shift_period_idx" ON "job_allocations"("shift_date", "shift_period");

-- CreateIndex
CREATE INDEX "costado_period_status_job_id_idx" ON "costado_period_status"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "costado_period_status_job_id_shift_date_shift_period_key" ON "costado_period_status"("job_id", "shift_date", "shift_period");

-- CreateIndex
CREATE INDEX "job_adjustments_job_id_idx" ON "job_adjustments"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_ships_mmsi_key" ON "external_ships"("mmsi");

-- CreateIndex
CREATE INDEX "login_logs_created_at_idx" ON "login_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "tool_requests_status_idx" ON "tool_requests"("status");

-- CreateIndex
CREATE INDEX "tool_requests_created_at_idx" ON "tool_requests"("created_at" DESC);

-- CreateIndex
CREATE INDEX "purchase_orders_purchase_date_idx" ON "purchase_orders"("purchase_date" DESC);

-- CreateIndex
CREATE INDEX "purchase_orders_department_idx" ON "purchase_orders"("department");

-- CreateIndex
CREATE INDEX "purchase_orders_request_id_idx" ON "purchase_orders"("request_id");

-- CreateIndex
CREATE INDEX "purchase_orders_ship_id_idx" ON "purchase_orders"("ship_id");

-- CreateIndex
CREATE INDEX "product_links_category_idx" ON "product_links"("category");

-- CreateIndex
CREATE INDEX "whatsapp_messages_remote_jid_timestamp_ms_idx" ON "whatsapp_messages"("remote_jid", "timestamp_ms" DESC);

-- CreateIndex
CREATE INDEX "whatsapp_messages_timestamp_ms_idx" ON "whatsapp_messages"("timestamp_ms" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_instance_name_message_id_remote_jid_key" ON "whatsapp_messages"("instance_name", "message_id", "remote_jid");

-- CreateIndex
CREATE INDEX "scheduled_messages_enabled_next_run_at_idx" ON "scheduled_messages"("enabled", "next_run_at");

-- AddForeignKey
ALTER TABLE "embark_kit_items" ADD CONSTRAINT "embark_kit_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "epi_movements" ADD CONSTRAINT "epi_movements_epi_id_fkey" FOREIGN KEY ("epi_id") REFERENCES "epis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uniform_movements" ADD CONSTRAINT "uniform_movements_uniform_id_fkey" FOREIGN KEY ("uniform_id") REFERENCES "uniforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_movements" ADD CONSTRAINT "tool_movements_tool_id_fkey" FOREIGN KEY ("tool_id") REFERENCES "tools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ships" ADD CONSTRAINT "ships_externalShipId_fkey" FOREIGN KEY ("externalShipId") REFERENCES "external_ships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_function_rates" ADD CONSTRAINT "employee_function_rates_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_function_rates" ADD CONSTRAINT "employee_function_rates_function_id_fkey" FOREIGN KEY ("function_id") REFERENCES "job_functions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_function_rates" ADD CONSTRAINT "job_function_rates_function_id_fkey" FOREIGN KEY ("function_id") REFERENCES "job_functions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_ship_id_fkey" FOREIGN KEY ("ship_id") REFERENCES "ships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_allocations" ADD CONSTRAINT "job_allocations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_allocations" ADD CONSTRAINT "job_allocations_function_id_fkey" FOREIGN KEY ("function_id") REFERENCES "job_functions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_allocations" ADD CONSTRAINT "job_allocations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_allocations" ADD CONSTRAINT "job_allocations_replaces_id_fkey" FOREIGN KEY ("replaces_id") REFERENCES "job_allocations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_adjustments" ADD CONSTRAINT "job_adjustments_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_logs" ADD CONSTRAINT "login_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

