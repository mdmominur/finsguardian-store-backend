import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import {
  canBrowseProductsForPos,
  canListStockLocationsForOperations,
  canUseInventoryDashboard,
  canViewSupplierPricing,
  hasPermission,
} from '../../lib/permissions.js';
import * as productService from '../../services/product.service.js';
import * as inventoryHistoryService from '../../services/inventory-history.service.js';
import * as productPurchaseInsightsService from '../../services/product-purchase-insights.service.js';
import { isMultiStockLocationEnabled } from '../../services/shop-features.service.js';
import type { FastifyRequest } from 'fastify';
import { DEFAULT_LIST_LIMIT } from '../../lib/pagination.js';

function mapProductForRole<T extends Record<string, unknown>>(
  p: T,
  auth: FastifyRequest['authUser'],
) {
  if (canViewSupplierPricing(auth)) return p;
  const { unitCost: _u, costMethod: _c, ...rest } = p;
  return rest;
}

export async function registerProductRoutes(app: FastifyInstance) {
  app.get(
    '/products',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        const q = z
          .object({
            search: z.string().optional(),
            categoryId: z.string().uuid().optional(),
            brandId: z.string().uuid().optional(),
            trackingMode: z.enum(['SERIALIZED', 'QUANTITY']).optional(),
            active: z.coerce.boolean().optional(),
            inventoryTracked: z
              .enum(['true', 'false'])
              .optional()
              .transform((v) => (v === 'true' ? true : v === 'false' ? false : undefined)),
            /** POS / pickers: compute on-hand at this stock location when multi-location is enabled. */
            stockLocationId: z.string().uuid().optional(),
            limit: z.coerce.number().min(1).max(200).default(DEFAULT_LIST_LIMIT),
            offset: z.coerce.number().min(0).default(0),
            stockScope: z.enum(['default', 'all_locations']).optional(),
            supplierId: z.string().uuid().optional(),
            purchaseOrderId: z.string().uuid().optional(),
          })
          .parse(request.query);

        if (q.inventoryTracked === true) {
          if (!canUseInventoryDashboard(request.authUser)) {
            return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
          }
        } else if (!canBrowseProductsForPos(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }

        const rows = await productService.listProducts(request.authUser.shopId, q);
        return reply.send({
          items: rows.map((r) => mapProductForRole(r, request.authUser)),
        });
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/products/suggest-sku',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'products.read')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const q = z
          .object({
            name: z.string().min(1),
            excludeProductId: z.string().uuid().optional(),
          })
          .parse(request.query);
        const sku = await productService.suggestUniqueSkuFromName(
          request.authUser.shopId,
          q.name,
          q.excludeProductId,
        );
        return reply.send({ sku });
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/products/check-sku',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'products.read')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const q = z
          .object({
            sku: z.string().min(1),
            excludeProductId: z.string().uuid().optional(),
          })
          .parse(request.query);
        const taken = await productService.isSkuTaken(
          request.authUser.shopId,
          q.sku,
          q.excludeProductId,
        );
        return reply.send({ available: !taken });
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/products/:id/on-hand-at-location',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canBrowseProductsForPos(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        if (!canListStockLocationsForOperations(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const q = z
          .object({
            locationId: z.string().uuid(),
          })
          .parse(request.query);
        const multiLoc = await isMultiStockLocationEnabled(request.authUser.shopId);
        const out = await productService.getQuantityOnHandAtLocation(
          request.authUser.shopId,
          id,
          q.locationId,
          multiLoc,
        );
        return reply.send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/products/:id/stock-by-locations',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canBrowseProductsForPos(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        if (!canListStockLocationsForOperations(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const out = await productService.listProductStockByLocations(
          request.authUser.shopId,
          id,
        );
        return reply.send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/products/:id/stock-history',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canUseInventoryDashboard(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const q = z
          .object({
            limit: z.coerce.number().min(1).max(200).optional().default(DEFAULT_LIST_LIMIT),
            offset: z.coerce.number().min(0).max(100_000).optional().default(0),
          })
          .parse(request.query);
        const out = await inventoryHistoryService.listProductStockHistory(
          request.authUser.shopId,
          id,
          { limit: q.limit, offset: q.offset },
        );
        return reply.send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/products/:id/purchase-insights',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canViewSupplierPricing(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        if (!canBrowseProductsForPos(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const out = await productPurchaseInsightsService.getProductPurchaseInsights(
          request.authUser.shopId,
          id,
        );
        if (!out) {
          return reply.status(404).send({ code: 'NOT_FOUND', message: 'Product' });
        }
        return reply.send(out);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/products/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canBrowseProductsForPos(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const row = await productService.getProductById(
          request.authUser.shopId,
          id,
        );
        if (!row) {
          return reply.status(404).send({ code: 'NOT_FOUND', message: 'Product' });
        }
        return reply.send(mapProductForRole(row, request.authUser));
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/products',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'products.edit')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            sku: z.string().min(1),
            name: z.string().min(1),
            barcode: z.string().optional().nullable(),
            categoryId: z.string().uuid().optional().nullable(),
            brandId: z.string().uuid().optional().nullable(),
            uomId: z.string().uuid().optional().nullable(),
            trackingMode: z.enum(['SERIALIZED', 'QUANTITY']),
            costMethod: z.enum(['MOVING_AVG', 'FIFO']).optional(),
            unitCost: z.string().optional(),
            listPrice: z.string().optional(),
            minStockLevel: z.number().optional(),
            isBundle: z.boolean().optional(),
            active: z.boolean().optional(),
            metadata: z.record(z.unknown()).optional(),
            website: z
              .object({
                visible: z.boolean().optional(),
                slug: z.string().min(1).nullable().optional(),
                shortDescription: z.string().nullable().optional(),
                longDescription: z.string().nullable().optional(),
              })
              .optional(),
            autoBarcode: z.boolean().optional(),
            inventoryTracked: z.boolean().optional(),
            openingQty: z.number().min(0).optional(),
            openingSerials: z.array(z.string().min(1)).optional(),
            openingBatches: z
              .array(
                z.object({
                  qty: z.string(),
                  manufacturedAt: z.string().nullable().optional(),
                  expiresAt: z.string().nullable().optional(),
                  supplierLotCode: z.string().nullable().optional(),
                  batchCode: z.string().nullable().optional(),
                }),
              )
              .optional(),
            batchTrackingEnabled: z.boolean().optional(),
            batchDatesRequired: z.boolean().optional(),
          })
          .parse(request.body);

        const row = await productService.createProduct(request.authUser.shopId, {
          ...body,
          createdByUserId: request.authUser.userId,
        });
        return reply.status(201).send(row);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.patch(
    '/products/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'products.edit')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            name: z.string().optional(),
            sku: z.string().optional(),
            barcode: z.string().nullable().optional(),
            categoryId: z.string().uuid().nullable().optional(),
            brandId: z.string().uuid().nullable().optional(),
            uomId: z.string().uuid().nullable().optional(),
            listPrice: z.string().optional(),
            unitCost: z.string().optional(),
            minStockLevel: z.number().optional(),
            active: z.boolean().optional(),
            isBundle: z.boolean().optional(),
            metadata: z.record(z.unknown()).optional(),
            website: z
              .object({
                visible: z.boolean().optional(),
                slug: z.string().min(1).nullable().optional(),
                shortDescription: z.string().nullable().optional(),
                longDescription: z.string().nullable().optional(),
              })
              .optional(),
            inventoryTracked: z.boolean().optional(),
            batchTrackingEnabled: z.boolean().optional(),
            batchDatesRequired: z.boolean().optional(),
          })
          .parse(request.body);

        const row = await productService.updateProduct(
          request.authUser.shopId,
          id,
          body,
        );
        return reply.send(mapProductForRole(row, request.authUser));
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.put(
    '/products/:id/bundle-items',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'products.edit')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            items: z.array(
              z.object({
                componentProductId: z.string().uuid(),
                quantity: z.string(),
              }),
            ),
          })
          .parse(request.body);

        await productService.setBundleItems(request.authUser.shopId, id, body.items);
        const items = await productService.getBundleItems(id);
        return reply.send({ items });
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/products/:id/bundle-items',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canBrowseProductsForPos(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        // Enforce shop isolation: ensure the bundle product belongs to this shop.
        const bundle = await productService.getProductById(request.authUser.shopId, id);
        if (!bundle || !bundle.isBundle) {
          return reply.status(404).send({ code: 'NOT_FOUND', message: 'Bundle product' });
        }
        const items = await productService.getBundleItems(id);
        return reply.send({ items });
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            details: e.flatten(),
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
