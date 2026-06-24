import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateCustomer } from '../../lib/authenticate-customer.js';
import { AppError, sendAppError } from '../../lib/errors.js';
import * as publicCustomerAddresses from '../../services/public-customer-addresses.service.js';
import * as publicCustomerAuth from '../../services/public-customer-auth.service.js';
import * as publicCustomerOrders from '../../services/public-customer-orders.service.js';
import * as publicStorefrontCheckout from '../../services/public-storefront-checkout.service.js';

const createAddressBody = z.object({
  label: z.string().nullable().optional(),
  recipientName: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  line1: z.string().min(1),
  line2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
});

const patchAddressBody = z.object({
  label: z.string().nullable().optional(),
  recipientName: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  line1: z.string().min(1).optional(),
  line2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  postalCode: z.string().nullable().optional(),
  isDefault: z.boolean().optional(),
});

const patchMeBody = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().min(6).nullable().optional(),
  address: z.string().nullable().optional(),
});

const placeWebOrderBody = z.object({
  /** Saved address book id (optional); storefront may omit while address UI is disabled. */
  shippingAddressId: z.string().uuid().optional(),
  deliveryLocationId: z.string().uuid().optional(),
  lines: z.array(
    z.object({
      productId: z.string().uuid(),
      qty: z.coerce.number().positive(),
    }),
  ),
});

export async function registerPublicCustomerRoutes(app: FastifyInstance) {
  app.get(
    '/public/shops/:slug/customer/me',
    { preHandler: authenticateCustomer },
    async (request, reply) => {
      try {
        const slug = String((request.params as any).slug ?? '');
        const auth = request.customerAuth!;
        const out = await publicCustomerAuth.getCustomerMe({
          shopSlug: slug,
          shopId: auth.shopId,
          customerId: auth.customerId,
        });
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.patch(
    '/public/shops/:slug/customer/me',
    { preHandler: authenticateCustomer },
    async (request, reply) => {
      try {
        const slug = String((request.params as any).slug ?? '');
        const auth = request.customerAuth!;
        const body = patchMeBody.parse(request.body);
        const out = await publicCustomerAuth.updateCustomerMe({
          shopSlug: slug,
          shopId: auth.shopId,
          customerId: auth.customerId,
          patch: body,
        });
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
    '/public/shops/:slug/customer/addresses',
    { preHandler: authenticateCustomer },
    async (request, reply) => {
      try {
        const slug = String((request.params as any).slug ?? '');
        const auth = request.customerAuth!;
        const out = await publicCustomerAddresses.listCustomerAddresses({
          shopSlug: slug,
          shopId: auth.shopId,
          customerId: auth.customerId,
        });
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/public/shops/:slug/customer/addresses',
    { preHandler: authenticateCustomer },
    async (request, reply) => {
      try {
        const slug = String((request.params as any).slug ?? '');
        const auth = request.customerAuth!;
        const body = createAddressBody.parse(request.body);
        const out = await publicCustomerAddresses.createCustomerAddress({
          shopSlug: slug,
          shopId: auth.shopId,
          customerId: auth.customerId,
          address: body,
        });
        return reply.status(201).send(out);
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
    '/public/shops/:slug/customer/addresses/:id',
    { preHandler: authenticateCustomer },
    async (request, reply) => {
      try {
        const slug = String((request.params as any).slug ?? '');
        const { id } = request.params as any;
        const auth = request.customerAuth!;
        const body = patchAddressBody.parse(request.body);
        const out = await publicCustomerAddresses.updateCustomerAddress({
          shopSlug: slug,
          shopId: auth.shopId,
          customerId: auth.customerId,
          addressId: String(id),
          patch: body,
        });
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

  app.delete(
    '/public/shops/:slug/customer/addresses/:id',
    { preHandler: authenticateCustomer },
    async (request, reply) => {
      try {
        const slug = String((request.params as any).slug ?? '');
        const { id } = request.params as any;
        const auth = request.customerAuth!;
        const out = await publicCustomerAddresses.deleteCustomerAddress({
          shopSlug: slug,
          shopId: auth.shopId,
          customerId: auth.customerId,
          addressId: String(id),
        });
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.get(
    '/public/shops/:slug/customer/orders',
    { preHandler: authenticateCustomer },
    async (request, reply) => {
      try {
        const slug = String((request.params as any).slug ?? '');
        const auth = request.customerAuth!;
        const q = request.query as any;
        const limit = Math.min(50, Math.max(1, Number(q?.limit ?? 20)));
        const offset = Math.max(0, Number(q?.offset ?? 0));
        const out = await publicCustomerOrders.listMyOrders({
          shopSlug: slug,
          shopId: auth.shopId,
          customerId: auth.customerId,
          limit,
          offset,
        });
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  app.post(
    '/public/shops/:slug/checkout/place-order',
    { preHandler: authenticateCustomer },
    async (request, reply) => {
      try {
        const slug = String((request.params as any).slug ?? '');
        const auth = request.customerAuth!;
        const body = placeWebOrderBody.parse(request.body);
        const idem = request.headers['idempotency-key'];
        const idempotencyKey =
          typeof idem === 'string' && idem.trim() ? idem.trim() : null;

        const out = await publicStorefrontCheckout.placeWebOrder({
          shopSlug: slug,
          shopId: auth.shopId,
          customerId: auth.customerId,
          shippingAddressId: body.shippingAddressId ?? null,
          deliveryLocationId: body.deliveryLocationId ?? null,
          lines: body.lines,
          idempotencyKey,
        });

        if (out.duplicate) {
          return reply.status(200).send({
            duplicate: true,
            orderId: out.order.id,
            publicRef: out.order.publicRef,
          });
        }
        return reply.status(201).send({
          duplicate: false,
          orderId: out.order.id,
          publicRef: out.order.publicRef,
        });
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
    '/public/shops/:slug/customer/orders/:saleId',
    { preHandler: authenticateCustomer },
    async (request, reply) => {
      try {
        const slug = String((request.params as any).slug ?? '');
        const { saleId } = request.params as any;
        const auth = request.customerAuth!;
        const out = await publicCustomerOrders.getMyOrderDetail({
          shopSlug: slug,
          shopId: auth.shopId,
          customerId: auth.customerId,
          saleId: String(saleId),
        });
        return reply.send(out);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );

  // Get active delivery locations for checkout (public endpoint - no auth required)
  app.get(
    '/public/shops/:slug/delivery-locations',
    async (request, reply) => {
      try {
        const slug = String((request.params as any).slug ?? '');
        const { db: dbClient } = await import('../../db/client.js');
        const { shops, deliveryLocations } = await import('../../db/schema/index.js');
        const { eq, and } = await import('drizzle-orm');

        // Find shop by slug
        const [shop] = await dbClient
          .select({ id: shops.id })
          .from(shops)
          .where(eq(shops.slug, slug));

        if (!shop) {
          return reply.status(404).send({
            code: 'NOT_FOUND',
            message: 'Shop not found',
          });
        }

        // Get active delivery locations
        const locations = await dbClient
          .select()
          .from(deliveryLocations)
          .where(
            and(
              eq(deliveryLocations.shopId, shop.id),
              eq(deliveryLocations.isActive, true),
            ),
          );

        return reply.send({ items: locations });
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}

