import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { shops, users, refreshTokens } from '../../db/schema/index.js';
import { AppError, sendAppError } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { sendMail, publicAppBaseUrl } from '../../services/mail.service.js';
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
  app.get('/auth/register/check-slug', async (request, reply) => {
    try {
      const query = z.object({ slug: z.string().min(1) }).parse(request.query);
      const cleanSlug = query.slug.trim().toLowerCase();
      
      const [existing] = await db
        .select({ id: shops.id })
        .from(shops)
        .where(eq(shops.slug, cleanSlug))
        .limit(1);
        
      return reply.send({ available: !existing });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid query parameter',
        });
      }
      throw e;
    }
  });

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

  app.post('/auth/forgot-password', async (request, reply) => {
    try {
      const body = z.object({ email: z.string().email() }).parse(request.body);
      const emailLower = body.email.trim().toLowerCase();

      const [user] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.email, emailLower))
        .limit(1);

      if (!user) {
        // Return ok for privacy
        return reply.send({
          ok: true,
          message: 'If this email exists in our system, a password reset link has been sent.',
        });
      }

      const token = app.jwt.sign(
        { userId: user.id, email: user.email, purpose: 'password_reset' } as any,
        { expiresIn: '15m' }
      );

      const baseUrl = publicAppBaseUrl();
      const resetLink = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;

      try {
        await sendMail({
          to: user.email!,
          subject: 'Reset your password',
          text: `Please click this link to reset your password: ${resetLink}`,
          html: `<p>Please click the link below to reset your password:</p><p><a href="${resetLink}">${resetLink}</a></p>`,
        });
      } catch (err) {
        console.log(`[password-reset] MAIL_* not set — Reset link for ${user.email} (dev only): ${resetLink}`);
      }

      return reply.send({
        ok: true,
        message: 'Password reset link sent.',
      });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: 'Invalid email format',
        });
      }
      throw e;
    }
  });

  app.post('/auth/reset-password', async (request, reply) => {
    try {
      const body = z
        .object({
          token: z.string().min(1),
          password: z.string().min(8, 'Password must be at least 8 characters'),
        })
        .parse(request.body);

      let payload: any;
      try {
        payload = app.jwt.verify(body.token) as any;
      } catch (err) {
        throw AppError.badRequest('Invalid or expired reset token');
      }

      if (payload.purpose !== 'password_reset' || !payload.userId) {
        throw AppError.badRequest('Invalid reset token');
      }

      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, payload.userId))
        .limit(1);

      if (!user) {
        throw AppError.notFound('User not found');
      }

      const passwordHash = await hashPassword(body.password);

      await db.transaction(async (tx) => {
        await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
        await tx.delete(refreshTokens).where(eq(refreshTokens.userId, user.id));
      });

      return reply.send({
        ok: true,
        message: 'Password reset successful.',
      });
    } catch (e) {
      if (e instanceof z.ZodError) {
        return reply.status(400).send({
          code: 'VALIDATION_ERROR',
          message: e.errors[0]?.message || 'Invalid input',
        });
      }
      if (e instanceof AppError) return sendAppError(reply, e);
      throw e;
    }
  });
}
