import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import {
  internalDashboardOtpChallenges,
  internalDashboardUsers,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { signInternalAccessToken } from '../lib/internal-token.js';
import { isMailConfigured, sendInternalDashboardOtpEmail } from './mail.service.js';

function hashInternalOtp(challengeId: string, otpDigits: string): string {
  return createHash('sha256')
    .update(`${challengeId}:${otpDigits}:${env.INTERNAL_JWT_ACCESS_SECRET}`, 'utf8')
    .digest('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function generateOtpDigits(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * If the email is not an active internal operator, returns `registered: false` (no OTP stored).
 * Otherwise creates a challenge and sends the code by email when SMTP is configured.
 */
export async function requestInternalDashboardOtp(rawEmail: string): Promise<{
  registered: boolean;
  otpExpiresAt: string | null;
  emailSent?: boolean;
}> {
  const email = normalizeEmail(rawEmail);
  if (!email) {
    return { registered: false, otpExpiresAt: null };
  }

  const [user] = await db
    .select()
    .from(internalDashboardUsers)
    .where(and(eq(internalDashboardUsers.email, email), eq(internalDashboardUsers.isActive, true)))
    .limit(1);

  if (!user) {
    return { registered: false, otpExpiresAt: null };
  }

  await db
    .update(internalDashboardOtpChallenges)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(internalDashboardOtpChallenges.email, email),
        isNull(internalDashboardOtpChallenges.consumedAt),
      ),
    );

  const otp = generateOtpDigits();
  const otpExpiresAt = new Date(Date.now() + env.INTERNAL_OTP_TTL_MIN * 60 * 1000);
  const challengeId = randomUUID();
  const otpHash = hashInternalOtp(challengeId, otp);

  await db.insert(internalDashboardOtpChallenges).values({
    id: challengeId,
    email,
    otpHash,
    otpExpiresAt,
    otpAttempts: 0,
    maxOtpAttempts: env.INTERNAL_OTP_MAX_ATTEMPTS,
  });

  let emailSent = false;
  try {
    if (isMailConfigured()) {
      await sendInternalDashboardOtpEmail({
        to: email,
        displayName: user.name,
        otp,
        ttlMin: env.INTERNAL_OTP_TTL_MIN,
      });
      emailSent = true;
    } else if (env.NODE_ENV === 'development') {
      console.warn(
        `[internal-dashboard] MAIL_* not set — OTP for ${email} (dev only): ${otp}`,
      );
    } else {
      throw AppError.badRequest(
        'Email delivery is not configured. Set MAIL_HOST, MAIL_USERNAME, MAIL_PASSWORD, and MAIL_FROM_ADDRESS.',
      );
    }
  } catch (e) {
    await db
      .delete(internalDashboardOtpChallenges)
      .where(eq(internalDashboardOtpChallenges.id, challengeId));
    throw e;
  }

  return {
    registered: true,
    otpExpiresAt: otpExpiresAt.toISOString(),
    emailSent,
  };
}

export async function verifyInternalDashboardOtp(
  rawEmail: string,
  otpDigits: string,
): Promise<{ accessToken: string }> {
  const email = normalizeEmail(rawEmail);
  const otp = otpDigits.trim().replace(/\s+/g, '');
  if (!email || otp.length !== 6 || !/^\d{6}$/.test(otp)) {
    throw AppError.badRequest('Invalid email or code');
  }

  const [user] = await db
    .select()
    .from(internalDashboardUsers)
    .where(and(eq(internalDashboardUsers.email, email), eq(internalDashboardUsers.isActive, true)))
    .limit(1);

  if (!user) {
    throw AppError.unauthorized('Invalid email or code');
  }

  const [challenge] = await db
    .select()
    .from(internalDashboardOtpChallenges)
    .where(
      and(
        eq(internalDashboardOtpChallenges.email, email),
        isNull(internalDashboardOtpChallenges.consumedAt),
      ),
    )
    .orderBy(desc(internalDashboardOtpChallenges.createdAt))
    .limit(1);

  if (!challenge) {
    throw AppError.unauthorized('Invalid email or code');
  }

  if (challenge.otpExpiresAt < new Date()) {
    throw AppError.badRequest('Code expired. Request a new one.');
  }

  if (challenge.otpAttempts >= challenge.maxOtpAttempts) {
    throw AppError.badRequest('Too many attempts. Request a new code.');
  }

  const expectedHash = hashInternalOtp(challenge.id, otp);
  if (!timingSafeEqualHex(expectedHash, challenge.otpHash)) {
    await db
      .update(internalDashboardOtpChallenges)
      .set({ otpAttempts: challenge.otpAttempts + 1 })
      .where(eq(internalDashboardOtpChallenges.id, challenge.id));
    throw AppError.unauthorized('Invalid email or code');
  }

  await db
    .update(internalDashboardOtpChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(internalDashboardOtpChallenges.id, challenge.id));

  const accessToken = signInternalAccessToken(
    { sub: user.id, typ: 'internal' },
    env.INTERNAL_JWT_ACCESS_SECRET,
    env.INTERNAL_JWT_ACCESS_EXPIRES_MIN,
  );

  return { accessToken };
}
