import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import { canListCatalogForProducts, hasPermission } from '../../lib/permissions.js';
import * as catalog from '../../services/catalog.service.js';

export async function registerCatalogRoutes(app: FastifyInstance) {
  app.get(
    '/categories',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!canListCatalogForProducts(request.authUser)) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const rows = await catalog.listCategories(request.authUser.shopId);
      return reply.send({ items: rows });
    },
  );

  app.post(
    '/categories',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'catalog.taxonomy')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z
          .object({
            name: z.string().min(1),
            parentId: z.string().uuid().nullable().optional(),
            sortOrder: z.number().int().optional(),
          })
          .parse(request.body);
        const row = await catalog.createCategory(request.authUser.shopId, body);
        return reply.status(201).send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/brands',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!canListCatalogForProducts(request.authUser)) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      const rows = await catalog.listBrands(request.authUser.shopId);
      return reply.send({ items: rows });
    },
  );

  app.post(
    '/brands',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'catalog.taxonomy')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const body = z.object({ name: z.string().min(1) }).parse(request.body);
        const row = await catalog.createBrand(request.authUser.shopId, body);
        return reply.status(201).send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.patch(
    '/categories/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'catalog.taxonomy')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            name: z.string().min(1).optional(),
            parentId: z.string().uuid().nullable().optional(),
            sortOrder: z.number().int().optional(),
            isActive: z.boolean().optional(),
          })
          .strict()
          .superRefine((data, ctx) => {
            const has =
              data.name !== undefined ||
              data.parentId !== undefined ||
              data.sortOrder !== undefined ||
              data.isActive !== undefined;
            if (!has) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'At least one of name, parentId, sortOrder, isActive is required',
              });
            }
          })
          .parse(request.body);
        const row = await catalog.updateCategory(request.authUser.shopId, id, body);
        return reply.send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.delete(
    '/categories/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'catalog.taxonomy')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      z.object({ id: z.string().uuid() }).parse(request.params);
      return reply.status(405).send({
        code: 'METHOD_NOT_ALLOWED',
        message:
          'Categories cannot be deleted. PATCH this resource with { isActive: false } to deactivate.',
      });
    },
  );

  app.patch(
    '/brands/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!hasPermission(request.authUser, 'catalog.taxonomy')) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
        }
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = z
          .object({
            name: z.string().min(1).optional(),
            isActive: z.boolean().optional(),
          })
          .strict()
          .superRefine((data, ctx) => {
            const has = data.name !== undefined || data.isActive !== undefined;
            if (!has) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'At least one of name, isActive is required',
              });
            }
          })
          .parse(request.body);
        const row = await catalog.updateBrand(request.authUser.shopId, id, body);
        return reply.send(row);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.delete(
    '/brands/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (!hasPermission(request.authUser, 'catalog.taxonomy')) {
        return reply.status(403).send({ code: 'FORBIDDEN', message: 'Role' });
      }
      z.object({ id: z.string().uuid() }).parse(request.params);
      return reply.status(405).send({
        code: 'METHOD_NOT_ALLOWED',
        message:
          'Brands cannot be deleted. PATCH this resource with { isActive: false } to deactivate.',
      });
    },
  );
}
