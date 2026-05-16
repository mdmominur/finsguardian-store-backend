import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission, canUseCustomersForPosCheckout } from '../../lib/permissions.js';
import * as customerService from '../../services/customer.service.js';
import { assertShopModule } from '../../services/shop-features.service.js';

export async function registerCustomerRoutes(app: FastifyInstance) {
  app.get(
    '/customers',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!canUseCustomersForPosCheckout(request.authUser)) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const q = z
        .object({
          search: z.string().optional(),
          limit: z.coerce.number().min(1).max(200).default(50),
          offset: z.coerce.number().min(0).default(0),
          dueOnly: z.preprocess(
            (val) => {
              if (val === undefined || val === null || val === '') return false;
              return val === 'true' || val === '1' || val === true;
            },
            z.boolean(),
          ),
        })
        .parse(request.query);

      const items = await customerService.listCustomers(request.authUser.shopId, q);
      return reply.send({ items });
    },
  );

  app.post(
    '/customers',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canUseCustomersForPosCheckout(request.authUser)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            name: z.string().min(1),
            phone: z.string().min(6),
            email: z
              .union([z.string().email(), z.literal(''), z.null()])
              .optional()
              .transform((v) => (v === '' || v === undefined ? null : v)),
            address: z.string().nullable().optional(),
            notes: z.string().nullable().optional(),
          })
          .parse(request.body);

        const row = await customerService.createCustomer(
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

  app.patch(
    '/customers/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'customers.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            name: z.string().min(1),
            phone: z.string().min(6),
            email: z
              .union([z.string().email(), z.literal(''), z.null()])
              .optional()
              .transform((v) => (v === '' || v === undefined ? null : v)),
            address: z.string().nullable().optional(),
            notes: z.string().nullable().optional(),
          })
          .parse(request.body);

        const row = await customerService.updateCustomer(request.authUser.shopId, id, {
          name: body.name,
          phone: body.phone,
          email: body.email ?? null,
          address: body.address ?? null,
          notes: body.notes ?? null,
        });
        return reply.send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/customers/:id/due-sales',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'customers.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const items = await customerService.listCustomerOpenDueSales(request.authUser.shopId, id);
        return reply.send({ items });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/customers/:id/payments',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'customers.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            amount: z.string(),
            note: z.string().optional(),
            allocations: z
              .array(
                z.object({
                  saleId: z.string().uuid(),
                  amount: z.string(),
                }),
              )
              .optional(),
          })
          .parse(request.body);
        const out = await customerService.recordCustomerPayment(
          request.authUser.shopId,
          id,
          {
            amount: body.amount,
            note: body.note,
            allocations: body.allocations,
          },
        );
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/customers/receipts',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'receipts.manage')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      try {
        await assertShopModule(request.authUser.shopId, 'moneyReceiptsModuleEnabled');
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
      const q = z
        .object({
          search: z.string().optional(),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
          limit: z.coerce.number().min(1).max(20).default(20),
          offset: z.coerce.number().min(0).default(0),
        })
        .parse(request.query);

      const { items, total } = await customerService.listMoneyReceipts(
        request.authUser.shopId,
        {
          search: q.search,
          from: q.from ? new Date(q.from) : undefined,
          to: q.to ? new Date(q.to) : undefined,
          limit: q.limit,
          offset: q.offset,
        },
      );
      return reply.send({ items, total });
    },
  );

  app.get(
    '/customers/receipts/:ledgerId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'receipts.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        await assertShopModule(request.authUser.shopId, 'moneyReceiptsModuleEnabled');
        const { ledgerId } = z
          .object({ ledgerId: z.coerce.number().int().positive() })
          .parse(request.params);
        const out = await customerService.getMoneyReceiptDetail(
          request.authUser.shopId,
          ledgerId,
        );
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
