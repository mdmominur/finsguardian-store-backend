import jwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { env } from '../config/env.js';
import { AppError, sendAppError } from '../lib/errors.js';
import { parseRole } from '../lib/rbac.js';
import { sanitizePermissionList } from '../lib/permissions.js';
import { assertMerchantShopWriteAllowed } from '../services/shop-subscription-access.service.js';

export default fp(async (app) => {
  await app.register(jwt, {
    secret: env.JWT_ACCESS_SECRET,
    sign: { expiresIn: `${env.JWT_ACCESS_EXPIRES_MIN}m` },
  });

  app.decorate(
    'authenticate',
    async function authenticate(request, reply) {
      try {
        await request.jwtVerify();
      } catch {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Invalid or expired token',
        });
      }

      const u = request.user as {
        sub?: string;
        sid?: string;
        role?: string;
        perms?: unknown;
      };
      if (!u.sub || !u.sid || !u.role) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Invalid token payload',
        });
      }
      const role = parseRole(u.role);
      if (!role) {
        return reply.status(401).send({
          code: 'UNAUTHORIZED',
          message: 'Invalid role',
        });
      }
      const permissions =
        role === 'owner' ? [] : sanitizePermissionList(u.perms);
      request.authUser = { userId: u.sub, shopId: u.sid, role, permissions };

      const method = request.method;
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        const pathOnly = (request.url ?? '').split('?')[0];
        if (!pathOnly.startsWith('/api/v1/auth')) {
          try {
            await assertMerchantShopWriteAllowed(u.sid);
          } catch (err) {
            if (err instanceof AppError) return sendAppError(reply, err);
            throw err;
          }
        }
      }
    },
  );
});
