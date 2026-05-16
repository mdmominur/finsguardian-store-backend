import { createHmac, timingSafeEqual } from 'node:crypto';

export type CustomerAccessPayload = {
  typ: 'customer';
  /** customer id */
  sub: string;
  /** shop id */
  sid: string;
  /** customer account id */
  aid: string;
};

/**
 * Signed access token for storefront customers (separate from merchant JWT).
 * Format: base64url(JSON).base64url(HMAC-SHA256(body)).
 */
export function signCustomerAccessToken(
  payload: Omit<CustomerAccessPayload, 'typ'>,
  secret: string,
  expiresInDays: number,
): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInDays * 24 * 60 * 60;
  const bodyObj: CustomerAccessPayload & { exp: number } = { ...payload, typ: 'customer', exp };
  const body = Buffer.from(JSON.stringify(bodyObj), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyCustomerAccessToken(
  token: string,
  secret: string,
): CustomerAccessPayload | null {
  const i = token.lastIndexOf('.');
  if (i <= 0 || i === token.length - 1) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');

  let sigBuf: Buffer;
  let expBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, 'base64url');
    expBuf = Buffer.from(expected, 'base64url');
  } catch {
    return null;
  }
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;

  if (o.typ !== 'customer') return null;
  if (typeof o.sub !== 'string' || typeof o.sid !== 'string' || typeof o.aid !== 'string') {
    return null;
  }
  if (typeof o.exp !== 'number' || o.exp < Math.floor(Date.now() / 1000)) return null;
  return { typ: 'customer', sub: o.sub, sid: o.sid, aid: o.aid };
}

