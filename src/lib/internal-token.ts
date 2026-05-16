import { createHmac, timingSafeEqual } from 'node:crypto';

export type InternalAccessPayload = { sub: string; typ: 'internal' };

/**
 * Signed access token for internal dashboard (not merchant JWT).
 * Format: base64url(JSON).base64url(HMAC-SHA256(body)).
 */
export function signInternalAccessToken(
  payload: InternalAccessPayload,
  secret: string,
  expiresInMin: number,
): string {
  const exp = Math.floor(Date.now() / 1000) + expiresInMin * 60;
  const bodyObj = { ...payload, exp };
  const body = Buffer.from(JSON.stringify(bodyObj), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyInternalAccessToken(
  token: string,
  secret: string,
): InternalAccessPayload | null {
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
  if (o.typ !== 'internal' || typeof o.sub !== 'string') return null;
  if (typeof o.exp !== 'number' || o.exp < Math.floor(Date.now() / 1000)) return null;
  return { sub: o.sub, typ: 'internal' };
}
