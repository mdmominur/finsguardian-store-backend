import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  batchInventoryBalances,
  batchInventoryMovements,
  deviceEvents,
  deviceUnits,
  inventoryBalances,
  inventoryMovements,
  productBatches,
  products,
  stockAdjustmentLines,
  stockAdjustments,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { isMultiStockLocationEnabled } from './shop-features.service.js';
import { resolveLocationIdOrDefault } from './stock-location.service.js';
import { generateBatchCode } from './batch.service.js';

export async function createStockAdjustment(
  shopId: string,
  userId: string,
  input: {
    reason: string;
    note?: string;
    lines: {
      productId: string;
      locationId?: string;
      qtyDelta: string;
      batchId?: string | null;
      batches?: Array<{
        qty: string;
        manufacturedAt?: string | null;
        expiresAt?: string | null;
        supplierLotCode?: string | null;
        batchCode?: string | null;
      }>;
      deviceUnitId?: string | null;
      // For ADD mode — create new device unit
      serial?: string;
      imei1?: string | null;
      imei2?: string | null;
      uniqueIdentifier?: string | null;
    }[];
  },
) {
  if (input.lines.length === 0) {
    throw AppError.badRequest('At least one line required');
  }

  const multi = await isMultiStockLocationEnabled(shopId);

  return db.transaction(async (tx) => {
    const [adj] = await tx
      .insert(stockAdjustments)
      .values({
        shopId,
        reason: input.reason,
        note: input.note ?? null,
        createdBy: userId,
      })
      .returning();

    if (!adj) throw AppError.conflict('Adjustment failed');

    for (const line of input.lines) {
      const locationId = await resolveLocationIdOrDefault(shopId, line.locationId ?? null, multi);

      const [p] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, line.productId), eq(products.shopId, shopId)))
        .limit(1);

      if (!p) throw AppError.notFound(`Product ${line.productId} not found`);

      const delta = Number(line.qtyDelta);
      if (delta === 0) throw AppError.badRequest('qtyDelta cannot be zero');

      let resolvedUnitId: string | undefined;

      if (p.trackingMode === 'SERIALIZED') {

        if (delta > 0 && line.serial) {
          // ADD mode: create a brand-new device unit
          const serial = line.serial.trim();
          if (!serial) throw AppError.badRequest('Serial cannot be empty');

          const unitStockLoc = await resolveLocationIdOrDefault(shopId, line.locationId ?? null, multi);

          const [newUnit] = await tx
            .insert(deviceUnits)
            .values({
              shopId,
              productId: p.id,
              serial,
              imei1: line.imei1?.trim() || null,
              imei2: line.imei2?.trim() || null,
              uniqueIdentifier: line.uniqueIdentifier?.trim() || null,
              status: 'IN_STOCK',
              stockLocationId: unitStockLoc,
            })
            .returning();

          if (!newUnit) throw AppError.conflict('Failed to create device unit');
          resolvedUnitId = newUnit.id;

          await tx.insert(deviceEvents).values({
            deviceUnitId: newUnit.id,
            eventType: 'ADJUSTED_IN',
            refTable: 'stock_adjustments',
            refId: adj.id,
            payload: { reason: input.reason },
            createdBy: userId,
          });
        } else {
          // REMOVE mode (or return-to-stock): deviceUnitId must be provided
          if (!line.deviceUnitId) {
            throw AppError.badRequest('deviceUnitId required for serialized product removal');
          }
          const [du] = await tx
            .select()
            .from(deviceUnits)
            .where(
              and(
                eq(deviceUnits.id, line.deviceUnitId),
                eq(deviceUnits.shopId, shopId),
                eq(deviceUnits.productId, p.id),
              ),
            )
            .limit(1);

          if (!du) throw AppError.notFound('Device unit not found for product');

          if (delta < 0) {
            if (du.status !== 'IN_STOCK') {
              throw AppError.conflict(`Device ${du.serial} is not in stock`);
            }
            await tx
              .update(deviceUnits)
              .set({ status: 'SCRAPPED', updatedAt: new Date() })
              .where(eq(deviceUnits.id, du.id));

            await tx.insert(deviceEvents).values({
              deviceUnitId: du.id,
              eventType: 'ADJUSTED_OUT',
              refTable: 'stock_adjustments',
              refId: adj.id,
              payload: { reason: input.reason },
              createdBy: userId,
            });
          } else {
            // return to stock
            await tx
              .update(deviceUnits)
              .set({ status: 'IN_STOCK', updatedAt: new Date() })
              .where(eq(deviceUnits.id, du.id));

            await tx.insert(deviceEvents).values({
              deviceUnitId: du.id,
              eventType: 'ADJUSTED_IN',
              refTable: 'stock_adjustments',
              refId: adj.id,
              payload: { reason: input.reason },
              createdBy: userId,
            });
          }
          resolvedUnitId = du.id;
        }
      } else {
        const absDelta = Math.abs(delta);
        if (p.batchTrackingEnabled) {
          // Batch-tracked QUANTITY adjustments must update batch balances + movements too.
          const datesRequired = p.batchDatesRequired === true;

          async function ensureBatchForProduct(batchId: string) {
            const [b] = await tx
              .select({ id: productBatches.id })
              .from(productBatches)
              .where(
                and(
                  eq(productBatches.id, batchId),
                  eq(productBatches.shopId, shopId),
                  eq(productBatches.productId, p.id),
                ),
              )
              .limit(1);
            if (!b) throw AppError.notFound('Batch not found for this product');
          }

          async function addToBatch(batchId: string, qtyStr: string) {
            await tx
              .insert(batchInventoryBalances)
              .values({ shopId, batchId, locationId, quantity: qtyStr })
              .onConflictDoUpdate({
                target: [batchInventoryBalances.shopId, batchInventoryBalances.batchId, batchInventoryBalances.locationId],
                set: {
                  quantity: sql`${batchInventoryBalances.quantity}::numeric + ${qtyStr}::numeric`,
                  updatedAt: new Date(),
                },
              });

            await tx.insert(batchInventoryMovements).values({
              shopId,
              batchId,
              productId: p.id,
              locationId,
              quantityDelta: qtyStr,
              movementType: 'ADJUSTMENT',
              refTable: 'stock_adjustments',
              refId: adj.id,
              createdBy: userId,
            });
          }

          async function removeFromBatch(batchId: string, qtyStr: string) {
            await ensureBatchForProduct(batchId);
            await tx
              .insert(batchInventoryBalances)
              .values({ shopId, batchId, locationId, quantity: '0' })
              .onConflictDoNothing({
                target: [batchInventoryBalances.shopId, batchInventoryBalances.batchId, batchInventoryBalances.locationId],
              });

            const upd = await tx
              .update(batchInventoryBalances)
              .set({
                quantity: sql`${batchInventoryBalances.quantity}::numeric - ${qtyStr}::numeric`,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(batchInventoryBalances.shopId, shopId),
                  eq(batchInventoryBalances.batchId, batchId),
                  eq(batchInventoryBalances.locationId, locationId),
                  sql`${batchInventoryBalances.quantity}::numeric >= ${qtyStr}::numeric`,
                ),
              )
              .returning();
            if (upd.length === 0) {
              throw AppError.conflict('Insufficient batch stock for adjustment', {
                productId: p.id,
                batchId,
                needQty: qtyStr,
              });
            }

            await tx.insert(batchInventoryMovements).values({
              shopId,
              batchId,
              productId: p.id,
              locationId,
              quantityDelta: (-Number(qtyStr)).toFixed(3),
              movementType: 'ADJUSTMENT',
              refTable: 'stock_adjustments',
              refId: adj.id,
              createdBy: userId,
            });
          }

          if (delta > 0) {
            const batches = line.batches ?? [];
            if (batches.length === 0) {
              throw AppError.badRequest('Batches are required for batch-tracked products', {
                productId: p.id,
              });
            }
            const sum = batches.reduce((s, b) => s + Number(b.qty), 0);
            if (!Number.isFinite(sum) || Math.abs(sum - delta) > 1e-6) {
              throw AppError.badRequest('Batch quantities must sum to qtyDelta for adjustment', {
                productId: p.id,
                qtyDelta: delta,
                batchQtySum: sum,
              });
            }

            for (const b of batches) {
              const bQty = Number(b.qty);
              if (!Number.isFinite(bQty) || bQty <= 0) {
                throw AppError.badRequest('Batch qty must be positive', { productId: p.id });
              }
              if (datesRequired) {
                if (!b.manufacturedAt || !/^\d{4}-\d{2}-\d{2}$/.test(b.manufacturedAt)) {
                  throw AppError.badRequest('manufacturedAt is required (YYYY-MM-DD)', { productId: p.id });
                }
                if (!b.expiresAt || !/^\d{4}-\d{2}-\d{2}$/.test(b.expiresAt)) {
                  throw AppError.badRequest('expiresAt is required (YYYY-MM-DD)', { productId: p.id });
                }
              }

              const batchCode = (b.batchCode?.trim() || generateBatchCode()).trim();
              const manufacturedAt =
                b.manufacturedAt && /^\d{4}-\d{2}-\d{2}$/.test(b.manufacturedAt) ? b.manufacturedAt : null;
              const expiresAt =
                b.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(b.expiresAt) ? b.expiresAt : null;

              const [created] = await tx
                .insert(productBatches)
                .values({
                  shopId,
                  productId: p.id,
                  batchCode,
                  supplierLotCode: b.supplierLotCode?.trim() || null,
                  manufacturedAt,
                  expiresAt,
                })
                .onConflictDoNothing({
                  target: [productBatches.shopId, productBatches.productId, productBatches.batchCode],
                })
                .returning();

              const batchRow =
                created ??
                (await tx
                  .select()
                  .from(productBatches)
                  .where(
                    and(
                      eq(productBatches.shopId, shopId),
                      eq(productBatches.productId, p.id),
                      eq(productBatches.batchCode, batchCode),
                    ),
                  )
                  .limit(1))[0];

              if (!batchRow) throw AppError.conflict('Could not create or load batch');

              await addToBatch(batchRow.id, bQty.toFixed(3));
            }
          } else {
            const need = absDelta;
            if (line.batchId) {
              await removeFromBatch(line.batchId, need.toFixed(3));
            } else {
              let remaining = need;
              const rows = await tx.execute<{ batchId: string; quantity: string }>(sql`
                SELECT
                  b.id::text AS "batchId",
                  COALESCE(bal.quantity::text, '0') AS quantity
                FROM product_batches b
                JOIN batch_inventory_balances bal
                  ON bal.batch_id = b.id
                 AND bal.shop_id = ${shopId}
                 AND bal.location_id = ${locationId}
                WHERE b.shop_id = ${shopId}
                  AND b.product_id = ${p.id}
                  AND bal.quantity::numeric > 0
                ORDER BY
                  (b.expires_at IS NULL) ASC,
                  b.expires_at ASC,
                  b.created_at ASC
              `);

              if (rows.rows.length === 0) {
                throw AppError.conflict('No batch stock available to remove for this product', {
                  productId: p.id,
                });
              }

              for (const r of rows.rows) {
                if (remaining <= 1e-9) break;
                const onHand = Number(r.quantity);
                if (!Number.isFinite(onHand) || onHand <= 0) continue;
                const take = Math.min(onHand, remaining);
                await removeFromBatch(r.batchId, take.toFixed(3));
                remaining -= take;
              }

              if (remaining > 1e-9) {
                throw AppError.conflict('Insufficient stock across batches for adjustment', {
                  productId: p.id,
                  needQty: need,
                });
              }
            }
          }
        }

        // Always update aggregate inventory balances for QUANTITY products.
        if (delta < 0) {
          const upd = await tx
            .update(inventoryBalances)
            .set({
              quantity: sql`${inventoryBalances.quantity}::numeric - ${String(absDelta)}::numeric`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(inventoryBalances.shopId, shopId),
                eq(inventoryBalances.productId, p.id),
                eq(inventoryBalances.locationId, locationId),
                sql`${inventoryBalances.quantity}::numeric >= ${String(absDelta)}::numeric`,
              ),
            )
            .returning();

          if (upd.length === 0) {
            throw AppError.conflict('Insufficient quantity for adjustment');
          }
        } else {
          await tx
            .insert(inventoryBalances)
            .values({
              shopId,
              productId: p.id,
              locationId,
              quantity: String(delta),
            })
            .onConflictDoUpdate({
              target: [
                inventoryBalances.shopId,
                inventoryBalances.productId,
                inventoryBalances.locationId,
              ],
              set: {
                quantity: sql`${inventoryBalances.quantity}::numeric + ${String(delta)}::numeric`,
                updatedAt: new Date(),
              },
            });
        }

        await tx.insert(inventoryMovements).values({
          shopId,
          productId: p.id,
          locationId,
          quantityDelta: String(delta),
          movementType: 'ADJUSTMENT',
          refTable: 'stock_adjustments',
          refId: adj.id,
          unitCost: p.unitCost,
          createdBy: userId,
        });
      }

      await tx.insert(stockAdjustmentLines).values({
        adjustmentId: adj.id,
        productId: p.id,
        locationId,
        qtyDelta: line.qtyDelta,
        deviceUnitId: p.trackingMode === 'SERIALIZED' ? (resolvedUnitId ?? null) : null,
      });
    }

    return adj;
  });
}

export async function listAdjustments(shopId: string, limit: number, offset: number) {
  const adjs = await db
    .select()
    .from(stockAdjustments)
    .where(eq(stockAdjustments.shopId, shopId))
    .orderBy(desc(stockAdjustments.createdAt))
    .limit(limit)
    .offset(offset);

  if (adjs.length === 0) return [];

  const adjIds = adjs.map((a) => a.id);

  const lines = await db
    .select({
      adjustmentId: stockAdjustmentLines.adjustmentId,
      qtyDelta: stockAdjustmentLines.qtyDelta,
      productName: products.name,
      productSku: products.sku,
      serial: deviceUnits.serial,
      imei1: deviceUnits.imei1,
      uniqueIdentifier: deviceUnits.uniqueIdentifier,
    })
    .from(stockAdjustmentLines)
    .innerJoin(products, eq(products.id, stockAdjustmentLines.productId))
    .leftJoin(deviceUnits, eq(deviceUnits.id, stockAdjustmentLines.deviceUnitId))
    .where(inArray(stockAdjustmentLines.adjustmentId, adjIds));

  return adjs.map((adj) => ({
    ...adj,
    lines: lines.filter((l) => l.adjustmentId === adj.id),
  }));
}
