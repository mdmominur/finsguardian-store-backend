import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { brands, categories } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';

function collectSelfAndDescendantIds(
  rows: Array<{ id: string; parentId: string | null }>,
  rootId: string,
): string[] {
  const ids: string[] = [];
  function walk(cid: string) {
    ids.push(cid);
    for (const r of rows) {
      if (r.parentId === cid) walk(r.id);
    }
  }
  walk(rootId);
  return ids;
}

export async function listCategories(shopId: string) {
  return db
    .select()
    .from(categories)
    .where(eq(categories.shopId, shopId))
    .orderBy(asc(categories.sortOrder), asc(categories.name));
}

export async function createCategory(
  shopId: string,
  input: { name: string; parentId?: string | null; sortOrder?: number },
) {
  let isActive = true;
  if (input.parentId) {
    const [parent] = await db
      .select()
      .from(categories)
      .where(and(eq(categories.id, input.parentId), eq(categories.shopId, shopId)));
    if (!parent) throw AppError.badRequest('Parent category not found');
    if (!parent.isActive) isActive = false;
  }

  const [row] = await db
    .insert(categories)
    .values({
      shopId,
      name: input.name.trim(),
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder ?? 0,
      isActive,
    })
    .returning();

  if (!row) throw AppError.conflict('Could not create category');
  return row;
}

export async function listBrands(shopId: string) {
  return db
    .select()
    .from(brands)
    .where(eq(brands.shopId, shopId))
    .orderBy(asc(brands.name));
}

export async function createBrand(shopId: string, input: { name: string }) {
  const [row] = await db
    .insert(brands)
    .values({
      shopId,
      name: input.name.trim(),
      isActive: true,
    })
    .returning();

  if (!row) throw AppError.conflict('Could not create brand');
  return row;
}

export async function updateCategory(
  shopId: string,
  id: string,
  patch: {
    name?: string;
    parentId?: string | null;
    sortOrder?: number;
    isActive?: boolean;
  },
) {
  const [existing] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.id, id), eq(categories.shopId, shopId)));
  if (!existing) throw AppError.notFound('Category not found');

  if (patch.isActive === false) {
    const allForTree = await db
      .select({ id: categories.id, parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.shopId, shopId));
    const subtreeIds = collectSelfAndDescendantIds(allForTree, id);

    await db
      .update(categories)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(categories.shopId, shopId), inArray(categories.id, subtreeIds)));

    const meta: { name?: string; parentId?: string | null; sortOrder?: number } = {};
    if (patch.name !== undefined) meta.name = patch.name;
    if (patch.parentId !== undefined) meta.parentId = patch.parentId;
    if (patch.sortOrder !== undefined) meta.sortOrder = patch.sortOrder;
    if (Object.keys(meta).length > 0) {
      await db
        .update(categories)
        .set({ ...meta, updatedAt: new Date() })
        .where(and(eq(categories.id, id), eq(categories.shopId, shopId)));
    }

    const [row] = await db
      .select()
      .from(categories)
      .where(and(eq(categories.id, id), eq(categories.shopId, shopId)));
    if (!row) throw AppError.notFound('Category not found');
    return row;
  }

  const setObj: Partial<typeof categories.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) setObj.name = patch.name;
  if (patch.parentId !== undefined) setObj.parentId = patch.parentId;
  if (patch.sortOrder !== undefined) setObj.sortOrder = patch.sortOrder;
  if (patch.isActive === true) setObj.isActive = true;

  const [row] = await db
    .update(categories)
    .set(setObj)
    .where(and(eq(categories.id, id), eq(categories.shopId, shopId)))
    .returning();

  if (!row) throw AppError.notFound('Category not found');
  return row;
}

export async function updateBrand(
  shopId: string,
  id: string,
  patch: { name?: string; isActive?: boolean },
) {
  const setObj: Partial<typeof brands.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) setObj.name = patch.name;
  if (patch.isActive !== undefined) setObj.isActive = patch.isActive;

  const [row] = await db
    .update(brands)
    .set(setObj)
    .where(and(eq(brands.id, id), eq(brands.shopId, shopId)))
    .returning();

  if (!row) throw AppError.notFound('Brand not found');
  return row;
}
