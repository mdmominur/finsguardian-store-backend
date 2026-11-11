/**
 * Packet scan profiles — enrolment ("fingerprint" capture) and lookup.
 *
 * Design contract (see docs/sql/047_product_scan_profiles.sql):
 *   • Enrolment happens once, while the merchant creates/updates a product: the packet barcode is
 *     captured (camera or typed) and stored, so POS can resolve the same packet later.
 *   • POS lookup is a pure indexed search over `product_scan_profiles.barcode`. Nothing is
 *     recognised on the server and no printed text is read.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { products, productScanProfiles } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { getProductById } from './product.service.js';

export type ScanProfileSource = 'PACKET_SCAN' | 'MANUAL' | 'IMPORT';

export type ScanProfileInput = {
  /** Packet barcode as printed (EAN-13 / UPC / CODE-128 / QR payload). */
  barcode?: string | null;
  imagePhash?: string | null;
  thumbUrl?: string | null;
  source?: ScanProfileSource;
};

/** Mirrors `product_scan_profiles` (Drizzle select type). */
export type ScanProfileRow = typeof productScanProfiles.$inferSelect;

/**
 * Create or refresh the current scan profile for a product.
 *
 * A packaging change creates a NEW row (the old one flips to `is_current = false`) so historical
 * packets still resolve. Re-capturing the same barcode updates the row in place instead of piling
 * up duplicates.
 */
export async function upsertScanProfile(
  shopId: string,
  productId: string,
  userId: string | null,
  input: ScanProfileInput,
): Promise<ScanProfileRow> {
  const product = await getProductById(shopId, productId);
  if (!product) throw AppError.notFound('Product not found');

  const barcode = (input.barcode ?? '').trim() || null;

  if (barcode) {
    const [clash] = await db
      .select({ id: productScanProfiles.id, productId: productScanProfiles.productId })
      .from(productScanProfiles)
      .where(and(eq(productScanProfiles.shopId, shopId), eq(productScanProfiles.barcode, barcode)))
      .limit(1);
    if (clash && clash.productId !== productId) {
      throw AppError.conflict(
        `Barcode ${barcode} is already enrolled for another product in this shop.`,
        { barcode },
      );
    }

    // A code printed on another product's own row is the same conflict: POS reads
    // `products.barcode` first, so enrolling it here would scan as the other product.
    const [productClash] = await db
      .select({ name: products.name, sku: products.sku })
      .from(products)
      .where(
        and(
          eq(products.shopId, shopId),
          eq(products.barcode, barcode),
          ne(products.id, productId),
        ),
      )
      .limit(1);
    if (productClash) {
      throw AppError.conflict(
        `Barcode ${barcode} is already assigned to ${productClash.name} (${productClash.sku})`,
        { barcode },
      );
    }
  }

  const [existing] = await db
    .select()
    .from(productScanProfiles)
    .where(
      and(
        eq(productScanProfiles.shopId, shopId),
        eq(productScanProfiles.productId, productId),
        eq(productScanProfiles.isCurrent, true),
      ),
    )
    .limit(1);

  const patch = {
    barcode,
    imagePhash: input.imagePhash?.trim() || null,
    thumbUrl: input.thumbUrl?.trim() || null,
    updatedAt: new Date(),
  };

  // Same packet re-captured: refresh the current row (keeps profile ids stable).
  if (existing && existing.barcode === barcode) {
    const [row] = await db
      .update(productScanProfiles)
      .set(patch)
      .where(eq(productScanProfiles.id, existing.id))
      .returning();
    return row!;
  }

  return db.transaction(async (tx) => {
    if (existing) {
      await tx
        .update(productScanProfiles)
        .set({ isCurrent: false, updatedAt: new Date() })
        .where(eq(productScanProfiles.id, existing.id));
    }
    const [row] = await tx
      .insert(productScanProfiles)
      .values({
        shopId,
        productId,
        ...patch,
        source: input.source ?? 'PACKET_SCAN',
        isCurrent: true,
        createdBy: userId,
      })
      .returning();
    return row!;
  });
}

/** Newest capture plus the full history (packaging revisions) for one product. */
export async function listScanProfiles(shopId: string, productId: string) {
  const items = await db
    .select()
    .from(productScanProfiles)
    .where(
      and(eq(productScanProfiles.shopId, shopId), eq(productScanProfiles.productId, productId)),
    )
    .orderBy(sql`${productScanProfiles.createdAt} DESC`);

  return { current: items.find((r) => r.isCurrent) ?? null, items };
}



/** Enrolled barcode → product mapping (lets POS confirm a camera-decoded code in one query). */
export async function findProductIdsByBarcode(shopId: string, barcodes: string[]) {
  const cleaned = [...new Set(barcodes.map((b) => b.trim()).filter(Boolean))];
  if (cleaned.length === 0) return [];
  return db
    .select({ productId: productScanProfiles.productId, barcode: productScanProfiles.barcode })
    .from(productScanProfiles)
    .where(
      and(
        eq(productScanProfiles.shopId, shopId),
        eq(productScanProfiles.isCurrent, true),
        inArray(productScanProfiles.barcode, cleaned),
      ),
    );
}
