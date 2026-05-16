import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import * as adjService from '../../services/stock-adjustment.service.js';
import { assertShopModule } from '../../services/shop-features.service.js';

export async function registerStockAdjustmentRoutes(app: FastifyInstance) {
  app.post(
    '/stock-adjustments',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'inventory.adjust')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        await assertShopModule(request.authUser.shopId, 'stockAdjustmentsEnabled');
        const body = z
          .object({
            reason: z.string().min(1),
            note: z.string().optional(),
            lines: z.array(
              z.object({
                productId: z.string().uuid(),
                locationId: z.string().uuid().optional(),
                qtyDelta: z.string(),
                // QUANTITY (batch-tracked) adjustments:
                batchId: z.string().uuid().nullable().optional(),
                batches: z
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
                deviceUnitId: z.string().uuid().nullable().optional(),
                // For ADD mode: create new device units on the fly
                serial: z.string().optional(),
                imei1: z.string().nullable().optional(),
                imei2: z.string().nullable().optional(),
                uniqueIdentifier: z.string().nullable().optional(),
              }),
            ),
          })
          .parse(request.body);

        const row = await adjService.createStockAdjustment(
          request.authUser.shopId,
          request.authUser.userId,
          body,
        );
        return reply.status(201).send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/stock-adjustments',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'inventory.adjust')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      try {
        await assertShopModule(request.authUser.shopId, 'stockAdjustmentsEnabled');
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
      const q = z
        .object({
          limit: z.coerce.number().min(1).max(200).default(50),
          offset: z.coerce.number().min(0).default(0),
        })
        .parse(request.query);
      const items = await adjService.listAdjustments(
        request.authUser.shopId,
        q.limit,
        q.offset,
      );
      return reply.send({ items });
    },
  );
}
