import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { verifyInternalAccessToken } from './internal-token.js';

export async function authenticateInternal(request: FastifyRequest, reply: FastifyReply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    await reply.status(401).send({
      code: 'UNAUTHORIZED',
      message: 'Missing or invalid Authorization header',
    });
    return;
  }
  const token = auth.slice('Bearer '.length).trim();
  const payload = verifyInternalAccessToken(token, env.INTERNAL_JWT_ACCESS_SECRET);
  if (!payload) {
    await reply.status(401).send({
      code: 'UNAUTHORIZED',
      message: 'Invalid or expired token',
    });
    return;
  }
  request.internalAuth = { userId: payload.sub };
}
