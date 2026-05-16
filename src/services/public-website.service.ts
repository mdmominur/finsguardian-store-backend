import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  brands,
  categories,
  productWebsiteImages,
  productWebsiteProfiles,
  products,
  shops,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import * as shopWebsiteService from './shop-website.service.js';

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

function normalizeHomepage(
  homepage: shopWebsiteService.ShopWebsiteSettings['homepage'],
  shopSlug: string,
) {
  return {
    ...homepage,
    sliderItems: (homepage.sliderItems ?? []).map((it) => ({
      ...it,
      imageUrl: normalizeShopAssetUrl(it.imageUrl, shopSlug) ?? it.imageUrl,
    })),
  };
}

async function shopBySlug(slug: string) {
  const [row] = await db
    .select({
      id: shops.id,
      slug: shops.slug,
      settings: shops.settings,
      subscriptionStatus: shops.subscriptionStatus,
    })
    .from(shops)
    .where(eq(shops.slug, slug))
    .limit(1);
  return row ?? null;
}

/** Public storefront config. Returns null if shop missing or website disabled. */
export async function getPublicSiteConfig(shopSlug: string) {
  const shop = await shopBySlug(shopSlug);
  if (!shop || shop.subscriptionStatus === 'suspended') return null;
  const slug = shop.slug ?? shopSlug;

  const w = shopWebsiteService.readWebsiteSettings(shop.settings);
  if (!w.enabled) return null;

  return {
    shopSlug: slug,
    enabled: true,
    publishedAt: w.publishedAt,
    logoUrl: normalizeShopAssetUrl(w.logoUrl, slug),
    theme: w.theme,
    policies: w.policies,
    contact: w.contact,
    checkout: w.checkout,
    seoDefaults: w.seoDefaults,
    header: w.header,
    footer: w.footer,
    homepage: normalizeHomepage(w.homepage, slug),
  };
}

export async function listPublicCategories(shopSlug: string) {
  const shop = await shopBySlug(shopSlug);
  if (!shop || shop.subscriptionStatus === 'suspended') throw AppError.notFound('Shop not found');
  const w = shopWebsiteService.readWebsiteSettings(shop.settings);
  if (!w.enabled) throw AppError.notFound('Not published');

  const rows = await db
    .select({
      id: categories.id,
      name: categories.name,
      parentId: categories.parentId,
      sortOrder: categories.sortOrder,
    })
    .from(categories)
    .where(and(eq(categories.shopId, shop.id), eq(categories.isActive, true)))
    .orderBy(asc(categories.sortOrder), asc(categories.name));

  return { items: rows };
}

/** Query ordering for `GET .../public/shops/:slug/products`. */
export type PublicProductListSort =
  | 'featured'
  | 'name_asc'
  | 'name_desc'
  | 'price_asc'
  | 'price_desc'
  | 'newest';

function publicProductListOrderBy(sort: PublicProductListSort | undefined) {
  switch (sort) {
    case 'name_asc':
      return [asc(products.name)];
    case 'name_desc':
      return [desc(products.name)];
    case 'price_asc':
      return [asc(products.listPrice), asc(products.name)];
    case 'price_desc':
      return [desc(products.listPrice), asc(products.name)];
    case 'newest':
      return [desc(products.createdAt), asc(products.name)];
    case 'featured':
    default:
      return [
        desc(productWebsiteProfiles.featured),
        asc(productWebsiteProfiles.sortOrder),
        asc(products.name),
      ];
  }
}

export async function listPublicProducts(
  shopSlug: string,
  q: {
    limit: number;
    offset: number;
    categoryId?: string;
    search?: string;
    featuredOnly?: boolean;
    sort?: PublicProductListSort;
  },
) {
  const shop = await shopBySlug(shopSlug);
  if (!shop || shop.subscriptionStatus === 'suspended') throw AppError.notFound('Shop not found');
  const slug = shop.slug ?? shopSlug;
  const w = shopWebsiteService.readWebsiteSettings(shop.settings);
  if (!w.enabled) throw AppError.notFound('Not published');

  const conditions = [
    eq(products.shopId, shop.id),
    eq(products.active, true),
    eq(productWebsiteProfiles.visible, true),
  ];

  if (q.categoryId) {
    conditions.push(eq(products.categoryId, q.categoryId));
  }
  if (q.featuredOnly) {
    conditions.push(eq(productWebsiteProfiles.featured, true));
  }
  if (q.search?.trim()) {
    const s = `%${q.search.trim()}%`;
    conditions.push(
      or(
        ilike(products.name, s),
        ilike(products.sku, s),
        ilike(productWebsiteProfiles.shortDescription, s),
      )!,
    );
  }

  const whereClause = and(...conditions);

  const orderByClause = publicProductListOrderBy(q.sort);

  const rows = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      listPrice: products.listPrice,
      categoryId: products.categoryId,
      brandId: products.brandId,
      webTitle: productWebsiteProfiles.webTitle,
      seoSlug: productWebsiteProfiles.seoSlug,
      shortDescription: productWebsiteProfiles.shortDescription,
      featured: productWebsiteProfiles.featured,
      sortOrder: productWebsiteProfiles.sortOrder,
      coverUrl: sql<string | null>`(select url from ${productWebsiteImages} i where i.shop_id = ${products.shopId} and i.product_id = ${products.id} and i.kind = 'COVER' and i.is_active = true order by i.sort_order asc, i.created_at desc limit 1)`,
    })
    .from(products)
    .innerJoin(
      productWebsiteProfiles,
      and(
        eq(productWebsiteProfiles.shopId, products.shopId),
        eq(productWebsiteProfiles.productId, products.id),
      ),
    )
    .where(whereClause)
    .orderBy(...orderByClause)
    .limit(q.limit)
    .offset(q.offset);

  return {
    items: rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      name: r.name,
      displayTitle: (r.webTitle ?? '').trim() || r.name,
      slug: r.seoSlug?.trim() || null,
      listPrice: r.listPrice,
      categoryId: r.categoryId,
      brandId: r.brandId,
      shortDescription: r.shortDescription ?? null,
      featured: r.featured === true,
      coverImageUrl: normalizeShopAssetUrl(r.coverUrl ?? null, slug),
    })),
  };
}

export async function getPublicProductBySlug(shopSlug: string, productSlug: string) {
  const shop = await shopBySlug(shopSlug);
  if (!shop || shop.subscriptionStatus === 'suspended') throw AppError.notFound('Shop not found');
  const slug = shop.slug ?? shopSlug;
  const w = shopWebsiteService.readWebsiteSettings(shop.settings);
  if (!w.enabled) throw AppError.notFound('Not published');

  const slugNorm = productSlug.trim().toLowerCase();
  if (!slugNorm) throw AppError.badRequest('Invalid slug');

  const [row] = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      listPrice: products.listPrice,
      categoryId: products.categoryId,
      brandId: products.brandId,
      webTitle: productWebsiteProfiles.webTitle,
      seoSlug: productWebsiteProfiles.seoSlug,
      shortDescription: productWebsiteProfiles.shortDescription,
      longDescription: productWebsiteProfiles.longDescription,
      metaTitle: productWebsiteProfiles.metaTitle,
      metaDescription: productWebsiteProfiles.metaDescription,
      ogImageUrl: productWebsiteProfiles.ogImageUrl,
      tags: productWebsiteProfiles.tags,
      canonicalUrl: productWebsiteProfiles.canonicalUrl,
      visible: productWebsiteProfiles.visible,
      featured: productWebsiteProfiles.featured,
    })
    .from(products)
    .innerJoin(
      productWebsiteProfiles,
      and(
        eq(productWebsiteProfiles.shopId, products.shopId),
        eq(productWebsiteProfiles.productId, products.id),
      ),
    )
    .where(
      and(
        eq(products.shopId, shop.id),
        eq(products.active, true),
        eq(productWebsiteProfiles.visible, true),
        sql`lower(btrim(${productWebsiteProfiles.seoSlug})) = ${slugNorm}`,
      ),
    )
    .limit(1);

  if (!row || !row.seoSlug?.trim()) throw AppError.notFound('Product not found');

  const [cat] = row.categoryId
    ? await db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(and(eq(categories.id, row.categoryId), eq(categories.shopId, shop.id)))
        .limit(1)
    : [null];

  const [br] = row.brandId
    ? await db
        .select({ id: brands.id, name: brands.name })
        .from(brands)
        .where(and(eq(brands.id, row.brandId), eq(brands.shopId, shop.id)))
        .limit(1)
    : [null];

  const images = await db
    .select({
      id: productWebsiteImages.id,
      kind: productWebsiteImages.kind,
      url: productWebsiteImages.url,
      altText: productWebsiteImages.altText,
      sortOrder: productWebsiteImages.sortOrder,
    })
    .from(productWebsiteImages)
    .where(
      and(
        eq(productWebsiteImages.shopId, shop.id),
        eq(productWebsiteImages.productId, row.id),
        eq(productWebsiteImages.isActive, true),
      ),
    )
    .orderBy(asc(productWebsiteImages.kind), asc(productWebsiteImages.sortOrder));

  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    displayTitle: (row.webTitle ?? '').trim() || row.name,
    slug: row.seoSlug.trim(),
    listPrice: row.listPrice,
    category: cat ? { id: cat.id, name: cat.name } : null,
    brand: br ? { id: br.id, name: br.name } : null,
    shortDescription: row.shortDescription ?? null,
    longDescription: row.longDescription ?? null,
    metaTitle: row.metaTitle ?? null,
    metaDescription: row.metaDescription ?? null,
    ogImageUrl: normalizeShopAssetUrl(row.ogImageUrl ?? null, slug),
    tags: row.tags ?? null,
    canonicalUrl: row.canonicalUrl ?? null,
    featured: row.featured === true,
    images: images.map((im) => ({ ...im, url: normalizeShopAssetUrl(im.url, slug) ?? im.url })),
  };
}

export async function getPublicProductById(shopSlug: string, productId: string) {
  const shop = await shopBySlug(shopSlug);
  if (!shop || shop.subscriptionStatus === 'suspended') throw AppError.notFound('Shop not found');
  const slug = shop.slug ?? shopSlug;
  const w = shopWebsiteService.readWebsiteSettings(shop.settings);
  if (!w.enabled) throw AppError.notFound('Not published');

  const id = productId.trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw AppError.badRequest('Invalid product id');

  const [row] = await db
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      listPrice: products.listPrice,
      categoryId: products.categoryId,
      brandId: products.brandId,
      webTitle: productWebsiteProfiles.webTitle,
      seoSlug: productWebsiteProfiles.seoSlug,
      shortDescription: productWebsiteProfiles.shortDescription,
      longDescription: productWebsiteProfiles.longDescription,
      metaTitle: productWebsiteProfiles.metaTitle,
      metaDescription: productWebsiteProfiles.metaDescription,
      ogImageUrl: productWebsiteProfiles.ogImageUrl,
      tags: productWebsiteProfiles.tags,
      canonicalUrl: productWebsiteProfiles.canonicalUrl,
      visible: productWebsiteProfiles.visible,
      featured: productWebsiteProfiles.featured,
    })
    .from(products)
    .innerJoin(
      productWebsiteProfiles,
      and(eq(productWebsiteProfiles.shopId, products.shopId), eq(productWebsiteProfiles.productId, products.id)),
    )
    .where(
      and(
        eq(products.shopId, shop.id),
        eq(products.active, true),
        eq(productWebsiteProfiles.visible, true),
        eq(products.id, id),
      ),
    )
    .limit(1);

  if (!row) throw AppError.notFound('Product not found');

  const [cat] = row.categoryId
    ? await db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(and(eq(categories.id, row.categoryId), eq(categories.shopId, shop.id)))
        .limit(1)
    : [null];

  const [br] = row.brandId
    ? await db
        .select({ id: brands.id, name: brands.name })
        .from(brands)
        .where(and(eq(brands.id, row.brandId), eq(brands.shopId, shop.id)))
        .limit(1)
    : [null];

  const images = await db
    .select({
      id: productWebsiteImages.id,
      kind: productWebsiteImages.kind,
      url: productWebsiteImages.url,
      altText: productWebsiteImages.altText,
      sortOrder: productWebsiteImages.sortOrder,
    })
    .from(productWebsiteImages)
    .where(
      and(
        eq(productWebsiteImages.shopId, shop.id),
        eq(productWebsiteImages.productId, row.id),
        eq(productWebsiteImages.isActive, true),
      ),
    )
    .orderBy(asc(productWebsiteImages.kind), asc(productWebsiteImages.sortOrder));

  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    displayTitle: (row.webTitle ?? '').trim() || row.name,
    slug: row.seoSlug?.trim() || null,
    listPrice: row.listPrice,
    category: cat ? { id: cat.id, name: cat.name } : null,
    brand: br ? { id: br.id, name: br.name } : null,
    shortDescription: row.shortDescription ?? null,
    longDescription: row.longDescription ?? null,
    metaTitle: row.metaTitle ?? null,
    metaDescription: row.metaDescription ?? null,
    ogImageUrl: normalizeShopAssetUrl(row.ogImageUrl ?? null, slug),
    tags: row.tags ?? null,
    canonicalUrl: row.canonicalUrl ?? null,
    featured: row.featured === true,
    images: images.map((im) => ({ ...im, url: normalizeShopAssetUrl(im.url, slug) ?? im.url })),
  };
}
