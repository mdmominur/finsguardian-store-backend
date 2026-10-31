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
}
