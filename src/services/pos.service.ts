import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  batchInventoryBalances,
  batchInventoryMovements,
  bundleItems,
  customerLedgerEntries,
  customers,
  deviceEvents,
  deviceUnits,
  inventoryBalances,
  inventoryMovements,
  posHolds,
  productBatches,
  products,
  saleLineBatchAllocations,
  saleLines,
  salePayments,
  sales,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { formatDhakaYmd, normalizePromisePayDate } from '../lib/datetime.js';
import { generateInvoiceNo } from '../lib/invoice.js';
import { addMoney, mulMoney, roundMoney, subMoney } from '../lib/money.js';
import { isDeviceRegistryEnabled, isMultiStockLocationEnabled } from './shop-features.service.js';
import { resolveLocationIdOrDefault } from './stock-location.service.js';
import { getProductByBarcode } from './product.service.js';
import { searchImei } from './device.service.js';
import { assertPaymentMethodsForCheckout } from './shop-payment-method.service.js';

export async function resolveScan(shopId: string, raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return { type: 'empty' as const };

  if (await isDeviceRegistryEnabled(shopId)) {
    const imeiHits = await searchImei(shopId, trimmed);
    if (imeiHits.length === 1) {
      return { type: 'imei' as const, ...imeiHits[0]! };
    }
    if (imeiHits.length > 1) {
      return { type: 'imei_ambiguous' as const, matches: imeiHits };
    }
  }

  const byBarcode = await getProductByBarcode(shopId, trimmed);
  if (byBarcode) return { type: 'product' as const, product: byBarcode };

  return { type: 'not_found' as const };
}

export async function createHold(
  shopId: string,
  userId: string,
  input: { name?: string; payload: unknown; expiresAt?: string | null },
) {
  const [row] = await db
    .insert(posHolds)
    .values({
      shopId,
      name: input.name ?? null,
      payload: input.payload as object,
      createdBy: userId,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    })
    .returning();

  return row!;
}

export async function listHolds(shopId: string) {
  return db
    .select()
    .from(posHolds)
    .where(eq(posHolds.shopId, shopId))
    .orderBy(posHolds.createdAt);
}

const CUSTOMER_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function getHold(shopId: string, holdId: string) {
  const [row] = await db
    .select()
    .from(posHolds)
    .where(and(eq(posHolds.shopId, shopId), eq(posHolds.id, holdId)))
    .limit(1);
  if (!row) throw AppError.notFound('Hold not found');

  const rawPayload = row.payload;
  if (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
    const p = rawPayload as Record<string, unknown>;
    const cid = p.customerId;
    if (typeof cid === 'string' && CUSTOMER_ID_UUID.test(cid)) {
      const [c] = await db
        .select({ name: customers.name, phone: customers.phone })
        .from(customers)
        .where(and(eq(customers.id, cid), eq(customers.shopId, shopId)))
        .limit(1);
      if (c) {
        return {
          ...row,
          payload: {
            ...p,
            customerName: c.name,
            customerPhone: c.phone,
          },
        };
      }
    }
  }

  return row;
}

export async function deleteHold(shopId: string, holdId: string) {
  await db
    .delete(posHolds)
    .where(and(eq(posHolds.id, holdId), eq(posHolds.shopId, shopId)));
}

const PAYMENT_METHODS = [
  'CASH',
  'BKASH',
  'NAGAD',
  'ROCKET',
  'CARD',
  'BANK',
  'OTHER',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(m: string): m is PaymentMethod {
  return (PAYMENT_METHODS as readonly string[]).includes(m);
}

type CartLineInput = {
  productId: string;
  qty: string;
  unitPrice?: string;
  discount?: string;
  deviceUnitIds?: string[];
  /** Per-line stock location for quantity / bundle lines (falls back to checkout-level locationId). */
  locationId?: string | null;
  /** Optional batch selection for QUANTITY products; if absent we allocate FEFO. */
  batchId?: string | null;
  /**
   * Optional explicit allocation across multiple batches (advanced picker).
   * When present, quantities must sum to qty and we deduct exactly from these batches.
   */
  batchAllocations?: Array<{ batchId: string; qty: string }>;
};

export async function checkout(
  shopId: string,
  cashierUserId: string | null,
  input: {
    customerId?: string | null;
    idempotencyKey?: string | null;
    /** When set, quantity stock and movements use this location (must belong to shop). */
    locationId?: string | null;
    /** Delivery location for order fulfillment. */
    deliveryLocationId?: string | null;
    /** YYYY-MM-DD (Dhaka). When due > 0: optional; defaults to sale Dhaka date + 7. */
    promisePayDate?: string | null;
    lines: CartLineInput[];
    cartDiscount?: { type: 'FIXED' | 'PERCENT'; value: string } | null;
    payments: {
      paymentMethodId: string;
      amount: string;
      providerReference?: string | null;
    }[];
    /** Storefront web orders: unpaid-at-order (e.g. COD) use empty `payments` and `channel: 'WEB'`. */
    channel?: 'POS' | 'WEB';
  },
) {
  if (input.lines.length === 0) throw AppError.badRequest('Cart is empty');

  const channel = input.channel ?? 'POS';
  if (channel === 'POS' && !cashierUserId) {
    throw AppError.badRequest('Cashier is required for POS checkout');
  }
  const actorUserId = channel === 'WEB' ? null : cashierUserId;

  const multiLoc = await isMultiStockLocationEnabled(shopId);

  if (input.idempotencyKey?.trim()) {
    const [existing] = await db
      .select()
      .from(sales)
      .where(
        and(
          eq(sales.shopId, shopId),
          eq(sales.idempotencyKey, input.idempotencyKey.trim()),
        ),
      )
      .limit(1);
    if (existing) return { sale: existing, duplicate: true as const };
  }

  type ResolvedLine = {
    productId: string;
    qty: string;
    unitPrice: string;
    discount: string;
    deviceUnitId: string | null;
    description: string | null;
    /** Stock location for quantity/bundle; for serialized lines, sale location (validated vs device). */
    stockLocationId: string | null;
    batchId: string | null;
    batchAllocations?: Array<{ batchId: string; qty: string }> | null;
  };

  const resolved: ResolvedLine[] = [];

  for (const line of input.lines) {
    const [p] = await db
      .select()
      .from(products)
      .where(and(eq(products.id, line.productId), eq(products.shopId, shopId)))
      .limit(1);

    if (!p || !p.active) throw AppError.notFound(`Product ${line.productId}`);

    if (p.isBundle) {
      const items = await db
        .select()
        .from(bundleItems)
        .where(eq(bundleItems.bundleProductId, p.id));

      if (items.length === 0) {
        throw AppError.conflict('Bundle has no components configured');
      }

      let firstComp = true;
      const bundleLineDiscount = line.discount ?? '0';
      const bundleLineUnitPrice = line.unitPrice ?? p.listPrice;
      const bundleStockLoc = await resolveLocationIdOrDefault(
        shopId,
        line.locationId ?? input.locationId,
        multiLoc,
      );

      for (const bi of items) {
        const [comp] = await db
          .select()
          .from(products)
          .where(eq(products.id, bi.componentProductId))
          .limit(1);

        if (!comp) throw AppError.notFound('Bundle component missing');

        if (comp.trackingMode === 'SERIALIZED') {
          throw AppError.badRequest(
            'Checkout bundles with serialized components is not supported — add devices as separate lines.',
            { bundleId: p.id, componentId: comp.id },
          );
        }

        const compQty = (
          Number(line.qty) * Number(bi.quantity)
        ).toFixed(3);

        // Allow editing selling price in POS for bundles by applying the bundle's unitPrice
        // to the first component (others 0). This keeps totals correct while keeping the
        // existing “expanded bundle components” structure.
        const unitPrice = firstComp ? bundleLineUnitPrice : '0';
        resolved.push({
          productId: comp.id,
          qty: compQty,
          unitPrice,
          discount: firstComp ? bundleLineDiscount : '0',
          deviceUnitId: null,
          description: `Part of bundle: ${p.name}`,
          stockLocationId: bundleStockLoc,
          batchId: null,
        });
        firstComp = false;
      }

      continue;
    }

    const unitPrice = line.unitPrice ?? p.listPrice;
    const discount = line.discount ?? '0';

    if (p.trackingMode === 'SERIALIZED') {
      const qn = Number(line.qty);
      if (!Number.isInteger(qn) || qn <= 0) {
        throw AppError.badRequest('Serialized line qty must be a positive integer');
      }
      const ids = line.deviceUnitIds ?? [];
      if (ids.length !== qn) {
        throw AppError.badRequest('deviceUnitIds length must match qty for serialized', {
          expected: qn,
          got: ids.length,
        });
      }
      const saleStockLoc = await resolveLocationIdOrDefault(
        shopId,
        line.locationId ?? input.locationId,
        multiLoc,
      );
      for (let i = 0; i < qn; i++) {
        resolved.push({
          productId: p.id,
          qty: '1',
          unitPrice,
          discount: i === 0 ? discount : '0',
          deviceUnitId: ids[i]!,
          description: null,
          stockLocationId: saleStockLoc,
          batchId: null,
        });
      }
      continue;
    }

    const lineStockLoc = await resolveLocationIdOrDefault(
      shopId,
      line.locationId ?? input.locationId,
      multiLoc,
    );
    if (line.batchId && !p.batchTrackingEnabled) {
      throw AppError.badRequest('This product is not batch-tracked; do not provide batchId', {
        productId: p.id,
      });
    }
    resolved.push({
      productId: p.id,
      qty: line.qty,
      unitPrice,
      discount,
      deviceUnitId: null,
      description: null,
      stockLocationId: lineStockLoc,
      batchId: line.batchId ?? null,
      batchAllocations:
        line.batchAllocations && Array.isArray(line.batchAllocations) && line.batchAllocations.length > 0
          ? line.batchAllocations.map((a) => ({ batchId: a.batchId, qty: a.qty }))
          : null,
    });
  }

  let subtotal = '0';
  const lineTotals: string[] = [];

  for (const rl of resolved) {
    const gross = mulMoney(rl.qty, rl.unitPrice);
    const afterDisc = subMoney(gross, rl.discount);
    if (Number(afterDisc) < 0) {
      throw AppError.badRequest('Line discount exceeds line amount');
    }
    lineTotals.push(afterDisc);
    subtotal = addMoney(subtotal, afterDisc);
  }

  let discountTotal = '0';
  let total = subtotal;

  if (input.cartDiscount) {
    if (input.cartDiscount.type === 'FIXED') {
      discountTotal = input.cartDiscount.value;
      total = subMoney(subtotal, discountTotal);
    } else {
      const pct = Number(input.cartDiscount.value);
      if (pct < 0 || pct > 100) throw AppError.badRequest('Percent 0–100');
      const d = roundMoney((Number(subtotal) * pct) / 100);
      discountTotal = d;
      total = subMoney(subtotal, discountTotal);
    }
  }

  if (Number(total) < 0) throw AppError.badRequest('Total cannot be negative');

  // Get delivery charge first so payment validation uses the final grand total.
  let deliveryCharge = '0';
  if (input.deliveryLocationId) {
    const { deliveryLocations } = await import('../db/schema/index.js');
    const [deliveryLoc] = await db
      .select({ deliveryCharge: deliveryLocations.deliveryCharge })
      .from(deliveryLocations)
      .where(
        and(
          eq(deliveryLocations.id, input.deliveryLocationId),
          eq(deliveryLocations.shopId, shopId),
        ),
      )
      .limit(1);

    if (deliveryLoc) {
      deliveryCharge = deliveryLoc.deliveryCharge;
      total = addMoney(total, deliveryCharge);
    }
  }

  let paid = '0';
  for (const pay of input.payments) {
    paid = addMoney(paid, pay.amount);
  }

  const due = subMoney(total, paid);
  if (Number(due) < 0) {
    throw AppError.badRequest('Overpayment — reduce payment amounts', {
      total,
      paid,
    });
  }

  if (Number(due) > 0 && !input.customerId) {
    throw AppError.badRequest('Customer is required when the sale has an outstanding balance.');
  }

  let promisePayDate: string | null = null;
  if (Number(due) > 0) {
    try {
      promisePayDate = normalizePromisePayDate(input.promisePayDate ?? null);
    } catch (e) {
      throw AppError.badRequest(
        e instanceof Error ? e.message : 'Invalid promised payment date',
      );
    }
  }

  const invoiceNo = generateInvoiceNo(formatDhakaYmd());

  const saleRow = await db.transaction(async (tx) => {
    const [sale] = await tx
      .insert(sales)
      .values({
        shopId,
        invoiceNo,
        customerId: input.customerId ?? null,
        subtotal,
        discountTotal,
        taxTotal: '0',
        total,
        paidTotal: paid,
        dueAmount: due,
        promisePayDate,
        status: 'COMPLETED',
        channel,
        deliveryLocationId: input.deliveryLocationId ?? null,
        deliveryCharge,
        cashierUserId: actorUserId,
        idempotencyKey: input.idempotencyKey?.trim() || null,
      })
      .returning();

    if (!sale) throw AppError.conflict('Sale failed');

    for (let i = 0; i < resolved.length; i++) {
      const rl = resolved[i]!;
      const lineTotal = lineTotals[i]!;

      const [p] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, rl.productId), eq(products.shopId, shopId)))
        .limit(1);

      if (!p) throw AppError.notFound('Product');

      if (p.trackingMode === 'SERIALIZED') {
        if (!rl.deviceUnitId) throw AppError.conflict('Missing device unit');

        const [du] = await tx
          .select()
          .from(deviceUnits)
          .where(
            and(
              eq(deviceUnits.id, rl.deviceUnitId),
              eq(deviceUnits.shopId, shopId),
              eq(deviceUnits.productId, p.id),
            ),
          )
          .limit(1);

        if (!du) throw AppError.notFound('Device unit');
        if (du.blocklisted) throw AppError.conflict('Device is blocklisted');
        if (du.status !== 'IN_STOCK') {
          throw AppError.conflict('Device not available for sale', {
            status: du.status,
          });
        }

        if (multiLoc && rl.stockLocationId && du.stockLocationId !== rl.stockLocationId) {
          throw AppError.conflict(
            'This serial is booked at a different stock location than the one selected in POS. Pick it from the correct site or change the POS location.',
            { serial: du.serial },
          );
        }

        const [sl] = await tx
          .insert(saleLines)
          .values({
            saleId: sale.id,
            productId: p.id,
            description: rl.description,
            qty: '1',
            unitPrice: rl.unitPrice,
            discount: rl.discount,
            lineTotal,
            cogsUnitCost: p.unitCost,
            deviceUnitId: du.id,
          })
          .returning();

        await tx
          .update(deviceUnits)
          .set({
            status: 'SOLD',
            soldSaleLineId: sl!.id,
            updatedAt: new Date(),
          })
          .where(eq(deviceUnits.id, du.id));

        await tx.insert(deviceEvents).values({
          deviceUnitId: du.id,
          eventType: 'SOLD',
          refTable: 'sale_lines',
          refId: sl!.id,
          payload: { saleId: sale.id },
          createdBy: actorUserId,
        });
      } else {
        const qtyNum = Number(rl.qty);
        const lineLocId = rl.stockLocationId;
        if (!lineLocId) {
          throw AppError.conflict('Missing stock location for quantity line', {
            productId: p.id,
          });
        }
        const locId = lineLocId;
        const allocs: Array<{ batchId: string; qty: string }> = [];

        if (p.inventoryTracked !== false) {
          if (p.batchTrackingEnabled) {
            // ── Batch (FEFO) stock deduction ───────────────────────────────
            // If rl.batchId is provided, deduct from that batch only.
            // Otherwise, allocate across batches by FEFO (earliest expiry first).
            async function allocateFromBatch(batchId: string, qtyStr: string) {
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

              await tx
                .insert(batchInventoryBalances)
                .values({ shopId, batchId, locationId: locId, quantity: '0' })
                .onConflictDoNothing({
                  target: [
                    batchInventoryBalances.shopId,
                    batchInventoryBalances.batchId,
                    batchInventoryBalances.locationId,
                  ],
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
                    eq(batchInventoryBalances.locationId, locId),
                    sql`${batchInventoryBalances.quantity}::numeric >= ${qtyStr}::numeric`,
                  ),
                )
                .returning();
              if (upd.length === 0) {
                throw AppError.conflict('Insufficient batch stock', {
                  productId: p.id,
                  batchId,
                  needQty: qtyStr,
                });
              }

              await tx.insert(batchInventoryMovements).values({
                shopId,
                batchId,
                productId: p.id,
                locationId: locId,
                quantityDelta: (-Number(qtyStr)).toFixed(3),
                movementType: 'SALE',
                refTable: 'sales',
                refId: sale.id,
                createdBy: actorUserId,
              });

              allocs.push({ batchId, qty: qtyStr });
            }

            if (rl.batchAllocations && rl.batchAllocations.length > 0) {
              const sum = rl.batchAllocations.reduce((s, a) => s + Number(a.qty), 0);
              if (!Number.isFinite(sum) || Math.abs(sum - qtyNum) > 1e-6) {
                throw AppError.badRequest('Batch allocations must sum to line qty', {
                  productId: p.id,
                  qty: rl.qty,
                  batchQtySum: sum,
                });
              }
              for (const a of rl.batchAllocations) {
                const q = Number(a.qty);
                if (!Number.isFinite(q) || q <= 0) {
                  throw AppError.badRequest('Batch allocation qty must be positive', {
                    productId: p.id,
                    batchId: a.batchId,
                  });
                }
                await allocateFromBatch(a.batchId, q.toFixed(3));
              }
            } else if (rl.batchId) {
              const selectedBatchId = rl.batchId;
              await allocateFromBatch(selectedBatchId, rl.qty);
            } else {
              let remaining = qtyNum;
              const rows = await tx.execute<{
                batchId: string;
                quantity: string;
              }>(sql`
                SELECT
                  b.id::text AS "batchId",
                  COALESCE(bal.quantity::text, '0') AS quantity
                FROM product_batches b
                JOIN batch_inventory_balances bal
                  ON bal.batch_id = b.id
                 AND bal.shop_id = ${shopId}
                 AND bal.location_id = ${locId}
                WHERE b.shop_id = ${shopId}
                  AND b.product_id = ${p.id}
                  AND bal.quantity::numeric > 0
                ORDER BY
                  (b.expires_at IS NULL) ASC,
                  b.expires_at ASC,
                  b.created_at ASC
              `);

              if (rows.rows.length === 0) {
                throw AppError.conflict(
                  'This product requires batches. Receive stock with batch + expiry before selling.',
                  { productId: p.id },
                );
              }

              for (const r of rows.rows) {
                if (remaining <= 1e-9) break;
                const onHand = Number(r.quantity);
                if (!Number.isFinite(onHand) || onHand <= 0) continue;
                const take = Math.min(onHand, remaining);
                await allocateFromBatch(r.batchId, take.toFixed(3));
                remaining -= take;
              }

              if (remaining > 1e-9) {
                throw AppError.conflict('Insufficient stock across batches (FEFO)', {
                  productId: p.id,
                  needQty: rl.qty,
                });
              }
            }
          }

          // Balance rows are created on PO receive / positive adjustments; new products often have no row yet.
          await tx
            .insert(inventoryBalances)
            .values({
              shopId,
              productId: p.id,
              locationId: locId,
              quantity: '0',
            })
            .onConflictDoNothing({
              target: [
                inventoryBalances.shopId,
                inventoryBalances.productId,
                inventoryBalances.locationId,
              ],
            });

          const upd = await tx
            .update(inventoryBalances)
            .set({
              quantity: sql`${inventoryBalances.quantity}::numeric - ${rl.qty}::numeric`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(inventoryBalances.shopId, shopId),
                eq(inventoryBalances.productId, p.id),
                  eq(inventoryBalances.locationId, locId),
                sql`${inventoryBalances.quantity}::numeric >= ${rl.qty}::numeric`,
              ),
            )
            .returning();

          if (upd.length === 0) {
            const [bal] = await tx
              .select({ quantity: inventoryBalances.quantity })
              .from(inventoryBalances)
              .where(
                and(
                  eq(inventoryBalances.shopId, shopId),
                  eq(inventoryBalances.productId, p.id),
                  eq(inventoryBalances.locationId, locId),
                ),
              )
              .limit(1);
            const onHand = bal?.quantity ?? '0';
            throw AppError.conflict(
              `Insufficient stock for “${p.name}” (SKU ${p.sku}): on hand ${onHand}, sale qty ${rl.qty}. Receive stock or add an opening balance.`,
              { productId: p.id, sku: p.sku, onHand, needQty: rl.qty },
            );
          }

          await tx.insert(inventoryMovements).values({
            shopId,
            productId: p.id,
            locationId: locId,
            quantityDelta: (-qtyNum).toFixed(3),
            movementType: 'SALE',
            refTable: 'sales',
            refId: sale.id,
            unitCost: p.unitCost,
            createdBy: actorUserId,
          });
        }

        const [sl] = await tx.insert(saleLines).values({
          saleId: sale.id,
          productId: p.id,
          description: rl.description,
          qty: rl.qty,
          unitPrice: rl.unitPrice,
          discount: rl.discount,
          lineTotal,
          cogsUnitCost: p.unitCost,
          deviceUnitId: null,
        }).returning();

        if (!sl) throw AppError.conflict('Sale line insert failed');

        if (allocs.length > 0) {
          for (const a of allocs) {
            await tx.insert(saleLineBatchAllocations).values({
              saleLineId: sl.id,
              batchId: a.batchId,
              qty: a.qty,
            });
          }
        }
      }
    }

    if (input.payments.length > 0) {
      const pmMap = await assertPaymentMethodsForCheckout(
        tx,
        shopId,
        input.payments.map((p) => p.paymentMethodId),
      );
      for (const pay of input.payments) {
        const meta = pmMap.get(pay.paymentMethodId)!;
        await tx.insert(salePayments).values({
          saleId: sale.id,
          paymentMethodId: pay.paymentMethodId,
          methodLabelSnapshot: meta.name,
          amount: pay.amount,
          providerReference: pay.providerReference ?? null,
        });
      }
    } else {
      if (channel !== 'WEB') {
        throw AppError.badRequest('At least one payment is required');
      }
      if (!(Number(due) > 0)) {
        throw AppError.badRequest('Web checkout with no payments requires an unpaid balance (for example cash on delivery)');
      }
    }

    if (Number(due) > 0 && input.customerId) {
      await tx.insert(customerLedgerEntries).values({
        customerId: input.customerId,
        entryType: 'SALE_DEBIT',
        amount: due,
        refTable: 'sales',
        refId: sale.id,
        note: 'Sale balance due',
      });
    }

    return sale;
  });

  return { sale: saleRow, duplicate: false as const };
}
