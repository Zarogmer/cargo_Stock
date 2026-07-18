-- CreateTable
CREATE TABLE "material_returns" (
    "id" SERIAL NOT NULL,
    "ship_id" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_return_items" (
    "id" SERIAL NOT NULL,
    "return_id" INTEGER NOT NULL,
    "stock_item_id" INTEGER,
    "item_name" TEXT NOT NULL,
    "went_qty" INTEGER NOT NULL DEFAULT 0,
    "returned_qty" INTEGER NOT NULL DEFAULT 0,
    "broken_qty" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "material_return_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "material_returns_ship_id_idx" ON "material_returns"("ship_id");

-- CreateIndex
CREATE INDEX "material_return_items_return_id_idx" ON "material_return_items"("return_id");

-- AddForeignKey
ALTER TABLE "material_returns" ADD CONSTRAINT "material_returns_ship_id_fkey" FOREIGN KEY ("ship_id") REFERENCES "ships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_return_items" ADD CONSTRAINT "material_return_items_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "material_returns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
