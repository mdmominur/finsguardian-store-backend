import { sql } from 'drizzle-orm';
import { db } from './client.js';

/**
 * Idempotently applies the indexes and one-time refund data heal from
 * `docs/sql/044_performance_indexes_and_refund_heal.sql` on server startup.
 */
export async function ensurePerformanceIndexesAndHeal(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE products ALTER COLUMN min_stock_level SET DATA TYPE numeric(14, 3)
  `);
  await db.execute(sql`
    ALTER TABLE products ALTER COLUMN min_stock_level SET DEFAULT '0'
  `);

  await db.execute(sql`
    UPDATE sales s
    SET status = 'PARTIALLY_REFUNDED'
    WHERE s.status = 'REFUNDED'
      AND EXISTS (
        SELECT 1
        FROM sale_lines sl
        WHERE sl.sale_id = s.id
          AND sl.qty::numeric > COALESCE((
            SELECT SUM(rl.qty::numeric)
            FROM refund_lines rl
            INNER JOIN refunds r ON r.id = rl.refund_id
            WHERE rl.sale_line_id = sl.id AND r.sale_id = s.id
          ), 0)
      )
  `);

  await db.execute(sql`
    UPDATE refunds r
    SET total_amount = sub.line_sum,
        payout_amount = LEAST(r.payout_amount::numeric, sub.line_sum)
    FROM (
      SELECT rl.refund_id, COALESCE(SUM(rl.amount::numeric), 0) AS line_sum
      FROM refund_lines rl
      GROUP BY rl.refund_id
    ) sub
    WHERE r.id = sub.refund_id
      AND (
        r.total_amount::numeric IS DISTINCT FROM sub.line_sum
        OR r.payout_amount::numeric > sub.line_sum
      )
  `);

  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS ix_refunds_shop_sale ON refunds (shop_id, sale_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS ix_refund_lines_sale_line ON refund_lines (sale_line_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS ix_sales_shop_status_sold_at ON sales (shop_id, status, sold_at)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS ix_sales_shop_customer_due ON sales (shop_id, customer_id, status) WHERE due_amount > 0`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS ix_expenses_shop_payment_method ON expenses (shop_id, payment_method_id) WHERE payment_method_id IS NOT NULL`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS ix_supplier_payments_shop_payment_method ON supplier_payments (shop_id, payment_method_id) WHERE payment_method_id IS NOT NULL`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS ix_inventory_balances_shop_loc ON inventory_balances (shop_id, location_id)`,
  );
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS ix_po_lines_product ON purchase_order_lines (product_id)`,
  );

  // 046: Storefront Product Reviews & Enhanced Website Fulfillment Order Details
  await db.execute(sql`
    ALTER TABLE storefront_fulfillment_orders
      ADD COLUMN IF NOT EXISTS recipient_name text,
      ADD COLUMN IF NOT EXISTS recipient_phone text,
      ADD COLUMN IF NOT EXISTS shipping_address_text text,
      ADD COLUMN IF NOT EXISTS customer_note text,
      ADD COLUMN IF NOT EXISTS cancelled_reason text,
      ADD COLUMN IF NOT EXISTS cancelled_at timestamptz
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS product_reviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      shop_id uuid NOT NULL REFERENCES shops (id) ON DELETE CASCADE,
      product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE,
      customer_id uuid REFERENCES customers (id) ON DELETE SET NULL,
      reviewer_name text NOT NULL,
      rating integer NOT NULL,
      title text,
      comment text NOT NULL,
      is_verified_purchase boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'APPROVED',
      is_featured_on_home boolean NOT NULL DEFAULT false,
      merchant_reply text,
      replied_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT product_reviews_rating_chk CHECK (rating >= 1 AND rating <= 5),
      CONSTRAINT product_reviews_status_chk CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'))
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ix_product_reviews_shop_product_status
      ON product_reviews (shop_id, product_id, status, created_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ix_product_reviews_shop_status_created
      ON product_reviews (shop_id, status, created_at DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ix_product_reviews_shop_featured_home
      ON product_reviews (shop_id, is_featured_on_home, status, created_at DESC)
      WHERE is_featured_on_home = true
  `);
}
