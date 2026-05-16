import { and, asc, eq, ilike, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  productWebsiteImages,
  productWebsiteProfiles,
  products,
  shops,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { deleteShopWebsiteAssetFile } from './shop-website-assets.service.js';

function normalizeShopAssetUrl(url: string | null | undefined, shopSlug: string): string | null {
  if (!url) return null;
  const s = String(url).trim();
  if (!s) return null;
  const path = (() => {
    if (s.startsWith('/')) return s;
    try {
      return new URL(s).pathname;
    } catch {
      return s;
    }
  })();
  const m = /^\/api\/v1\/public\/shops\/([^/]+)\/assets\/(.+)$/.exec(path);
  if (!m) return s;
  const key = m[2]!;
  return `/api/v1/public/shops/${encodeURIComponent(shopSlug)}/assets/${key}`;
}

function normalizeSeoSlug(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = raw.trim().toLowerCase();
  if (!t) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t)) {
    throw AppError.badRequest(
      'SEO slug must use lowercase letters, numbers, and single hyphens only (e.g. galaxy-s24-case).',
    );
  }
  if (t.length > 120) throw AppError.badRequest('SEO slug is too long (max 120 characters).');
  return t;
}

async function assertSeoSlugAvailable(shopId: string, productId: string, slug: string | null) {
  if (!slug) return;
  const [hit] = await db
    .select({ productId: productWebsiteProfiles.productId })
    .from(productWebsiteProfiles)
    .where(
      and(
        eq(productWebsiteProfiles.shopId, shopId),
        sql`lower(btrim(${productWebsiteProfiles.seoSlug})) = ${slug}`,
        ne(productWebsiteProfiles.productId, productId),
      ),
    )
    .limit(1);
  if (hit) {
    throw AppError.conflict('Another product in this shop already uses this SEO slug.');
  }
}

export async function listWebsiteProducts(
  shopId: string,
  q: { search?: string; limit: number; offset: number },
) {
  const [shop] = await db
    .select({ slug: shops.slug })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  const slug = shop?.slug ?? '';

  const conditions = [eq(products.shopId, shopId)];
  if (q.search?.trim()) {
    const s = `%${q.search.trim()}%`;
    conditions.push(orIlikeProduct(s));
  }

  const whereClause = and(...conditions);

  const rows = await db
    .select({
      productId: products.id,
      sku: products.sku,
      name: products.name,
      listPrice: products.listPrice,
      profileVisible: productWebsiteProfiles.visible,
      webTitle: productWebsiteProfiles.webTitle,
      seoSlug: productWebsiteProfiles.seoSlug,
      sortOrder: productWebsiteProfiles.sortOrder,
      featured: productWebsiteProfiles.featured,
      shortDescription: productWebsiteProfiles.shortDescription,
      longDescription: productWebsiteProfiles.longDescription,
      metaTitle: productWebsiteProfiles.metaTitle,
      metaDescription: productWebsiteProfiles.metaDescription,
      ogImageUrl: productWebsiteProfiles.ogImageUrl,
      coverImageUrl: sql<string | null>`(
        select i.url
        from ${productWebsiteImages} i
        where i.shop_id = ${products.shopId}
          and i.product_id = ${products.id}
          and i.kind = 'COVER'
          and i.is_active = true
        order by i.sort_order asc, i.created_at desc
        limit 1
      )`,
      galleryCount: sql<number>`(
        select count(*)::int
        from ${productWebsiteImages} gi
        where gi.shop_id = ${products.shopId}
          and gi.product_id = ${products.id}
          and gi.kind = 'GALLERY'
          and gi.is_active = true
      )`,
    })
    .from(products)
    .leftJoin(
      productWebsiteProfiles,
      and(
        eq(productWebsiteProfiles.shopId, products.shopId),
        eq(productWebsiteProfiles.productId, products.id),
      ),
    )
    .where(whereClause)
    .orderBy(asc(sql`coalesce(${productWebsiteProfiles.sortOrder}, 0)`), asc(products.name))
    .limit(q.limit)
    .offset(q.offset);

  return rows.map((r) => ({
    productId: r.productId,
    sku: r.sku,
    name: r.name,
    listPrice: r.listPrice,
    visible: r.profileVisible === true,
    webTitle: r.webTitle ?? null,
    seoSlug: r.seoSlug?.trim() || null,
    sortOrder: Number(r.sortOrder ?? 0) || 0,
    featured: r.featured === true,
    shortDescription: r.shortDescription ?? null,
    longDescription: r.longDescription ?? null,
    metaTitle: r.metaTitle ?? null,
    metaDescription: r.metaDescription ?? null,
    ogImageUrl: r.ogImageUrl ?? null,
    coverImageUrl: normalizeShopAssetUrl(r.coverImageUrl ?? null, slug),
    galleryCount: Number(r.galleryCount ?? 0) || 0,
  }));
}

function orIlikeProduct(s: string) {
  return sql`${ilike(products.name, s)} OR ${ilike(products.sku, s)} OR ${ilike(products.barcode, s)}`;
}

export async function patchWebsiteProduct(
  shopId: string,
  productId: string,
  patch: {
    visible?: boolean;
    webTitle?: string | null;
    seoSlug?: string | null;
    sortOrder?: number;
    featured?: boolean;
    shortDescription?: string | null;
    longDescription?: string | null;
    metaTitle?: string | null;
    metaDescription?: string | null;
    ogImageUrl?: string | null;
    tags?: string | null;
    canonicalUrl?: string | null;
    twitterTitle?: string | null;
    twitterDescription?: string | null;
    twitterImageUrl?: string | null;
  },
) {
  const [p] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, productId), eq(products.shopId, shopId)))
    .limit(1);
  if (!p) throw AppError.notFound('Product not found');

  let normalizedSlug: string | null | undefined;
  if (patch.seoSlug !== undefined) {
    normalizedSlug = normalizeSeoSlug(patch.seoSlug);
    await assertSeoSlugAvailable(shopId, productId, normalizedSlug);
  }

  const setRow: Partial<typeof productWebsiteProfiles.$inferInsert> = {
    shopId,
    productId,
    updatedAt: new Date(),
  };

  if (patch.visible !== undefined) setRow.visible = patch.visible;
  if (patch.webTitle !== undefined) setRow.webTitle = patch.webTitle?.trim() || null;
  if (patch.seoSlug !== undefined) setRow.seoSlug = normalizedSlug ?? null;
  if (patch.sortOrder !== undefined) {
    const n = Number(patch.sortOrder);
    if (!Number.isFinite(n) || n < 0 || n > 2_000_000_000) {
      throw AppError.badRequest('Invalid sort order');
    }
    setRow.sortOrder = Math.floor(n);
  }
  if (patch.featured !== undefined) setRow.featured = patch.featured;
  if (patch.shortDescription !== undefined)
    setRow.shortDescription = patch.shortDescription?.trim() || null;
  if (patch.longDescription !== undefined)
    setRow.longDescription = patch.longDescription?.trim() || null;
  if (patch.metaTitle !== undefined) setRow.metaTitle = patch.metaTitle?.trim() || null;
  if (patch.metaDescription !== undefined)
    setRow.metaDescription = patch.metaDescription?.trim() || null;
  if (patch.ogImageUrl !== undefined) setRow.ogImageUrl = patch.ogImageUrl?.trim() || null;
  if (patch.tags !== undefined) setRow.tags = patch.tags?.trim() || null;
  if (patch.canonicalUrl !== undefined) setRow.canonicalUrl = patch.canonicalUrl?.trim() || null;
  if (patch.twitterTitle !== undefined) setRow.twitterTitle = patch.twitterTitle?.trim() || null;
  if (patch.twitterDescription !== undefined)
    setRow.twitterDescription = patch.twitterDescription?.trim() || null;
  if (patch.twitterImageUrl !== undefined)
    setRow.twitterImageUrl = patch.twitterImageUrl?.trim() || null;

  await db
    .insert(productWebsiteProfiles)
    .values({
      shopId,
      productId,
      visible: setRow.visible ?? false,
      webTitle: setRow.webTitle ?? null,
      seoSlug: setRow.seoSlug ?? null,
      sortOrder: setRow.sortOrder ?? 0,
      featured: setRow.featured ?? false,
      shortDescription: setRow.shortDescription ?? null,
      longDescription: setRow.longDescription ?? null,
      metaTitle: setRow.metaTitle ?? null,
      metaDescription: setRow.metaDescription ?? null,
      ogImageUrl: setRow.ogImageUrl ?? null,
      tags: setRow.tags ?? null,
      canonicalUrl: setRow.canonicalUrl ?? null,
      twitterTitle: setRow.twitterTitle ?? null,
      twitterDescription: setRow.twitterDescription ?? null,
      twitterImageUrl: setRow.twitterImageUrl ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [productWebsiteProfiles.shopId, productWebsiteProfiles.productId],
      set: {
        ...(patch.visible !== undefined ? { visible: setRow.visible } : {}),
        ...(patch.webTitle !== undefined ? { webTitle: setRow.webTitle } : {}),
        ...(patch.seoSlug !== undefined ? { seoSlug: setRow.seoSlug } : {}),
        ...(patch.sortOrder !== undefined ? { sortOrder: setRow.sortOrder } : {}),
        ...(patch.featured !== undefined ? { featured: setRow.featured } : {}),
        ...(patch.shortDescription !== undefined ? { shortDescription: setRow.shortDescription } : {}),
        ...(patch.longDescription !== undefined ? { longDescription: setRow.longDescription } : {}),
        ...(patch.metaTitle !== undefined ? { metaTitle: setRow.metaTitle } : {}),
        ...(patch.metaDescription !== undefined ? { metaDescription: setRow.metaDescription } : {}),
        ...(patch.ogImageUrl !== undefined ? { ogImageUrl: setRow.ogImageUrl } : {}),
        ...(patch.tags !== undefined ? { tags: setRow.tags } : {}),
        ...(patch.canonicalUrl !== undefined ? { canonicalUrl: setRow.canonicalUrl } : {}),
        ...(patch.twitterTitle !== undefined ? { twitterTitle: setRow.twitterTitle } : {}),
        ...(patch.twitterDescription !== undefined
          ? { twitterDescription: setRow.twitterDescription }
          : {}),
        ...(patch.twitterImageUrl !== undefined ? { twitterImageUrl: setRow.twitterImageUrl } : {}),
        updatedAt: new Date(),
      },
    });

  return { ok: true };
}

export async function getWebsiteProductDetail(shopId: string, productId: string) {
  const [shop] = await db
    .select({ slug: shops.slug })
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);
  const slug = shop?.slug ?? '';

  const [row] = await db
    .select({
      productId: products.id,
      sku: products.sku,
      name: products.name,
      listPrice: products.listPrice,
      visible: productWebsiteProfiles.visible,
      webTitle: productWebsiteProfiles.webTitle,
      seoSlug: productWebsiteProfiles.seoSlug,
      sortOrder: productWebsiteProfiles.sortOrder,
      featured: productWebsiteProfiles.featured,
      shortDescription: productWebsiteProfiles.shortDescription,
      longDescription: productWebsiteProfiles.longDescription,
      metaTitle: productWebsiteProfiles.metaTitle,
      metaDescription: productWebsiteProfiles.metaDescription,
      ogImageUrl: productWebsiteProfiles.ogImageUrl,
      tags: productWebsiteProfiles.tags,
      canonicalUrl: productWebsiteProfiles.canonicalUrl,
      twitterTitle: productWebsiteProfiles.twitterTitle,
      twitterDescription: productWebsiteProfiles.twitterDescription,
      twitterImageUrl: productWebsiteProfiles.twitterImageUrl,
    })
    .from(products)
    .leftJoin(
      productWebsiteProfiles,
      and(
        eq(productWebsiteProfiles.shopId, products.shopId),
        eq(productWebsiteProfiles.productId, products.id),
      ),
    )
    .where(and(eq(products.shopId, shopId), eq(products.id, productId)))
    .limit(1);
  if (!row) throw AppError.notFound('Product not found');

  const images = await db
    .select()
    .from(productWebsiteImages)
    .where(and(eq(productWebsiteImages.shopId, shopId), eq(productWebsiteImages.productId, productId)))
    .orderBy(asc(productWebsiteImages.kind), asc(productWebsiteImages.sortOrder), asc(productWebsiteImages.createdAt));

  return {
    productId: row.productId,
    sku: row.sku,
    name: row.name,
    listPrice: row.listPrice,
    visible: row.visible === true,
    webTitle: row.webTitle ?? null,
    seoSlug: row.seoSlug?.trim() || null,
    sortOrder: Number(row.sortOrder ?? 0) || 0,
    featured: row.featured === true,
    shortDescription: row.shortDescription ?? null,
    longDescription: row.longDescription ?? null,
    metaTitle: row.metaTitle ?? null,
    metaDescription: row.metaDescription ?? null,
    ogImageUrl: normalizeShopAssetUrl(row.ogImageUrl ?? null, slug),
    tags: row.tags ?? null,
    canonicalUrl: row.canonicalUrl ?? null,
    twitterTitle: row.twitterTitle ?? null,
    twitterDescription: row.twitterDescription ?? null,
    twitterImageUrl: row.twitterImageUrl ?? null,
    images: images.map((i) => ({
      id: i.id,
      kind: i.kind,
      url: normalizeShopAssetUrl(i.url, slug) ?? i.url,
      altText: i.altText ?? null,
      sortOrder: i.sortOrder ?? 0,
      isActive: i.isActive !== false,
    })),
  };
}

export async function deleteWebsiteProductImage(shopId: string, imageId: string) {
  const [row] = await db
    .select()
    .from(productWebsiteImages)
    .where(and(eq(productWebsiteImages.id, imageId), eq(productWebsiteImages.shopId, shopId)))
    .limit(1);
  if (!row) throw AppError.notFound('Image not found');

  await db
    .update(productWebsiteImages)
    .set({ isActive: false, updatedAt: new Date() })
    .where(eq(productWebsiteImages.id, imageId));

  const key = keyFromAssetUrl(row.url);
  if (key) {
    await deleteShopWebsiteAssetFile({ shopId, key });
  }
  return { ok: true };
}

function keyFromAssetUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/api\/v1\/public\/shops\/[^/]+\/assets\/([^/?#]+)/.exec(url);
  if (!m) return null;
  try {
    const key = decodeURIComponent(m[1]!);
    if (!/^product_[A-Za-z0-9_-]{10,}\.(png|jpg|webp)$/.test(key)) return null;
    return key;
  } catch {
    return null;
  }
}

export async function patchWebsiteProductImage(
  shopId: string,
  imageId: string,
  patch: { altText?: string | null; sortOrder?: number; isActive?: boolean },
) {
  const setRow: Partial<typeof productWebsiteImages.$inferInsert> = { updatedAt: new Date() };
  if (patch.altText !== undefined) setRow.altText = patch.altText?.trim() || null;
  if (patch.sortOrder !== undefined) setRow.sortOrder = patch.sortOrder;
  if (patch.isActive !== undefined) setRow.isActive = patch.isActive;

  const [row] = await db
    .update(productWebsiteImages)
    .set(setRow)
    .where(and(eq(productWebsiteImages.id, imageId), eq(productWebsiteImages.shopId, shopId)))
    .returning();
  if (!row) throw AppError.notFound('Image not found');
  return { ok: true };
}
