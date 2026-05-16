import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { canViewSupplierPricing, hasPermission } from '../../lib/permissions.js';
import * as supplierService from '../../services/supplier.service.js';

export async function registerSupplierRoutes(app: FastifyInstance) {
  app.get(
    '/suppliers',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const includeBalance = canViewSupplierPricing(request.authUser);
      const rows = await supplierService.listSuppliers(
        request.authUser.shopId,
        includeBalance,
      );
      return reply.send({ items: rows });
    },
  );

  app.post(
    '/suppliers',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            name: z.string().min(1),
            phone: z.string().optional(),
            email: z.string().optional(),
            address: z.string().optional(),
            notes: z.string().optional(),
            openingBalance: z.string().optional(),
          })
          .parse(request.body);
        const row = await supplierService.createSupplier(
          request.authUser.shopId,
          body,
        );
        return reply.status(201).send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/suppliers/:id/payments',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            amount: z.string(),
            paymentMethodId: z.string().uuid(),
            note: z.string().optional(),
            allocations: z
              .array(
                z.object({
                  poId: z.string().uuid(),
                  amount: z.string(),
                }),
              )
              .optional(),
          })
          .parse(request.body);
        const out = await supplierService.recordSupplierPayment(
          request.authUser.shopId,
          id,
          request.authUser.userId,
          body,
        );
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/suppliers/:id/unpaid-purchase-orders',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const items = await supplierService.getSupplierUnpaidPurchaseOrders(
          request.authUser.shopId,
          id,
        );
        return reply.send({ items });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/suppliers/:id/purchase-lines',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const q = z.object({ limit: z.coerce.number().default(200) }).parse(request.query);
        const out = await supplierService.getSupplierPurchaseLines(
          request.authUser.shopId,
          id,
          q.limit,
        );
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/suppliers/:id/ledger',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'finance.pricing')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const q = z.object({ limit: z.coerce.number().default(100) }).parse(request.query);
        const out = await supplierService.getSupplierLedger(
          id,
          request.authUser.shopId,
          q.limit,
        );
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
