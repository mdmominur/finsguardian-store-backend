import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import * as adjustService from '../../services/payment-method-adjustment.service.js';
import * as pmService from '../../services/shop-payment-method.service.js';

export async function registerPaymentMethodAdjustmentRoutes(app: FastifyInstance) {
  /* ── GET /shop-payment-methods/adjustments — all shop adjustments ─────── */
  app.get(
    '/shop-payment-methods/adjustments',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Requires finance.pricing' });
        }
        const q = z
          .object({
            limit: z.coerce.number().min(1).max(500).default(200),
            offset: z.coerce.number().min(0).default(0),
          })
          .parse(request.query);
        const items = await adjustService.listAdjustments(request.authUser.shopId, q);
        return reply.send({ items });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/shop-payment-methods/:id/adjust',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Requires finance.pricing' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            amount: z.string(),
            type: z.enum(['IN', 'OUT']),
            note: z.string().nullable().optional(),
          })
          .parse(request.body);
        const row = await adjustService.createAdjustment(request.authUser.shopId, request.authUser.userId, {
          paymentMethodId: id,
          ...body,
        });
        return reply.status(201).send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/shop-payment-methods/:id/adjustments',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Requires finance.pricing' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const q = z
          .object({
            limit: z.coerce.number().min(1).max(200).default(50),
            offset: z.coerce.number().min(0).default(0),
          })
          .parse(request.query);
        const items = await adjustService.listAdjustments(request.authUser.shopId, {
          paymentMethodId: id,
          ...q,
        });
        return reply.send({ items });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  /* ── GET /shop-payment-methods/:id/transactions ─────────────────────── */
  app.get(
    '/shop-payment-methods/:id/transactions',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Requires finance.pricing' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const q = z
          .object({
            limit: z.coerce.number().min(1).max(200).default(100),
            offset: z.coerce.number().min(0).default(0),
          })
          .parse(request.query);
        const [result, balance] = await Promise.all([
          pmService.listPaymentMethodTransactions(request.authUser.shopId, id, q),
          pmService.getPaymentMethodBalance(request.authUser.shopId, id),
        ]);
        return reply.send({ ...result, balance });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  /* ── GET /shop-payment-methods/:id ─ single method info ─────────────── */
  app.get(
    '/shop-payment-methods/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Requires finance.pricing' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const methods = await pmService.listPaymentMethodsWithBalances(request.authUser.shopId);
        const m = methods.find((x) => x.id === id);
        if (!m) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Payment method not found' });
        return reply.send(m);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  /* ── POST /shop-payment-methods/transfer ─ transfer between methods ───── */
  app.post(
    '/shop-payment-methods/transfer',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Requires finance.pricing' });
        }
        const body = z
          .object({
            fromPaymentMethodId: z.string().uuid(),
            toPaymentMethodId: z.string().uuid(),
            amount: z.string(),
            note: z.string().nullable().optional(),
          })
          .parse(request.body);
        const result = await adjustService.transferBetweenMethods(
          request.authUser.shopId,
          request.authUser.userId,
          body,
        );
        return reply.status(201).send(result);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
