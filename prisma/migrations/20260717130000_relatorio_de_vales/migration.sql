-- CreateTable
CREATE TABLE "employee_advances" (
    "id" SERIAL NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "advance_date" DATE NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "origin" TEXT NOT NULL,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_advances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "advance_discounts" (
    "id" SERIAL NOT NULL,
    "advance_id" INTEGER NOT NULL,
    "job_id" TEXT NOT NULL,
    "employee_id" INTEGER NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "advance_discounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_advances_employee_id_idx" ON "employee_advances"("employee_id");

-- CreateIndex
CREATE INDEX "advance_discounts_advance_id_idx" ON "advance_discounts"("advance_id");

-- CreateIndex
CREATE INDEX "advance_discounts_job_id_employee_id_idx" ON "advance_discounts"("job_id", "employee_id");

-- AddForeignKey
ALTER TABLE "employee_advances" ADD CONSTRAINT "employee_advances_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_discounts" ADD CONSTRAINT "advance_discounts_advance_id_fkey" FOREIGN KEY ("advance_id") REFERENCES "employee_advances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "advance_discounts" ADD CONSTRAINT "advance_discounts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
