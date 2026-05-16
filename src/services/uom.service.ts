import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { uoms } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

export async function listUoms(shopId: string) {
  return db
    .select()
    .from(uoms)
    .where(eq(uoms.shopId, shopId))
    .orderBy(asc(uoms.name));
}

export async function createUom(
  shopId: string,
  input: { name: string; symbol?: string | null },
) {
  const name = input.name.trim();
  if (!name) throw AppError.badRequest('UOM name is required');
  const symbol = input.symbol?.trim() || null;

  const [row] = await db
    .insert(uoms)
    .values({ shopId, name, symbol, isActive: true })
    .returning();
  if (!row) throw AppError.conflict('Failed to create UOM');
  return row;
}

export async function updateUom(
  shopId: string,
  uomId: string,
  patch: { name?: string; symbol?: string | null; isActive?: boolean },
) {
  const next: { name?: string; symbol?: string | null; isActive?: boolean; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n) throw AppError.badRequest('UOM name cannot be empty');
    next.name = n;
  }
  if (patch.symbol !== undefined) {
    next.symbol = patch.symbol?.trim() || null;
  }
  if (patch.isActive !== undefined) {
    next.isActive = patch.isActive;
  }

  const [row] = await db
    .update(uoms)
    .set(next)
    .where(and(eq(uoms.id, uomId), eq(uoms.shopId, shopId)))
    .returning();
  if (!row) throw AppError.notFound('UOM not found');
  return row;
}

