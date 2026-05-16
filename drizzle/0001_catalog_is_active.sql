ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true NOT NULL;
