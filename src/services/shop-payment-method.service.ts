import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, type DbExecutor } from '../db/client.js';
import { shopPaymentMethods } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

export async function ensureDefaultShopPaymentMethods(
  executor: DbExecutor,
  shopId: string,
): Promise<void> {
  const [row] = await executor
    .select({ id: shopPaymentMethods.id })
    .from(shopPaymentMethods)
    .where(eq(shopPaymentMethods.shopId, shopId))
    .limit(1);
  if (row) return;
  await executor.insert(shopPaymentMethods).values({
    shopId,
    name: 'Cash',
    sortOrder: 0,
    isActive: true,
  });
}

export async function listShopPaymentMethods(shopId: string) {
  await ensureDefaultShopPaymentMethods(db, shopId);
  return db
    .select()
    .from(shopPaymentMethods)
    .where(eq(shopPaymentMethods.shopId, shopId))
    .orderBy(asc(shopPaymentMethods.sortOrder), asc(shopPaymentMethods.name));
}

/** List all payment methods with computed balances.
 *  Uses a single round-trip query (correlated subqueries in SELECT)
 *  instead of N×5 separate queries — scales well with proper indexes.
 */
export async function listPaymentMethodsWithBalances(shopId: string) {
  await ensureDefaultShopPaymentMethods(db, shopId);

  // One query: all methods + balance computed via correlated subqueries.
  // Postgres executes each subquery once per row using index scans.
  const rows = await db.execute<{
    id: string;
    shopId: string;
    name: string;
    sortOrder: number;
    isActive: boolean;
    createdAt: Date;
    balance: string;
  }>(sql`
    SELECT
      m.id,
      m.shop_id   AS "shopId",
      m.name,
      m.sort_order AS "sortOrder",
      m.is_active  AS "isActive",
      m.created_at AS "createdAt",
      (
        COALESCE((
          SELECT SUM(sp.amount::numeric)
          FROM   sale_payments sp
          JOIN   sales s ON s.id = sp.sale_id
          WHERE  sp.payment_method_id = m.id
            AND  s.shop_id = ${shopId}
            AND  s.status != 'VOID'
        ), 0)
        + COALESCE((
          SELECT SUM(adj.amount::numeric)
          FROM   payment_method_adjustments adj
          WHERE  adj.payment_method_id = m.id
            AND  adj.shop_id = ${shopId}
            AND  adj.type = 'IN'
        ), 0)
        - COALESCE((
          SELECT SUM(e.amount::numeric)
          FROM   expenses e
          WHERE  e.payment_method_id = m.id
            AND  e.shop_id = ${shopId}
        ), 0)
        - COALESCE((
          SELECT SUM(sup.total_amount::numeric)
          FROM   supplier_payments sup
          WHERE  sup.payment_method_id = m.id
            AND  sup.shop_id = ${shopId}
        ), 0)
        - COALESCE((
          SELECT SUM(adj.amount::numeric)
          FROM   payment_method_adjustments adj
          WHERE  adj.payment_method_id = m.id
            AND  adj.shop_id = ${shopId}
            AND  adj.type = 'OUT'
        ), 0)
        - COALESCE((
          SELECT SUM(rf.payout_amount::numeric)
          FROM   refunds rf
          WHERE  rf.payment_method_id = m.id
            AND  rf.shop_id = ${shopId}
        ), 0)
        + COALESCE((
          SELECT SUM(pr.refund_amount::numeric)
          FROM   purchase_returns pr
          WHERE  pr.payment_method_id = m.id
            AND  pr.shop_id = ${shopId}
        ), 0)
      )::text AS balance
    FROM  shop_payment_methods m
    WHERE m.shop_id = ${shopId}
    ORDER BY m.sort_order, m.name
  `);

  return rows.rows;
}

/** Balance for a single payment method. Used by the per-method transaction page. */
export async function getPaymentMethodBalance(shopId: string, methodId: string): Promise<string> {
  const result = await db.execute<{ balance: string }>(sql`
    SELECT (
      COALESCE((
        SELECT SUM(sp.amount::numeric) FROM sale_payments sp
        JOIN sales s ON s.id = sp.sale_id
        WHERE sp.payment_method_id = ${methodId} AND s.shop_id = ${shopId} AND s.status != 'VOID'
      ), 0)
      + COALESCE((
        SELECT SUM(adj.amount::numeric) FROM payment_method_adjustments adj
        WHERE adj.payment_method_id = ${methodId} AND adj.shop_id = ${shopId} AND adj.type = 'IN'
      ), 0)
      - COALESCE((
        SELECT SUM(e.amount::numeric) FROM expenses e
        WHERE e.payment_method_id = ${methodId} AND e.shop_id = ${shopId}
      ), 0)
      - COALESCE((
        SELECT SUM(sup.total_amount::numeric) FROM supplier_payments sup
        WHERE sup.payment_method_id = ${methodId} AND sup.shop_id = ${shopId}
      ), 0)
      - COALESCE((
        SELECT SUM(adj.amount::numeric) FROM payment_method_adjustments adj
        WHERE adj.payment_method_id = ${methodId} AND adj.shop_id = ${shopId} AND adj.type = 'OUT'
      ), 0)
      - COALESCE((
        SELECT SUM(rf.payout_amount::numeric) FROM refunds rf
        WHERE rf.payment_method_id = ${methodId} AND rf.shop_id = ${shopId}
      ), 0)
      + COALESCE((
        SELECT SUM(pr.refund_amount::numeric) FROM purchase_returns pr
        WHERE pr.payment_method_id = ${methodId} AND pr.shop_id = ${shopId}
      ), 0)
    )::text AS balance
  `);
  return result.rows[0]?.balance ?? '0';
}

export type TxType = 'SALE' | 'EXPENSE' | 'SUPPLIER_PAYMENT' | 'CASH_IN' | 'WITHDRAWAL' | 'REFUND' | 'PURCHASE_RETURN';

export interface PaymentMethodTx {
  id: string;
  txType: TxType;
  direction: 'IN' | 'OUT';
  amount: string;
  description: string;
  refId: string | null;
  createdAt: Date;
}

/** All transactions for a payment method (UNION of 5 tables), paginated.
 *  Indexes on payment_method_id in each table keep this fast even at scale.
 */
export async function listPaymentMethodTransactions(
  shopId: string,
  methodId: string,
  opts: { limit: number; offset: number },
): Promise<{ items: PaymentMethodTx[]; hasMore: boolean }> {
  const fetchLimit = opts.limit + 1; // fetch +1 to detect hasMore

  const rows = await db.execute<{
    id: string;
    txType: TxType;
    direction: 'IN' | 'OUT';
    amount: string;
    description: string;
    refId: string | null;
    createdAt: Date;
  }>(sql`
    SELECT id, tx_type AS "txType", direction, amount::text, description, ref_id AS "refId", created_at AS "createdAt"
    FROM (
      -- 1) Sales collected
      SELECT
        sp.id::text               AS id,
        'SALE'                    AS tx_type,
        'IN'                      AS direction,
        sp.amount                 AS amount,
        COALESCE(sp.method_label_snapshot, 'Sale')::text AS description,
        s.id::text                AS ref_id,
        s.sold_at                 AS created_at
      FROM  sale_payments sp
      JOIN  sales s ON s.id = sp.sale_id
      WHERE sp.payment_method_id = ${methodId}
        AND s.shop_id = ${shopId}
        AND s.status != 'VOID'

      UNION ALL

      -- 2) Expenses paid
      SELECT
        e.id::text                AS id,
        'EXPENSE'                 AS tx_type,
        'OUT'                     AS direction,
        e.amount                  AS amount,
        ec.name::text             AS description,
        e.id::text                AS ref_id,
        e.spent_at                AS created_at
      FROM  expenses e
      JOIN  expense_categories ec ON ec.id = e.category_id
      WHERE e.payment_method_id = ${methodId}
        AND e.shop_id = ${shopId}

      UNION ALL

      -- 3) Supplier payments
      SELECT
        sup.id::text              AS id,
        'SUPPLIER_PAYMENT'        AS tx_type,
        'OUT'                     AS direction,
        sup.total_amount          AS amount,
        COALESCE(sup.note, 'Supplier payment')::text AS description,
        sup.id::text              AS ref_id,
        sup.created_at            AS created_at
      FROM  supplier_payments sup
      WHERE sup.payment_method_id = ${methodId}
        AND sup.shop_id = ${shopId}

      UNION ALL

      -- 4) Manual adjustments (cash in / withdrawal)
      SELECT
        adj.id::text              AS id,
        CASE adj.type WHEN 'IN' THEN 'CASH_IN' ELSE 'WITHDRAWAL' END AS tx_type,
        adj.type                  AS direction,
        adj.amount                AS amount,
        COALESCE(adj.note, CASE adj.type WHEN 'IN' THEN 'Cash in' ELSE 'Withdrawal' END)::text AS description,
        NULL                      AS ref_id,
        adj.created_at            AS created_at
      FROM  payment_method_adjustments adj
      WHERE adj.payment_method_id = ${methodId}
        AND adj.shop_id = ${shopId}

      UNION ALL

      -- 5) Refunds paid out
      SELECT
        rf.id::text                AS id,
        'REFUND'                   AS tx_type,
        'OUT'                      AS direction,
        rf.payout_amount           AS amount,
        COALESCE(rf.note, 'Refund for invoice ' || s.invoice_no)::text AS description,
        rf.id::text                AS ref_id,
        rf.created_at              AS created_at
      FROM  refunds rf
      JOIN  sales s ON s.id = rf.sale_id
      WHERE rf.payment_method_id = ${methodId}
        AND rf.shop_id = ${shopId}

      UNION ALL

      -- 6) Purchase return cash refunds
      SELECT
        pr.id::text                AS id,
        'PURCHASE_RETURN'          AS tx_type,
        'IN'                       AS direction,
        pr.refund_amount           AS amount,
        COALESCE(pr.note, 'Refund for purchase return')::text AS description,
        pr.id::text                AS ref_id,
        pr.created_at              AS created_at
      FROM  purchase_returns pr
      WHERE pr.payment_method_id = ${methodId}
        AND pr.shop_id = ${shopId}
    ) t
    ORDER BY created_at DESC
    LIMIT  ${fetchLimit}
    OFFSET ${opts.offset}
  `);

  const items = rows.rows.slice(0, opts.limit);
  const hasMore = rows.rows.length > opts.limit;
  return { items, hasMore };
}

export async function createShopPaymentMethod(
  shopId: string,
  input: { name: string; sortOrder?: number },
) {
  const name = input.name.trim();
  if (!name) throw AppError.badRequest('Payment method name is required');
  const [mxRow] = await db
    .select({ n: sql<number>`coalesce(max(${shopPaymentMethods.sortOrder}), -1)::int` })
    .from(shopPaymentMethods)
    .where(eq(shopPaymentMethods.shopId, shopId));
  const nextOrder = input.sortOrder ?? (mxRow?.n ?? -1) + 1;
  const [row] = await db
    .insert(shopPaymentMethods)
    .values({ shopId, name, sortOrder: nextOrder, isActive: true })
    .returning();
  if (!row) throw AppError.conflict('Could not create payment method');
  return row;
}

export async function updateShopPaymentMethod(
  shopId: string,
  methodId: string,
  input: { name?: string; sortOrder?: number; isActive?: boolean },
) {
  const [existing] = await db
    .select()
    .from(shopPaymentMethods)
    .where(and(eq(shopPaymentMethods.id, methodId), eq(shopPaymentMethods.shopId, shopId)))
    .limit(1);
  if (!existing) throw AppError.notFound('Payment method not found');

  if (input.isActive === false) {
    const others = await db
      .select({ id: shopPaymentMethods.id })
      .from(shopPaymentMethods)
      .where(
        and(
          eq(shopPaymentMethods.shopId, shopId),
          eq(shopPaymentMethods.isActive, true),
          ne(shopPaymentMethods.id, methodId),
        ),
      );
    if (others.length === 0) {
      throw AppError.badRequest('At least one payment method must stay active.');
    }
  }

  const patch: Partial<typeof shopPaymentMethods.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  const [row] = await db
    .update(shopPaymentMethods)
    .set(patch)
    .where(eq(shopPaymentMethods.id, methodId))
    .returning();
  return row!;
}

/** Bulk reorder: accepts array of { id, sortOrder } and applies atomically. */
export async function reorderPaymentMethods(
  shopId: string,
  items: { id: string; sortOrder: number }[],
) {
  if (items.length === 0) return;
  await db.transaction(async (tx) => {
    for (const item of items) {
      const [ex] = await tx
        .select({ id: shopPaymentMethods.id })
        .from(shopPaymentMethods)
        .where(and(eq(shopPaymentMethods.id, item.id), eq(shopPaymentMethods.shopId, shopId)))
        .limit(1);
      if (!ex) throw AppError.badRequest(`Payment method ${item.id} not found`);
      await tx
        .update(shopPaymentMethods)
        .set({ sortOrder: item.sortOrder })
        .where(eq(shopPaymentMethods.id, item.id));
    }
  });
}

/** Resolve payment method rows for checkout; all ids must belong to shop and be active. */
export async function assertPaymentMethodsForCheckout(
  tx: DbExecutor,
  shopId: string,
  methodIds: string[],
): Promise<Map<string, { id: string; name: string }>> {
  if (methodIds.length === 0) throw AppError.badRequest('At least one payment line is required');
  const uniq = [...new Set(methodIds)];
  const rows = await tx
    .select()
    .from(shopPaymentMethods)
    .where(
      and(
        eq(shopPaymentMethods.shopId, shopId),
        inArray(shopPaymentMethods.id, uniq),
        eq(shopPaymentMethods.isActive, true),
      ),
    );
  if (rows.length !== uniq.length) {
    throw AppError.badRequest('One or more payment methods are invalid or inactive for this shop');
  }
  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name }]));
}

/** Prefer "Cash" for internal allocations (e.g. customer payment from money receipt). */
export async function getDefaultTenderPaymentMethodId(shopId: string): Promise<string> {
  await ensureDefaultShopPaymentMethods(db, shopId);
  const [cash] = await db
    .select()
    .from(shopPaymentMethods)
    .where(and(eq(shopPaymentMethods.shopId, shopId), eq(shopPaymentMethods.isActive, true), eq(shopPaymentMethods.name, 'Cash')))
    .limit(1);
  if (cash) return cash.id;
  const [any] = await db
    .select()
    .from(shopPaymentMethods)
    .where(and(eq(shopPaymentMethods.shopId, shopId), eq(shopPaymentMethods.isActive, true)))
    .orderBy(asc(shopPaymentMethods.sortOrder), asc(shopPaymentMethods.name))
    .limit(1);
  if (!any) throw AppError.conflict('No payment methods configured for this shop');
  return any.id;
}

/** For allocations that historically used method OTHER (money receipt). */
export async function getMoneyReceiptAllocationMethodId(shopId: string): Promise<string> {
  await ensureDefaultShopPaymentMethods(db, shopId);
  const [other] = await db
    .select()
    .from(shopPaymentMethods)
    .where(and(eq(shopPaymentMethods.shopId, shopId), eq(shopPaymentMethods.isActive, true), eq(shopPaymentMethods.name, 'Other')))
    .limit(1);
  if (other) return other.id;
  return getDefaultTenderPaymentMethodId(shopId);
}
