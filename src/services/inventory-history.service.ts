import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  deviceEvents,
  deviceUnits,
  inventoryMovements,
  products,
  refunds,
  saleLines,
  sales,
  stockAdjustments,
  stockLocations,
  users,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

export type StockHistoryEntry = {
  source: 'movement' | 'device';
  id: string;
  occurredAt: string;
  /** Signed change for display, e.g. "+2", "-1"; null for events that do not change on-hand count */
  quantityDelta: string | null;
  kind: string;
  summary: string;
  locationName: string | null;
  serial: string | null;
  refTable: string | null;
  refId: string | null;
  actorName: string | null;
  /** Sale UUID when this row ties to an invoice */
  saleId: string | null;
  /** Human invoice number when known */
  invoiceNo: string | null;
};

function formatDelta(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (n > 0) return `+${n}`;
  return String(n);
}

function movementSummary(
  movementType: string,
  _refTable: string | null,
  adjustmentReason: string | null,
): string {
  switch (movementType) {
    case 'SALE':
      return 'Sale — stock out';
    case 'PO_RECEIVE':
      return 'Purchase order — stock received';
    case 'LOCATION_TRANSFER':
      return 'Stock location transfer';
    case 'ADJUSTMENT':
      return adjustmentReason?.trim()
        ? `Stock adjustment — ${adjustmentReason.trim()}`
        : 'Stock adjustment';
    case 'RMA_RETURN':
      return 'Refund / return — restocked';
    case 'PURCHASE_RETURN':
      return 'Purchase return — stock out to supplier';
    default:
      return movementType;
  }
}

function devicePayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

function deviceEventSummary(eventType: string, payload: unknown, serial: string | null): string {
  const pl = devicePayload(payload);
  const reason = typeof pl.reason === 'string' ? pl.reason : null;
  const unit = serial ? ` · ${serial}` : '';
  switch (eventType) {
    case 'RECEIVED':
      return `Purchase receive${unit}`;
    case 'SOLD':
      return `Sale${unit}`;
    case 'ADJUSTED_IN':
      if (pl.source === 'SERIAL_MANAGE') return `Serial added (inventory)${unit}`;
      return reason ? `Stock in — ${reason}${unit}` : `Stock in${unit}`;
    case 'ADJUSTED_OUT':
      return reason ? `Stock out — ${reason}${unit}` : `Removed or scrapped${unit}`;
    case 'CREATED_WITH_PRODUCT':
      return `Opening stock (new product)${unit}`;
    case 'BLOCKLIST_ON':
      return `Blocklist on${unit}`;
    case 'BLOCKLIST_OFF':
      return `Blocklist off${unit}`;
    case 'LOCATION_TRANSFER':
      return `Stock location transfer${unit}`;
    case 'RETURNED_TO_SUPPLIER':
      return `Returned to supplier${unit}`;
    default:
      return `${eventType}${unit}`;
  }
}

function deviceEventDelta(eventType: string): string | null {
  switch (eventType) {
    case 'RECEIVED':
    case 'ADJUSTED_IN':
    case 'CREATED_WITH_PRODUCT':
      return '+1';
    case 'SOLD':
    case 'ADJUSTED_OUT':
    case 'RETURNED_TO_SUPPLIER':
      return '-1';
    default:
      return null;
  }
}

function uniq(ids: string[]): string[] {
  return [...new Set(ids)];
}

export type ListProductStockHistoryOpts = {
  limit?: number;
  offset?: number;
};

export async function listProductStockHistory(
  shopId: string,
  productId: string,
  opts: ListProductStockHistoryOpts,
): Promise<{
  productName: string;
  trackingMode: string;
  items: StockHistoryEntry[];
  hasMore: boolean;
}> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
  const offset = Math.max(0, opts.offset ?? 0);

  const [p] = await db
    .select({
      id: products.id,
      trackingMode: products.trackingMode,
      name: products.name,
    })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);

  if (!p) throw AppError.notFound('Product not found');

  /** Rows to read from each stream so merged timeline can cover offset+limit. */
  const perSource = Math.min(500, offset + limit);

  const movRows = await db
    .select({
      id: inventoryMovements.id,
      quantityDelta: inventoryMovements.quantityDelta,
      movementType: inventoryMovements.movementType,
      refTable: inventoryMovements.refTable,
      refId: inventoryMovements.refId,
      createdAt: inventoryMovements.createdAt,
      locationName: stockLocations.name,
      actorName: users.name,
    })
    .from(inventoryMovements)
    .innerJoin(stockLocations, eq(stockLocations.id, inventoryMovements.locationId))
    .leftJoin(users, eq(users.id, inventoryMovements.createdBy))
    .where(and(eq(inventoryMovements.shopId, shopId), eq(inventoryMovements.productId, productId)))
    .orderBy(desc(inventoryMovements.createdAt))
    .limit(perSource);

  type DevRow = {
    id: number;
    eventType: string;
    refTable: string | null;
    refId: string | null;
    payload: unknown;
    createdAt: Date;
    serial: string | null;
    actorName: string | null;
    /** Current stock location of the device (best available label for unit-level events). */
    stockLocationName: string | null;
  };

  let devRows: DevRow[] = [];
  if (p.trackingMode === 'SERIALIZED') {
    devRows = await db
      .select({
        id: deviceEvents.id,
        eventType: deviceEvents.eventType,
        refTable: deviceEvents.refTable,
        refId: deviceEvents.refId,
        payload: deviceEvents.payload,
        createdAt: deviceEvents.createdAt,
        serial: deviceUnits.serial,
        actorName: users.name,
        stockLocationName: stockLocations.name,
      })
      .from(deviceEvents)
      .innerJoin(deviceUnits, eq(deviceUnits.id, deviceEvents.deviceUnitId))
      .leftJoin(stockLocations, eq(stockLocations.id, deviceUnits.stockLocationId))
      .leftJoin(users, eq(users.id, deviceEvents.createdBy))
      .where(and(eq(deviceUnits.shopId, shopId), eq(deviceUnits.productId, productId)))
      .orderBy(desc(deviceEvents.createdAt))
      .limit(perSource);
  }

  const adjIds = movRows
    .filter((m) => m.refTable === 'stock_adjustments' && m.refId)
    .map((m) => m.refId as string);
  const reasonByAdjId = new Map<string, string>();
  if (adjIds.length > 0) {
    const u = uniq(adjIds);
    const adjs = await db
      .select({ id: stockAdjustments.id, reason: stockAdjustments.reason })
      .from(stockAdjustments)
      .where(inArray(stockAdjustments.id, u));
    for (const a of adjs) {
      reasonByAdjId.set(a.id, a.reason);
    }
  }

  const saleIds = new Set<string>();
  const refundIds: string[] = [];
  for (const m of movRows) {
    if (m.refTable === 'sales' && m.refId) saleIds.add(m.refId);
    if (m.refTable === 'refunds' && m.refId) refundIds.push(m.refId);
  }
  const saleLineIds: string[] = [];
  for (const r of devRows) {
    if (r.refTable === 'sale_lines' && r.refId) saleLineIds.push(r.refId);
    const pl = devicePayload(r.payload);
    if (typeof pl.saleId === 'string') saleIds.add(pl.saleId);
  }

  const refundSaleById = new Map<string, string>();
  if (refundIds.length > 0) {
    const u = uniq(refundIds);
    const rws = await db
      .select({ id: refunds.id, saleId: refunds.saleId })
      .from(refunds)
      .where(inArray(refunds.id, u));
    for (const rw of rws) {
      refundSaleById.set(rw.id, rw.saleId);
      saleIds.add(rw.saleId);
    }
  }

  const saleByLineId = new Map<string, string>();
  if (saleLineIds.length > 0) {
    const u = uniq(saleLineIds);
    const lns = await db
      .select({ id: saleLines.id, saleId: saleLines.saleId })
      .from(saleLines)
      .where(inArray(saleLines.id, u));
    for (const ln of lns) {
      saleByLineId.set(ln.id, ln.saleId);
      saleIds.add(ln.saleId);
    }
  }

  const invoiceBySaleId = new Map<string, string>();
  if (saleIds.size > 0) {
    const idArr = [...saleIds];
    const srows = await db
      .select({ id: sales.id, invoiceNo: sales.invoiceNo })
      .from(sales)
      .where(and(eq(sales.shopId, shopId), inArray(sales.id, idArr)));
    for (const s of srows) {
      invoiceBySaleId.set(s.id, s.invoiceNo);
    }
  }

  function invoiceForMovement(m: (typeof movRows)[number]): {
    saleId: string | null;
    invoiceNo: string | null;
  } {
    if (m.refTable === 'sales' && m.refId) {
      return { saleId: m.refId, invoiceNo: invoiceBySaleId.get(m.refId) ?? null };
    }
    if (m.refTable === 'refunds' && m.refId) {
      const sid = refundSaleById.get(m.refId);
      if (!sid) return { saleId: null, invoiceNo: null };
      return { saleId: sid, invoiceNo: invoiceBySaleId.get(sid) ?? null };
    }
    return { saleId: null, invoiceNo: null };
  }

  function invoiceForDevice(r: DevRow): { saleId: string | null; invoiceNo: string | null } {
    const pl = devicePayload(r.payload);
    if (typeof pl.saleId === 'string') {
      return { saleId: pl.saleId, invoiceNo: invoiceBySaleId.get(pl.saleId) ?? null };
    }
    if (r.refTable === 'sale_lines' && r.refId) {
      const sid = saleByLineId.get(r.refId);
      if (!sid) return { saleId: null, invoiceNo: null };
      return { saleId: sid, invoiceNo: invoiceBySaleId.get(sid) ?? null };
    }
    return { saleId: null, invoiceNo: null };
  }

  const movementEntries: StockHistoryEntry[] = movRows.map((m) => {
    const adjReason =
      m.refTable === 'stock_adjustments' && m.refId ? reasonByAdjId.get(m.refId) ?? null : null;
    const inv = invoiceForMovement(m);
    return {
      source: 'movement' as const,
      id: `mov-${m.id}`,
      occurredAt: m.createdAt.toISOString(),
      quantityDelta: formatDelta(String(m.quantityDelta)),
      kind: m.movementType,
      summary: movementSummary(m.movementType, m.refTable, adjReason),
      locationName: m.locationName,
      serial: null,
      refTable: m.refTable,
      refId: m.refId,
      actorName: m.actorName,
      saleId: inv.saleId,
      invoiceNo: inv.invoiceNo,
    };
  });

  const deviceEntries: StockHistoryEntry[] = devRows.map((r) => {
    const inv = invoiceForDevice(r);
    return {
      source: 'device' as const,
      id: `dev-${r.id}`,
      occurredAt: r.createdAt.toISOString(),
      quantityDelta: deviceEventDelta(r.eventType),
      kind: r.eventType,
      summary: deviceEventSummary(r.eventType, r.payload, r.serial),
      locationName: r.stockLocationName,
      serial: r.serial,
      refTable: r.refTable,
      refId: r.refId,
      actorName: r.actorName,
      saleId: inv.saleId,
      invoiceNo: inv.invoiceNo,
    };
  });

  const merged = [...movementEntries, ...deviceEntries].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );

  const items = merged.slice(offset, offset + limit);
  const hasMore =
    merged.length > offset + limit ||
    movRows.length >= perSource ||
    (p.trackingMode === 'SERIALIZED' && devRows.length >= perSource);

  return {
    productName: p.name,
    trackingMode: p.trackingMode,
    items,
    hasMore,
  };
}
