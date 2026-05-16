import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '../lib/rbac.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      sub: string;
      sid: string;
      role: Role;
      /** Granted permission keys for members; omitted or ignored for owners. */
      perms?: string[];
    };
    user: {
      sub: string;
      sid: string;
      role: Role;
      perms?: string[];
    };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }

  interface FastifyRequest {
    authUser: {
      userId: string;
      shopId: string;
      role: Role;
      /** Effective keys for this session (empty for owners — hasPermission bypasses). */
      permissions: string[];
    };
  }
}
