import { and, count, desc, eq, ilike, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { deviceEvents, deviceUnits, products, purchaseOrderLines } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import {
  expectedImeiCheckDigit,
  isValidImeiFormat,
  normalizeImei,
} from '../lib/imei.js';

import { saleLines, sales, stockLocations } from '../db/schema/index.js';
import { getDefaultLocationId } from './stock-location.service.js';

export async function searchImei(shopId: string, rawQuery: string) {
  const raw = rawQuery.trim();
  if (raw.length < 2) return [];

  const normalized = normalizeImei(raw);
  const pat = `%${raw}%`;
  const patNorm = `%${normalized}%`;

  return db
    .select({
      unit: deviceUnits,
      productName: products.name,
      productSku: products.sku,
      saleId: sales.id,
      invoiceNo: sales.invoiceNo,
      soldAt: sales.soldAt,
      stockLocationName: stockLocations.name,
    })
    .from(deviceUnits)
    .innerJoin(products, eq(products.id, deviceUnits.productId))
    .leftJoin(stockLocations, eq(stockLocations.id, deviceUnits.stockLocationId))
    .leftJoin(saleLines, eq(saleLines.id, deviceUnits.soldSaleLineId))
    .leftJoin(sales, eq(sales.id, saleLines.saleId))
    .where(
      and(
        eq(deviceUnits.shopId, shopId),
        or(
          ilike(deviceUnits.imei1, patNorm),
          ilike(deviceUnits.imei2, patNorm),
          ilike(deviceUnits.imei1, pat),
          ilike(deviceUnits.imei2, pat),
          ilike(deviceUnits.serial, pat),
          ilike(deviceUnits.uniqueIdentifier, pat),
        )!,
      ),
    )
    .limit(50);
}

export async function listDeviceUnits(
  shopId: string,
  q: {
    search?: string;
    status?: string;
    blocklisted?: boolean;
    stockLocationId?: string;
    limit: number;
    offset: number;
  },
) {
  const search = q.search?.trim();
  const pat = search ? `%${search}%` : null;

  const where = and(
    eq(deviceUnits.shopId, shopId),
    q.status ? eq(deviceUnits.status, q.status) : undefined,
    q.blocklisted !== undefined ? eq(deviceUnits.blocklisted, q.blocklisted) : undefined,
    q.stockLocationId ? eq(deviceUnits.stockLocationId, q.stockLocationId) : undefined,
    pat
      ? or(
          ilike(deviceUnits.serial, pat),
          ilike(deviceUnits.imei1, pat),
          ilike(deviceUnits.imei2, pat),
          ilike(deviceUnits.uniqueIdentifier, pat),
          ilike(products.name, pat),
          ilike(products.sku, pat),
        )
      : undefined,
  );

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        unit: deviceUnits,
        productName: products.name,
        productSku: products.sku,
        stockLocationName: stockLocations.name,
      })
      .from(deviceUnits)
      .innerJoin(products, eq(products.id, deviceUnits.productId))
      .leftJoin(stockLocations, eq(stockLocations.id, deviceUnits.stockLocationId))
      .where(where)
      .orderBy(desc(deviceUnits.updatedAt))
      .limit(q.limit)
      .offset(q.offset),
    db
      .select({ total: count() })
      .from(deviceUnits)
      .innerJoin(products, eq(products.id, deviceUnits.productId))
      .leftJoin(stockLocations, eq(stockLocations.id, deviceUnits.stockLocationId))
      .where(where),
  ]);

  return { items: rows, total: Number(totalRows[0]?.total ?? 0) };
}

export async function getDeviceUnitStats(shopId: string) {
  const rows = await db
    .select({
      status: deviceUnits.status,
      blocklisted: deviceUnits.blocklisted,
      cnt: count(),
    })
    .from(deviceUnits)
    .where(eq(deviceUnits.shopId, shopId))
    .groupBy(deviceUnits.status, deviceUnits.blocklisted);

  const stats = { total: 0, inStock: 0, sold: 0, rma: 0, scrapped: 0, blocklisted: 0 };
  for (const r of rows) {
    const n = Number(r.cnt);
    stats.total += n;
    if (r.blocklisted) stats.blocklisted += n;
    if (r.status === 'IN_STOCK') stats.inStock += n;
    if (r.status === 'SOLD') stats.sold += n;
    if (r.status === 'RMA') stats.rma += n;
    if (r.status === 'SCRAPPED') stats.scrapped += n;
  }
  return stats;
}

export async function getDeviceUnit(shopId: string, unitId: string) {
  const [row] = await db
    .select()
    .from(deviceUnits)
    .where(and(eq(deviceUnits.id, unitId), eq(deviceUnits.shopId, shopId)))
    .limit(1);
  return row ?? null;
}

export async function getTimeline(unitId: string) {
  return db
    .select()
    .from(deviceEvents)
    .where(eq(deviceEvents.deviceUnitId, unitId))
    .orderBy(deviceEvents.createdAt);
}

export async function updateDeviceUnit(
  shopId: string,
  unitId: string,
  userId: string | null,
  patch: {
    blocklisted?: boolean;
    blocklistReason?: string | null;
    channelTag?: 'OFFICIAL' | 'UNOFFICIAL' | null;
    notes?: string | null;
    imei1?: string | null;
    imei2?: string | null;
    uniqueIdentifier?: string | null;
  },
) {
  const existing = await getDeviceUnit(shopId, unitId);
  if (!existing) throw AppError.notFound('Device unit not found');

  const nextPatch = {
    ...patch,
    imei1: patch.imei1 === undefined ? undefined : patch.imei1?.trim() || null,
    imei2: patch.imei2 === undefined ? undefined : patch.imei2?.trim() || null,
    uniqueIdentifier:
      patch.uniqueIdentifier === undefined
        ? undefined
        : patch.uniqueIdentifier?.trim() || null,
    notes: patch.notes === undefined ? undefined : patch.notes?.trim() || null,
  };

  const [row] = await db
    .update(deviceUnits)
    .set({
      ...nextPatch,
      updatedAt: new Date(),
    })
    .where(and(eq(deviceUnits.id, unitId), eq(deviceUnits.shopId, shopId)))
    .returning();

  if (patch.blocklisted !== undefined) {
    await db.insert(deviceEvents).values({
      deviceUnitId: unitId,
      eventType: patch.blocklisted ? 'BLOCKLIST_ON' : 'BLOCKLIST_OFF',
      payload: { reason: patch.blocklistReason ?? null },
      createdBy: userId,
    });
  }

  return row!;
}

export function assertImeiValid(imei: string) {
  const n = normalizeImei(imei);
  if (n.length !== 15) {
    throw AppError.badRequest('IMEI must be 15 digits', { imei: n });
  }
  if (!isValidImeiFormat(n)) {
    const expected = expectedImeiCheckDigit(n.slice(0, 14));
    const hint =
      expected !== null
        ? ` The 15th digit must be ${expected} (Luhn checksum for the first 14 digits).`
        : '';
    throw AppError.badRequest(`IMEI check digit invalid.${hint}`, {
      imei: n,
      expectedCheckDigit: expected,
    });
  }
  return n;
}

export async function listProductSerials(
  shopId: string,
  productId: string,
  q: {
    search?: string;
    status?: string;
    stockLocationId?: string;
    limit: number;
    offset: number;
  },
) {
  const [p] = await db
    .select({ id: products.id, trackingMode: products.trackingMode })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);

  if (!p) throw AppError.notFound('Product not found');
  if (p.trackingMode !== 'SERIALIZED') {
    throw AppError.badRequest('Serials are only available for per-device products');
  }

  const search = q.search?.trim();
  return db
    .select({
      id: deviceUnits.id,
      shopId: deviceUnits.shopId,
      productId: deviceUnits.productId,
      serial: deviceUnits.serial,
      imei1: deviceUnits.imei1,
      imei2: deviceUnits.imei2,
      status: deviceUnits.status,
      blocklisted: deviceUnits.blocklisted,
      blocklistReason: deviceUnits.blocklistReason,
      channelTag: deviceUnits.channelTag,
      receivedAt: deviceUnits.receivedAt,
      receivedPoLineId: deviceUnits.receivedPoLineId,
      soldSaleLineId: deviceUnits.soldSaleLineId,
      stockLocationId: deviceUnits.stockLocationId,
      uniqueIdentifier: deviceUnits.uniqueIdentifier,
      notes: deviceUnits.notes,
      createdAt: deviceUnits.createdAt,
      updatedAt: deviceUnits.updatedAt,
      stockLocationName: stockLocations.name,
      receivedUnitCost: purchaseOrderLines.unitCost,
    })
    .from(deviceUnits)
    .leftJoin(stockLocations, eq(stockLocations.id, deviceUnits.stockLocationId))
    .leftJoin(purchaseOrderLines, eq(purchaseOrderLines.id, deviceUnits.receivedPoLineId))
    .where(
      and(
        eq(deviceUnits.shopId, shopId),
        eq(deviceUnits.productId, productId),
        q.status ? eq(deviceUnits.status, q.status) : undefined,
        q.stockLocationId ? eq(deviceUnits.stockLocationId, q.stockLocationId) : undefined,
        search
          ? or(
              ilike(deviceUnits.serial, `%${search}%`),
              ilike(deviceUnits.imei1, `%${search}%`),
              ilike(deviceUnits.imei2, `%${search}%`),
              ilike(deviceUnits.uniqueIdentifier, `%${search}%`),
              ilike(deviceUnits.notes, `%${search}%`),
            )
          : undefined,
      ),
    )
    .orderBy(desc(deviceUnits.createdAt))
    .limit(q.limit)
    .offset(q.offset);
}

export async function addProductSerials(
  shopId: string,
  userId: string,
  productId: string,
  items: {
    serial: string;
    imei1?: string | null;
    imei2?: string | null;
    uniqueIdentifier?: string | null;
    note?: string | null;
  }[],
) {
  if (items.length === 0) throw AppError.badRequest('No serial items provided');

  const [p] = await db
    .select({ id: products.id, trackingMode: products.trackingMode })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);

  if (!p) throw AppError.notFound('Product not found');
  if (p.trackingMode !== 'SERIALIZED') {
    throw AppError.badRequest('Serials are only available for per-device products');
  }

  const defaultLocId = await getDefaultLocationId(shopId);

  return db.transaction(async (tx) => {
    const created: Array<typeof deviceUnits.$inferSelect> = [];
    for (const item of items) {
      const serial = item.serial.trim();
      const imei1 = item.imei1?.trim() ? item.imei1.trim() : null;
      const imei2 = item.imei2?.trim() ? item.imei2.trim() : null;
      const uniqueIdentifier = item.uniqueIdentifier?.trim()
        ? item.uniqueIdentifier.trim()
        : null;
      const note = item.note?.trim() ? item.note.trim() : null;

      if (!serial) throw AppError.badRequest('Serial cannot be empty');
      if (imei2 && imei1 && imei2 === imei1) {
        throw AppError.badRequest('imei2 must be different from imei1');
      }

      const [du] = await tx
        .insert(deviceUnits)
        .values({
          shopId,
          productId,
          serial,
          imei1,
          imei2,
          uniqueIdentifier,
          notes: note,
          status: 'IN_STOCK',
          receivedPoLineId: null,
          stockLocationId: defaultLocId,
        })
        .returning();
      created.push(du!);

      await tx.insert(deviceEvents).values({
        deviceUnitId: du!.id,
        eventType: 'ADJUSTED_IN',
        refTable: 'device_units',
        refId: du!.id,
        payload: { source: 'SERIAL_MANAGE' },
        createdBy: userId,
      });
    }
    return created;
  });
}

export async function autoGenerateProductSerials(
  shopId: string,
  userId: string,
  productId: string,
  input: {
    prefix?: string;
    suffix?: string;
    start: number;
    count: number;
    pad: number;
  },
) {
  const count = Math.max(1, Math.floor(input.count));
  const start = Math.max(0, Math.floor(input.start));
  const pad = Math.max(1, Math.floor(input.pad));
  const prefix = input.prefix ?? '';
  const suffix = input.suffix ?? '';

  const items = Array.from({ length: count }, (_, idx) => ({
    serial: `${prefix}${String(start + idx).padStart(pad, '0')}${suffix}`,
    imei1: null,
    imei2: null,
    uniqueIdentifier: null,
    note: null,
  }));

  return addProductSerials(shopId, userId, productId, items);
}
