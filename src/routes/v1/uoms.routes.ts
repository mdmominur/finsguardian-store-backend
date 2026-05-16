import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hasPermission } from '../../lib/permissions.js';
import * as uomService from '../../services/uom.service.js';

export async function registerUomRoutes(app: FastifyInstance) {
  app.get('/uoms', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      if (!hasPermission(request.authUser, 'products.read')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const items = await uomService.listUoms(request.authUser.shopId);
      return reply.send({ items });
    } catch (e) {
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.post('/uoms', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      if (!hasPermission(request.authUser, 'catalog.taxonomy')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const body = z
        .object({
          name: z.string().min(1),
          symbol: z.string().optional().nullable(),
        })
        .parse(request.body);
      const row = await uomService.createUom(request.authUser.shopId, body);
      return reply.status(201).send(row);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', details: e.flatten() });
      }
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });

  app.patch('/uoms/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    try {
      if (!hasPermission(request.authUser, 'catalog.taxonomy')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          name: z.string().min(1).optional(),
          symbol: z.string().optional().nullable(),
          isActive: z.boolean().optional(),
        })
        .refine((b) => b.name !== undefined || b.symbol !== undefined || b.isActive !== undefined, {
          message: 'Provide name and/or symbol and/or isActive',
        })
        .parse(request.body);
      const row = await uomService.updateUom(request.authUser.shopId, id, body);
      return reply.send(row);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({ code: 'VALIDATION_ERROR', details: e.flatten() });
      }
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });
}

