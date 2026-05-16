import type { FastifyReply } from 'fastify';

export type ApiErrorBody = {
  code: string;
  message: string;
  details?: unknown;
};

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static unauthorized(message = 'Unauthorized') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }

  static forbidden(message = 'Forbidden') {
    return new AppError(403, 'FORBIDDEN', message);
  }

  /** Shop owner turned this module off in Settings (optional verticals). */
  static featureDisabled(message: string) {
    return new AppError(403, 'FEATURE_DISABLED', message);
  }

  static notFound(message = 'Not found') {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string, details?: unknown) {
    return new AppError(409, 'CONFLICT', message, details);
  }

  /** Unique (shop_id, phone) on customers — tell user to search existing. */
  static duplicateCustomerPhone(
    message = 'A customer already exists with this phone number. Use Find existing above, or enter a different phone.',
  ) {
    return new AppError(409, 'DUPLICATE_CUSTOMER_PHONE', message);
  }

  /** SaaS subscription not covering this shop (trial ended, paid_through in the past or unset). */
  static subscriptionLapsed(
    message = 'Shop subscription is not active. Renew or contact support to continue using the app.',
  ) {
    return new AppError(403, 'SUBSCRIPTION_LAPSED', message);
  }

  static shopSuspended(message = 'This shop has been suspended. Contact support.') {
    return new AppError(403, 'SHOP_SUSPENDED', message);
  }
}

export function sendAppError(reply: FastifyReply, err: unknown) {
  if (err instanceof AppError) {
    const body: ApiErrorBody = {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
    return reply.status(err.statusCode).send(body);
  }
  throw err;
}
