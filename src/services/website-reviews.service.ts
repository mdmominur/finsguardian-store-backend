import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  customers,
  productReviews,
  products,
  saleLines,
  sales,
  shops,
  storefrontFulfillmentOrderLines,
  storefrontFulfillmentOrders,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import * as shopWebsiteService from './shop-website.service.js';

async function shopBySlugOrThrow(shopSlug: string) {
  const slug = shopSlug.trim();
  const [row] = await db.select().from(shops).where(eq(shops.slug, slug)).limit(1);
  if (!row || row.subscriptionStatus === 'suspended') throw AppError.notFound('Shop not found');
  const w = shopWebsiteService.readWebsiteSettings(row.settings);
  if (!w.enabled) throw AppError.notFound('Not published');
  return row;
}

export async function listPublicProductReviews(shopSlug: string, productId: string) {
  const shop = await shopBySlugOrThrow(shopSlug);

  const rows = await db
    .select({
      id: productReviews.id,
      productId: productReviews.productId,
      reviewerName: productReviews.reviewerName,
      rating: productReviews.rating,
      title: productReviews.title,
      comment: productReviews.comment,
      isVerifiedPurchase: productReviews.isVerifiedPurchase,
      merchantReply: productReviews.merchantReply,
      repliedAt: productReviews.repliedAt,
      createdAt: productReviews.createdAt,
    })
    .from(productReviews)
    .where(
      and(
        eq(productReviews.shopId, shop.id),
        eq(productReviews.productId, productId),
        eq(productReviews.status, 'APPROVED'),
      ),
    )
    .orderBy(desc(productReviews.createdAt))
    .limit(50);

  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let sum = 0;
  for (const r of rows) {
    const rt = Math.min(5, Math.max(1, Number(r.rating) || 5)) as 1 | 2 | 3 | 4 | 5;
    distribution[rt] = (distribution[rt] ?? 0) + 1;
    sum += rt;
  }

  const totalCount = rows.length;
  const averageRating = totalCount > 0 ? Number((sum / totalCount).toFixed(1)) : 0;

  return {
    summary: {
      averageRating,
      totalCount,
      distribution,
    },
    items: rows,
  };
}

export async function listPublicFeaturedTestimonials(shopSlug: string, limit = 6) {
  const shop = await shopBySlugOrThrow(shopSlug);

  const rows = await db
    .select({
      id: productReviews.id,
      productId: productReviews.productId,
      productName: products.name,
      reviewerName: productReviews.reviewerName,
      rating: productReviews.rating,
      title: productReviews.title,
      comment: productReviews.comment,
      isVerifiedPurchase: productReviews.isVerifiedPurchase,
      isFeaturedOnHome: productReviews.isFeaturedOnHome,
      createdAt: productReviews.createdAt,
    })
    .from(productReviews)
    .innerJoin(products, eq(products.id, productReviews.productId))
    .where(and(eq(productReviews.shopId, shop.id), eq(productReviews.status, 'APPROVED')))
    .orderBy(
      desc(productReviews.isFeaturedOnHome),
      desc(productReviews.rating),
      desc(productReviews.createdAt),
    )
    .limit(Math.min(12, Math.max(1, limit)));

  return { items: rows };
}

export async function createPublicProductReview(input: {
  shopSlug: string;
  shopId: string;
  customerId: string;
  productId: string;
  rating: number;
  title?: string | null;
  comment: string;
}) {
  const shop = await shopBySlugOrThrow(input.shopSlug);
  if (shop.id !== input.shopId) throw AppError.unauthorized('Invalid token for this shop');

  const [cust] = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(and(eq(customers.id, input.customerId), eq(customers.shopId, shop.id)))
    .limit(1);
  if (!cust) throw AppError.badRequest('Customer not found');

  const [prod] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.id, input.productId), eq(products.shopId, shop.id), eq(products.active, true)))
    .limit(1);
  if (!prod) throw AppError.notFound('Product not found');

  // Check if customer purchased this product via sales or storefront fulfillment orders
  const [saleMatch] = await db
    .select({ id: saleLines.id })
    .from(saleLines)
    .innerJoin(sales, eq(sales.id, saleLines.saleId))
    .where(
      and(
        eq(sales.shopId, shop.id),
        eq(sales.customerId, cust.id),
        eq(saleLines.productId, prod.id),
      ),
    )
    .limit(1);

  const [foMatch] = !saleMatch
    ? await db
        .select({ id: storefrontFulfillmentOrderLines.id })
        .from(storefrontFulfillmentOrderLines)
        .innerJoin(
          storefrontFulfillmentOrders,
          eq(storefrontFulfillmentOrders.id, storefrontFulfillmentOrderLines.orderId),
        )
        .where(
          and(
            eq(storefrontFulfillmentOrders.shopId, shop.id),
            eq(storefrontFulfillmentOrders.customerId, cust.id),
            eq(storefrontFulfillmentOrderLines.productId, prod.id),
          ),
        )
        .limit(1)
    : [null];

  const isVerifiedPurchase = Boolean(saleMatch || foMatch);
  const reviewerName = cust.name?.trim() && cust.name.trim() !== 'Customer' ? cust.name.trim() : 'Verified Shopper';

  const [inserted] = await db
    .insert(productReviews)
    .values({
      shopId: shop.id,
      productId: prod.id,
      customerId: cust.id,
      reviewerName,
      rating: Math.min(5, Math.max(1, Math.round(input.rating))),
      title: input.title?.trim() || null,
      comment: input.comment.trim(),
      isVerifiedPurchase,
      status: 'APPROVED',
      isFeaturedOnHome: false,
    })
    .returning();

  return inserted;
}

export async function listStaffProductReviews(
  shopId: string,
  q: {
    status?: 'PENDING' | 'APPROVED' | 'REJECTED';
    search?: string;
    limit?: number;
    offset?: number;
  },
) {
  const conditions = [eq(productReviews.shopId, shopId)];
  if (q.status) {
    conditions.push(eq(productReviews.status, q.status));
  }
  if (q.search?.trim()) {
    const s = `%${q.search.trim()}%`;
    conditions.push(
      or(
        ilike(productReviews.reviewerName, s),
        ilike(productReviews.comment, s),
        ilike(products.name, s),
      )!,
    );
  }

  const rows = await db
    .select({
      id: productReviews.id,
      productId: productReviews.productId,
      productName: products.name,
      productSku: products.sku,
      customerId: productReviews.customerId,
      customerPhone: customers.phone,
      reviewerName: productReviews.reviewerName,
      rating: productReviews.rating,
      title: productReviews.title,
      comment: productReviews.comment,
      isVerifiedPurchase: productReviews.isVerifiedPurchase,
      status: productReviews.status,
      isFeaturedOnHome: productReviews.isFeaturedOnHome,
      merchantReply: productReviews.merchantReply,
      repliedAt: productReviews.repliedAt,
      createdAt: productReviews.createdAt,
    })
    .from(productReviews)
    .innerJoin(products, eq(products.id, productReviews.productId))
    .leftJoin(customers, eq(customers.id, productReviews.customerId))
    .where(and(...conditions))
    .orderBy(desc(productReviews.createdAt))
    .limit(Math.min(200, Math.max(1, q.limit ?? 50)))
    .offset(Math.max(0, q.offset ?? 0));

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      approved: sql<number>`count(*) filter (where ${productReviews.status} = 'APPROVED')::int`,
      pending: sql<number>`count(*) filter (where ${productReviews.status} = 'PENDING')::int`,
      rejected: sql<number>`count(*) filter (where ${productReviews.status} = 'REJECTED')::int`,
      featured: sql<number>`count(*) filter (where ${productReviews.isFeaturedOnHome} = true)::int`,
    })
    .from(productReviews)
    .where(eq(productReviews.shopId, shopId));

  return {
    counts: counts ?? { total: 0, approved: 0, pending: 0, rejected: 0, featured: 0 },
    items: rows,
  };
}

export async function patchStaffProductReview(
  shopId: string,
  reviewId: string,
  patch: {
    status?: 'PENDING' | 'APPROVED' | 'REJECTED';
    isFeaturedOnHome?: boolean;
    merchantReply?: string | null;
  },
) {
  const [existing] = await db
    .select({ id: productReviews.id })
    .from(productReviews)
    .where(and(eq(productReviews.id, reviewId), eq(productReviews.shopId, shopId)))
    .limit(1);
  if (!existing) throw AppError.notFound('Review not found');

  const updateSet: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status !== undefined) updateSet.status = patch.status;
  if (patch.isFeaturedOnHome !== undefined) updateSet.isFeaturedOnHome = patch.isFeaturedOnHome;
  if (patch.merchantReply !== undefined) {
    const reply = patch.merchantReply?.trim() || null;
    updateSet.merchantReply = reply;
    updateSet.repliedAt = reply ? new Date() : null;
  }

  const [updated] = await db
    .update(productReviews)
    .set(updateSet)
    .where(and(eq(productReviews.id, reviewId), eq(productReviews.shopId, shopId)))
    .returning();

  return updated;
}

export async function deleteStaffProductReview(shopId: string, reviewId: string) {
  const [existing] = await db
    .select({ id: productReviews.id })
    .from(productReviews)
    .where(and(eq(productReviews.id, reviewId), eq(productReviews.shopId, shopId)))
    .limit(1);
  if (!existing) throw AppError.notFound('Review not found');

  await db
    .delete(productReviews)
    .where(and(eq(productReviews.id, reviewId), eq(productReviews.shopId, shopId)));

  return { ok: true as const };
}
