import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  deviceEvents,
  deviceUnits,
  inventoryMovements,
  products,
  purchaseOrderLines,
  purchaseOrders,
  stockLocations,
  suppliers,
} from '../db/schema/index.js';

export type PurchaseReceiveRow = {
  source: 'quantity_receive' | 'serial_receive';
  id: string;
  receivedAt: string;
  quantity: string;
  unitCost: string;
  lineTotal: string;
  poId: string;
  poOrderDate: string;
  supplierId: string;
  supplierName: string;
  poLineId: string;
  locationName: string | null;
};

export type PurchaseInsights = {
  productId: string;
  costMethod: string;
  bookUnitCost: string;
  /** True when more receive rows exist than returned in `receives`. */
  truncated: boolean;
  /** Total receive events (same as summary.eventCount). */
  totalReceiveRows: number;
  summary: {
    eventCount: number;
    totalQtyIn: string;
    weightedAvgUnitCost: string | null;
    minUnitCost: string | null;
    maxUnitCost: string | null;
    lastReceiveAt: string | null;
    lastUnitCost: string | null;
    lastPoId: string | null;
    lastSupplierName: string | null;
  };
  receives: PurchaseReceiveRow[];
};

function ymd(d: unknown): string {
  if (d == null) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

export async function getProductPurchaseInsights(
  shopId: string,
  productId: string,
): Promise<PurchaseInsights | null> {
  const [prod] = await db
    .select({
      id: products.id,
      costMethod: products.costMethod,
      unitCost: products.unitCost,
    })
    .from(products)
    .where(and(eq(products.shopId, shopId), eq(products.id, productId)))
    .limit(1);

  if (!prod) return null;

  const bulkRows = await db
    .select({
      id: inventoryMovements.id,
      createdAt: inventoryMovements.createdAt,
      qty: inventoryMovements.quantityDelta,
      unitCost: inventoryMovements.unitCost,
      poLineId: purchaseOrderLines.id,
      poId: purchaseOrders.id,
      orderDate: purchaseOrders.orderDate,
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      locName: stockLocations.name,
    })
    .from(inventoryMovements)
    .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, inventoryMovements.refId))
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .leftJoin(stockLocations, eq(stockLocations.id, inventoryMovements.locationId))
    .where(
      and(
        eq(inventoryMovements.shopId, shopId),
        eq(inventoryMovements.productId, productId),
        eq(inventoryMovements.movementType, 'PO_RECEIVE'),
        eq(inventoryMovements.refTable, 'purchase_order_lines'),
        sql`${inventoryMovements.quantityDelta}::numeric > 0`,
      ),
    )
    .orderBy(desc(inventoryMovements.createdAt));

  const serialRows = await db
    .select({
      id: deviceEvents.id,
      createdAt: deviceEvents.createdAt,
      unitCost: purchaseOrderLines.unitCost,
      poLineId: purchaseOrderLines.id,
      poId: purchaseOrders.id,
      orderDate: purchaseOrders.orderDate,
      supplierId: suppliers.id,
      supplierName: suppliers.name,
    })
    .from(deviceEvents)
    .innerJoin(deviceUnits, eq(deviceUnits.id, deviceEvents.deviceUnitId))
    .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, deviceEvents.refId))
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
    .innerJoin(suppliers, eq(suppliers.id, purchaseOrders.supplierId))
    .where(
      and(
        eq(deviceUnits.shopId, shopId),
        eq(deviceUnits.productId, productId),
        eq(deviceEvents.eventType, 'RECEIVED'),
        eq(deviceEvents.refTable, 'purchase_order_lines'),
      ),
    )
    .orderBy(desc(deviceEvents.createdAt));

  const forAgg: { ts: Date; qty: number; unitCost: number }[] = [];
  const receives: PurchaseReceiveRow[] = [];

  for (const r of bulkRows) {
    const qty = num(r.qty);
    const uc = num(r.unitCost);
    if (qty <= 0) continue;
    forAgg.push({ ts: r.createdAt, qty, unitCost: uc });
    receives.push({
      source: 'quantity_receive',
      id: String(r.id),
      receivedAt: r.createdAt.toISOString(),
      quantity: String(qty),
      unitCost: fmtMoney(uc),
      lineTotal: fmtMoney(qty * uc),
      poId: r.poId,
      poOrderDate: ymd(r.orderDate),
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      poLineId: r.poLineId,
      locationName: r.locName ?? null,
    });
  }

  for (const r of serialRows) {
    const uc = num(r.unitCost);
    forAgg.push({ ts: r.createdAt, qty: 1, unitCost: uc });
    receives.push({
      source: 'serial_receive',
      id: String(r.id),
      receivedAt: r.createdAt.toISOString(),
      quantity: '1',
      unitCost: fmtMoney(uc),
      lineTotal: fmtMoney(uc),
      poId: r.poId,
      poOrderDate: ymd(r.orderDate),
      supplierId: r.supplierId,
      supplierName: r.supplierName,
      poLineId: r.poLineId,
      locationName: null,
    });
  }

  receives.sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));

  let totalQty = 0;
  let weightedSum = 0;
  let minUc: number | null = null;
  let maxUc: number | null = null;

  for (const row of forAgg) {
    totalQty += row.qty;
    weightedSum += row.qty * row.unitCost;
    minUc = minUc === null ? row.unitCost : Math.min(minUc, row.unitCost);
    maxUc = maxUc === null ? row.unitCost : Math.max(maxUc, row.unitCost);
  }

  const lastReceiveRow = receives[0] ?? null;

  const weightedAvg =
    totalQty > 1e-9 ? fmtMoney(weightedSum / totalQty) : forAgg.length ? fmtMoney(weightedSum) : null;

  const MAX = 250;
  const truncated = receives.length > MAX;
  const receivesOut = receives.slice(0, MAX);

  return {
    productId,
    costMethod: prod.costMethod ?? 'MOVING_AVG',
    bookUnitCost: String(prod.unitCost ?? '0'),
    totalReceiveRows: receives.length,
    summary: {
      eventCount: forAgg.length,
      totalQtyIn: totalQty.toFixed(3),
      weightedAvgUnitCost: weightedAvg,
      minUnitCost: minUc === null ? null : fmtMoney(minUc),
      maxUnitCost: maxUc === null ? null : fmtMoney(maxUc),
      lastReceiveAt: lastReceiveRow?.receivedAt ?? null,
      lastUnitCost: lastReceiveRow?.unitCost ?? null,
      lastPoId: lastReceiveRow?.poId ?? null,
      lastSupplierName: lastReceiveRow?.supplierName ?? null,
    },
    truncated,
    receives: receivesOut,
  };
}
