import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { customerAccounts, customerOtpChallenges, customers, shops } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { signCustomerAccessToken } from '../lib/customer-token.js';
import { normalizeBdPhone } from './customer.service.js';
import * as shopWebsiteService from './shop-website.service.js';
import { isMailConfigured, sendCustomerSigninOtpEmail } from './mail.service.js';

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

function normalizePhone(raw: string): string {
  return raw.replace(/\D/g, '').trim();
}

function hashOtp(challengeId: string, otpDigits: string): string {
  return createHash('sha256')
    .update(`${challengeId}:${otpDigits}:${env.JWT_ACCESS_SECRET}`, 'utf8')
    .digest('hex');
}

async function shopBySlugOrThrow(shopSlug: string) {
  const slug = shopSlug.trim();
  const [row] = await db.select().from(shops).where(eq(shops.slug, slug)).limit(1);
  if (!row || row.subscriptionStatus === 'suspended') throw AppError.notFound('Shop not found');

  const w = shopWebsiteService.readWebsiteSettings(row.settings);
  if (!w.enabled) throw AppError.notFound('Not published');

  return { shop: row, website: w };
}

export type CustomerOtpChannel = 'SMS' | 'EMAIL';

export async function requestCustomerOtp(input: {
  shopSlug: string;
  channel: CustomerOtpChannel;
  destination: string;
}): Promise<{ challengeId: string; otpExpiresAt: string; devOtp?: string }> {
  const { shop } = await shopBySlugOrThrow(input.shopSlug);

  const channel = input.channel;
  const dest =
    channel === 'EMAIL' ? normalizeEmail(input.destination) : normalizePhone(input.destination);

  if (!dest) throw AppError.badRequest(channel === 'EMAIL' ? 'Email is required' : 'Phone is required');
  if (channel === 'SMS' && dest.length < 8) throw AppError.badRequest('Phone is invalid');

  await db
    .update(customerOtpChallenges)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(customerOtpChallenges.shopId, shop.id),
        eq(customerOtpChallenges.destination, dest),
        isNull(customerOtpChallenges.consumedAt),
      ),
    );

  const otp = generateOtpDigits();
  const otpExpiresAt = new Date(Date.now() + env.CUSTOMER_OTP_TTL_MIN * 60 * 1000);
  const challengeId = randomUUID();
  const otpHash = hashOtp(challengeId, otp);

  await db.insert(customerOtpChallenges).values({
    id: challengeId,
    shopId: shop.id,
    channel,
    destination: dest,
    otpHash,
    otpExpiresAt,
    otpAttempts: 0,
    maxOtpAttempts: env.CUSTOMER_OTP_MAX_ATTEMPTS,
  });

  if (channel === 'EMAIL') {
    if (isMailConfigured(shop.settings)) {
      try {
        await sendCustomerSigninOtpEmail({
          to: dest,
          shopName: shop.name,
          otp,
          ttlMin: env.CUSTOMER_OTP_TTL_MIN,
          shopSettings: shop.settings,
        });
      } catch (e: any) {
        const raw = String(e?.message ?? '').trim();
        const detail = raw ? ` (${raw})` : '';
        throw AppError.badRequest(`Failed to send OTP email${detail}`);
      }
    } else if (env.NODE_ENV === 'development') {
      console.warn(`[storefront-auth] MAIL_* not set — OTP for ${dest} (dev only): ${otp}`);
    } else {
      throw AppError.badRequest(
        'Email delivery is not configured on this server. Set MAIL_HOST, MAIL_USERNAME, MAIL_PASSWORD, and MAIL_FROM_ADDRESS.',
      );
    }
  } else {
    if (env.NODE_ENV === 'development') {
      console.warn(`[storefront-auth] SMS provider not configured — OTP for ${dest} (dev only): ${otp}`);
    } else {
      throw AppError.badRequest('SMS OTP is not configured on this server');
    }
  }

  return {
    challengeId,
    otpExpiresAt: otpExpiresAt.toISOString(),
    devOtp: env.NODE_ENV === 'development' ? otp : undefined,
  };
}

export async function verifyCustomerOtp(input: {
  shopSlug: string;
  challengeId: string;
  otp: string;
}): Promise<{
  accessToken: string;
  isNew: boolean;
  customer: { id: string; name: string; phone: string; email: string | null; address: string | null };
}> {
  const { shop } = await shopBySlugOrThrow(input.shopSlug);

  const otpDigits = input.otp.replace(/\D/g, '').trim();
  if (otpDigits.length !== 6 || !/^\d{6}$/.test(otpDigits)) {
    throw AppError.badRequest('Enter the 6-digit code');
  }

  const [challenge] = await db
    .select()
    .from(customerOtpChallenges)
    .where(
      and(
        eq(customerOtpChallenges.id, input.challengeId),
        eq(customerOtpChallenges.shopId, shop.id),
        isNull(customerOtpChallenges.consumedAt),
      ),
    )
    .limit(1);

  if (!challenge) throw AppError.unauthorized('Invalid or expired code');
  if (challenge.otpExpiresAt < new Date()) throw AppError.unauthorized('Code expired');
  if (challenge.otpAttempts >= challenge.maxOtpAttempts) {
    throw AppError.unauthorized('Too many attempts. Request a new code');
  }

  const expected = hashOtp(challenge.id, otpDigits);
  if (!timingSafeEqualHex(expected, challenge.otpHash)) {
    await db
      .update(customerOtpChallenges)
      .set({ otpAttempts: challenge.otpAttempts + 1 })
      .where(eq(customerOtpChallenges.id, challenge.id));
    throw AppError.unauthorized('Invalid or expired code');
  }

  await db
    .update(customerOtpChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(customerOtpChallenges.id, challenge.id));

  // Customer identity: same `customers` rows as dashboard/POS (phone stored with normalizeBdPhone).
  const phoneCanon = challenge.channel === 'SMS' ? normalizeBdPhone(challenge.destination) : null;
  const phoneLoose = challenge.channel === 'SMS' ? normalizePhone(challenge.destination) : null;
  const email = challenge.channel === 'EMAIL' ? normalizeEmail(challenge.destination) : null;

  const [existingCustomer] = await db
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.shopId, shop.id),
        phoneCanon
          ? or(eq(customers.phone, phoneCanon), eq(customers.phone, phoneLoose!))!
          : eq(customers.email, email!),
      ),
    )
    .limit(1);

  const isNew = !existingCustomer;
  const customer =
    existingCustomer ??
    (
      await db
        .insert(customers)
        .values({
          shopId: shop.id,
          // For EMAIL OTP with a brand-new customer we do not have a real phone yet.
          // Keep a unique placeholder and let the "complete profile" step update it.
          name: 'Customer',
          phone: phoneCanon ?? `pending:${challenge.id}`,
          email: email ?? null,
          address: null,
          notes: null,
        })
        .returning()
    )[0]!;

  const [acctExisting] = await db
    .select()
    .from(customerAccounts)
    .where(and(eq(customerAccounts.shopId, shop.id), eq(customerAccounts.customerId, customer.id)))
    .limit(1);

  const account =
    acctExisting ??
    (
      await db
        .insert(customerAccounts)
        .values({
          shopId: shop.id,
          customerId: customer.id,
          phone: phoneCanon ?? null,
          email: email ?? customer.email,
          passwordHash: null,
          lastLoginAt: new Date(),
        })
        .returning()
    )[0]!;

  if (acctExisting) {
    await db
      .update(customerAccounts)
      .set({
        lastLoginAt: new Date(),
        phone: phoneCanon ?? acctExisting.phone,
        email: email ?? acctExisting.email,
      })
      .where(eq(customerAccounts.id, acctExisting.id));
  }

  const accessToken = signCustomerAccessToken(
    { sub: customer.id, sid: shop.id, aid: account.id },
    env.JWT_ACCESS_SECRET,
    env.CUSTOMER_JWT_EXPIRES_DAYS,
  );

  return {
    accessToken,
    isNew,
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email ?? null,
      address: customer.address ?? null,
    },
  };
}

export async function getCustomerMe(input: { shopSlug: string; shopId: string; customerId: string }) {
  const { shop } = await shopBySlugOrThrow(input.shopSlug);
  if (shop.id !== input.shopId) throw AppError.unauthorized('Invalid token for this shop');

  const [row] = await db
    .select({
      customer: customers,
      account: customerAccounts,
    })
    .from(customers)
    .innerJoin(
      customerAccounts,
      and(eq(customerAccounts.shopId, customers.shopId), eq(customerAccounts.customerId, customers.id)),
    )
    .where(and(eq(customers.shopId, shop.id), eq(customers.id, input.customerId)))
    .limit(1);

  if (!row) throw AppError.notFound('Customer not found');
  return {
    id: row.customer.id,
    name: row.customer.name,
    phone: row.customer.phone,
    email: row.customer.email ?? row.account.email ?? null,
    address: row.customer.address ?? null,
    lastLoginAt: row.account.lastLoginAt,
    createdAt: row.customer.createdAt,
  };
}

export async function updateCustomerMe(input: {
  shopSlug: string;
  shopId: string;
  customerId: string;
  patch: { name?: string; email?: string | null; phone?: string | null; address?: string | null };
}) {
  const { shop } = await shopBySlugOrThrow(input.shopSlug);
  if (shop.id !== input.shopId) throw AppError.unauthorized('Invalid token for this shop');

  const updates: Partial<typeof customers.$inferInsert> = {};
  if (input.patch.name !== undefined) {
    const name = input.patch.name.trim();
    if (!name) throw AppError.badRequest('Name is required');
    updates.name = name;
  }
  if (input.patch.email !== undefined) {
    const email = input.patch.email ? normalizeEmail(input.patch.email) : null;
    if (email) {
      const [takenAccount] = await db
        .select({ id: customerAccounts.id })
        .from(customerAccounts)
        .where(
          and(
            eq(customerAccounts.shopId, shop.id),
            sql`lower(btrim(${customerAccounts.email})) = lower(btrim(${email}))`,
            ne(customerAccounts.customerId, input.customerId),
          ),
        )
        .limit(1);
      if (takenAccount) {
        throw AppError.conflict('That email is already used by another customer');
      }
    }
    updates.email = email;
  }
  if (input.patch.phone !== undefined) {
    const phone = input.patch.phone ? normalizeBdPhone(input.patch.phone) : null;
    if (!phone) throw AppError.badRequest('Phone is required');

    const [taken] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.shopId, shop.id), eq(customers.phone, phone)))
      .limit(1);
    if (taken && taken.id !== input.customerId) {
      throw AppError.conflict('That phone number is already used');
    }

    updates.phone = phone;
  }
  if (input.patch.address !== undefined) {
    updates.address = input.patch.address?.trim() ? input.patch.address.trim() : null;
  }

  const [row] = await db
    .update(customers)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(eq(customers.shopId, shop.id), eq(customers.id, input.customerId)))
    .returning();
  if (!row) throw AppError.notFound('Customer not found');

  if (input.patch.email !== undefined) {
    await db
      .update(customerAccounts)
      .set({ email: row.email })
      .where(and(eq(customerAccounts.shopId, shop.id), eq(customerAccounts.customerId, row.id)));
  }
  if (input.patch.phone !== undefined) {
    await db
      .update(customerAccounts)
      .set({ phone: row.phone })
      .where(and(eq(customerAccounts.shopId, shop.id), eq(customerAccounts.customerId, row.id)));
  }

  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email ?? null,
    address: row.address ?? null,
  };
}

