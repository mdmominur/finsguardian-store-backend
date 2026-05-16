import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import {
  canListStockLocationsForOperations,
  canUseInventoryDashboard,
  hasPermission,
} from '../../lib/permissions.js';
import * as invLocService from '../../services/inventory-location.service.js';
import { isMultiStockLocationEnabled } from '../../services/shop-features.service.js';
import * as locService from '../../services/stock-location.service.js';

export async function registerLocationRoutes(app: FastifyInstance) {
  app.get(
    '/stock-locations',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!canListStockLocationsForOperations(request.authUser)) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const items = await locService.listLocations(request.authUser.shopId);
      return reply.send({ items });
    },
  );

  app.post(
    '/stock-locations',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'locations.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        if (!(await isMultiStockLocationEnabled(request.authUser.shopId))) {
          return reply.status(403).send({
            code: 'FEATURE_DISABLED',
            message:
              'Multiple stock locations are off for this shop. Turn them on in Shop settings to add or edit locations.',
          });
        }
        const body = z
          .object({
            name: z.string().min(1),
            setAsDefault: z.boolean().optional(),
          })
          .parse(request.body);
        const row = await locService.createLocation(request.authUser.shopId, {
          name: body.name,
          setAsDefault: body.setAsDefault,
        });
        return reply.status(201).send(row);
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
    '/stock-locations/:id/inventory',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (
        !canListStockLocationsForOperations(request.authUser) &&
        !canUseInventoryDashboard(request.authUser)
      ) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      try {
        const out = await invLocService.getStockLocationInventory(request.authUser.shopId, id);
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/inventory/serialized-transfers',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'inventory.adjust')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            transfers: z.array(
              z.object({
                deviceUnitId: z.string().uuid(),
                toLocationId: z.string().uuid(),
              }),
            ),
          })
          .parse(request.body);
        const result = await invLocService.transferSerializedDevices(
          request.authUser.shopId,
          request.authUser.userId,
          body.transfers,
        );
        return reply.send(result);
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

  app.post(
    '/inventory/quantity-transfers',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'inventory.adjust')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            fromLocationId: z.string().uuid(),
            toLocationId: z.string().uuid(),
            productId: z.string().uuid(),
            qty: z.string().optional().nullable(),
            transferAll: z.boolean().optional(),
          })
          .parse(request.body);
        const result = await invLocService.transferQuantityBetweenLocations(
          request.authUser.shopId,
          request.authUser.userId,
          {
            fromLocationId: body.fromLocationId,
            toLocationId: body.toLocationId,
            productId: body.productId,
            qty: body.qty,
            transferAll: body.transferAll,
          },
        );
        return reply.send(result);
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
    '/stock-locations/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'locations.manage')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        if (!(await isMultiStockLocationEnabled(request.authUser.shopId))) {
          return reply.status(403).send({
            code: 'FEATURE_DISABLED',
            message:
              'Multiple stock locations are off for this shop. Turn them on in Shop settings to edit locations.',
          });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            name: z.string().min(1).optional(),
            setAsDefault: z.boolean().optional(),
          })
          .refine((b) => b.name !== undefined || b.setAsDefault === true, {
            message: 'Provide name and/or setAsDefault',
          })
          .parse(request.body);
        const row = await locService.updateLocation(request.authUser.shopId, id, {
          name: body.name,
          setAsDefault: body.setAsDefault,
        });
        return reply.send(row);
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
