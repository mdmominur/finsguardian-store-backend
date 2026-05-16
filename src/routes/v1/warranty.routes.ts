import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import * as warrantyService from '../../services/warranty.service.js';
import { assertShopModule } from '../../services/shop-features.service.js';

export async function registerWarrantyRoutes(app: FastifyInstance) {
  app.get(
    '/warranty/claims',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'warranty.manage')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      try {
        await assertShopModule(request.authUser.shopId, 'warrantyModuleEnabled');
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
      const items = await warrantyService.listClaims(request.authUser.shopId);
      return reply.send({ items });
    },
  );

  app.post(
    '/warranty/claims',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'warranty.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        await assertShopModule(request.authUser.shopId, 'warrantyModuleEnabled');
        const body = z
          .object({
            customerId: z.string().uuid(),
            saleId: z.string().uuid().nullable().optional(),
            productId: z.string().uuid().nullable().optional(),
            deviceUnitId: z.string().uuid().nullable().optional(),
            reportedIssue: z.string().nullable().optional(),
            physicalCondition: z.string().nullable().optional(),
            includedAccessories: z.string().nullable().optional(),
            termsSnapshot: z.string().nullable().optional(),
            notes: z.string().nullable().optional(),
          })
          .parse(request.body);

        const row = await warrantyService.createClaim(
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

  app.patch(
    '/warranty/claims/:id/status',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'warranty.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        await assertShopModule(request.authUser.shopId, 'warrantyModuleEnabled');
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            status: z.string().min(1),
            note: z.string().nullable().optional(),
            supplierId: z.string().uuid().nullable().optional(),
            vendorRmaNumber: z.string().nullable().optional(),
            replacementDeviceUnitId: z.string().uuid().nullable().optional(),
          })
          .parse(request.body);

        const row = await warrantyService.updateClaimStatus(
          request.authUser.shopId,
          request.authUser.userId,
          id,
          body,
        );
        return reply.send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
