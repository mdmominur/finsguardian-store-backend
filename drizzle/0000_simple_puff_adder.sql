CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"shop_id" uuid,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"diff" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bundle_items" (
	"bundle_product_id" uuid NOT NULL,
	"component_product_id" uuid NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	CONSTRAINT "bundle_items_bundle_product_id_component_product_id_pk" PRIMARY KEY("bundle_product_id","component_product_id"),
	CONSTRAINT "bundle_items_quantity_chk" CHECK ("bundle_items"."quantity" > 0),
	CONSTRAINT "bundle_no_self" CHECK ("bundle_items"."bundle_product_id" <> "bundle_items"."component_product_id")
);
--> statement-breakpoint
CREATE TABLE "cash_drawer_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"opening_float" numeric(14, 2) DEFAULT '0' NOT NULL,
	"expected_cash" numeric(14, 2),
	"counted_cash" numeric(14, 2),
	"variance" numeric(14, 2),
	"opened_by" uuid NOT NULL,
	"closed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_ledger_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customer_ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"ref_table" text,
	"ref_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_ledger_entries_type_chk" CHECK ("customer_ledger_entries"."entry_type" IN ('SALE_DEBIT', 'PAYMENT', 'ADJUSTMENT', 'OPENING'))
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"address" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "device_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"device_unit_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"ref_table" text,
	"ref_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "device_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"imei1" text,
	"imei2" text,
	"status" text DEFAULT 'IN_STOCK' NOT NULL,
	"blocklisted" boolean DEFAULT false NOT NULL,
	"blocklist_reason" text,
	"channel_tag" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_po_line_id" uuid,
	"sold_sale_line_id" uuid,
	"unique_identifier" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_units_status_chk" CHECK ("device_units"."status" IN ('IN_STOCK', 'SOLD', 'RMA', 'TRANSFERRED', 'SCRAPPED')),
	CONSTRAINT "device_units_channel_chk" CHECK ("device_units"."channel_tag" IS NULL OR "device_units"."channel_tag" IN ('OFFICIAL', 'UNOFFICIAL')),
	CONSTRAINT "device_imei_distinct_chk" CHECK ("device_units"."imei1" IS NULL OR "device_units"."imei2" IS NULL OR "device_units"."imei1" <> "device_units"."imei2")
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"spent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_amount_chk" CHECK ("expenses"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_balances" (
	"shop_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity" numeric(14, 3) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_balances_shop_id_product_id_location_id_pk" PRIMARY KEY("shop_id","product_id","location_id"),
	CONSTRAINT "inventory_balances_qty_chk" CHECK ("inventory_balances"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"shop_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"quantity_delta" numeric(14, 3) NOT NULL,
	"movement_type" text NOT NULL,
	"ref_table" text,
	"ref_id" uuid,
	"unit_cost" numeric(14, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_channel_chk" CHECK ("notification_outbox"."channel" IN ('SMS', 'EMAIL')),
	CONSTRAINT "notification_outbox_status_chk" CHECK ("notification_outbox"."status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "pos_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"barcode" text,
	"category_id" uuid,
	"brand_id" uuid,
	"tracking_mode" text NOT NULL,
	"cost_method" text DEFAULT 'MOVING_AVG' NOT NULL,
	"unit_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"list_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"min_stock_level" integer DEFAULT 0 NOT NULL,
	"inventory_tracked" boolean DEFAULT true NOT NULL,
	"is_bundle" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_tracking_mode_chk" CHECK ("products"."tracking_mode" IN ('SERIALIZED', 'QUANTITY')),
	CONSTRAINT "products_cost_method_chk" CHECK ("products"."cost_method" IN ('MOVING_AVG', 'FIFO'))
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"po_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"qty_ordered" numeric(14, 3) NOT NULL,
	"qty_received" numeric(14, 3) DEFAULT '0' NOT NULL,
	"unit_cost" numeric(14, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	CONSTRAINT "po_line_qty_ordered_chk" CHECK ("purchase_order_lines"."qty_ordered" > 0),
	CONSTRAINT "po_line_qty_received_chk" CHECK ("purchase_order_lines"."qty_received" >= 0),
	CONSTRAINT "po_line_received_lte_ordered" CHECK ("purchase_order_lines"."qty_received" <= "purchase_order_lines"."qty_ordered")
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"order_date" date DEFAULT (now() AT TIME ZONE 'UTC')::date NOT NULL,
	"expected_date" date,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_status_chk" CHECK ("purchase_orders"."status" IN ('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'COMPLETED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	"ip_inet" text
);
--> statement-breakpoint
CREATE TABLE "refund_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"refund_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"qty" numeric(14, 3) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"restock" boolean DEFAULT true NOT NULL,
	CONSTRAINT "refund_lines_qty_chk" CHECK ("refund_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"description" text,
	"qty" numeric(14, 3) NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"discount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"cogs_unit_cost" numeric(14, 2),
	"device_unit_id" uuid,
	CONSTRAINT "sale_lines_qty_chk" CHECK ("sale_lines"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "sale_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"provider_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sale_payments_method_chk" CHECK ("sale_payments"."method" IN ('CASH', 'BKASH', 'NAGAD', 'ROCKET', 'CARD', 'BANK', 'OTHER')),
	CONSTRAINT "sale_payments_amount_chk" CHECK ("sale_payments"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"invoice_no" text NOT NULL,
	"customer_id" uuid,
	"sold_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"discount_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"paid_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"due_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'COMPLETED' NOT NULL,
	"cashier_user_id" uuid,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_status_chk" CHECK ("sales"."status" IN ('COMPLETED', 'VOID', 'REFUNDED', 'PARTIALLY_REFUNDED'))
);
--> statement-breakpoint
CREATE TABLE "shop_users" (
	"shop_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shop_users_shop_id_user_id_pk" PRIMARY KEY("shop_id","user_id"),
	CONSTRAINT "shop_users_role_chk" CHECK ("shop_users"."role" IN ('owner', 'manager', 'salesman', 'warehouse'))
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shops_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "stock_adjustment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"qty_delta" numeric(14, 3) NOT NULL,
	"device_unit_id" uuid
);
--> statement-breakpoint
CREATE TABLE "stock_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_ledger_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"supplier_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"ref_table" text,
	"ref_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_ledger_entries_type_chk" CHECK ("supplier_ledger_entries"."entry_type" IN ('PURCHASE', 'PAYMENT', 'ADJUSTMENT', 'OPENING'))
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"address" text,
	"notes" text,
	"opening_balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"phone" text,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_contact_chk" CHECK ("users"."email" IS NOT NULL OR "users"."phone" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "warranty_claim_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "warranty_claim_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"claim_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "warranty_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_id" uuid,
	"device_unit_id" uuid,
	"sale_id" uuid,
	"reported_issue" text,
	"physical_condition" text,
	"included_accessories" text,
	"supplier_id" uuid,
	"vendor_rma_number" text,
	"replacement_device_unit_id" uuid,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"turnaround_days" integer,
	"terms_snapshot" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_items" ADD CONSTRAINT "bundle_items_bundle_product_id_products_id_fk" FOREIGN KEY ("bundle_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundle_items" ADD CONSTRAINT "bundle_items_component_product_id_products_id_fk" FOREIGN KEY ("component_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_drawer_sessions" ADD CONSTRAINT "cash_drawer_sessions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger_entries" ADD CONSTRAINT "customer_ledger_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_device_unit_id_device_units_id_fk" FOREIGN KEY ("device_unit_id") REFERENCES "public"."device_units"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_units" ADD CONSTRAINT "device_units_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_units" ADD CONSTRAINT "device_units_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_holds" ADD CONSTRAINT "pos_holds_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_holds" ADD CONSTRAINT "pos_holds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_sale_line_id_sale_lines_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "public"."sale_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_device_unit_id_device_units_id_fk" FOREIGN KEY ("device_unit_id") REFERENCES "public"."device_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_users" ADD CONSTRAINT "shop_users_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_users" ADD CONSTRAINT "shop_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_adjustment_id_stock_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."stock_adjustments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustment_lines" ADD CONSTRAINT "stock_adjustment_lines_device_unit_id_device_units_id_fk" FOREIGN KEY ("device_unit_id") REFERENCES "public"."device_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_adjustments" ADD CONSTRAINT "stock_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_ledger_entries" ADD CONSTRAINT "supplier_ledger_entries_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_claim_events" ADD CONSTRAINT "warranty_claim_events_claim_id_warranty_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."warranty_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_claim_events" ADD CONSTRAINT "warranty_claim_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_device_unit_id_device_units_id_fk" FOREIGN KEY ("device_unit_id") REFERENCES "public"."device_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_claims" ADD CONSTRAINT "warranty_claims_replacement_device_unit_id_device_units_id_fk" FOREIGN KEY ("replacement_device_unit_id") REFERENCES "public"."device_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_audit_shop_time" ON "audit_logs" USING btree ("shop_id","created_at") WHERE "audit_logs"."shop_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_audit_entity" ON "audit_logs" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_shop_id_name" ON "brands" USING btree ("shop_id","name");--> statement-breakpoint
CREATE INDEX "ix_cash_drawer_shop_opened" ON "cash_drawer_sessions" USING btree ("shop_id","opened_at");--> statement-breakpoint
CREATE INDEX "ix_categories_shop_parent" ON "categories" USING btree ("shop_id","parent_id");--> statement-breakpoint
CREATE INDEX "ix_categories_shop_sort" ON "categories" USING btree ("shop_id","sort_order");--> statement-breakpoint
CREATE INDEX "ix_customer_ledger_customer_time" ON "customer_ledger_entries" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_shop_id_phone" ON "customers" USING btree ("shop_id","phone");--> statement-breakpoint
CREATE INDEX "ix_customers_shop_name" ON "customers" USING btree ("shop_id",lower("name"));--> statement-breakpoint
CREATE INDEX "ix_device_events_unit_time" ON "device_events" USING btree ("device_unit_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_device_units_shop_serial" ON "device_units" USING btree ("shop_id","serial");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_device_units_shop_imei1" ON "device_units" USING btree ("shop_id","imei1") WHERE "device_units"."imei1" IS NOT NULL AND btrim("device_units"."imei1") <> '';--> statement-breakpoint
CREATE UNIQUE INDEX "ux_device_units_shop_imei2" ON "device_units" USING btree ("shop_id","imei2") WHERE "device_units"."imei2" IS NOT NULL AND btrim("device_units"."imei2") <> '';--> statement-breakpoint
CREATE INDEX "ix_device_units_shop_product_status" ON "device_units" USING btree ("shop_id","product_id","status");--> statement-breakpoint
CREATE INDEX "ix_device_units_shop_status" ON "device_units" USING btree ("shop_id","status") WHERE NOT "device_units"."blocklisted";--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_shop_id_name" ON "expense_categories" USING btree ("shop_id","name");--> statement-breakpoint
CREATE INDEX "ix_expenses_shop_spent" ON "expenses" USING btree ("shop_id","spent_at");--> statement-breakpoint
CREATE INDEX "ix_inv_mov_shop_product_time" ON "inventory_movements" USING btree ("shop_id","product_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_inv_mov_shop_time" ON "inventory_movements" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_notification_outbox_pending" ON "notification_outbox" USING btree ("shop_id","created_at") WHERE "notification_outbox"."status" IN ('PENDING', 'FAILED') AND "notification_outbox"."attempts" < 10;--> statement-breakpoint
CREATE INDEX "ix_pos_holds_shop_created" ON "pos_holds" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_products_shop_sku_ci" ON "products" USING btree ("shop_id",lower("sku"));--> statement-breakpoint
CREATE UNIQUE INDEX "ux_products_shop_barcode" ON "products" USING btree ("shop_id","barcode") WHERE "products"."barcode" IS NOT NULL AND btrim("products"."barcode") <> '';--> statement-breakpoint
CREATE INDEX "ix_products_shop_active_name" ON "products" USING btree ("shop_id","active",lower("name"));--> statement-breakpoint
CREATE INDEX "ix_products_shop_category" ON "products" USING btree ("shop_id","category_id") WHERE "products"."active";--> statement-breakpoint
CREATE INDEX "ix_products_shop_brand" ON "products" USING btree ("shop_id","brand_id") WHERE "products"."active";--> statement-breakpoint
CREATE INDEX "ix_po_lines_po" ON "purchase_order_lines" USING btree ("po_id");--> statement-breakpoint
CREATE INDEX "ix_po_shop_status_date" ON "purchase_orders" USING btree ("shop_id","status","order_date");--> statement-breakpoint
CREATE INDEX "ix_refresh_tokens_user" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_refresh_tokens_expires" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ix_refund_lines_refund" ON "refund_lines" USING btree ("refund_id");--> statement-breakpoint
CREATE INDEX "ix_refunds_shop_time" ON "refunds" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_sale_lines_sale" ON "sale_lines" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "ix_sale_lines_product" ON "sale_lines" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "ix_sale_payments_sale" ON "sale_payments" USING btree ("sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_shop_id_invoice_no" ON "sales" USING btree ("shop_id","invoice_no");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_sales_shop_idempotency" ON "sales" USING btree ("shop_id","idempotency_key") WHERE "sales"."idempotency_key" IS NOT NULL AND btrim("sales"."idempotency_key") <> '';--> statement-breakpoint
CREATE INDEX "ix_sales_shop_sold_at" ON "sales" USING btree ("shop_id","sold_at");--> statement-breakpoint
CREATE INDEX "ix_sales_shop_customer" ON "sales" USING btree ("shop_id","customer_id") WHERE "sales"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_sales_shop_cashier_time" ON "sales" USING btree ("shop_id","cashier_user_id","sold_at");--> statement-breakpoint
CREATE INDEX "ix_shop_users_user" ON "shop_users" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_stock_adj_lines_adj" ON "stock_adjustment_lines" USING btree ("adjustment_id");--> statement-breakpoint
CREATE INDEX "ix_stock_adj_shop_time" ON "stock_adjustments" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_locations_shop_id_name" ON "stock_locations" USING btree ("shop_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_stock_locations_one_default_per_shop" ON "stock_locations" USING btree ("shop_id") WHERE "stock_locations"."is_default";--> statement-breakpoint
CREATE INDEX "ix_supplier_ledger_supplier_time" ON "supplier_ledger_entries" USING btree ("supplier_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_suppliers_shop_name" ON "suppliers" USING btree ("shop_id",lower("name"));--> statement-breakpoint
CREATE INDEX "ix_warranty_events_claim_time" ON "warranty_claim_events" USING btree ("claim_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_warranty_shop_status" ON "warranty_claims" USING btree ("shop_id","status","received_at");