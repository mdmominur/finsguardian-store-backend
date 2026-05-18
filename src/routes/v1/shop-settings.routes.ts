import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { canManageShopSettings } from '../../lib/rbac.js';
import * as shopSettingsService from '../../services/shop-settings.service.js';

const patchShopBody = z.object({
  name: z.string().min(1).optional(),
  invoiceAddress: z.string().nullable().optional(),
  multiStockLocationEnabled: z.boolean().optional(),
  deviceRegistryEnabled: z.boolean().optional(),
  warrantyModuleEnabled: z.boolean().optional(),
  bundlesModuleEnabled: z.boolean().optional(),
  stockAdjustmentsEnabled: z.boolean().optional(),
  moneyReceiptsModuleEnabled: z.boolean().optional(),
  mail: z
    .object({
      smtp: z
        .object({
          host: z.string().min(1).nullable().optional(),
          port: z.number().int().min(1).max(65535).nullable().optional(),
          encryption: z.enum(['ssl', 'tls', 'none']).nullable().optional(),
          username: z.string().min(1).nullable().optional(),
          password: z.string().min(1).nullable().optional(),
          fromAddress: z.string().email().nullable().optional(),
          fromName: z.string().min(1).nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

const patchMemberBody = z
  .object({
    name: z.string().min(1).optional(),
    email: z.union([z.string().email(), z.null()]).optional(),
    phone: z.union([z.string().min(1), z.null()]).optional(),
    permissions: z.array(z.string()).optional(),
    shopRole: z.enum(['owner', 'member']).optional(),
  })
  .refine(
    (b) =>
      b.name !== undefined ||
      b.email !== undefined ||
      b.phone !== undefined ||
      b.permissions !== undefined ||
      b.shopRole !== undefined,
    { message: 'At least one field required' },
  );

const postMemberBody = z
  .object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().min(6).optional(),
    password: z.string().min(8).optional(),
    permissions: z.array(z.string()).optional(),
  })
  .refine((b) => !!(b.email?.trim() || b.phone?.trim()), {
    message: 'Email or phone required',
    path: ['email'],
  });

export async function registerShopSettingsRoutes(app: FastifyInstance) {
  app.get(
    '/shop',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageShopSettings(request.authUser.role)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Owners only' });
        }
        const out = await shopSettingsService.getShopSettings(request.authUser.shopId);
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.patch(
    '/shop',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageShopSettings(request.authUser.role)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Owners only' });
        }
        const body = patchShopBody.parse(request.body);
        const out = await shopSettingsService.updateShopSettings(request.authUser.shopId, body);
        return reply.send(out);
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

  app.get(
    '/shop/members',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageShopSettings(request.authUser.role)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Owners only' });
        }
        const items = await shopSettingsService.listShopMembers(request.authUser.shopId);
        return reply.send({ items });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/shop/members',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageShopSettings(request.authUser.role)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Owners only' });
        }
        const body = postMemberBody.parse(request.body);
        const items = await shopSettingsService.addShopMember(request.authUser.shopId, {
          name: body.name,
          email: body.email?.trim() ? body.email.trim() : null,
          phone: body.phone?.trim() ? body.phone.trim() : null,
          password: body.password ?? null,
          permissions: body.permissions,
        });
        return reply.status(201).send({ items });
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

  app.patch(
    '/shop/members/:userId',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageShopSettings(request.authUser.role)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Owners only' });
        }
        const { userId } = request.params as { userId: string };
        const body = patchMemberBody.parse(request.body);
        const items = await shopSettingsService.updateShopMember(request.authUser.shopId, userId, {
          name: body.name,
          email: body.email,
          phone: body.phone,
          permissions: body.permissions,
          shopRole: body.shopRole,
        });
        return reply.send({ items });
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
}
