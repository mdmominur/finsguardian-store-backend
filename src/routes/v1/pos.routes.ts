import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import * as posService from '../../services/pos.service.js';
import * as storefrontFulfillment from '../../services/storefront-fulfillment.service.js';

export async function registerPosRoutes(app: FastifyInstance) {
  app.get(
    '/pos/resolve',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'pos.use')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const q = z
        .object({
          q: z.string().min(1),
          /** The till's location, so the product answer carries real on-hand stock. */
          locationId: z.string().uuid().optional(),
        })
        .parse(request.query);
      const out = await posService.resolveScan(request.authUser.shopId, q.q, q.locationId);
      return reply.send(out);
    },
  );

  /**
   * Camera packet scan (enrolment-driven lookup).
   * Body: `{ barcode?: string, locationId?: string }` — decoded on the device, nothing is recognised
   * server-side. Barcode → exact product (with on-hand stock); anything else → `not_found` (never a
   * guess).
   */
  app.post(
    '/pos/resolve-scan',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'pos.use')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            barcode: z.string().max(128).nullable().optional(),
            locationId: z.string().uuid().nullable().optional(),
          })
          .parse(request.body ?? {});

        const out = await posService.resolveScanPayload(request.authUser.shopId, body);
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
    '/pos/holds',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'pos.use')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const body = z
        .object({
          name: z.string().optional(),
          payload: z.unknown(),
          expiresAt: z.string().nullable().optional(),
        })
        .parse(request.body);

      const row = await posService.createHold(
        request.authUser.shopId,
        request.authUser.userId,
        {
          name: body.name,
          payload: body.payload,
          expiresAt: body.expiresAt ?? undefined,
        },
      );
      return reply.status(201).send(row);
    },
  );

  app.get(
    '/pos/holds',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'pos.use')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const items = await posService.listHolds(request.authUser.shopId);
      return reply.send({ items });
    },
  );

  app.delete(
    '/pos/holds/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'pos.use')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      await posService.deleteHold(request.authUser.shopId, id);
      return reply.status(204).send();
    },
  );

  app.get(
    '/pos/holds/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'pos.use')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      try {
        const row = await posService.getHold(request.authUser.shopId, id);
        return reply.send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/pos/checkout',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'pos.use')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }

        const paymentSchema = z.object({
          paymentMethodId: z.string().uuid(),
          amount: z.string(),
          providerReference: z.string().nullable().optional(),
        });

        const body = z
          .object({
            customerId: z.string().uuid().nullable().optional(),
            promisePayDate: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/)
              .optional()
              .nullable(),
            idempotencyKey: z.string().nullable().optional(),
            locationId: z.string().uuid().optional().nullable(),
            deliveryLocationId: z.string().uuid().optional().nullable(),
            lines: z.array(
              z.object({
                productId: z.string().uuid(),
                qty: z.string(),
                unitPrice: z.string().optional(),
                discount: z.string().optional(),
                deviceUnitIds: z.array(z.string().uuid()).optional(),
                locationId: z.string().uuid().optional().nullable(),
                batchId: z.string().uuid().optional().nullable(),
                batchAllocations: z
                  .array(
                    z.object({
                      batchId: z.string().uuid(),
                      qty: z.string(),
                    }),
                  )
                  .optional(),
              }),
            ),
            cartDiscount: z
              .object({
                type: z.enum(['FIXED', 'PERCENT']),
                value: z.string(),
              })
              .nullable()
              .optional(),
            payments: z.array(paymentSchema),
            /** When fulfilling a website bag order from POS (links sale to `storefront_fulfillment_orders`). */
            fulfillmentOrderId: z.string().uuid().optional(),
            channel: z.enum(['POS', 'WEB']).optional(),
          })
          .parse(request.body);

        const idem = request.headers['idempotency-key'];
        const idempotencyKey =
          typeof idem === 'string' && idem.trim()
            ? idem.trim()
            : (body.idempotencyKey ?? undefined);

        const out = await posService.checkout(
          request.authUser.shopId,
          request.authUser.userId,
          {
            customerId: body.customerId ?? undefined,
            promisePayDate: body.promisePayDate ?? undefined,
            idempotencyKey: idempotencyKey ?? null,
            locationId: body.locationId ?? undefined,
            deliveryLocationId: body.deliveryLocationId ?? undefined,
            lines: body.lines,
            cartDiscount: body.cartDiscount ?? null,
            payments: body.payments.map((p) => ({
              paymentMethodId: p.paymentMethodId,
              amount: p.amount,
              providerReference: p.providerReference ?? null,
            })),
            channel: body.channel ?? 'POS',
          },
        );

        if (!out.duplicate && body.fulfillmentOrderId) {
          try {
            await storefrontFulfillment.attachSaleToFulfillmentOrder({
              shopId: request.authUser.shopId,
              fulfillmentOrderId: body.fulfillmentOrderId,
              saleId: out.sale.id,
              expectedCustomerId: body.customerId ?? null,
            });
          } catch (linkErr) {
            request.log.error({ err: linkErr }, 'Failed to link website fulfillment order to sale');
          }
        }

        if (out.duplicate) {
          return reply.status(200).send({ duplicate: true, sale: out.sale });
        }
        return reply.status(201).send({ duplicate: false, sale: out.sale });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
