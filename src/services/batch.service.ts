import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  batchInventoryBalances,
  productBatches,
  products,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

export function generateBatchCode(now: Date = new Date()): string {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  // Short random suffix avoids collisions without a DB sequence.
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `B${ymd}-${suffix}`;
}

export async function listProductBatchesForLocation(args: {
  shopId: string;
  productId: string;
  locationId: string;
  includeZero?: boolean;
}) {
  const [p] = await db
    .select({
      id: products.id,
      shopId: products.shopId,
      trackingMode: products.trackingMode,
      batchTrackingEnabled: products.batchTrackingEnabled,
    })
    .from(products)
    .where(and(eq(products.id, args.productId), eq(products.shopId, args.shopId)))
    .limit(1);
  if (!p) throw AppError.notFound('Product not found');
  if (p.trackingMode !== 'QUANTITY') {
    throw AppError.badRequest('Batches apply to QUANTITY products only');
  }
  if (!p.batchTrackingEnabled) {
    return { items: [] as any[] };
  }

  const includeZero = args.includeZero === true;

  const rows = await db
    .select({
      id: productBatches.id,
      batchCode: productBatches.batchCode,
      supplierLotCode: productBatches.supplierLotCode,
      manufacturedAt: productBatches.manufacturedAt,
      expiresAt: productBatches.expiresAt,
      createdAt: productBatches.createdAt,
      quantity: batchInventoryBalances.quantity,
    })
    .from(productBatches)
    .leftJoin(
      batchInventoryBalances,
      and(
        eq(batchInventoryBalances.shopId, args.shopId),
        eq(batchInventoryBalances.batchId, productBatches.id),
        eq(batchInventoryBalances.locationId, args.locationId),
      ),
    )
    .where(and(eq(productBatches.shopId, args.shopId), eq(productBatches.productId, args.productId)))
    .orderBy(
      // FEFO: earliest expiry first; NULL expiry goes last.
      sql`(${productBatches.expiresAt} IS NULL) ASC`,
      asc(productBatches.expiresAt),
      asc(productBatches.createdAt),
    );

  const items = rows
    .map((r) => ({
      ...r,
      quantity: r.quantity ?? '0',
    }))
    .filter((r) => includeZero || Number(r.quantity) > 0);

  return { items };
}

