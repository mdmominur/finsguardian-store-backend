import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import * as poService from '../../services/po.service.js';

export async function registerPurchaseOrderRoutes(app: FastifyInstance) {
  app.get(
    '/purchase-orders',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'purchase_orders.view')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const q = z
        .object({
          completedOnly: z.coerce.boolean().optional(),
        })
        .parse(request.query);
      const items = await poService.listPurchaseOrdersWithSettlement(request.authUser.shopId, {
        completedOnly: q.completedOnly === true,
      });
      return reply.send({ items });
    },
  );

  app.get(
    '/purchase-orders/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'purchase_orders.view')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const po = await poService.getPurchaseOrder(request.authUser.shopId, id);
      if (!po) return reply.status(404).send({ code: 'NOT_FOUND', message: 'PO' });
      return reply.send(po);
    },
  );

  app.post(
    '/purchase-orders',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'purchase_orders.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            supplierId: z.string().uuid(),
            orderDate: z.string().optional(),
            expectedDate: z.string().nullable().optional(),
            note: z.string().nullable().optional(),
            lines: z.array(
              z.object({
                productId: z.string().uuid(),
                qtyOrdered: z.string(),
                unitCost: z.string(),
              }),
            ),
          })
          .parse(request.body);

        const po = await poService.createPurchaseOrder(
          request.authUser.shopId,
          request.authUser.userId,
          body,
        );
        return reply.status(201).send(po);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.patch(
    '/purchase-orders/:id/status',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'purchase_orders.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            status: z.enum(['DRAFT', 'SENT', 'CANCELLED']),
          })
          .parse(request.body);
        const row = await poService.updatePoStatus(
          request.authUser.shopId,
          id,
          body.status,
        );
        return reply.send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.patch(
    '/purchase-orders/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'purchase_orders.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            supplierId: z.string().uuid().optional(),
            orderDate: z.string().optional(),
            expectedDate: z.string().nullable().optional(),
            note: z.string().nullable().optional(),
            lines: z
              .array(
                z.object({
                  productId: z.string().uuid(),
                  qtyOrdered: z.string(),
                  unitCost: z.string(),
                }),
              )
              .optional(),
          })
          .parse(request.body);

        const po = await poService.updatePurchaseOrder(
          request.authUser.shopId,
          id,
          body,
        );
        return reply.send(po);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );


  app.post(
    '/purchase-orders/:id/receive',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'purchase_orders.receive')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            locationId: z.string().uuid().optional(),
            lines: z.array(
              z.object({
                poLineId: z.string().uuid(),
                qty: z.string(),
                unitCost: z.string().optional(),
                batches: z
                  .array(
                    z.object({
                      qty: z.string(),
                      manufacturedAt: z.string().optional().nullable(), // YYYY-MM-DD
                      expiresAt: z.string().optional().nullable(), // YYYY-MM-DD
                      supplierLotCode: z.string().optional().nullable(),
                      batchCode: z.string().optional().nullable(), // optional override
                    }),
                  )
                  .optional(),
                serials: z
                  .array(
                    z.object({
                      serial: z.string().min(1),
                      imei1: z.string().optional().nullable(),
                      imei2: z.string().optional().nullable(),
                      locationId: z.string().uuid().optional().nullable(),
                    }),
                  )
                  .optional(),
              }),
            ),
          })
          .parse(request.body);

        const po = await poService.receivePurchaseOrder(
          request.authUser.shopId,
          request.authUser.userId,
          id,
          body,
        );
        return reply.send(po);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
