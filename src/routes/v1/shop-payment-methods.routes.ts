import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import * as shopPaymentMethodService from '../../services/shop-payment-method.service.js';

export async function registerShopPaymentMethodRoutes(app: FastifyInstance) {
  /* ── GET /shop-payment-methods ─ list (with balances) ─────────────────── */
  app.get(
    '/shop-payment-methods',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (
        !hasPermission(request.authUser, 'pos.use') &&
        !hasPermission(request.authUser, 'finance.pricing') &&
        !hasPermission(request.authUser, 'sales.refund')
      ) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const withBalances = (request.query as Record<string, string>).withBalances === '1';
      if (withBalances && hasPermission(request.authUser, 'finance.pricing')) {
        const items = await shopPaymentMethodService.listPaymentMethodsWithBalances(request.authUser.shopId);
        return reply.send({ items });
      }
      const items = await shopPaymentMethodService.listShopPaymentMethods(request.authUser.shopId);
      return reply.send({ items });
    },
  );

  /* ── POST /shop-payment-methods ─ create ──────────────────────────────── */
  app.post(
    '/shop-payment-methods',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({ name: z.string().min(1), sortOrder: z.number().int().optional() })
          .parse(request.body);
        const row = await shopPaymentMethodService.createShopPaymentMethod(request.authUser.shopId, body);
        return reply.status(201).send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  /* ── PATCH /shop-payment-methods/:id ─ update one ─────────────────────── */
  app.patch(
    '/shop-payment-methods/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            name: z.string().min(1).optional(),
            sortOrder: z.number().int().optional(),
            isActive: z.boolean().optional(),
          })
          .parse(request.body);
        const row = await shopPaymentMethodService.updateShopPaymentMethod(request.authUser.shopId, id, body);
        return reply.send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  /* ── PUT /shop-payment-methods/reorder ─ bulk reorder ─────────────────── */
  app.put(
    '/shop-payment-methods/reorder',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            items: z.array(z.object({ id: z.string().uuid(), sortOrder: z.number().int() })),
          })
          .parse(request.body);
        await shopPaymentMethodService.reorderPaymentMethods(request.authUser.shopId, body.items);
        return reply.send({ ok: true });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
