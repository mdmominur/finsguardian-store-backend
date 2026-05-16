import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { canManageWebsite, canViewWebOrderInvoices } from '../../lib/permissions.js';
import * as websiteProducts from '../../services/website-products.service.js';
import * as storefrontFulfillment from '../../services/storefront-fulfillment.service.js';
import * as websiteAssets from '../../services/shop-website-assets.service.js';
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { productWebsiteImages, productWebsiteProfiles, products } from '../../db/schema/index.js';

export async function registerWebsiteRoutes(app: FastifyInstance) {
  app.get(
    '/website/products',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageWebsite(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website permission required' });
        }
        const q = z
          .object({
            search: z.string().optional(),
            limit: z.coerce.number().min(1).max(200).default(50),
            offset: z.coerce.number().min(0).default(0),
          })
          .parse(request.query);
        const items = await websiteProducts.listWebsiteProducts(request.authUser.shopId, q);
        return reply.send({ items });
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', details: e.flatten() });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/website/check-seo-slug',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageWebsite(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website permission required' });
        }
        const { slug, excludeProductId } = z
          .object({
            slug: z.string().min(1),
            excludeProductId: z.string().uuid().optional(),
          })
          .parse(request.query);

        const conditions = [
          eq(productWebsiteProfiles.shopId, request.authUser.shopId),
          eq(productWebsiteProfiles.seoSlug, slug),
        ];
        if (excludeProductId) {
          conditions.push(ne(productWebsiteProfiles.productId, excludeProductId));
        }

        const [existing] = await db
          .select({ id: productWebsiteProfiles.productId })
          .from(productWebsiteProfiles)
          .where(and(...conditions))
          .limit(1);

        return reply.send({ available: !existing });
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', details: e.flatten() });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.patch(
    '/website/products/:productId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageWebsite(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website permission required' });
        }
        const { productId } = z.object({ productId: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            visible: z.boolean().optional(),
            webTitle: z.string().nullable().optional(),
            seoSlug: z.string().nullable().optional(),
            sortOrder: z.number().int().min(0).optional(),
            featured: z.boolean().optional(),
            shortDescription: z.string().nullable().optional(),
            longDescription: z.string().nullable().optional(),
            metaTitle: z.string().nullable().optional(),
            metaDescription: z.string().nullable().optional(),
            ogImageUrl: z.string().nullable().optional(),
            tags: z.string().nullable().optional(),
            canonicalUrl: z.string().nullable().optional(),
            twitterTitle: z.string().nullable().optional(),
            twitterDescription: z.string().nullable().optional(),
            twitterImageUrl: z.string().nullable().optional(),
          })
          .strict()
          .superRefine((b, ctx) => {
            const has =
              b.visible !== undefined ||
              b.webTitle !== undefined ||
              b.seoSlug !== undefined ||
              b.sortOrder !== undefined ||
              b.featured !== undefined ||
              b.shortDescription !== undefined ||
              b.longDescription !== undefined ||
              b.metaTitle !== undefined ||
              b.metaDescription !== undefined ||
              b.ogImageUrl !== undefined ||
              b.tags !== undefined ||
              b.canonicalUrl !== undefined ||
              b.twitterTitle !== undefined ||
              b.twitterDescription !== undefined ||
              b.twitterImageUrl !== undefined;
            if (!has) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one field required' });
            }
          })
          .parse(request.body);

        const out = await websiteProducts.patchWebsiteProduct(request.authUser.shopId, productId, body);
        return reply.send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', details: e.flatten() });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/website/products/:productId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageWebsite(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website permission required' });
        }
        const { productId } = z.object({ productId: z.string().uuid() }).parse(request.params);
        const out = await websiteProducts.getWebsiteProductDetail(request.authUser.shopId, productId);
        return reply.send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', details: e.flatten() });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/website/products/:productId/images',
    {
      preHandler: [app.authenticate],
      // base64 JSON payload is larger than the actual image bytes (~33% overhead)
      bodyLimit: 16 * 1024 * 1024,
    },
    async (request, reply) => {
      try {
        if (!canManageWebsite(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website permission required' });
        }
        const { productId } = z.object({ productId: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            kind: z.enum(['cover', 'gallery']),
            dataUrl: z.string().min(20),
            altText: z.string().nullable().optional(),
          })
          .strict()
          .parse(request.body);

        const [p] = await db
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.id, productId), eq(products.shopId, request.authUser.shopId)))
          .limit(1);
        if (!p) throw AppError.notFound('Product not found');

        // If replacing cover, deactivate previous cover rows and delete their files.
        if (body.kind === 'cover') {
          const existing = await db
            .select({ id: productWebsiteImages.id, url: productWebsiteImages.url })
            .from(productWebsiteImages)
            .where(
              and(
                eq(productWebsiteImages.shopId, request.authUser.shopId),
                eq(productWebsiteImages.productId, productId),
                eq(productWebsiteImages.kind, 'COVER'),
                eq(productWebsiteImages.isActive, true),
              ),
            );
          if (existing.length > 0) {
            await db
              .update(productWebsiteImages)
              .set({ isActive: false, updatedAt: new Date() })
              .where(
                and(
                  eq(productWebsiteImages.shopId, request.authUser.shopId),
                  eq(productWebsiteImages.productId, productId),
                  eq(productWebsiteImages.kind, 'COVER'),
                  eq(productWebsiteImages.isActive, true),
                ),
              );
            for (const ex of existing) {
              const key = (() => {
                const m = /\/api\/v1\/public\/shops\/[^/]+\/assets\/([^/?#]+)/.exec(ex.url);
                if (!m) return null;
                try {
                  return decodeURIComponent(m[1]!);
                } catch {
                  return null;
                }
              })();
              if (key && /^product_[A-Za-z0-9_-]{10,}\.(png|jpg|webp)$/.test(key)) {
                await websiteAssets.deleteShopWebsiteAssetFile({
                  shopId: request.authUser.shopId,
                  key,
                });
              }
            }
          }
        }

        const uploaded = await websiteAssets.uploadShopWebsiteAsset({
          shopId: request.authUser.shopId,
          kind: 'product',
          dataUrl: body.dataUrl,
        });

        // For cover, set sort_order=0; for gallery append at end by using createdAt ordering.
        await db.insert(productWebsiteImages).values({
          shopId: request.authUser.shopId,
          productId,
          kind: body.kind === 'cover' ? 'COVER' : 'GALLERY',
          url: uploaded.url,
          altText: body.altText?.trim() || null,
          sortOrder: 0,
          isActive: true,
          updatedAt: new Date(),
        });

        // Set OG + Twitter image from cover upload.
        if (body.kind === 'cover') {
          await db
            .insert(productWebsiteProfiles)
            .values({
              shopId: request.authUser.shopId,
              productId,
              visible: false,
              ogImageUrl: uploaded.url,
              twitterImageUrl: uploaded.url,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as any)
            .onConflictDoUpdate({
              target: [productWebsiteProfiles.shopId, productWebsiteProfiles.productId],
              set: {
                ogImageUrl: uploaded.url,
                twitterImageUrl: uploaded.url,
                updatedAt: new Date(),
              },
            });
        }

        return reply.status(201).send({ url: uploaded.url });
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', details: e.flatten() });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.patch(
    '/website/images/:imageId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageWebsite(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website permission required' });
        }
        const { imageId } = z.object({ imageId: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            altText: z.string().nullable().optional(),
            sortOrder: z.number().int().optional(),
            isActive: z.boolean().optional(),
          })
          .strict()
          .superRefine((b, ctx) => {
            const has = b.altText !== undefined || b.sortOrder !== undefined || b.isActive !== undefined;
            if (!has) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At least one field required' });
          })
          .parse(request.body);

        const out = await websiteProducts.patchWebsiteProductImage(request.authUser.shopId, imageId, body);
        return reply.send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', details: e.flatten() });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.delete(
    '/website/images/:imageId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageWebsite(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website permission required' });
        }
        const { imageId } = z.object({ imageId: z.string().uuid() }).parse(request.params);
        const out = await websiteProducts.deleteWebsiteProductImage(request.authUser.shopId, imageId);
        return reply.send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', details: e.flatten() });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/website/storefront-fulfillment-orders',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canViewWebOrderInvoices(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website orders permission required' });
        }
        const q = z
          .object({
            status: z.enum(['PROCESSING', 'OUT_FOR_DELIVERY', 'SHIPPED', 'CANCELLED']).optional(),
          })
          .parse(request.query ?? {});
        const out = await storefrontFulfillment.listStaffFulfillmentOrders({
          shopId: request.authUser.shopId,
          status: q.status,
        });
        return reply.send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', details: e.flatten() });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/website/storefront-fulfillment-orders/:id/pos-hold',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canViewWebOrderInvoices(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website orders permission required' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const out = await storefrontFulfillment.createPosHoldFromFulfillmentOrder({
          shopId: request.authUser.shopId,
          userId: request.authUser.userId,
          orderId: id,
        });
        return reply.status(201).send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', details: e.flatten() });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/website/storefront-fulfillment-orders/:id/mark-shipped',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canViewWebOrderInvoices(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website orders permission required' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const out = await storefrontFulfillment.markStorefrontFulfillmentShipped({
          shopId: request.authUser.shopId,
          orderId: id,
        });
        return reply.status(200).send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', details: e.flatten() });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}

