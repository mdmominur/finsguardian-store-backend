import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import * as purchaseReturnService from '../../services/purchase-return.service.js';

export async function registerPurchaseReturnRoutes(app: FastifyInstance) {
  app.get(
    '/purchase-returns/suggested-unit-cost',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'purchase_orders.manage')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      if (!hasPermission(request.authUser, 'finance.pricing')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const q = z
        .object({
          supplierId: z.string().uuid(),
          productId: z.string().uuid(),
          refPoId: z.string().uuid().optional().nullable(),
        })
        .parse(request.query);
      const out = await purchaseReturnService.suggestedReturnUnitCost(
        request.authUser.shopId,
        q.supplierId,
        q.productId,
        q.refPoId ?? null,
      );
      return reply.send(out);
    },
  );

  app.get(
    '/purchase-returns',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'purchase_orders.view')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const q = z.object({ limit: z.coerce.number().default(50) }).parse(request.query);
      const items = await purchaseReturnService.listPurchaseReturns(
        request.authUser.shopId,
        q.limit,
      );
      return reply.send({ items });
    },
  );

  app.post(
    '/purchase-returns',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'purchase_orders.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            supplierId: z.string().uuid(),
            refPoId: z.string().uuid().optional().nullable(),
            returnDate: z.string().optional().nullable(),
            note: z.string().optional().nullable(),
            paymentMethodId: z.string().uuid(),
            refundAmount: z.string(),
            lines: z.array(
              z.union([
                z.object({
                  productId: z.string().uuid(),
                  tracking: z.literal('QUANTITY'),
                  locationId: z.string().uuid().optional().nullable(),
                  qty: z.string(),
                  unitCost: z.string().optional().nullable(),
                  poLineId: z.string().uuid().optional().nullable(),
                  batchId: z.string().uuid().optional().nullable(),
                }),
                z.object({
                  productId: z.string().uuid(),
                  tracking: z.literal('SERIALIZED'),
                  deviceUnitId: z.string().uuid(),
                  unitCost: z.string().optional().nullable(),
                  poLineId: z.string().uuid().optional().nullable(),
                }),
              ]),
            ),
          })
          .parse(request.body);

        const out = await purchaseReturnService.createPurchaseReturn(
          request.authUser.shopId,
          request.authUser.userId,
          body,
        );
        return reply.status(201).send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
