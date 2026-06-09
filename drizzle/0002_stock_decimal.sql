ALTER TABLE "products" ALTER COLUMN "min_stock_level" SET DATA TYPE numeric(14, 3);
ALTER TABLE "products" ALTER COLUMN "min_stock_level" SET DEFAULT '0';
ALTER TABLE "sale_payments" ADD COLUMN IF NOT EXISTS "payment_method_id" uuid;
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_payment_method_id_shop_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."shop_payment_methods"("id") ON DELETE restrict ON UPDATE no action;