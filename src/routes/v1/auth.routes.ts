import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, sendAppError } from '../../lib/errors.js';
import * as authService from '../../services/auth.service.js';
import * as shopRegistration from '../../services/shop-registration.service.js';

const registerStartBody = z.object({
  shopName: z.string().min(1),
  shopSlug: z.string().optional(),
  ownerName: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

const registerCompleteBody = z.object({
  registrationToken: z.string().min(10),
  otp: z.string().min(4),
});

const registerResendBody = z.object({
  registrationToken: z.string().min(10),
});

const loginBody = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  password: z.string().min(1),
  shopId: z.string().uuid().optional(),
});

const refreshBody = z.object({
  refreshToken: z.string().min(10),
  shopId: z.string().uuid().optional(),
});

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post('/auth/register/start', async (request, reply) => {
    try {
      const body = registerStartBody.parse(request.body);
      const out = await shopRegistration.startShopRegistration({
        shopName: body.shopName,
        shopSlug: body.shopSlug,
        ownerName: body.ownerName,
        email: body.email,
        password: body.password,
      });
      return reply.status(200).send({
        registrationToken: out.registrationToken,
        otpExpiresAt: out.otpExpiresAt,
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
  });

  app.post('/auth/register/resend-otp', async (request, reply) => {
    try {
      const body = registerResendBody.parse(request.body);
      const out = await shopRegistration.resendShopRegistrationOtp(body.registrationToken);
      return reply.send({ otpExpiresAt: out.otpExpiresAt });
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

  app.post('/auth/register/complete', async (request, reply) => {
    try {
      const body = registerCompleteBody.parse(request.body);
      const result = await shopRegistration.completeShopRegistration({
        registrationToken: body.registrationToken,
        otp: body.otp,
      });
      return reply.status(201).send({
        shop: result.shop,
        user: { id: result.user.id, name: result.user.name },
        defaultLocationId: result.defaultLocationId,
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
  });

  app.post('/auth/login', async (request, reply) => {
    try {
      const body = loginBody.parse(request.body);
      const ua = request.headers['user-agent'];
      const ip = request.ip;
      const out = await authService.login(app, {
        ...body,
        userAgent: typeof ua === 'string' ? ua : undefined,
        ip,
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
  });

  app.post('/auth/refresh', async (request, reply) => {
    try {
      const body = refreshBody.parse(request.body);
      const ua = request.headers['user-agent'];
      const ip = request.ip;
      const out = await authService.refreshTokensFlow(app, body.refreshToken, {
        shopId: body.shopId,
        userAgent: typeof ua === 'string' ? ua : undefined,
        ip,
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
  });

  app.post('/auth/logout', async (request, reply) => {
    const body = z.object({ refreshToken: z.string() }).parse(request.body);
    await authService.logoutRefresh(body.refreshToken);
    return reply.send({ ok: true });
  });

  app.get(
    '/me',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      try {
        const u = request.authUser;
        const me = await authService.getMe(u.userId, u.shopId);
        return reply.send(me);
      } catch (e) {
        if (e instanceof AppError) return sendAppError(reply, e);
        throw e;
      }
    },
  );
}
