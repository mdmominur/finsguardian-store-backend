import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { canManageWebsite } from '../../lib/permissions.js';
import * as websiteService from '../../services/shop-website.service.js';
import * as websiteAssets from '../../services/shop-website-assets.service.js';
import * as publicWebsite from '../../services/public-website.service.js';

const sliderItemSchema = z.object({
  id: z.string().min(6),
  imageUrl: z.string().min(1),
  href: z.string().min(1),
  altText: z.string().nullable().optional(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});

const patchWebsiteBody = z
  .object({
    enabled: z.boolean().optional(),
    publishedAt: z.string().nullable().optional(),
    logoUrl: z.string().nullable().optional(),
    policies: z
      .object({
        privacy: z.string().nullable().optional(),
        terms: z.string().nullable().optional(),
        shipping: z.string().nullable().optional(),
        returns: z.string().nullable().optional(),
      })
      .optional(),
    theme: z
      .object({
        primaryColor: z.string().nullable().optional(),
        accentColor: z.string().nullable().optional(),
      })
      .optional(),
    contact: z
      .object({
        supportEmail: z.string().nullable().optional(),
        supportPhone: z.string().nullable().optional(),
        facebookUrl: z.string().nullable().optional(),
      })
      .optional(),
    checkout: z
      .object({
        defaultPaymentMethodHints: z.string().nullable().optional(),
      })
      .optional(),
    seoDefaults: z
      .object({
        defaultMetaTitleSuffix: z.string().nullable().optional(),
        defaultOgImageUrl: z.string().nullable().optional(),
      })
      .optional(),
    header: z
      .object({
        showCategoryMenu: z.boolean().optional(),
        menuCategoryIds: z.array(z.string().uuid()).optional(),
      })
      .optional(),
    footer: z
      .object({
        about: z.string().nullable().optional(),
        address: z.string().nullable().optional(),
        socialLinks: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    homepage: z
      .object({
        sliderEnabled: z.boolean().optional(),
        sliderItems: z.array(sliderItemSchema).optional(),
      })
      .optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'At least one field required' });

const uploadAssetBody = z
  .object({
    kind: z.enum(['logo', 'slider', 'product', 'productdesc']),
    dataUrl: z.string().min(20),
  })
  .strict();

export async function registerShopWebsiteRoutes(app: FastifyInstance) {
  app.get(
    '/shop/website',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageWebsite(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website permission required' });
        }
        const out = await websiteService.getShopWebsiteSettings(request.authUser.shopId);
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.patch(
    '/shop/website',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageWebsite(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website permission required' });
        }
        const body = patchWebsiteBody.parse(request.body);
        const out = await websiteService.patchShopWebsiteSettings(request.authUser.shopId, body);
        return reply.send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/shop/website/assets',
    {
      preHandler: [app.authenticate],
      bodyLimit: 16 * 1024 * 1024,
    },
    async (request, reply) => {
      try {
        if (!canManageWebsite(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website permission required' });
        }
        const body = uploadAssetBody.parse(request.body);
        const out = await websiteAssets.uploadShopWebsiteAsset({
          shopId: request.authUser.shopId,
          kind: body.kind,
          dataUrl: body.dataUrl,
        });
        return reply.status(201).send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.delete(
    '/shop/website/assets/:key',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { key } = z.object({ key: z.string().min(1) }).parse(request.params);
      try {
        if (!canManageWebsite(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Website permission required' });
        }
        if (!/^productdesc_[A-Za-z0-9_-]{10,}\.(png|jpg|webp)$/.test(key)) {
          return reply.status(404).send({ code: 'NOT_FOUND', message: 'Asset not found' });
        }
        await websiteAssets.deleteShopWebsiteAsset({ shopId: request.authUser.shopId, key });
        return reply.send({ ok: true });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  // ─── Public storefront (read-only; no staff JWT) ───────────────────────

  app.get('/public/shops/:slug/site-config', async (request, reply) => {
    const { slug } = z.object({ slug: z.string().min(1) }).parse(request.params);
    try {
      const out = await publicWebsite.getPublicSiteConfig(slug);
      if (!out) {
        return reply.status(404).send({ code: 'SITE_DISABLED', message: 'Website is not published' });
      }
      reply.header('Cache-Control', 'public, max-age=60');
      return reply.send(out);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.get('/public/shops/:slug/categories', async (request, reply) => {
    const { slug } = z.object({ slug: z.string().min(1) }).parse(request.params);
    try {
      const out = await publicWebsite.listPublicCategories(slug);
      reply.header('Cache-Control', 'public, max-age=120');
      return reply.send(out);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.get('/public/shops/:slug/products', async (request, reply) => {
    const { slug } = z.object({ slug: z.string().min(1) }).parse(request.params);
    const q = z
      .object({
        limit: z.coerce.number().min(1).max(100).default(48),
        offset: z.coerce.number().min(0).default(0),
        categoryId: z.string().uuid().optional(),
        search: z.string().optional(),
        featured: z.enum(['1', 'true', 'yes']).optional(),
        sort: z
          .enum(['featured', 'name_asc', 'name_desc', 'price_asc', 'price_desc', 'newest'])
          .optional(),
      })
      .parse(request.query);
    try {
      const out = await publicWebsite.listPublicProducts(slug, {
        limit: q.limit,
        offset: q.offset,
        categoryId: q.categoryId,
        search: q.search,
        featuredOnly: q.featured !== undefined,
        sort: q.sort,
      });
      reply.header('Cache-Control', 'public, max-age=60');
      return reply.send(out);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.get('/public/shops/:slug/products/by-slug/:productSlug', async (request, reply) => {
    const { slug, productSlug } = z
      .object({ slug: z.string().min(1), productSlug: z.string().min(1) })
      .parse(request.params);
    try {
      const out = await publicWebsite.getPublicProductBySlug(slug, productSlug);
      reply.header('Cache-Control', 'public, max-age=120');
      return reply.send(out);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.get('/public/shops/:slug/products/by-id/:productId', async (request, reply) => {
    const { slug, productId } = z
      .object({ slug: z.string().min(1), productId: z.string().min(1) })
      .parse(request.params);
    try {
      const out = await publicWebsite.getPublicProductById(slug, productId);
      reply.header('Cache-Control', 'public, max-age=120');
      return reply.send(out);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.get('/public/shops/:slug/assets/:key', async (request, reply) => {
    const { slug, key } = z
      .object({ slug: z.string().min(1), key: z.string().min(1) })
      .parse(request.params);
    try {
      const out = await websiteAssets.readShopWebsiteAssetBySlug({ shopSlug: slug, key });
      reply.header('Content-Type', out.mime);
      reply.header('Cache-Control', 'public, max-age=86400, immutable');
      return reply.send(out.bytes);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });
}
