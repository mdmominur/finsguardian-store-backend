import { sql } from 'drizzle-orm';
import { db, pool } from './src/db/client.js';

async function main() {
  console.log('Running ALTER TABLE for warranty_claims...');
  
  await db.execute(sql`
    ALTER TABLE "warranty_claims" ADD COLUMN IF NOT EXISTS "sale_id" uuid;
    ALTER TABLE "warranty_claims" ADD COLUMN IF NOT EXISTS "reported_issue" text;
    ALTER TABLE "warranty_claims" ADD COLUMN IF NOT EXISTS "physical_condition" text;
    ALTER TABLE "warranty_claims" ADD COLUMN IF NOT EXISTS "included_accessories" text;
    ALTER TABLE "warranty_claims" ADD COLUMN IF NOT EXISTS "supplier_id" uuid;
    ALTER TABLE "warranty_claims" ADD COLUMN IF NOT EXISTS "vendor_rma_number" text;
    ALTER TABLE "warranty_claims" ADD COLUMN IF NOT EXISTS "replacement_device_unit_id" uuid;

    DO $$
    BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warranty_claims_sale_id_sales_id_fk') THEN
            ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warranty_claims_supplier_id_suppliers_id_fk') THEN
            ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;
        END IF;

        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warranty_claims_replacement_device_unit_id_device_units_id_fk') THEN
            ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_replacement_device_unit_id_device_units_id_fk" FOREIGN KEY ("replacement_device_unit_id") REFERENCES "public"."device_units"("id") ON DELETE set null ON UPDATE no action;
        END IF;
    END;
    $$;
  `);

  console.log('Complete.');
  await pool.end();
}

main().catch(console.error);
