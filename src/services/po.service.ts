import { and, count, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
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
  purchaseOrderLines,
  purchaseOrders,
  purchaseReturnLines,
  purchaseReturns,
  shopPaymentMethods,
  stockLocations,
  supplierLedgerEntries,
  suppliers,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { assertImeiValid } from './device.service.js';
import { isMultiStockLocationEnabled } from './shop-features.service.js';
import { resolveLocationIdOrDefault } from './stock-location.service.js';
import { settlementByPoIds } from './supplier-po-settlement.service.js';
import { generateBatchCode } from './batch.service.js';

export async function createPurchaseOrder(
  shopId: string,
  userId: string,
  input: {
    supplierId: string;
    orderDate?: string;
    expectedDate?: string | null;
    note?: string | null;
    lines: { productId: string; qtyOrdered: string; unitCost: string }[];
  },
) {
  if (input.lines.length === 0) throw AppError.badRequest('PO needs lines');

  const [sup] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.shopId, shopId)))
    .limit(1);

  if (!sup) throw AppError.notFound('Supplier not found');

  return db.transaction(async (tx) => {
    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        shopId,
        supplierId: input.supplierId,
        status: 'DRAFT',
        orderDate: input.orderDate ?? undefined,
        expectedDate: input.expectedDate ?? null,
        note: input.note ?? null,
        createdBy: userId,
      })
      .returning();

    if (!po) throw AppError.conflict('PO create failed');

    for (const line of input.lines) {
      const [p] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, line.productId), eq(products.shopId, shopId)))
        .limit(1);

      if (!p) throw AppError.notFound(`Product ${line.productId}`);

      const lineTotal = (
        Number(line.qtyOrdered) * Number(line.unitCost)
      ).toFixed(2);

      await tx.insert(purchaseOrderLines).values({
        poId: po.id,
        productId: p.id,
        qtyOrdered: line.qtyOrdered,
        qtyReceived: '0',
        unitCost: line.unitCost,
        lineTotal,
      });
    }

    return po;
  });
}

export type ReceiveSerial = {
  serial: string;
  imei1?: string | null;
  imei2?: string | null;
  /** When multiple stock locations are on, optional per-unit destination (else header location). */
  locationId?: string | null;
};

/** Client often echoes PO line unit cost on every receive; treat as unchanged when numerically equal. */
function receiveUnitCostMatchesLine(provided: string, lineUnitCost: string): boolean {
  const p = Number(String(provided).trim());
  const l = Number(String(lineUnitCost).trim());
  if (Number.isFinite(p) && Number.isFinite(l)) {
    return Math.abs(p - l) <= 0.009;
  }
  return String(provided).trim() === String(lineUnitCost).trim();
}

export async function receivePurchaseOrder(
  shopId: string,
  userId: string,
  poId: string,
  input: {
    locationId?: string;
    lines: {
      poLineId: string;
      qty: string;
      unitCost?: string;
      batches?: Array<{
        qty: string;
        manufacturedAt?: string | null;
        expiresAt?: string | null;
        supplierLotCode?: string | null;
        batchCode?: string | null;
      }>;
      serials?: ReceiveSerial[];
    }[];
  },
) {
  const multi = await isMultiStockLocationEnabled(shopId);
  const receiveLocationId = await resolveLocationIdOrDefault(shopId, input.locationId ?? null, multi);

  return db.transaction(async (tx) => {
    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.shopId, shopId)))
      .limit(1);

    if (!po) throw AppError.notFound('Purchase order not found');
    if (po.status === 'CANCELLED') throw AppError.conflict('PO cancelled');
    if (po.status === 'COMPLETED') throw AppError.conflict('PO already completed');

    let totalPayableDelta = 0;

    for (const rec of input.lines) {
      const [line] = await tx
        .select()
        .from(purchaseOrderLines)
        .where(
          and(
            eq(purchaseOrderLines.id, rec.poLineId),
            eq(purchaseOrderLines.poId, poId),
          ),
        )
        .limit(1);

      if (!line) throw AppError.notFound(`PO line ${rec.poLineId}`);

      const qty = Number(rec.qty);
      if (qty <= 0) throw AppError.badRequest('Receive qty must be positive');

      const ordered = Number(line.qtyOrdered);
      const already = Number(line.qtyReceived);
      const maxRecv = ordered - already;
      if (qty > maxRecv + 1e-9) {
        throw AppError.conflict(
          `Cannot receive ${qty} on this line — only ${maxRecv} left (ordered ${ordered}, already received ${already}).`,
          {
            poLineId: rec.poLineId,
            max: maxRecv,
            ordered,
            alreadyReceived: already,
            attempted: qty,
          },
        );
      }

      const [p] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, line.productId), eq(products.shopId, shopId)))
        .limit(1);

      if (!p) throw AppError.notFound('Product missing');

      const locationId = receiveLocationId;

      // Allow changing line unit cost only before any qty is received. After partial receive, the UI
      // still sends the same unit cost each time — allow that; reject only a different cost.
      if (rec.unitCost !== undefined) {
        const nextUnitCost = String(rec.unitCost);
        const current = String(line.unitCost);
        if (already > 0) {
          if (!receiveUnitCostMatchesLine(nextUnitCost, current)) {
            throw AppError.conflict('Cannot update unit cost after receiving has started on a line', {
              poLineId: rec.poLineId,
            });
          }
        } else if (!receiveUnitCostMatchesLine(nextUnitCost, current)) {
          const nextLineTotal = (Number(line.qtyOrdered) * Number(nextUnitCost)).toFixed(2);
          await tx
            .update(purchaseOrderLines)
            .set({
              unitCost: nextUnitCost,
              lineTotal: nextLineTotal,
            })
            .where(eq(purchaseOrderLines.id, line.id));
          line.unitCost = nextUnitCost as any;
        }
      }

      const lineCost = (qty * Number(line.unitCost)).toFixed(2);
      totalPayableDelta += Number(lineCost);

      if (p.trackingMode === 'SERIALIZED') {
        const serials = rec.serials ?? [];
        if (serials.length !== qty) {
          throw AppError.badRequest('Serials are required for serialized line', {
            expected: qty,
            got: serials.length,
          });
        }

        // Detect duplicates inside payload and against existing stock before insert.
        // This provides a cleaner error than a raw unique index violation.
        const trimmedSerials = serials.map((s) => s.serial.trim()).filter(Boolean);
        const seen = new Set<string>();
        for (const s of trimmedSerials) {
          if (seen.has(s)) {
            throw AppError.conflict('Duplicate serial in receive payload', {
              poLineId: rec.poLineId,
              serial: s,
            });
          }
          seen.add(s);
        }
        if (trimmedSerials.length > 0) {
          const existing = await tx
            .select({ serial: deviceUnits.serial })
            .from(deviceUnits)
            .where(and(eq(deviceUnits.shopId, shopId), inArray(deviceUnits.serial, trimmedSerials)))
            .limit(5);
          if (existing.length > 0) {
            throw AppError.conflict('Serial already exists', {
              poLineId: rec.poLineId,
              serial: existing[0]!.serial,
            });
          }
        }

        for (const s of serials) {
          const serial = s.serial.trim();
          if (!serial) throw AppError.badRequest('Serial cannot be empty');
          const imei1 = s.imei1 ? assertImeiValid(s.imei1) : null;
          const imei2 = s.imei2 ? assertImeiValid(s.imei2) : null;

          const unitStockLocationId = multi
            ? await resolveLocationIdOrDefault(
                shopId,
                s.locationId?.trim() || input.locationId || null,
                true,
              )
            : receiveLocationId;

          const [du] = await tx
            .insert(deviceUnits)
            .values({
              shopId,
              productId: p.id,
              serial,
              imei1,
              imei2,
              status: 'IN_STOCK',
              receivedPoLineId: line.id,
              channelTag: null,
              stockLocationId: unitStockLocationId,
            })
            .returning();

          await tx.insert(deviceEvents).values({
            deviceUnitId: du!.id,
            eventType: 'RECEIVED',
            refTable: 'purchase_order_lines',
            refId: line.id,
            payload: { poId },
            createdBy: userId,
          });
        }
      } else {
        // For QUANTITY items, allow receiving into one or more batches.
        // If caller provided batches, validate that their sum matches `qty`.
        const batches = rec.batches ?? null;
        if (batches && batches.length > 0) {
          const sum = batches.reduce((s, b) => s + Number(b.qty), 0);
          if (!Number.isFinite(sum) || Math.abs(sum - qty) > 1e-6) {
            throw AppError.badRequest('Batch quantities must sum to received qty', {
              poLineId: rec.poLineId,
              receivedQty: qty,
              batchQtySum: sum,
            });
          }
        }
        if (!p.batchTrackingEnabled && batches && batches.length > 0) {
          throw AppError.badRequest('This product is not batch-tracked; do not provide batches', {
            poLineId: rec.poLineId,
            productId: p.id,
          });
        }
        if (p.batchTrackingEnabled && (!batches || batches.length === 0)) {
          throw AppError.badRequest('Batches are required for this product', {
            poLineId: rec.poLineId,
            productId: p.id,
            required: true,
          });
        }

        const [existingBal] = await tx
          .select({ quantity: inventoryBalances.quantity })
          .from(inventoryBalances)
          .where(
            and(
              eq(inventoryBalances.shopId, shopId),
              eq(inventoryBalances.productId, p.id),
              eq(inventoryBalances.locationId, locationId),
            ),
          )
          .limit(1);

        const q0 = Number(existingBal?.quantity ?? 0);
        const incoming = qty;
        const newQty = q0 + incoming;
        const oldCost = Number(p.unitCost);
        const incomingCost = Number(line.unitCost);
        const newUnitCost =
          newQty > 0
            ? ((q0 * oldCost + incoming * incomingCost) / newQty).toFixed(2)
            : line.unitCost;

        await tx
          .insert(inventoryBalances)
          .values({
            shopId,
            productId: p.id,
            locationId,
            quantity: String(qty),
          })
          .onConflictDoUpdate({
            target: [
              inventoryBalances.shopId,
              inventoryBalances.productId,
              inventoryBalances.locationId,
            ],
            set: {
              quantity: sql`${inventoryBalances.quantity}::numeric + ${String(qty)}::numeric`,
              updatedAt: new Date(),
            },
          });

        await tx.insert(inventoryMovements).values({
          shopId,
          productId: p.id,
          locationId,
          quantityDelta: String(qty),
          movementType: 'PO_RECEIVE',
          refTable: 'purchase_order_lines',
          refId: line.id,
          unitCost: line.unitCost,
          createdBy: userId,
        });

        // Batch stock receive (required when product is batch-tracked).
        if (batches && batches.length > 0) {
          for (const b of batches) {
            const bQty = Number(b.qty);
            if (!Number.isFinite(bQty) || bQty <= 0) {
              throw AppError.badRequest('Batch qty must be positive', { poLineId: rec.poLineId });
            }

            const batchCode = (b.batchCode?.trim() || generateBatchCode()).trim();
            if (p.batchDatesRequired) {
              if (!b.manufacturedAt || !/^\d{4}-\d{2}-\d{2}$/.test(b.manufacturedAt)) {
                throw AppError.badRequest('manufacturedAt is required (YYYY-MM-DD) for batch-tracked products', {
                  poLineId: rec.poLineId,
                  productId: p.id,
                });
              }
              if (!b.expiresAt || !/^\d{4}-\d{2}-\d{2}$/.test(b.expiresAt)) {
                throw AppError.badRequest('expiresAt is required (YYYY-MM-DD) for batch-tracked products', {
                  poLineId: rec.poLineId,
                  productId: p.id,
                });
              }
            }
            const manufacturedAt =
              b.manufacturedAt && /^\d{4}-\d{2}-\d{2}$/.test(b.manufacturedAt)
                ? b.manufacturedAt
                : null;
            const expiresAt =
              b.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(b.expiresAt)
                ? b.expiresAt
                : null;

            const [batch] = await tx
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

            // If already existed, fetch it.
            const batchRow =
              batch ??
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

            await tx
              .insert(batchInventoryBalances)
              .values({
                shopId,
                batchId: batchRow.id,
                locationId,
                quantity: String(bQty),
              })
              .onConflictDoUpdate({
                target: [batchInventoryBalances.shopId, batchInventoryBalances.batchId, batchInventoryBalances.locationId],
                set: {
                  quantity: sql`${batchInventoryBalances.quantity}::numeric + ${String(bQty)}::numeric`,
                  updatedAt: new Date(),
                },
              });

            await tx.insert(batchInventoryMovements).values({
              shopId,
              batchId: batchRow.id,
              productId: p.id,
              locationId,
              quantityDelta: String(bQty),
              movementType: 'PO_RECEIVE',
              refTable: 'purchase_order_lines',
              refId: line.id,
              createdBy: userId,
            });
          }
        }

        if (p.costMethod === 'MOVING_AVG') {
          await tx
            .update(products)
            .set({
              unitCost: newUnitCost,
              updatedAt: new Date(),
            })
            .where(eq(products.id, p.id));
        }
      }

      const newReceived = (Number(line.qtyReceived) + qty).toFixed(3);
      await tx
        .update(purchaseOrderLines)
        .set({ qtyReceived: newReceived })
        .where(eq(purchaseOrderLines.id, line.id));
    }

    if (totalPayableDelta > 0) {
      await tx.insert(supplierLedgerEntries).values({
        supplierId: po.supplierId,
        entryType: 'PURCHASE',
        amount: totalPayableDelta.toFixed(2),
        refTable: 'purchase_orders',
        refId: po.id,
        note: 'Stock received',
      });
    }

    const lines = await tx
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.poId, poId));

    const allDone = lines.every(
      (l) => Number(l.qtyReceived) >= Number(l.qtyOrdered) - 1e-9,
    );
    const anyRecv = lines.some((l) => Number(l.qtyReceived) > 0);

    const nextStatus = allDone
      ? 'COMPLETED'
      : anyRecv
        ? 'PARTIALLY_RECEIVED'
        : po.status;

    await tx
      .update(purchaseOrders)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(purchaseOrders.id, poId));

    const [updated] = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, poId))
      .limit(1);

    return updated!;
  });
}

export type ListPurchaseOrdersOpts = {
  /** Only fully received POs (for returns, payments, filters). Excludes PARTIALLY_RECEIVED / DRAFT / SENT. */
  completedOnly?: boolean;
};

export async function listPurchaseOrders(shopId: string, opts?: ListPurchaseOrdersOpts) {
  const conds = [eq(purchaseOrders.shopId, shopId)];
  if (opts?.completedOnly) {
    conds.push(eq(purchaseOrders.status, 'COMPLETED'));
  }
  return db
    .select()
    .from(purchaseOrders)
    .where(and(...conds))
    .orderBy(desc(purchaseOrders.createdAt));
}

export async function listPurchaseOrdersWithSettlement(shopId: string, opts?: ListPurchaseOrdersOpts) {
  const pos = await listPurchaseOrders(shopId, opts);
  const ids = pos.map((p) => p.id);
  const settlement = await settlementByPoIds(ids);
  return pos.map((po) => ({
    ...po,
    settlement: settlement.get(po.id)!,
  }));
}

export async function getPurchaseOrder(shopId: string, poId: string) {
  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.shopId, shopId)))
    .limit(1);

  if (!po) return null;

  const lines = await db
    .select()
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.poId, poId));

  const lineIds = lines.map((l) => l.id);
  const units =
    lineIds.length === 0
      ? []
      : await db
          .select({
            id: deviceUnits.id,
            receivedPoLineId: deviceUnits.receivedPoLineId,
            serial: deviceUnits.serial,
            imei1: deviceUnits.imei1,
            imei2: deviceUnits.imei2,
            uniqueIdentifier: deviceUnits.uniqueIdentifier,
            notes: deviceUnits.notes,
            status: deviceUnits.status,
            createdAt: deviceUnits.createdAt,
            stockLocationId: deviceUnits.stockLocationId,
            stockLocationName: stockLocations.name,
          })
          .from(deviceUnits)
          .leftJoin(stockLocations, eq(stockLocations.id, deviceUnits.stockLocationId))
          .where(
            and(
              eq(deviceUnits.shopId, shopId),
              inArray(deviceUnits.receivedPoLineId, lineIds),
            ),
          )
          .orderBy(deviceUnits.createdAt);

  const receivedUnitsByLineId: Record<string, typeof units> = {};
  for (const u of units) {
    const k = u.receivedPoLineId;
    if (!k) continue;
    (receivedUnitsByLineId[k] ??= []).push(u);
  }

  let receiveStockLocationLabels: string[] = [];
  if (lineIds.length > 0) {
    const locRows = await db
      .select({ name: stockLocations.name })
      .from(inventoryMovements)
      .innerJoin(
        stockLocations,
        eq(stockLocations.id, inventoryMovements.locationId),
      )
      .where(
        and(
          eq(inventoryMovements.shopId, shopId),
          eq(inventoryMovements.movementType, 'PO_RECEIVE'),
          eq(inventoryMovements.refTable, 'purchase_order_lines'),
          inArray(inventoryMovements.refId, lineIds),
        ),
      )
      .groupBy(stockLocations.name);
    receiveStockLocationLabels = locRows.map((r) => r.name);
  }

  const fromSerials = [
    ...new Set(
      units
        .map((u) => u.stockLocationName)
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
    ),
  ];
  receiveStockLocationLabels = [...new Set([...receiveStockLocationLabels, ...fromSerials])];

  type QtyRecvRow = {
    createdAt: string;
    locationName: string;
    quantityDelta: string;
  };
  const receiveQtyMovementsByLineId: Record<string, QtyRecvRow[]> = {};
  if (lineIds.length > 0) {
    const qtyMovs = await db
      .select({
        refId: inventoryMovements.refId,
        createdAt: inventoryMovements.createdAt,
        quantityDelta: inventoryMovements.quantityDelta,
        locationName: stockLocations.name,
      })
      .from(inventoryMovements)
      .innerJoin(
        stockLocations,
        eq(stockLocations.id, inventoryMovements.locationId),
      )
      .where(
        and(
          eq(inventoryMovements.shopId, shopId),
          eq(inventoryMovements.movementType, 'PO_RECEIVE'),
          eq(inventoryMovements.refTable, 'purchase_order_lines'),
          inArray(inventoryMovements.refId, lineIds),
        ),
      )
      .orderBy(desc(inventoryMovements.createdAt));

    for (const m of qtyMovs) {
      const lid = m.refId;
      if (!lid) continue;
      (receiveQtyMovementsByLineId[lid] ??= []).push({
        createdAt: m.createdAt.toISOString(),
        locationName: m.locationName,
        quantityDelta: String(m.quantityDelta),
      });
    }
  }

  type SerialLocRow = { locationName: string | null; count: number };
  const receiveSerialsByLocationByLineId: Record<string, SerialLocRow[]> = {};
  if (lineIds.length > 0) {
    const agg = await db
      .select({
        lineId: deviceUnits.receivedPoLineId,
        locationName: stockLocations.name,
        cnt: count(),
      })
      .from(deviceUnits)
      .leftJoin(stockLocations, eq(stockLocations.id, deviceUnits.stockLocationId))
      .where(
        and(
          eq(deviceUnits.shopId, shopId),
          isNotNull(deviceUnits.receivedPoLineId),
          inArray(deviceUnits.receivedPoLineId, lineIds),
        ),
      )
      .groupBy(deviceUnits.receivedPoLineId, stockLocations.name);

    for (const row of agg) {
      const lid = row.lineId;
      if (!lid) continue;
      (receiveSerialsByLocationByLineId[lid] ??= []).push({
        locationName: row.locationName,
        count: Number(row.cnt),
      });
    }
  }

  // Find any purchase returns for this PO
  const returns = await db
    .select({
      id: purchaseReturns.id,
      returnDate: purchaseReturns.returnDate,
      note: purchaseReturns.note,
      refundAmount: purchaseReturns.refundAmount,
      paymentMethodId: purchaseReturns.paymentMethodId,
      paymentMethodName: shopPaymentMethods.name,
    })
    .from(purchaseReturns)
    .leftJoin(shopPaymentMethods, eq(shopPaymentMethods.id, purchaseReturns.paymentMethodId))
    .where(
      and(
        eq(purchaseReturns.shopId, shopId),
        eq(purchaseReturns.refPoId, poId),
      ),
    );

  const returnIds = returns.map((r) => r.id);
  const returnLines =
    returnIds.length === 0
      ? []
      : await db
          .select({
            id: purchaseReturnLines.id,
            returnId: purchaseReturnLines.returnId,
            productId: purchaseReturnLines.productId,
            poLineId: purchaseReturnLines.poLineId,
            qty: purchaseReturnLines.qty,
            unitCost: purchaseReturnLines.unitCost,
            lineTotal: purchaseReturnLines.lineTotal,
            productName: products.name,
            productSku: products.sku,
            serial: deviceUnits.serial,
          })
          .from(purchaseReturnLines)
          .innerJoin(products, eq(products.id, purchaseReturnLines.productId))
          .leftJoin(deviceUnits, eq(deviceUnits.id, purchaseReturnLines.deviceUnitId))
          .where(inArray(purchaseReturnLines.returnId, returnIds));

  return {
    po,
    lines,
    receivedUnitsByLineId,
    receiveStockLocationLabels,
    receiveQtyMovementsByLineId,
    receiveSerialsByLocationByLineId,
    settlement: (await settlementByPoIds([poId])).get(poId)!,
    returns,
    returnLines,
  };
}

export async function updatePoStatus(
  shopId: string,
  poId: string,
  status: 'DRAFT' | 'SENT' | 'CANCELLED',
) {
  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.shopId, shopId)))
    .limit(1);

  if (!po) throw AppError.notFound('PO not found');

  // Guardrails: once stock receiving starts, PO becomes immutable (except receiving).
  if (po.status === 'COMPLETED') {
    throw AppError.conflict('PO already completed');
  }
  if (po.status === 'CANCELLED') {
    throw AppError.conflict('PO is cancelled');
  }

  const lines = await db
    .select({ qtyReceived: purchaseOrderLines.qtyReceived })
    .from(purchaseOrderLines)
    .where(eq(purchaseOrderLines.poId, poId));

  const anyReceived = lines.some((l) => Number(l.qtyReceived) > 0);

  if (anyReceived) {
    throw AppError.conflict(
      'Cannot change PO status after receiving has started',
      { poId },
    );
  }

  if (status === 'SENT') {
    if (po.status !== 'DRAFT') {
      throw AppError.conflict('Only DRAFT POs can be marked SENT');
    }
  }

  if (status === 'CANCELLED') {
    if (po.status !== 'DRAFT' && po.status !== 'SENT') {
      throw AppError.conflict('Only DRAFT/SENT POs can be cancelled');
    }
  }

  const [row] = await db
    .update(purchaseOrders)
    .set({ status, updatedAt: new Date() })
    .where(eq(purchaseOrders.id, poId))
    .returning();

  return row!;
}

export async function updatePurchaseOrder(
  shopId: string,
  poId: string,
  input: {
    supplierId?: string;
    orderDate?: string;
    expectedDate?: string | null;
    note?: string | null;
    lines?: { productId: string; qtyOrdered: string; unitCost: string }[];
  },
) {
  const [po] = await db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.shopId, shopId)))
    .limit(1);

  if (!po) throw AppError.notFound('PO not found');
  if (po.status !== 'DRAFT') {
    throw AppError.conflict('Only DRAFT purchase orders can be edited');
  }

  return db.transaction(async (tx) => {
    const updateObj: any = { updatedAt: new Date() };
    if (input.supplierId !== undefined) {
      const [sup] = await tx
        .select()
        .from(suppliers)
        .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.shopId, shopId)))
        .limit(1);
      if (!sup) throw AppError.notFound('Supplier not found');
      updateObj.supplierId = input.supplierId;
    }
    if (input.orderDate !== undefined) updateObj.orderDate = input.orderDate;
    if (input.expectedDate !== undefined) updateObj.expectedDate = input.expectedDate;
    if (input.note !== undefined) updateObj.note = input.note;

    await tx.update(purchaseOrders).set(updateObj).where(eq(purchaseOrders.id, poId));

    if (input.lines !== undefined) {
      if (input.lines.length === 0) throw AppError.badRequest('PO needs lines');

      // Delete existing lines
      await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));

      for (const line of input.lines) {
        const [p] = await tx
          .select()
          .from(products)
          .where(and(eq(products.id, line.productId), eq(products.shopId, shopId)))
          .limit(1);

        if (!p) throw AppError.notFound(`Product ${line.productId}`);

        const lineTotal = (
          Number(line.qtyOrdered) * Number(line.unitCost)
        ).toFixed(2);

        await tx.insert(purchaseOrderLines).values({
          poId,
          productId: p.id,
          qtyOrdered: line.qtyOrdered,
          qtyReceived: '0',
          unitCost: line.unitCost,
          lineTotal,
        });
      }
    }

    const [updated] = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, poId))
      .limit(1);

    return updated!;
  });
}

