import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  deviceEvents,
  deviceUnits,
  inventoryBalances,
  inventoryMovements,
  products,
  stockLocations,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { isMultiStockLocationEnabled } from './shop-features.service.js';
import { resolveLocationIdOrDefault } from './stock-location.service.js';

export async function assertLocationInShop(shopId: string, locationId: string) {
  const [loc] = await db
    .select()
    .from(stockLocations)
    .where(and(eq(stockLocations.id, locationId), eq(stockLocations.shopId, shopId)))
    .limit(1);
  if (!loc) throw AppError.notFound('Stock location not found');
  return loc;
}

/** Quantity rows + in-stock serialized units at this stock location. */
export async function getStockLocationInventory(shopId: string, locationId: string) {
  await assertLocationInShop(shopId, locationId);

  const qtyRows = await db
    .select({
      productId: inventoryBalances.productId,
      quantity: inventoryBalances.quantity,
      name: products.name,
      sku: products.sku,
      trackingMode: products.trackingMode,
      batchTrackingEnabled: products.batchTrackingEnabled,
    })
    .from(inventoryBalances)
    .innerJoin(products, eq(products.id, inventoryBalances.productId))
    .where(
      and(
        eq(inventoryBalances.shopId, shopId),
        eq(inventoryBalances.locationId, locationId),
        sql`${inventoryBalances.quantity}::numeric > 0`,
      ),
    )
    .orderBy(asc(products.name));

  const serialRows = await db
    .select({
      id: deviceUnits.id,
      serial: deviceUnits.serial,
      imei1: deviceUnits.imei1,
      imei2: deviceUnits.imei2,
      productId: deviceUnits.productId,
      productName: products.name,
      productSku: products.sku,
      status: deviceUnits.status,
      updatedAt: deviceUnits.updatedAt,
    })
    .from(deviceUnits)
    .innerJoin(products, eq(products.id, deviceUnits.productId))
    .where(
      and(
        eq(deviceUnits.shopId, shopId),
        eq(deviceUnits.stockLocationId, locationId),
        eq(deviceUnits.status, 'IN_STOCK'),
        eq(deviceUnits.blocklisted, false),
      ),
    )
    .orderBy(asc(products.name), asc(deviceUnits.serial));

  return { quantityItems: qtyRows, serializedItems: serialRows };
}

export async function transferSerializedDevices(
  shopId: string,
  userId: string,
  transfers: { deviceUnitId: string; toLocationId: string }[],
) {
  if (transfers.length === 0) return { updated: 0 };

  const multi = await isMultiStockLocationEnabled(shopId);
  if (!multi) {
    throw AppError.badRequest(
      'Multiple stock locations are off — serialized units stay on the default location. Enable multiple locations in Shop settings to transfer between sites.',
    );
  }

  return db.transaction(async (tx) => {
    let n = 0;
    for (const t of transfers) {
      const toId = await resolveLocationIdOrDefault(shopId, t.toLocationId, true);

      const [du] = await tx
        .select()
        .from(deviceUnits)
        .where(and(eq(deviceUnits.id, t.deviceUnitId), eq(deviceUnits.shopId, shopId)))
        .limit(1);

      if (!du) throw AppError.notFound('Device unit not found');
      if (du.status !== 'IN_STOCK') {
        throw AppError.conflict('Only in-stock devices can be moved between locations', {
          serial: du.serial,
          status: du.status,
        });
      }

      const fromId = du.stockLocationId;
      if (fromId === toId) continue;

      await tx
        .update(deviceUnits)
        .set({ stockLocationId: toId, updatedAt: new Date() })
        .where(eq(deviceUnits.id, du.id));

      await tx.insert(deviceEvents).values({
        deviceUnitId: du.id,
        eventType: 'LOCATION_TRANSFER',
        refTable: 'stock_locations',
        refId: toId,
        payload: { fromLocationId: fromId, toLocationId: toId },
        createdBy: userId,
      });
      n += 1;
    }
    return { updated: n };
  });
}

export async function transferSerializedDevicesBulkSameDestination(
  shopId: string,
  userId: string,
  deviceUnitIds: string[],
  toLocationId: string,
) {
  const uniq = [...new Set(deviceUnitIds)];
  return transferSerializedDevices(
    shopId,
    userId,
    uniq.map((deviceUnitId) => ({ deviceUnitId, toLocationId })),
  );
}

/** Move quantity stock between locations (non-serialized products only). */
export async function transferQuantityBetweenLocations(
  shopId: string,
  userId: string,
  args: {
    fromLocationId: string;
    toLocationId: string;
    productId: string;
    /** When `transferAll` is true or qty is empty, moves full on-hand at source. */
    qty?: string | null;
    transferAll?: boolean;
  },
) {
  const multi = await isMultiStockLocationEnabled(shopId);
  if (!multi) {
    throw AppError.badRequest(
      'Enable multiple stock locations in Shop settings to transfer quantity stock between sites.',
    );
  }

  await assertLocationInShop(shopId, args.fromLocationId);
  await assertLocationInShop(shopId, args.toLocationId);

  if (args.fromLocationId === args.toLocationId) {
    throw AppError.badRequest('Source and destination location must be different');
  }

  const [p] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, args.productId), eq(products.shopId, shopId)))
    .limit(1);

  if (!p) throw AppError.notFound('Product not found');
  if (p.trackingMode === 'SERIALIZED') {
    throw AppError.badRequest(
      'Serialized products must be moved as individual devices — use the serialized transfer list.',
    );
  }

  return db.transaction(async (tx) => {
    const [bal] = await tx
      .select({ quantity: inventoryBalances.quantity })
      .from(inventoryBalances)
      .where(
        and(
          eq(inventoryBalances.shopId, shopId),
          eq(inventoryBalances.productId, args.productId),
          eq(inventoryBalances.locationId, args.fromLocationId),
        ),
      )
      .limit(1);

    const onHand = Number(bal?.quantity ?? 0);
    const wantAll = args.transferAll === true;
    const qRaw = args.qty?.trim();
    let move: number;
    if (wantAll || !qRaw) {
      move = onHand;
    } else {
      move = Number(qRaw);
      if (!Number.isFinite(move) || move <= 0) {
        throw AppError.badRequest('Enter a positive quantity, or leave empty / use “all” to move full on-hand.');
      }
      if (move > onHand) {
        throw AppError.conflict(`Only ${onHand} on hand at source location`, { onHand });
      }
    }

    if (move <= 0) {
      return { moved: '0' };
    }

    const dec = await tx
      .update(inventoryBalances)
      .set({
        quantity: sql`${inventoryBalances.quantity}::numeric - ${String(move)}::numeric`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventoryBalances.shopId, shopId),
          eq(inventoryBalances.productId, args.productId),
          eq(inventoryBalances.locationId, args.fromLocationId),
          sql`${inventoryBalances.quantity}::numeric >= ${String(move)}::numeric`,
        ),
      )
      .returning();

    if (dec.length === 0) {
      throw AppError.conflict('Insufficient quantity at source location', {
        onHand,
        requested: move,
      });
    }

    await tx
      .insert(inventoryBalances)
      .values({
        shopId,
        productId: args.productId,
        locationId: args.toLocationId,
        quantity: String(move),
      })
      .onConflictDoUpdate({
        target: [
          inventoryBalances.shopId,
          inventoryBalances.productId,
          inventoryBalances.locationId,
        ],
        set: {
          quantity: sql`${inventoryBalances.quantity}::numeric + ${String(move)}::numeric`,
          updatedAt: new Date(),
        },
      });

    await tx.insert(inventoryMovements).values({
      shopId,
      productId: args.productId,
      locationId: args.fromLocationId,
      quantityDelta: (-move).toFixed(3),
      movementType: 'LOCATION_TRANSFER',
      refTable: 'stock_locations',
      refId: args.toLocationId,
      createdBy: userId,
    });

    await tx.insert(inventoryMovements).values({
      shopId,
      productId: args.productId,
      locationId: args.toLocationId,
      quantityDelta: move.toFixed(3),
      movementType: 'LOCATION_TRANSFER',
      refTable: 'stock_locations',
      refId: args.fromLocationId,
      createdBy: userId,
    });

    return { moved: move.toFixed(3) };
  });
}
