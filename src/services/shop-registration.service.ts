import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { shopRegistrationChallenges, users } from '../db/schema/index.js';
import type { ShopRegistrationChallengePayload } from '../db/schema/tables.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { hashPassword } from '../lib/password.js';
import { registerShopTx } from './auth.service.js';
import { isMailConfigured, sendShopRegistrationOtpEmail } from './mail.service.js';

function hashRegistrationToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function hashOtp(challengeId: string, otpDigits: string): string {
  return createHash('sha256')
    .update(`${challengeId}:${otpDigits}:${env.JWT_ACCESS_SECRET}`, 'utf8')
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

export async function startShopRegistration(input: {
  shopName: string;
  shopSlug?: string | null;
  ownerName: string;
  email: string;
  password: string;
}): Promise<{ registrationToken: string; otpExpiresAt: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email) throw AppError.badRequest('Email is required');

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    throw AppError.conflict('An account with this email already exists');
  }

  if (env.NODE_ENV === 'production' && !isMailConfigured()) {
    throw AppError.badRequest(
      'Email delivery is not configured on this server. Set MAIL_HOST, MAIL_USERNAME, MAIL_PASSWORD, and MAIL_FROM_ADDRESS.',
    );
  }

  const passwordHash = await hashPassword(input.password);
  const payload: ShopRegistrationChallengePayload = {
    shopName: input.shopName.trim(),
    shopSlug: input.shopSlug?.trim() ? input.shopSlug.trim() : null,
    ownerName: input.ownerName.trim(),
  };
  if (!payload.shopName) throw AppError.badRequest('Shop name is required');
  if (!payload.ownerName) throw AppError.badRequest('Owner name is required');

  const challengeId = randomUUID();
  const otp = generateOtpDigits();
  const otpHash = hashOtp(challengeId, otp);
  const otpExpiresAt = new Date(
    Date.now() + env.REGISTRATION_OTP_TTL_MIN * 60 * 1000,
  );

  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashRegistrationToken(rawToken);

  await db
    .update(shopRegistrationChallenges)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(shopRegistrationChallenges.email, email),
        isNull(shopRegistrationChallenges.consumedAt),
      ),
    );

  await db.insert(shopRegistrationChallenges).values({
    id: challengeId,
    email,
    tokenHash,
    passwordHash,
    payload,
    otpHash,
    otpExpiresAt,
    otpAttempts: 0,
    maxOtpAttempts: env.REGISTRATION_OTP_MAX_ATTEMPTS,
  });

  if (isMailConfigured()) {
    await sendShopRegistrationOtpEmail({
      to: email,
      shopName: payload.shopName,
      otp,
    });
  } else if (env.NODE_ENV === 'development') {
    console.warn(
      `[shop-registration] MAIL_* not set — OTP for ${email} (dev only): ${otp}`,
    );
  } else {
    throw AppError.badRequest(
      'Email delivery is not configured on this server. Set MAIL_* environment variables.',
    );
  }

  return {
    registrationToken: rawToken,
    otpExpiresAt: otpExpiresAt.toISOString(),
  };
}

export async function resendShopRegistrationOtp(registrationToken: string): Promise<{
  otpExpiresAt: string;
}> {
  const tokenHash = hashRegistrationToken(registrationToken.trim());
  const [row] = await db
    .select()
    .from(shopRegistrationChallenges)
    .where(
      and(
        eq(shopRegistrationChallenges.tokenHash, tokenHash),
        isNull(shopRegistrationChallenges.consumedAt),
      ),
    )
    .limit(1);

  if (!row) throw AppError.notFound('Invalid or expired registration session');
  if (row.otpExpiresAt < new Date()) {
    throw AppError.badRequest('Registration session expired. Please start again.');
  }

  const otp = generateOtpDigits();
  const otpHash = hashOtp(row.id, otp);
  const otpExpiresAt = new Date(
    Date.now() + env.REGISTRATION_OTP_TTL_MIN * 60 * 1000,
  );

  await db
    .update(shopRegistrationChallenges)
    .set({
      otpHash,
      otpExpiresAt,
      otpAttempts: 0,
    })
    .where(eq(shopRegistrationChallenges.id, row.id));

  if (isMailConfigured()) {
    await sendShopRegistrationOtpEmail({
      to: row.email,
      shopName: row.payload.shopName,
      otp,
    });
  } else if (env.NODE_ENV === 'development') {
    console.warn(
      `[shop-registration] MAIL_* not set — resent OTP for ${row.email} (dev only): ${otp}`,
    );
  } else {
    throw AppError.badRequest(
      'Email delivery is not configured on this server. Set MAIL_* environment variables.',
    );
  }

  return { otpExpiresAt: otpExpiresAt.toISOString() };
}

export async function completeShopRegistration(input: {
  registrationToken: string;
  otp: string;
}) {
  const rawToken = input.registrationToken.trim();
  const otpDigits = input.otp.replace(/\D/g, '').trim();
  if (!rawToken) throw AppError.badRequest('registrationToken is required');
  if (otpDigits.length !== 6) throw AppError.badRequest('Enter the 6-digit code from your email');

  const tokenHash = hashRegistrationToken(rawToken);

  const [row] = await db
    .select()
    .from(shopRegistrationChallenges)
    .where(
      and(
        eq(shopRegistrationChallenges.tokenHash, tokenHash),
        isNull(shopRegistrationChallenges.consumedAt),
      ),
    )
    .limit(1);

  if (!row) throw AppError.notFound('Invalid or expired registration session');
  if (row.otpExpiresAt < new Date()) {
    throw AppError.badRequest('Code expired. Please start registration again.');
  }

  if (row.otpAttempts >= row.maxOtpAttempts) {
    throw AppError.forbidden('Too many incorrect attempts. Request a new code.');
  }

  const expectedHash = hashOtp(row.id, otpDigits);
  if (!timingSafeEqualHex(expectedHash, row.otpHash)) {
    await db
      .update(shopRegistrationChallenges)
      .set({ otpAttempts: row.otpAttempts + 1 })
      .where(eq(shopRegistrationChallenges.id, row.id));
    throw AppError.unauthorized('Invalid verification code');
  }

  const email = row.email.trim().toLowerCase();

  return db.transaction(async (tx) => {
    const [stillOpen] = await tx
      .select({ id: shopRegistrationChallenges.id })
      .from(shopRegistrationChallenges)
      .where(
        and(
          eq(shopRegistrationChallenges.id, row.id),
          isNull(shopRegistrationChallenges.consumedAt),
        ),
      )
      .limit(1);
    if (!stillOpen) {
      throw AppError.conflict('This registration was already completed');
    }

    const [dup] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (dup) {
      await tx
        .update(shopRegistrationChallenges)
        .set({ consumedAt: new Date() })
        .where(eq(shopRegistrationChallenges.id, row.id));
      throw AppError.conflict('An account with this email already exists');
    }

    const result = await registerShopTx(tx, {
      shopName: row.payload.shopName,
      shopSlug: row.payload.shopSlug,
      ownerName: row.payload.ownerName,
      email,
      passwordHash: row.passwordHash,
    });

    await tx
      .update(shopRegistrationChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(shopRegistrationChallenges.id, row.id));

    return result;
  });
}
