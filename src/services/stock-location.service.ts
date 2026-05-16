import { and, asc, count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { stockLocations } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

export async function getDefaultLocationId(shopId: string): Promise<string> {
  const [row] = await db
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.shopId, shopId),
        eq(stockLocations.isDefault, true),
      ),
    )
    .limit(1);

  if (!row) {
    throw AppError.conflict(
      'No default stock location for this shop. Create one in stock_locations.',
    );
  }
  return row.id;
}

/**
 * Use requested location if it belongs to the shop; otherwise fall back to default.
 * When `multiStockLocationEnabled` is false, always uses the shop default (requested id ignored).
 */
export async function resolveLocationIdOrDefault(
  shopId: string,
  requestedId: string | null | undefined,
  multiStockLocationEnabled: boolean,
): Promise<string> {
  if (!multiStockLocationEnabled) {
    return getDefaultLocationId(shopId);
  }
  const rid = requestedId?.trim();
  if (!rid) {
    return getDefaultLocationId(shopId);
  }
  const [row] = await db
    .select({ id: stockLocations.id })
    .from(stockLocations)
    .where(and(eq(stockLocations.id, rid), eq(stockLocations.shopId, shopId)))
    .limit(1);
  if (!row) {
    throw AppError.badRequest('Unknown stock location for this shop');
  }
  return row.id;
}

export async function listLocations(shopId: string) {
  return db
    .select()
    .from(stockLocations)
    .where(eq(stockLocations.shopId, shopId))
    .orderBy(asc(stockLocations.name));
}

export async function createLocation(
  shopId: string,
  input: { name: string; setAsDefault?: boolean },
) {
  const name = input.name.trim();
  if (!name) throw AppError.badRequest('Location name is required');

  const [{ n }] = await db
    .select({ n: count() })
    .from(stockLocations)
    .where(eq(stockLocations.shopId, shopId));
  const isFirst = Number(n) === 0;
  const makeDefault = input.setAsDefault === true || isFirst;

  try {
    return await db.transaction(async (tx) => {
      if (makeDefault) {
        await tx
          .update(stockLocations)
          .set({ isDefault: false })
          .where(eq(stockLocations.shopId, shopId));
      }
      const [row] = await tx
        .insert(stockLocations)
        .values({
          shopId,
          name,
          isDefault: makeDefault,
        })
        .returning();
      if (!row) throw AppError.conflict('Could not create location');
      return row;
    });
  } catch (e: unknown) {
    const code = e && typeof e === 'object' && 'code' in e ? (e as { code?: string }).code : undefined;
    if (code === '23505') {
      throw AppError.conflict('A location with this name already exists');
    }
    throw e;
  }
}

export async function updateLocation(
  shopId: string,
  locationId: string,
  input: { name?: string; setAsDefault?: boolean },
) {
  const [existing] = await db
    .select()
    .from(stockLocations)
    .where(and(eq(stockLocations.id, locationId), eq(stockLocations.shopId, shopId)))
    .limit(1);

  if (!existing) throw AppError.notFound('Stock location not found');

  const hasName = input.name !== undefined;
  const hasDefault = input.setAsDefault === true;
  if (!hasName && !hasDefault) {
    return existing;
  }

  if (hasName) {
    const name = input.name!.trim();
    if (!name) throw AppError.badRequest('Location name is required');
  }

  try {
    return await db.transaction(async (tx) => {
      if (hasDefault) {
        await tx
          .update(stockLocations)
          .set({ isDefault: false })
          .where(eq(stockLocations.shopId, shopId));
      }

      const setRow: { name?: string; isDefault?: boolean } = {};
      if (hasName) setRow.name = input.name!.trim();
      if (hasDefault) setRow.isDefault = true;

      const [row] = await tx
        .update(stockLocations)
        .set(setRow)
        .where(and(eq(stockLocations.id, locationId), eq(stockLocations.shopId, shopId)))
        .returning();

      if (!row) throw AppError.notFound('Stock location not found');
      return row;
    });
  } catch (e: unknown) {
    const code = e && typeof e === 'object' && 'code' in e ? (e as { code?: string }).code : undefined;
    if (code === '23505') {
      throw AppError.conflict('A location with this name already exists');
    }
    throw e;
  }
}
