import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { db, type DbExecutor } from '../db/client.js';
import {
  deviceEvents,
  deviceUnits,
  inventoryBalances,
  inventoryMovements,
  products,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReturnLines,
  purchaseReturns,
  shopPaymentMethods,
  supplierLedgerEntries,
  suppliers,
  productBatches,
  batchInventoryBalances,
  batchInventoryMovements,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { isMultiStockLocationEnabled } from './shop-features.service.js';
import { resolveLocationIdOrDefault } from './stock-location.service.js';
import { money2 } from './supplier-po-settlement.service.js';

function coerceMoneyCost(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return money2(n);
}

function assertReturnUnitCostMatchesCanonical(
  canonicalMoney: string,
  provided: string | null | undefined,
): void {
  const c = Number(canonicalMoney);
  const raw = provided?.trim();
  if (!raw) return;
  const p = Number(raw);
  if (!Number.isFinite(p) || Math.abs(p - c) > 0.009) {
    throw AppError.badRequest(
      `Unit cost must match the purchase receive price for this stock (৳${canonicalMoney})`,
    );
  }
}

async function sumQtyReceivedForSupplierProductTx(
  tx: DbExecutor,
  shopId: string,
  supplierId: string,
  productId: string,
  refPoId: string | null | undefined,
): Promise<number> {
  const conds = [
    eq(purchaseOrders.shopId, shopId),
    eq(purchaseOrders.status, 'COMPLETED'),
    eq(purchaseOrderLines.productId, productId),
    sql`${purchaseOrderLines.qtyReceived}::numeric > 0`,
  ];
  if (refPoId) {
    conds.push(eq(purchaseOrders.id, refPoId));
  } else {
    conds.push(eq(purchaseOrders.supplierId, supplierId));
  }
  const [row] = await tx
    .select({
      sum: sql<string>`coalesce(sum(${purchaseOrderLines.qtyReceived}::numeric), 0)::text`,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
    .where(and(...conds));
  return Number(row?.sum ?? 0);
}

async function sumQtyReturnedForSupplierProductTx(
  tx: DbExecutor,
  shopId: string,
  supplierId: string,
  productId: string,
  refPoId: string | null | undefined,
): Promise<number> {
  const conds = [
    eq(purchaseReturns.shopId, shopId),
    eq(purchaseReturns.supplierId, supplierId),
    eq(purchaseReturnLines.productId, productId),
  ];
  if (refPoId) {
    conds.push(eq(purchaseReturns.refPoId, refPoId));
  }
  const [row] = await tx
    .select({
      sum: sql<string>`coalesce(sum(${purchaseReturnLines.qty}::numeric), 0)::text`,
    })
    .from(purchaseReturnLines)
    .innerJoin(purchaseReturns, eq(purchaseReturns.id, purchaseReturnLines.returnId))
    .where(and(...conds));
  return Number(row?.sum ?? 0);
}

/** Best unit cost for return credit: match how stock came in (receive line / PO receive movement / PO line). */
async function suggestedReturnUnitCostTx(
  tx: DbExecutor,
  shopId: string,
  supplierId: string,
  productId: string,
  refPoId?: string | null,
): Promise<string> {
  const poEligible = refPoId
    ? and(eq(purchaseOrders.shopId, shopId), eq(purchaseOrders.status, 'COMPLETED'), eq(purchaseOrders.id, refPoId))
    : and(
        eq(purchaseOrders.shopId, shopId),
        eq(purchaseOrders.status, 'COMPLETED'),
        eq(purchaseOrders.supplierId, supplierId),
      );

  // 1) In-stock serialized unit linked to a PO line (actual receive cost for current inventory).
  const duConds = and(
    eq(deviceUnits.shopId, shopId),
    eq(deviceUnits.productId, productId),
    eq(deviceUnits.status, 'IN_STOCK'),
    isNotNull(deviceUnits.receivedPoLineId),
    poEligible,
  );
  const [fromDevice] = await tx
    .select({ unitCost: purchaseOrderLines.unitCost })
    .from(deviceUnits)
    .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, deviceUnits.receivedPoLineId))
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
    .where(duConds)
    .orderBy(desc(deviceUnits.receivedAt))
    .limit(1);
  const c0 = coerceMoneyCost(fromDevice?.unitCost);
  if (c0) return c0;

  // 2) Last PO_RECEIVE movement for this supplier/product (quantity stock-ins record line unit cost).
  const [fromMov] = await tx
    .select({ unitCost: inventoryMovements.unitCost })
    .from(inventoryMovements)
    .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, inventoryMovements.refId))
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
    .where(
      and(
        eq(inventoryMovements.shopId, shopId),
        eq(inventoryMovements.productId, productId),
        eq(inventoryMovements.movementType, 'PO_RECEIVE'),
        eq(inventoryMovements.refTable, 'purchase_order_lines'),
        sql`${inventoryMovements.quantityDelta}::numeric > 0`,
        isNotNull(inventoryMovements.unitCost),
        eq(purchaseOrderLines.productId, productId),
        poEligible,
      ),
    )
    .orderBy(desc(inventoryMovements.createdAt))
    .limit(1);
  const c1 = coerceMoneyCost(fromMov?.unitCost);
  if (c1) return c1;

  // 3) PO line with qty received > 0
  const [fromReceived] = await tx
    .select({ unitCost: purchaseOrderLines.unitCost })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
    .where(
      and(
        eq(purchaseOrderLines.productId, productId),
        sql`${purchaseOrderLines.qtyReceived}::numeric > 0`,
        poEligible,
      ),
    )
    .orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrderLines.id))
    .limit(1);
  const c2 = coerceMoneyCost(fromReceived?.unitCost);
  if (c2) return c2;

  // 4) Any PO line with qty ordered (listed PO unit price)
  const [fromOrdered] = await tx
    .select({ unitCost: purchaseOrderLines.unitCost })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
    .where(
      and(
        eq(purchaseOrderLines.productId, productId),
        sql`${purchaseOrderLines.qtyOrdered}::numeric > 0`,
        poEligible,
      ),
    )
    .orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrderLines.id))
    .limit(1);
  const c3 = coerceMoneyCost(fromOrdered?.unitCost);
  if (c3) return c3;

  const [p] = await tx
    .select({ unitCost: products.unitCost })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);
  const c4 = coerceMoneyCost(p?.unitCost);
  return c4 ?? '0.00';
}

export async function suggestedReturnUnitCost(
  shopId: string,
  supplierId: string,
  productId: string,
  refPoId?: string | null,
): Promise<{ unitCost: string }> {
  const unitCost = await suggestedReturnUnitCostTx(db, shopId, supplierId, productId, refPoId);
  return { unitCost };
}

export type CreatePurchaseReturnLine =
  | {
      productId: string;
      tracking: 'QUANTITY';
      locationId?: string | null;
      qty: string;
      unitCost?: string | null;
      poLineId?: string | null;
      batchId?: string | null;
    }
  | {
      productId: string;
      tracking: 'SERIALIZED';
      deviceUnitId: string;
      unitCost?: string | null;
      poLineId?: string | null;
    };

export async function createPurchaseReturn(
  shopId: string,
  userId: string,
  input: {
    supplierId: string;
    refPoId?: string | null;
    returnDate?: string | null;
    note?: string | null;
    paymentMethodId?: string | null;
    refundAmount?: string | null;
    lines: CreatePurchaseReturnLine[];
  },
) {
  if (input.lines.length === 0) throw AppError.badRequest('At least one return line required');

  const [sup] = await db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, input.supplierId), eq(suppliers.shopId, shopId)))
    .limit(1);
  if (!sup) throw AppError.notFound('Supplier not found');

  if (input.refPoId) {
    const [po] = await db
      .select()
      .from(purchaseOrders)
      .where(
        and(
          eq(purchaseOrders.id, input.refPoId),
          eq(purchaseOrders.shopId, shopId),
          eq(purchaseOrders.supplierId, input.supplierId),
        ),
      )
      .limit(1);
    if (!po) throw AppError.badRequest('Linked PO not found for this supplier');
    if (po.status !== 'COMPLETED') {
      throw AppError.badRequest(
        'Only fully received (completed) purchase orders can be linked to a purchase return',
      );
    }
  }

  const multi = await isMultiStockLocationEnabled(shopId);

  return db.transaction(async (tx) => {
    if (!input.paymentMethodId) {
      throw AppError.badRequest('Refund payment method is required');
    }

    const [pm] = await tx
      .select()
      .from(shopPaymentMethods)
      .where(
        and(
          eq(shopPaymentMethods.id, input.paymentMethodId),
          eq(shopPaymentMethods.shopId, shopId),
          eq(shopPaymentMethods.isActive, true),
        ),
      )
      .limit(1);
    if (!pm) throw AppError.badRequest('Payment method not found or inactive');

    const [ret] = await tx
      .insert(purchaseReturns)
      .values({
        shopId,
        supplierId: input.supplierId,
        refPoId: input.refPoId ?? null,
        returnDate: input.returnDate ?? undefined,
        note: input.note ?? null,
        paymentMethodId: input.paymentMethodId,
        refundAmount: input.refundAmount ? money2(Number(input.refundAmount)) : '0.00',
        createdBy: userId,
      })
      .returning();

    if (!ret) throw AppError.conflict('Could not create purchase return');

    const qtyByProduct = new Map<string, number>();
    for (const line of input.lines) {
      if (line.tracking === 'QUANTITY') {
        const q = Number(line.qty);
        if (Number.isFinite(q) && q > 0) {
          qtyByProduct.set(line.productId, (qtyByProduct.get(line.productId) ?? 0) + q);
        }
      } else {
        qtyByProduct.set(line.productId, (qtyByProduct.get(line.productId) ?? 0) + 1);
      }
    }
    for (const [productId, addQty] of qtyByProduct) {
      const received = await sumQtyReceivedForSupplierProductTx(
        tx,
        shopId,
        input.supplierId,
        productId,
        input.refPoId ?? null,
      );
      const returned = await sumQtyReturnedForSupplierProductTx(
        tx,
        shopId,
        input.supplierId,
        productId,
        input.refPoId ?? null,
      );
      const remaining = received - returned;
      if (addQty > remaining + 1e-6) {
        throw AppError.badRequest(
          `Return quantity exceeds purchase stock for this supplier${input.refPoId ? ' on this PO' : ''} (remaining returnable: ${Math.max(0, remaining).toFixed(3)} qty)`,
        );
      }
    }

    let creditTotal = 0;

    for (const line of input.lines) {
      const [p] = await tx
        .select()
        .from(products)
        .where(and(eq(products.id, line.productId), eq(products.shopId, shopId)))
        .limit(1);
      if (!p) throw AppError.notFound(`Product ${line.productId}`);

      if (line.tracking === 'SERIALIZED') {
        if (p.trackingMode !== 'SERIALIZED') {
          throw AppError.badRequest('Product is not serialized');
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
        if (!du) throw AppError.notFound('Device unit not found');
        if (du.status !== 'IN_STOCK') {
          throw AppError.conflict('Device must be in stock to return to supplier');
        }

        if (!du.receivedPoLineId) {
          throw AppError.badRequest(
            'This serial was not received on a purchase order — it cannot be returned to a supplier',
          );
        }

        const [polCtx] = await tx
          .select({
            unitCost: purchaseOrderLines.unitCost,
            poId: purchaseOrderLines.poId,
          })
          .from(purchaseOrderLines)
          .where(eq(purchaseOrderLines.id, du.receivedPoLineId))
          .limit(1);
        if (!polCtx) {
          throw AppError.badRequest('Receive line not found for this serial');
        }

        const [poRow] = await tx
          .select()
          .from(purchaseOrders)
          .where(
            and(
              eq(purchaseOrders.id, polCtx.poId),
              eq(purchaseOrders.shopId, shopId),
              eq(purchaseOrders.status, 'COMPLETED'),
            ),
          )
          .limit(1);
        if (!poRow || poRow.supplierId !== input.supplierId) {
          throw AppError.badRequest('Serial was not received on a completed purchase from this supplier');
        }

        if (line.poLineId) {
          if (du.receivedPoLineId !== line.poLineId) {
            throw AppError.badRequest('Serial does not match selected PO line');
          }
        }

        const canonicalMoney = coerceMoneyCost(polCtx.unitCost);
        if (!canonicalMoney) {
          throw AppError.badRequest('Receive line has no unit cost — cannot confirm return price');
        }
        assertReturnUnitCostMatchesCanonical(canonicalMoney, line.unitCost);
        const unitCost = Number(canonicalMoney);
        const lineTotal = unitCost;
        creditTotal += lineTotal;

        await tx
          .update(deviceUnits)
          .set({ status: 'RETURNED_TO_SUPPLIER', updatedAt: new Date() })
          .where(eq(deviceUnits.id, du.id));

        await tx.insert(deviceEvents).values({
          deviceUnitId: du.id,
          eventType: 'RETURNED_TO_SUPPLIER',
          refTable: 'purchase_returns',
          refId: ret.id,
          payload: { supplierId: input.supplierId },
          createdBy: userId,
        });

        await tx.insert(purchaseReturnLines).values({
          returnId: ret.id,
          productId: p.id,
          poLineId: line.poLineId ?? du.receivedPoLineId ?? null,
          locationId: du.stockLocationId,
          qty: '1',
          unitCost: money2(unitCost),
          deviceUnitId: du.id,
          lineTotal: money2(lineTotal),
        });
      } else {
        if (p.trackingMode !== 'QUANTITY') {
          throw AppError.badRequest('Use serial selection for serialized products');
        }
        const qty = Number(line.qty);
        if (!Number.isFinite(qty) || qty <= 0) throw AppError.badRequest('Invalid qty');

        let canonicalMoneyStr: string | null = null;
        if (line.poLineId) {
          const [polRow] = await tx
            .select({
              unitCost: purchaseOrderLines.unitCost,
              poId: purchaseOrderLines.poId,
            })
            .from(purchaseOrderLines)
            .where(eq(purchaseOrderLines.id, line.poLineId))
            .limit(1);
          if (!polRow) throw AppError.badRequest('PO line not found');
          const [poL] = await tx
            .select()
            .from(purchaseOrders)
            .where(
              and(
                eq(purchaseOrders.id, polRow.poId),
                eq(purchaseOrders.shopId, shopId),
                eq(purchaseOrders.supplierId, input.supplierId),
                eq(purchaseOrders.status, 'COMPLETED'),
              ),
            )
            .limit(1);
          if (!poL) {
            throw AppError.badRequest('PO line is not on a completed purchase from this supplier');
          }
          canonicalMoneyStr = coerceMoneyCost(polRow.unitCost);
        } else {
          canonicalMoneyStr = coerceMoneyCost(
            await suggestedReturnUnitCostTx(tx, shopId, input.supplierId, p.id, input.refPoId),
          );
        }
        if (!canonicalMoneyStr) {
          throw AppError.badRequest('Could not resolve unit cost for this return line');
        }
        assertReturnUnitCostMatchesCanonical(canonicalMoneyStr, line.unitCost);
        const unitCost = Number(canonicalMoneyStr);

        const locationId = await resolveLocationIdOrDefault(
          shopId,
          line.locationId ?? null,
          multi,
        );

        const lineTotal = qty * unitCost;
        creditTotal += lineTotal;

        if (p.inventoryTracked !== false) {
          const [totRow] = await tx
            .select({
              sum: sql<string>`coalesce(sum(${inventoryBalances.quantity}::numeric), 0)::text`,
            })
            .from(inventoryBalances)
            .where(
              and(eq(inventoryBalances.shopId, shopId), eq(inventoryBalances.productId, p.id)),
            );
          const totalOnHand = Number(totRow?.sum ?? 0);
          if (totalOnHand < qty - 1e-9) {
            throw AppError.conflict(
              'Cannot return this quantity — stock is zero across all locations (or less than requested).',
              { productId: p.id, totalOnHand, requested: qty },
            );
          }

          const upd = await tx
            .update(inventoryBalances)
            .set({
              quantity: sql`${inventoryBalances.quantity}::numeric - ${String(qty)}::numeric`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(inventoryBalances.shopId, shopId),
                eq(inventoryBalances.productId, p.id),
                eq(inventoryBalances.locationId, locationId),
                sql`${inventoryBalances.quantity}::numeric >= ${String(qty)}::numeric`,
              ),
            )
            .returning();

          if (upd.length === 0) {
            throw AppError.conflict('Insufficient quantity at the selected stock location');
          }
        }

        if (p.batchTrackingEnabled) {
          if (!line.batchId) {
            throw AppError.badRequest(`Batch selection is required for batch-tracked product: ${p.name}`);
          }
          const [batch] = await tx
            .select()
            .from(productBatches)
            .where(
              and(
                eq(productBatches.id, line.batchId),
                eq(productBatches.shopId, shopId),
                eq(productBatches.productId, p.id),
              ),
            )
            .limit(1);
          if (!batch) {
            throw AppError.notFound(`Selected batch not found for product: ${p.name}`);
          }

          const [batchBal] = await tx
            .select()
            .from(batchInventoryBalances)
            .where(
              and(
                eq(batchInventoryBalances.shopId, shopId),
                eq(batchInventoryBalances.batchId, batch.id),
                eq(batchInventoryBalances.locationId, locationId),
              ),
            )
            .limit(1);

          const batchQty = Number(batchBal?.quantity ?? 0);
          if (batchQty < qty - 1e-9) {
            throw AppError.conflict(
              `Insufficient quantity for batch "${batch.batchCode}" at the selected stock location (Available: ${batchQty}, Requested: ${qty})`
            );
          }

          const updBatch = await tx
            .update(batchInventoryBalances)
            .set({
              quantity: sql`${batchInventoryBalances.quantity}::numeric - ${String(qty)}::numeric`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(batchInventoryBalances.shopId, shopId),
                eq(batchInventoryBalances.batchId, batch.id),
                eq(batchInventoryBalances.locationId, locationId),
                sql`${batchInventoryBalances.quantity}::numeric >= ${String(qty)}::numeric`,
              ),
            )
            .returning();

          if (updBatch.length === 0) {
            throw AppError.conflict(`Insufficient quantity for batch "${batch.batchCode}" at the selected stock location`);
          }

          await tx.insert(batchInventoryMovements).values({
            shopId,
            batchId: batch.id,
            productId: p.id,
            locationId,
            quantityDelta: (-qty).toFixed(3),
            movementType: 'PURCHASE_RETURN',
            refTable: 'purchase_returns',
            refId: ret.id,
            createdBy: userId,
          });
        }

        await tx.insert(inventoryMovements).values({
          shopId,
          productId: p.id,
          locationId,
          quantityDelta: (-qty).toFixed(3),
          movementType: 'PURCHASE_RETURN',
          refTable: 'purchase_returns',
          refId: ret.id,
          unitCost: money2(unitCost),
          createdBy: userId,
        });

        await tx.insert(purchaseReturnLines).values({
          returnId: ret.id,
          productId: p.id,
          poLineId: line.poLineId ?? null,
          locationId,
          batchId: line.batchId ?? null,
          qty: String(qty),
          unitCost: money2(unitCost),
          deviceUnitId: null,
          lineTotal: money2(lineTotal),
        });
      }
    }

    if (creditTotal <= 0) throw AppError.badRequest('Return total must be positive');

    const creditStr = money2(creditTotal);
    const neg = (-creditTotal).toFixed(2);

    await tx.insert(supplierLedgerEntries).values({
      supplierId: input.supplierId,
      entryType: 'PURCHASE_RETURN',
      amount: neg,
      refTable: input.refPoId ? 'purchase_orders' : 'purchase_returns',
      refId: input.refPoId ?? ret.id,
      note: input.refPoId ? 'Purchase return (linked PO)' : 'Purchase return',
    });

    if (input.paymentMethodId) {
      const refundAmt = Number(input.refundAmount);
      if (!Number.isFinite(refundAmt) || refundAmt <= 0) {
        throw AppError.badRequest('Refund amount must be positive');
      }
      if (refundAmt > creditTotal + 0.009) {
        throw AppError.badRequest('Refund amount cannot exceed return credit total');
      }
      await tx.insert(supplierLedgerEntries).values({
        supplierId: input.supplierId,
        entryType: 'PAYMENT',
        amount: money2(refundAmt),
        refTable: 'purchase_returns',
        refId: ret.id,
        note: `Supplier refund for purchase return ${ret.id.slice(0, 8)}…`,
      });
    }

    return { id: ret.id, creditAmount: creditStr };
  });
}

export async function listPurchaseReturns(shopId: string, limit: number) {
  const lim = Math.min(Math.max(limit, 1), 200);
  const rows = await db
    .select()
    .from(purchaseReturns)
    .where(eq(purchaseReturns.shopId, shopId))
    .orderBy(desc(purchaseReturns.createdAt))
    .limit(lim);

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const lines = await db
    .select({
      returnId: purchaseReturnLines.returnId,
      productName: products.name,
      productSku: products.sku,
      qty: purchaseReturnLines.qty,
      unitCost: purchaseReturnLines.unitCost,
      lineTotal: purchaseReturnLines.lineTotal,
      serial: deviceUnits.serial,
      batchCode: productBatches.batchCode,
    })
    .from(purchaseReturnLines)
    .innerJoin(products, eq(products.id, purchaseReturnLines.productId))
    .leftJoin(deviceUnits, eq(deviceUnits.id, purchaseReturnLines.deviceUnitId))
    .leftJoin(productBatches, eq(productBatches.id, purchaseReturnLines.batchId))
    .where(inArray(purchaseReturnLines.returnId, ids));

  const byRet: Record<string, typeof lines> = {};
  for (const l of lines) {
    (byRet[l.returnId] ??= []).push(l);
  }

  return rows.map((r) => ({ ...r, lines: byRet[r.id] ?? [] }));
}
