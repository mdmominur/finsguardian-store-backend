import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateInternal } from '../../../lib/authenticate-internal.js';
import { AppError, sendAppError } from '../../../lib/errors.js';
import * as internalShops from '../../../services/internal-dashboard-shops.service.js';

/** Standard UUID string shape (Postgres `uuid` / `gen_random_uuid`). */
const SHOP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseShopId(raw: string): string {
  const id = raw?.trim() ?? '';
  if (!SHOP_ID_RE.test(id)) {
    throw AppError.badRequest('Invalid shop id (expected UUID)');
  }
  return id;
}

const listQuery = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  status: z.enum(['trialing', 'active', 'lapsed', 'suspended']).optional(),
  q: z.string().optional(),
  sort: z.enum(['paidThroughAsc', 'createdDesc']).optional(),
});

const recordPaymentBody = z.object({
  amount: z.union([z.string(), z.number()]).transform((v) => String(v)),
  periodDays: z.coerce.number().min(1).max(3660).optional().default(30),
  paidAt: z.string().optional().nullable(),
  note: z.string().optional().nullable(),
});

const patchShopBody = z
  .object({
    suspended: z.boolean().optional(),
    paidThrough: z.union([z.string(), z.null()]).optional(),
    /** Set trial end only (does not change paid_through). ISO 8601 instant. */
    trialEndsAt: z.string().optional(),
    customerWebsiteEnabled: z.boolean().optional(),
    maxUsers: z.number().int().min(1).optional(),
  })
  .refine(
    (d) =>
      d.suspended !== undefined ||
      d.paidThrough !== undefined ||
      d.trialEndsAt !== undefined ||
      d.customerWebsiteEnabled !== undefined ||
      d.maxUsers !== undefined,
    { message: 'Provide at least one of suspended, paidThrough, trialEndsAt, customerWebsiteEnabled, or maxUsers' },
  );

export async function registerInternalShopRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticateInternal);

  app.get('/metrics/summary', async (_request, reply) => {
    try {
      const out = await internalShops.internalMetricsSummary();
      return reply.send(out);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.get('/shops', async (request, reply) => {
    try {
      const qs = listQuery.parse(request.query);
      const out = await internalShops.internalListShops({
        limit: qs.limit,
        offset: qs.offset,
        status: qs.status,
        search: qs.q,
        sort: qs.sort,
      });
      return reply.send(out);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid query',
          details: e.flatten(),
        });
      }
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.get<{ Params: { shopId: string } }>('/shops/:shopId', async (request, reply) => {
    try {
      const shopId = parseShopId(request.params.shopId);
      const out = await internalShops.internalGetShop(shopId);
      return reply.header('Content-Type', 'application/json; charset=utf-8').send(out);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.patch<{ Params: { shopId: string } }>('/shops/:shopId', async (request, reply) => {
    try {
      const shopId = parseShopId(request.params.shopId);
      const body = patchShopBody.parse(request.body);
      let paidThrough: Date | null | undefined;
      if (body.paidThrough !== undefined) {
        if (body.paidThrough === null) {
          paidThrough = null;
        } else {
          const d = new Date(body.paidThrough);
          if (Number.isNaN(d.getTime())) {
            return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid paidThrough' });
          }
          paidThrough = d;
        }
      }
      let trialEndsAt: Date | undefined;
      if (body.trialEndsAt !== undefined) {
        const d = new Date(body.trialEndsAt);
        if (Number.isNaN(d.getTime())) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid trialEndsAt' });
        }
        trialEndsAt = d;
      }
      const out = await internalShops.internalUpdateShop(shopId, {
        suspended: body.suspended,
        paidThrough,
        trialEndsAt,
        customerWebsiteEnabled: body.customerWebsiteEnabled,
        maxUsers: body.maxUsers,
      });
      return reply.header('Content-Type', 'application/json; charset=utf-8').send(out);
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
  });

  app.post<{ Params: { shopId: string } }>(
    '/shops/:shopId/subscription-payments',
    async (request, reply) => {
      try {
        const shopId = parseShopId(request.params.shopId);
        const uid = request.internalAuth?.userId;
        if (!uid) {
          return reply.status(401).send({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
        }
        const body = recordPaymentBody.parse(request.body);
        const paidAt =
          body.paidAt && body.paidAt.trim() !== ''
            ? new Date(body.paidAt)
            : null;
        if (paidAt && Number.isNaN(paidAt.getTime())) {
          return reply.status(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid paidAt' });
        }
        const out = await internalShops.internalRecordSubscriptionPayment(shopId, uid, {
          amount: body.amount,
          periodDays: body.periodDays,
          paidAt,
          note: body.note,
        });
        return reply.status(201).header('Content-Type', 'application/json; charset=utf-8').send(out);
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

  app.get<{ Params: { shopId: string } }>('/shops/:shopId/users', async (request, reply) => {
    try {
      const shopId = parseShopId(request.params.shopId);
      const out = await internalShops.internalGetShopUsers(shopId);
      return reply.header('Content-Type', 'application/json; charset=utf-8').send(out);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.get<{ Params: { shopId: string } }>('/shops/:shopId/products', async (request, reply) => {
    try {
      const shopId = parseShopId(request.params.shopId);
      const qs = z
        .object({
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
          q: z.string().optional(),
        })
        .parse(request.query);
      const out = await internalShops.internalGetShopProducts(shopId, qs.limit, qs.offset, qs.q);
      return reply.header('Content-Type', 'application/json; charset=utf-8').send(out);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid query',
          details: e.flatten(),
        });
      }
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.get<{ Params: { shopId: string } }>('/shops/:shopId/suppliers', async (request, reply) => {
    try {
      const shopId = parseShopId(request.params.shopId);
      const out = await internalShops.internalGetShopSuppliers(shopId);
      return reply.header('Content-Type', 'application/json; charset=utf-8').send(out);
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.get<{ Params: { shopId: string } }>('/shops/:shopId/sales', async (request, reply) => {
    try {
      const shopId = parseShopId(request.params.shopId);
      const qs = z
        .object({
          limit: z.coerce.number().min(1).max(100).default(20),
          offset: z.coerce.number().min(0).default(0),
        })
        .parse(request.query);
      const out = await internalShops.internalGetShopSales(shopId, qs.limit, qs.offset);
      return reply.header('Content-Type', 'application/json; charset=utf-8').send(out);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid query',
          details: e.flatten(),
        });
      }
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });
}
