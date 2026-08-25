-- Notas de Débito / Crédito emitidas pelo Pagamento de Navios.

CREATE TABLE "invoice_clients" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "address" TEXT,
    "cnpj" TEXT,
    "ie" TEXT,
    "municipal_reg" TEXT,
    "header_line" TEXT,
    "language" TEXT NOT NULL DEFAULT 'PT',
    "default_currency" TEXT NOT NULL DEFAULT 'BRL',
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_clients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoice_clients_name_key" ON "invoice_clients"("name");

CREATE TABLE "fiscal_notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "year" INTEGER NOT NULL,
    "job_id" TEXT,
    "ship_name" TEXT NOT NULL,
    "client_name" TEXT NOT NULL,
    "client_legal_name" TEXT,
    "client_address" TEXT,
    "client_cnpj" TEXT,
    "client_ie" TEXT,
    "client_municipal" TEXT,
    "header_line" TEXT,
    "language" TEXT NOT NULL DEFAULT 'PT',
    "oi" TEXT,
    "port" TEXT,
    "arrival_date" DATE,
    "departure_date" DATE,
    "issue_date" DATE NOT NULL,
    "due_date" DATE,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "exchange_rate" DECIMAL(12,4),
    "iss_percent" DECIMAL(6,4),
    "iss_value" DECIMAL(12,2),
    "subtotal" DECIMAL(12,2) NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "fiscal_notes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fiscal_notes_kind_number_year_key" ON "fiscal_notes"("kind", "number", "year");
CREATE INDEX "fiscal_notes_job_id_idx" ON "fiscal_notes"("job_id");
CREATE INDEX "fiscal_notes_year_idx" ON "fiscal_notes"("year");

CREATE TABLE "fiscal_note_items" (
    "id" SERIAL NOT NULL,
    "note_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT NOT NULL,
    "unit_value" DECIMAL(12,2),
    "quantity" DECIMAL(12,2),
    "amount" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "fiscal_note_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "fiscal_note_items_note_id_idx" ON "fiscal_note_items"("note_id");

ALTER TABLE "fiscal_notes" ADD CONSTRAINT "fiscal_notes_job_id_fkey"
    FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "fiscal_note_items" ADD CONSTRAINT "fiscal_note_items_note_id_fkey"
    FOREIGN KEY ("note_id") REFERENCES "fiscal_notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
