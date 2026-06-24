import { and, asc, count, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { customAlphabet } from 'nanoid';
import { db } from '../db/client.js';
import {
  batchInventoryBalances,
  batchInventoryMovements,
  bundleItems,
  deviceEvents,
  inventoryBalances,
  inventoryMovements,
  deviceUnits,
  productBatches,
  products,
  productWebsiteProfiles,
  purchaseOrderLines,
  purchaseOrders,
  stockLocations,
  suppliers,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { isMultiStockLocationEnabled } from './shop-features.service.js';
import { getDefaultLocationId, resolveLocationIdOrDefault } from './stock-location.service.js';
import { generateBatchCode } from './batch.service.js';

const barcodeSuffix = customAlphabet('0123456789', 12);

export type ProductRow = typeof products.$inferSelect;

export async function getQuantityOnHandAtLocation(
  shopId: string,
  productId: string,
  locationId: string,
  multiStockLocationEnabled: boolean,
) {
  const locId = await resolveLocationIdOrDefault(shopId, locationId, multiStockLocationEnabled);
  const [p] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);
  if (!p) throw AppError.notFound('Product not found');
  const [b] = await db
    .select({ quantity: inventoryBalances.quantity })
    .from(inventoryBalances)
    .where(
      and(
        eq(inventoryBalances.shopId, shopId),
        eq(inventoryBalances.productId, productId),
        eq(inventoryBalances.locationId, locId),
      ),
    )
    .limit(1);
  return { quantity: String(b?.quantity ?? '0') };
}

/** Per-location on-hand for POS / pickers (quantity balances or serialized counts). */
export async function listProductStockByLocations(shopId: string, productId: string) {
  const [p] = await db
    .select({
      id: products.id,
      trackingMode: products.trackingMode,
    })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);

  if (!p) throw AppError.notFound('Product not found');

  const defaultLocationId = await getDefaultLocationId(shopId);

  if (p.trackingMode === 'QUANTITY') {
    const rows = await db
      .select({
        locationId: inventoryBalances.locationId,
        locationName: stockLocations.name,
        isDefault: stockLocations.isDefault,
        quantity: inventoryBalances.quantity,
      })
      .from(inventoryBalances)
      .innerJoin(stockLocations, eq(stockLocations.id, inventoryBalances.locationId))
      .where(
        and(
          eq(inventoryBalances.shopId, shopId),
          eq(inventoryBalances.productId, productId),
          sql`${inventoryBalances.quantity}::numeric > 0`,
        ),
      )
      .orderBy(asc(stockLocations.name));

    return {
      trackingMode: p.trackingMode as 'QUANTITY',
      defaultLocationId,
      items: rows.map((r) => ({
        locationId: r.locationId,
        locationName: r.locationName,
        isDefault: r.isDefault,
        quantity: String(r.quantity),
      })),
    };
  }

  const rows = await db
    .select({
      locationId: deviceUnits.stockLocationId,
      locationName: stockLocations.name,
      isDefault: stockLocations.isDefault,
      cnt: count(),
    })
    .from(deviceUnits)
    .leftJoin(stockLocations, eq(stockLocations.id, deviceUnits.stockLocationId))
    .where(
      and(
        eq(deviceUnits.shopId, shopId),
        eq(deviceUnits.productId, productId),
        eq(deviceUnits.status, 'IN_STOCK'),
        eq(deviceUnits.blocklisted, false),
      ),
    )
    .groupBy(deviceUnits.stockLocationId, stockLocations.name, stockLocations.isDefault)
    .orderBy(asc(stockLocations.name));

  return {
    trackingMode: p.trackingMode as 'SERIALIZED',
    defaultLocationId,
    items: rows.map((r) => ({
      locationId: r.locationId,
      locationName: r.locationName ?? 'Unassigned',
      isDefault: r.isDefault ?? false,
      quantity: String(r.cnt ?? 0),
    })),
  };
}

export async function listProducts(
  shopId: string,
  q: {
    search?: string;
    categoryId?: string;
    brandId?: string;
    trackingMode?: 'SERIALIZED' | 'QUANTITY';
    active?: boolean;
    /** When true: serialized products (always IMEI-tracked) OR quantity products with inventory_tracked. */
    inventoryTracked?: boolean;
    limit: number;
    offset: number;
    /** When multi-location is on, on-hand figures use this stock location (POS picker). */
    stockLocationId?: string;
    /** Sum quantity across locations / count serialized units shop-wide (e.g. purchase return picker). */
    stockScope?: 'default' | 'all_locations';
    /** Products that appear on any non-cancelled PO for this supplier (purchase return picker). */
    supplierId?: string;
    /** Narrow to products on this PO’s lines (must belong to shop; optional cross-check with supplierId). */
    purchaseOrderId?: string;
  },
) {
  const conditions = [eq(products.shopId, shopId)];

  let productIdFilter: string[] | null = null;

  if (q.purchaseOrderId) {
    const [po] = await db
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, q.purchaseOrderId), eq(purchaseOrders.shopId, shopId)))
      .limit(1);
    if (!po) throw AppError.notFound('Purchase order not found');
    if (po.status !== 'COMPLETED') {
      throw AppError.badRequest(
        'Products can only be filtered by a fully received (completed) purchase order',
      );
    }
    if (q.supplierId && po.supplierId !== q.supplierId) {
      throw AppError.badRequest('This purchase order does not belong to the selected supplier');
    }
    const lineRows = await db
      .select({ productId: purchaseOrderLines.productId })
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.poId, q.purchaseOrderId))
      .groupBy(purchaseOrderLines.productId);
    productIdFilter = lineRows.map((r) => r.productId);
  } else if (q.supplierId) {
    const [sup] = await db
      .select()
      .from(suppliers)
      .where(and(eq(suppliers.id, q.supplierId), eq(suppliers.shopId, shopId)))
      .limit(1);
    if (!sup) throw AppError.notFound('Supplier not found');
    const lineRows = await db
      .select({ productId: purchaseOrderLines.productId })
      .from(purchaseOrderLines)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseOrderLines.poId))
      .where(
        and(
          eq(purchaseOrders.shopId, shopId),
          eq(purchaseOrders.supplierId, q.supplierId),
          eq(purchaseOrders.status, 'COMPLETED'),
        ),
      )
      .groupBy(purchaseOrderLines.productId);
    productIdFilter = lineRows.map((r) => r.productId);
  }

  if (productIdFilter !== null && productIdFilter.length === 0) {
    return [];
  }
  if (productIdFilter !== null) {
    conditions.push(inArray(products.id, productIdFilter));
  }

  if (q.active !== undefined) conditions.push(eq(products.active, q.active));
  if (q.categoryId) conditions.push(eq(products.categoryId, q.categoryId));
  if (q.brandId) conditions.push(eq(products.brandId, q.brandId));
  if (q.trackingMode) conditions.push(eq(products.trackingMode, q.trackingMode));
  if (q.inventoryTracked === true) {
    conditions.push(
      or(eq(products.trackingMode, 'SERIALIZED'), eq(products.inventoryTracked, true))!,
    );
  }

  if (q.search?.trim()) {
    const s = `%${q.search.trim()}%`;
    conditions.push(
      or(ilike(products.name, s), ilike(products.sku, s), ilike(products.barcode, s))!,
    );
  }

  const whereClause = and(...conditions);

  const rows = await db
    .select()
    .from(products)
    .where(whereClause)
    .orderBy(products.name)
    .limit(q.limit)
    .offset(q.offset);

  const defaultLocId = await getDefaultLocationId(shopId);
  const multiLoc = await isMultiStockLocationEnabled(shopId);
  const effectiveLocId = await resolveLocationIdOrDefault(shopId, q.stockLocationId, multiLoc);

  const scopeAll = q.stockScope === 'all_locations';

  const withStock = await Promise.all(
    rows.map(async (p) => {
      let quantityOnHand = '0';
      if (p.trackingMode === 'QUANTITY') {
        if (scopeAll) {
          const [sumRow] = await db
            .select({
              sum: sql<string>`coalesce(sum(${inventoryBalances.quantity}::numeric), 0)::text`,
            })
            .from(inventoryBalances)
            .where(
              and(
                eq(inventoryBalances.shopId, shopId),
                eq(inventoryBalances.productId, p.id),
              ),
            );
          quantityOnHand = sumRow?.sum ?? '0';
        } else {
          const [b] = await db
            .select({ quantity: inventoryBalances.quantity })
            .from(inventoryBalances)
            .where(
              and(
                eq(inventoryBalances.shopId, shopId),
                eq(inventoryBalances.productId, p.id),
                eq(inventoryBalances.locationId, effectiveLocId),
              ),
            )
            .limit(1);
          quantityOnHand = b?.quantity ?? '0';
        }
      } else {
        let duWhere = and(
          eq(deviceUnits.shopId, shopId),
          eq(deviceUnits.productId, p.id),
          eq(deviceUnits.status, 'IN_STOCK'),
          eq(deviceUnits.blocklisted, false),
        );
        if (!scopeAll && multiLoc) {
          const atLocation = eq(deviceUnits.stockLocationId, effectiveLocId);
          if (effectiveLocId === defaultLocId) {
            duWhere = and(duWhere, or(atLocation, isNull(deviceUnits.stockLocationId))!);
          } else {
            duWhere = and(duWhere, atLocation);
          }
        }
        const [c] = await db
          .select({ n: count() })
          .from(deviceUnits)
          .where(duWhere);
        quantityOnHand = String(c?.n ?? 0);
      }

      const min = Number(p.minStockLevel || 0);
      const qNum = Number(quantityOnHand);
      let stockBadge: 'EMPTY' | 'LOW' | 'GOOD' = 'GOOD';
      if (qNum <= 0) stockBadge = 'EMPTY';
      else if (qNum <= min) stockBadge = 'LOW';

      return { ...p, quantityOnHand, stockBadge };
    }),
  );

  return withStock;
}

function generateBarcode(): string {
  return `8${barcodeSuffix()}`;
}

/** Uppercase slug from product name for SKU (A–Z, 0–9, hyphens). */
export function slugifySkuBase(name: string): string {
  const s = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return s || `ITEM-${Date.now()}`;
}

export async function isSkuTaken(
  shopId: string,
  sku: string,
  excludeProductId?: string,
): Promise<boolean> {
  const trimmed = sku.trim();
  if (!trimmed) return false;
  const cond = [
    eq(products.shopId, shopId),
    sql`lower(${products.sku}) = lower(${trimmed})`,
  ];
  if (excludeProductId) cond.push(ne(products.id, excludeProductId));
  const [row] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(...cond))
    .limit(1);
  return !!row;
}

/** Base slug from name; if taken, append timestamp (per shop, case-insensitive SKU). */
export async function suggestUniqueSkuFromName(
  shopId: string,
  name: string,
  excludeProductId?: string,
): Promise<string> {
  const base = slugifySkuBase(name);
  if (!(await isSkuTaken(shopId, base, excludeProductId))) return base;
  const withTs = `${base}-${Date.now()}`.slice(0, 120);
  if (!(await isSkuTaken(shopId, withTs, excludeProductId))) return withTs;
  return `${base}-${Date.now()}-2`.slice(0, 120);
}

export async function createProduct(
  shopId: string,
  input: {
    sku: string;
    name: string;
    barcode?: string | null;
    categoryId?: string | null;
    brandId?: string | null;
    uomId?: string | null;
    trackingMode: 'SERIALIZED' | 'QUANTITY';
    costMethod?: 'MOVING_AVG' | 'FIFO';
    unitCost?: string;
    listPrice?: string;
    minStockLevel?: number;
    isBundle?: boolean;
    active?: boolean;
    metadata?: Record<string, unknown>;
    website?: {
      visible?: boolean;
      slug?: string | null;
      shortDescription?: string | null;
      longDescription?: string | null;
    };
    autoBarcode?: boolean;
    /** Ignored for SERIALIZED (always tracked by device). */
    inventoryTracked?: boolean;
    openingQty?: number;
    openingSerials?: string[];
    openingBatches?: Array<{
      qty: string;
      manufacturedAt?: string | null;
      expiresAt?: string | null;
      supplierLotCode?: string | null;
      batchCode?: string | null;
    }>;
    /** QUANTITY only: enable FEFO batch tracking. */
    batchTrackingEnabled?: boolean;
    /** When batch tracking enabled, require manufactured/expires dates for incoming batches. */
    batchDatesRequired?: boolean;
    createdByUserId?: string | null;
  },
) {
  const openingQty = Math.max(0, Number(input.openingQty ?? 0) || 0);
  const openingSerials = (input.openingSerials ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const openingBatches = input.openingBatches ?? [];

  if (input.trackingMode === 'SERIALIZED') {
    if (openingQty > 0 && openingSerials.length !== openingQty) {
      throw AppError.badRequest(
        `Opening serial count (${openingSerials.length}) must match opening quantity (${openingQty})`,
      );
    }
    const dup = new Set<string>();
    for (const serial of openingSerials) {
      if (dup.has(serial)) {
        throw AppError.badRequest(`Duplicate serial in opening list: ${serial}`);
      }
      dup.add(serial);
    }
  }

  let barcode = input.barcode?.trim() || null;
  if (!barcode && input.autoBarcode !== false) {
    barcode = generateBarcode();
  }

  const inventoryTracked =
    input.trackingMode === 'SERIALIZED' ? true : (input.inventoryTracked ?? true);

  const batchTrackingEnabled =
    input.trackingMode === 'QUANTITY' ? (input.batchTrackingEnabled ?? false) : false;
  const batchDatesRequired =
    batchTrackingEnabled ? (input.batchDatesRequired ?? true) : false;

  if (input.trackingMode === 'QUANTITY') {
    if (openingQty > 0 && batchTrackingEnabled) {
      if (openingBatches.length === 0) {
        throw AppError.badRequest('Opening batches are required when batch tracking is enabled');
      }
      const sum = openingBatches.reduce((s, b) => s + Number(b.qty), 0);
      if (!Number.isFinite(sum) || Math.abs(sum - openingQty) > 1e-6) {
        throw AppError.badRequest('Opening batch quantities must sum to openingQty', {
          openingQty,
          openingBatchQtySum: sum,
        });
      }
      if (batchDatesRequired) {
        for (const b of openingBatches) {
          if (!b.manufacturedAt || !/^\d{4}-\d{2}-\d{2}$/.test(b.manufacturedAt)) {
            throw AppError.badRequest('manufacturedAt is required (YYYY-MM-DD) for opening batches');
          }
          if (!b.expiresAt || !/^\d{4}-\d{2}-\d{2}$/.test(b.expiresAt)) {
            throw AppError.badRequest('expiresAt is required (YYYY-MM-DD) for opening batches');
          }
        }
      }
    }
  }

  const metadata: Record<string, unknown> = input.metadata ?? {};
  if (input.website) {
    const nextWebsite: Record<string, unknown> =
      metadata.website && typeof metadata.website === 'object' && !Array.isArray(metadata.website)
        ? { ...(metadata.website as Record<string, unknown>) }
        : {};
    if (input.website.visible !== undefined) nextWebsite.visible = input.website.visible;
    if (input.website.slug !== undefined) nextWebsite.slug = input.website.slug;
    if (input.website.shortDescription !== undefined)
      nextWebsite.shortDescription = input.website.shortDescription;
    if (input.website.longDescription !== undefined)
      nextWebsite.longDescription = input.website.longDescription;
    metadata.website = nextWebsite;
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(products)
      .values({
        shopId,
        sku: input.sku.trim(),
        name: input.name.trim(),
        barcode,
        categoryId: input.categoryId ?? null,
        brandId: input.brandId ?? null,
        uomId: input.uomId ?? null,
        trackingMode: input.trackingMode,
        costMethod: input.costMethod ?? 'MOVING_AVG',
        unitCost: input.unitCost ?? '0',
        listPrice: input.listPrice ?? '0',
        minStockLevel: String(input.minStockLevel ?? 0),
        inventoryTracked,
        batchTrackingEnabled,
        batchDatesRequired,
        isBundle: input.isBundle ?? false,
        active: input.active ?? true,
        metadata,
      })
      .returning();

    if (!row) throw AppError.conflict('Could not create product');

    if (input.website) {
      await tx
        .insert(productWebsiteProfiles)
        .values({
          shopId,
          productId: row.id,
          visible: input.website.visible ?? false,
          seoSlug: input.website.slug || null,
          shortDescription: input.website.shortDescription || null,
          longDescription: input.website.longDescription || null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
    }

    if (input.trackingMode === 'SERIALIZED' && openingSerials.length > 0) {
      for (const serial of openingSerials) {
        const [du] = await tx
          .insert(deviceUnits)
          .values({
            shopId,
            productId: row.id,
            serial,
            imei1: null,
            imei2: null,
            status: 'IN_STOCK',
            receivedPoLineId: null,
          })
          .returning();

        await tx.insert(deviceEvents).values({
          deviceUnitId: du!.id,
          eventType: 'CREATED_WITH_PRODUCT',
          refTable: 'products',
          refId: row.id,
          payload: {},
          createdBy: input.createdByUserId ?? null,
        });
      }
    }

    if (input.trackingMode === 'QUANTITY' && openingQty > 0 && inventoryTracked !== false) {
      const defaultLocId = await getDefaultLocationId(shopId);

      // Aggregate balance
      await tx
        .insert(inventoryBalances)
        .values({
          shopId,
          productId: row.id,
          locationId: defaultLocId,
          quantity: String(openingQty),
        })
        .onConflictDoUpdate({
          target: [inventoryBalances.shopId, inventoryBalances.productId, inventoryBalances.locationId],
          set: {
            quantity: sql`${inventoryBalances.quantity}::numeric + ${String(openingQty)}::numeric`,
            updatedAt: new Date(),
          },
        });

      await tx.insert(inventoryMovements).values({
        shopId,
        productId: row.id,
        locationId: defaultLocId,
        quantityDelta: String(openingQty),
        movementType: 'ADJUSTMENT',
        refTable: 'products',
        refId: row.id,
        unitCost: row.unitCost,
        createdBy: input.createdByUserId ?? null,
      });

      if (batchTrackingEnabled) {
        for (const b of openingBatches) {
          const bQty = Number(b.qty);
          if (!Number.isFinite(bQty) || bQty <= 0) continue;

          const batchCode = (b.batchCode?.trim() || generateBatchCode()).trim();
          const manufacturedAt =
            b.manufacturedAt && /^\d{4}-\d{2}-\d{2}$/.test(b.manufacturedAt) ? b.manufacturedAt : null;
          const expiresAt =
            b.expiresAt && /^\d{4}-\d{2}-\d{2}$/.test(b.expiresAt) ? b.expiresAt : null;

          const [created] = await tx
            .insert(productBatches)
            .values({
              shopId,
              productId: row.id,
              batchCode,
              supplierLotCode: b.supplierLotCode?.trim() || null,
              manufacturedAt,
              expiresAt,
            })
            .onConflictDoNothing({
              target: [productBatches.shopId, productBatches.productId, productBatches.batchCode],
            })
            .returning();

          const batchRow =
            created ??
            (await tx
              .select()
              .from(productBatches)
              .where(
                and(
                  eq(productBatches.shopId, shopId),
                  eq(productBatches.productId, row.id),
                  eq(productBatches.batchCode, batchCode),
                ),
              )
              .limit(1))[0];
          if (!batchRow) throw AppError.conflict('Could not create or load opening batch');

          await tx
            .insert(batchInventoryBalances)
            .values({
              shopId,
              batchId: batchRow.id,
              locationId: defaultLocId,
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
            productId: row.id,
            locationId: defaultLocId,
            quantityDelta: String(bQty),
            movementType: 'ADJUSTMENT',
            refTable: 'products',
            refId: row.id,
            createdBy: input.createdByUserId ?? null,
          });
        }
      }
    }

    return row;
  });
}

export async function updateProduct(
  shopId: string,
  productId: string,
  patch: Partial<{
    name: string;
    sku: string;
    barcode: string | null;
    categoryId: string | null;
    brandId: string | null;
    uomId: string | null;
    listPrice: string;
    unitCost: string;
    minStockLevel: number;
    active: boolean;
    isBundle: boolean;
    metadata: Record<string, unknown>;
    website: {
      visible?: boolean;
      slug?: string | null;
      shortDescription?: string | null;
      longDescription?: string | null;
    };
    inventoryTracked: boolean;
    batchTrackingEnabled: boolean;
    batchDatesRequired: boolean;
  }>,
) {
  const [existing] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);

  if (!existing) throw AppError.notFound('Product not found');

  if (
    patch.batchTrackingEnabled !== undefined ||
    patch.batchDatesRequired !== undefined
  ) {
    if (existing.trackingMode !== 'QUANTITY') {
      throw AppError.badRequest('Batch tracking applies to QUANTITY products only');
    }
    const enabling = patch.batchTrackingEnabled === true;
    if (enabling && patch.batchDatesRequired === undefined) {
      patch.batchDatesRequired = true;
    }
    if (patch.batchTrackingEnabled === false) {
      patch.batchDatesRequired = false;
    }
  }

  const nextPatch: typeof patch = { ...patch };

  if (patch.website !== undefined) {
    const currentMeta =
      existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata)
        ? { ...(existing.metadata as Record<string, unknown>) }
        : {};
    const currentWebsite =
      currentMeta.website && typeof currentMeta.website === 'object' && !Array.isArray(currentMeta.website)
        ? { ...(currentMeta.website as Record<string, unknown>) }
        : {};

    if (patch.website.visible !== undefined) currentWebsite.visible = patch.website.visible;
    if (patch.website.slug !== undefined) currentWebsite.slug = patch.website.slug;
    if (patch.website.shortDescription !== undefined)
      currentWebsite.shortDescription = patch.website.shortDescription;
    if (patch.website.longDescription !== undefined)
      currentWebsite.longDescription = patch.website.longDescription;

    currentMeta.website = currentWebsite;
    nextPatch.metadata = currentMeta;
    delete (nextPatch as any).website;

    await db
      .insert(productWebsiteProfiles)
      .values({
        shopId,
        productId,
        visible: patch.website.visible ?? false,
        seoSlug: patch.website.slug || null,
        shortDescription: patch.website.shortDescription || null,
        longDescription: patch.website.longDescription || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [productWebsiteProfiles.shopId, productWebsiteProfiles.productId],
        set: {
          ...(patch.website.visible !== undefined ? { visible: patch.website.visible } : {}),
          ...(patch.website.slug !== undefined ? { seoSlug: patch.website.slug || null } : {}),
          ...(patch.website.shortDescription !== undefined ? { shortDescription: patch.website.shortDescription || null } : {}),
          ...(patch.website.longDescription !== undefined ? { longDescription: patch.website.longDescription || null } : {}),
          updatedAt: new Date(),
        },
      });
  }

  const setValues: any = { ...nextPatch };
  if (patch.minStockLevel !== undefined) {
    setValues.minStockLevel = String(patch.minStockLevel);
  }

  const [row] = await db
    .update(products)
    .set({
      ...setValues,
      updatedAt: new Date(),
    })
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .returning();

  return row!;
}

export async function getProductById(shopId: string, productId: string) {
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);
  return row ?? null;
}

export async function getProductByBarcode(shopId: string, barcode: string) {
  const [row] = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.shopId, shopId),
        eq(products.barcode, barcode.trim()),
        eq(products.active, true),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function setBundleItems(
  shopId: string,
  bundleProductId: string,
  items: { componentProductId: string; quantity: string }[],
) {
  const bundle = await getProductById(shopId, bundleProductId);
  if (!bundle) throw AppError.notFound('Bundle product not found');
  if (!bundle.isBundle) {
    throw AppError.badRequest('Product is not marked as bundle (is_bundle)');
  }

  await db.transaction(async (tx) => {
    await tx.delete(bundleItems).where(eq(bundleItems.bundleProductId, bundleProductId));
    if (items.length === 0) return;
    await tx.insert(bundleItems).values(
      items.map((i) => ({
        bundleProductId,
        componentProductId: i.componentProductId,
        quantity: i.quantity,
      })),
    );
  });
}

export async function getBundleItems(bundleProductId: string) {
  return db
    .select()
    .from(bundleItems)
    .where(eq(bundleItems.bundleProductId, bundleProductId));
}
