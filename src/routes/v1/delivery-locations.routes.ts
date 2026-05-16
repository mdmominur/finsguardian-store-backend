import type { FastifyInstance } from 'fastify';
import { and, eq, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { deliveryLocations } from '../../db/schema/index.js';
import { AppError, sendAppError } from '../../lib/errors.js';
import { canManageShopSettings } from '../../lib/rbac.js';

const createDeliveryLocationBody = z.object({
  name: z.string().min(1).max(255),
  deliveryCharge: z.string().regex(/^\d+(\.\d{1,2})?$/),
  isActive: z.boolean().optional().default(true),
  sortOrder: z.number().int().optional().default(0),
});

const updateDeliveryLocationBody = z.object({
  name: z.string().min(1).max(255).optional(),
  deliveryCharge: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export async function registerDeliveryLocationRoutes(app: FastifyInstance) {
  // List delivery locations for a shop
  app.get(
    '/delivery-locations',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        const locations = await db
          .select()
          .from(deliveryLocations)
          .where(eq(deliveryLocations.shopId, request.authUser.shopId))
          .orderBy(asc(deliveryLocations.sortOrder), asc(deliveryLocations.createdAt));

        return reply.send({ items: locations });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  // Get active delivery locations (for checkout)
  app.get(
    '/delivery-locations/active',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        const locations = await db
          .select()
          .from(deliveryLocations)
          .where(
            and(
              eq(deliveryLocations.shopId, request.authUser.shopId),
              eq(deliveryLocations.isActive, true),
            ),
          )
          .orderBy(asc(deliveryLocations.sortOrder), asc(deliveryLocations.createdAt));

        return reply.send({ items: locations });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  // Get single delivery location
  app.get(
    '/delivery-locations/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

        const [location] = await db
          .select()
          .from(deliveryLocations)
          .where(
            and(
              eq(deliveryLocations.id, id),
              eq(deliveryLocations.shopId, request.authUser.shopId),
            ),
          );

        if (!location) {
          return reply.status(404).send({
            code: 'NOT_FOUND',
            message: 'Delivery location not found',
          });
        }

        return reply.send(location);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  // Create delivery location
  app.post(
    '/delivery-locations',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageShopSettings(request.authUser.role)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Owners only' });
        }

        const body = createDeliveryLocationBody.parse(request.body);

        const [created] = await db
          .insert(deliveryLocations)
          .values({
            shopId: request.authUser.shopId,
            name: body.name,
            deliveryCharge: body.deliveryCharge,
            isActive: body.isActive,
            sortOrder: body.sortOrder,
          })
          .returning();

        return reply.status(201).send(created);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            errors: e.errors,
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  // Update delivery location
  app.patch(
    '/delivery-locations/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageShopSettings(request.authUser.role)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Owners only' });
        }

        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const body = updateDeliveryLocationBody.parse(request.body);

        const updates: Record<string, any> = {};
        if (body.name !== undefined) updates.name = body.name;
        if (body.deliveryCharge !== undefined) updates.deliveryCharge = body.deliveryCharge;
        if (body.isActive !== undefined) updates.isActive = body.isActive;
        if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;
        updates.updatedAt = new Date();

        const [updated] = await db
          .update(deliveryLocations)
          .set(updates)
          .where(
            and(
              eq(deliveryLocations.id, id),
              eq(deliveryLocations.shopId, request.authUser.shopId),
            ),
          )
          .returning();

        if (!updated) {
          return reply.status(404).send({
            code: 'NOT_FOUND',
            message: 'Delivery location not found',
          });
        }

        return reply.send(updated);
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply.status(400).send({
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            errors: e.errors,
          });
        }
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  // Delete delivery location
  app.delete(
    '/delivery-locations/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        if (!canManageShopSettings(request.authUser.role)) {
          return reply.status(403).send({ code: 'FORBIDDEN', message: 'Owners only' });
        }

        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

        await db
          .delete(deliveryLocations)
          .where(
            and(
              eq(deliveryLocations.id, id),
              eq(deliveryLocations.shopId, request.authUser.shopId),
            ),
          );

        return reply.status(204).send();
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
