import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { AppError } from '../lib/errors.js';

export type BatchIntegrityMismatch = {
  productId: string;
  locationId: string;
  inventoryQty: string;
  batchQty: string;
  delta: string;
};

export async function listBatchIntegrityMismatches(shopId: string) {
  const rows = await db.execute<BatchIntegrityMismatch>(sql`
    WITH batch_sum AS (
      SELECT
        b.product_id AS product_id,
        bal.location_id AS location_id,
        COALESCE(SUM(bal.quantity::numeric), 0)::text AS batch_qty
      FROM product_batches b
      JOIN batch_inventory_balances bal
        ON bal.batch_id = b.id
       AND bal.shop_id = ${shopId}
      JOIN products p
        ON p.id = b.product_id
       AND p.shop_id = ${shopId}
      WHERE b.shop_id = ${shopId}
        AND p.tracking_mode = 'QUANTITY'
        AND p.batch_tracking_enabled = true
      GROUP BY b.product_id, bal.location_id
    ),
    inv AS (
      SELECT
        ib.product_id AS product_id,
        ib.location_id AS location_id,
        COALESCE(ib.quantity::numeric, 0)::text AS inventory_qty
      FROM inventory_balances ib
      JOIN products p
        ON p.id = ib.product_id
       AND p.shop_id = ${shopId}
      WHERE ib.shop_id = ${shopId}
        AND p.tracking_mode = 'QUANTITY'
        AND p.batch_tracking_enabled = true
    )
    SELECT
      COALESCE(inv.product_id, batch_sum.product_id)::text AS "productId",
      COALESCE(inv.location_id, batch_sum.location_id)::text AS "locationId",
      COALESCE(inv.inventory_qty, '0') AS "inventoryQty",
      COALESCE(batch_sum.batch_qty, '0') AS "batchQty",
      (COALESCE(inv.inventory_qty, '0')::numeric - COALESCE(batch_sum.batch_qty, '0')::numeric)::text AS delta
    FROM inv
    FULL OUTER JOIN batch_sum
      ON inv.product_id = batch_sum.product_id
     AND inv.location_id = batch_sum.location_id
    WHERE ABS(COALESCE(inv.inventory_qty, '0')::numeric - COALESCE(batch_sum.batch_qty, '0')::numeric) > 0.0005
    ORDER BY ABS(COALESCE(inv.inventory_qty, '0')::numeric - COALESCE(batch_sum.batch_qty, '0')::numeric) DESC
    LIMIT 500
  `);

  return { items: rows.rows };
}

export async function fixBatchIntegrity(shopId: string) {
  const mismatches = await listBatchIntegrityMismatches(shopId);
  if (mismatches.items.length === 0) return { fixed: 0 };

  const fixed = await db.transaction(async (tx) => {
    let count = 0;
    for (const m of mismatches.items) {
      // Set inventory balance = batch sum (source of truth for batch-tracked products)
      const res = await tx.execute(sql`
        INSERT INTO inventory_balances (shop_id, product_id, location_id, quantity, updated_at)
        VALUES (${shopId}, ${m.productId}::uuid, ${m.locationId}::uuid, ${m.batchQty}::numeric, now())
        ON CONFLICT (shop_id, product_id, location_id)
        DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = now()
      `);
      if (res) count++;
    }
    return count;
  });

  if (!Number.isFinite(fixed)) throw AppError.conflict('Fix did not complete');
  return { fixed };
}

