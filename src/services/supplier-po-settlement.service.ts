import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  products,
  purchaseOrderLines,
  purchaseOrders,
  supplierLedgerEntries,
  supplierPaymentPoAllocations,
} from '../db/schema/index.js';

export type PoSettlement = {
  owedGross: string;
  paidAllocated: string;
  due: string;
};

export function money2(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export async function settlementByPoIdsTx(tx: typeof db, poIds: string[]): Promise<Map<string, PoSettlement>> {
  const map = new Map<string, PoSettlement>();
  for (const id of poIds) {
    map.set(id, { owedGross: '0.00', paidAllocated: '0.00', due: '0.00' });
  }
  if (poIds.length === 0) return map;

  const owedRows = await tx
    .select({
      poId: supplierLedgerEntries.refId,
      owed: sql<string>`coalesce(sum(${supplierLedgerEntries.amount}::numeric), 0)::text`,
    })
    .from(supplierLedgerEntries)
    .where(
      and(
        eq(supplierLedgerEntries.refTable, 'purchase_orders'),
        inArray(supplierLedgerEntries.refId, poIds),
        inArray(supplierLedgerEntries.entryType, ['PURCHASE', 'PURCHASE_RETURN']),
      ),
    )
    .groupBy(supplierLedgerEntries.refId);

  const paidRows = await tx
    .select({
      poId: supplierPaymentPoAllocations.poId,
      paid: sql<string>`coalesce(sum(${supplierPaymentPoAllocations.amount}::numeric), 0)::text`,
    })
    .from(supplierPaymentPoAllocations)
    .where(inArray(supplierPaymentPoAllocations.poId, poIds))
    .groupBy(supplierPaymentPoAllocations.poId);

  for (const r of owedRows) {
    if (!r.poId) continue;
    const cur = map.get(r.poId)!;
    cur.owedGross = money2(Number(r.owed));
    map.set(r.poId, cur);
  }
  for (const r of paidRows) {
    const cur = map.get(r.poId)!;
    cur.paidAllocated = money2(Number(r.paid));
    map.set(r.poId, cur);
  }
  for (const id of poIds) {
    const cur = map.get(id)!;
    const due = Number(cur.owedGross) - Number(cur.paidAllocated);
    cur.due = money2(Math.max(0, due));
    map.set(id, cur);
  }
  return map;
}

export async function settlementByPoIds(poIds: string[]): Promise<Map<string, PoSettlement>> {
  return settlementByPoIdsTx(db, poIds);
}

export async function listUnpaidPurchaseOrdersForSupplier(shopId: string, supplierId: string) {
  const pos = await db
    .select()
    .from(purchaseOrders)
    .where(
      and(
        eq(purchaseOrders.shopId, shopId),
        eq(purchaseOrders.supplierId, supplierId),
        eq(purchaseOrders.status, 'COMPLETED'),
      ),
    )
    .orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrders.createdAt));

  const ids = pos.map((p) => p.id);
  const settlement = await settlementByPoIds(ids);

  return pos
    .map((po) => {
      const s = settlement.get(po.id)!;
      return {
        ...po,
        settlement: s,
      };
    })
    .filter((row) => Number(row.settlement.due) > 0.004);
}

export async function listSupplierPurchaseLines(shopId: string, supplierId: string, limit: number) {
  const lim = Math.min(Math.max(limit, 1), 500);
  const rows = await db
    .select({
      poId: purchaseOrders.id,
      poStatus: purchaseOrders.status,
      orderDate: purchaseOrders.orderDate,
      lineId: purchaseOrderLines.id,
      productId: purchaseOrderLines.productId,
      productName: products.name,
      productSku: products.sku,
      qtyOrdered: purchaseOrderLines.qtyOrdered,
      qtyReceived: purchaseOrderLines.qtyReceived,
      unitCost: purchaseOrderLines.unitCost,
      lineTotal: purchaseOrderLines.lineTotal,
    })
    .from(purchaseOrderLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
    .innerJoin(products, eq(products.id, purchaseOrderLines.productId))
    .where(
      and(
        eq(purchaseOrders.shopId, shopId),
        eq(purchaseOrders.supplierId, supplierId),
        eq(purchaseOrders.status, 'COMPLETED'),
        sql`${purchaseOrderLines.qtyReceived}::numeric > 0`,
      ),
    )
    .orderBy(desc(purchaseOrders.orderDate), desc(purchaseOrders.createdAt))
    .limit(lim);

  return rows;
}
