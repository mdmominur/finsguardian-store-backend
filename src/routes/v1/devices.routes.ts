import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import {
  hasPermission,
  canListProductSerialsForCheckout,
  canListSerialsForPurchaseReturn,
} from '../../lib/permissions.js';
import * as deviceService from '../../services/device.service.js';
import { assertShopModule } from '../../services/shop-features.service.js';

export async function registerDeviceRoutes(app: FastifyInstance) {
  app.get(
    '/imei/search',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'devices.registry')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const q = z.object({ q: z.string().min(2) }).parse(request.query);
      const rows = await deviceService.searchImei(request.authUser.shopId, q.q);
      return reply.send({ items: rows });
    },
  );

  app.get(
    '/device-units',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'devices.registry')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      try {
        await assertShopModule(request.authUser.shopId, 'deviceRegistryEnabled');
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
      const q = z
        .object({
          search: z.string().optional(),
          status: z.string().optional(),
          blocklisted: z.coerce.boolean().optional(),
          stockLocationId: z.string().uuid().optional(),
          limit: z.coerce.number().min(1).max(20).default(20),
          offset: z.coerce.number().min(0).default(0),
        })
        .parse(request.query);
      const result = await deviceService.listDeviceUnits(request.authUser.shopId, q);
      return reply.send(result);
    },
  );

  app.get(
    '/device-units/stats',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'devices.registry')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        await assertShopModule(request.authUser.shopId, 'deviceRegistryEnabled');
        const stats = await deviceService.getDeviceUnitStats(request.authUser.shopId);
        return reply.send(stats);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/device-units/:id/timeline',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'devices.registry')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      try {
        await assertShopModule(request.authUser.shopId, 'deviceRegistryEnabled');
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const unit = await deviceService.getDeviceUnit(request.authUser.shopId, id);
      if (!unit) return reply.status(404).send({ code: 'NOT_FOUND', message: 'Unit' });
      const events = await deviceService.getTimeline(id);
      return reply.send({ unit, events });
    },
  );

  app.patch(
    '/device-units/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'devices.registry')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        await assertShopModule(request.authUser.shopId, 'deviceRegistryEnabled');
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            blocklisted: z.boolean().optional(),
            blocklistReason: z.string().nullable().optional(),
            channelTag: z.enum(['OFFICIAL', 'UNOFFICIAL']).nullable().optional(),
            notes: z.string().nullable().optional(),
            imei1: z.string().nullable().optional(),
            imei2: z.string().nullable().optional(),
            uniqueIdentifier: z.string().nullable().optional(),
          })
          .parse(request.body);

        const row = await deviceService.updateDeviceUnit(
          request.authUser.shopId,
          id,
          request.authUser.userId,
          body,
        );
        return reply.send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/products/:productId/device-units',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (
        !canListProductSerialsForCheckout(request.authUser) &&
        !canListSerialsForPurchaseReturn(request.authUser)
      ) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const { productId } = z
        .object({ productId: z.string().uuid() })
        .parse(request.params);
      const q = z
        .object({
          search: z.string().optional(),
          status: z.string().optional(),
          stockLocationId: z.string().uuid().optional(),
          limit: z.coerce.number().min(1).max(200).default(100),
          offset: z.coerce.number().min(0).default(0),
        })
        .parse(request.query);
      const items = await deviceService.listProductSerials(
        request.authUser.shopId,
        productId,
        q,
      );
      return reply.send({ items });
    },
  );
}
