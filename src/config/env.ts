import { createHash } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Load `backend/.env` before reading `process.env` (Node does not load .env by itself). */
loadDotenv({ path: resolve(__dirname, '../../.env') });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_MIN: z.coerce.number().min(1).default(15),
  JWT_REFRESH_EXPIRES_DAYS: z.coerce.number().min(1).default(7),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  /** Public storefront URL for links in emails (defaults to CORS_ORIGIN if empty). */
  PUBLIC_APP_URL: z.string().default(''),
  MAIL_MAILER: z.string().default('smtp'),
  MAIL_HOST: z.string().default(''),
  MAIL_PORT: z.coerce.number().default(465),
  MAIL_USERNAME: z.string().default(''),
  MAIL_PASSWORD: z.string().default(''),
  /** Use `ssl` for port 465 (TLS), `tls` for STARTTLS on 587. */
  MAIL_ENCRYPTION: z.string().default('ssl'),
  MAIL_FROM_ADDRESS: z.string().default(''),
  MAIL_FROM_NAME: z.string().default('TechTubeBD'),
  /** Shop signup OTP validity (minutes). */
  REGISTRATION_OTP_TTL_MIN: z.coerce.number().min(1).max(60).default(10),
  REGISTRATION_OTP_MAX_ATTEMPTS: z.coerce.number().min(3).max(20).default(5),
  /**
   * Internal dashboard token signing secret (min 32 chars).
   * Omit (or leave blank) in development: a value is derived from JWT_ACCESS_SECRET. Required in production.
   */
  INTERNAL_JWT_ACCESS_SECRET: z.preprocess(
    (v) => {
      if (v === undefined || v === null) return undefined;
      const s = String(v).trim();
      return s === '' ? undefined : s;
    },
    z.string().min(32).optional(),
  ),
  INTERNAL_JWT_ACCESS_EXPIRES_MIN: z.coerce.number().min(15).max(24 * 60).default(480),
  INTERNAL_OTP_TTL_MIN: z.coerce.number().min(1).max(60).default(10),
  INTERNAL_OTP_MAX_ATTEMPTS: z.coerce.number().min(3).max(20).default(5),
  /** Storefront customer OTP validity (minutes). */
  CUSTOMER_OTP_TTL_MIN: z.coerce.number().min(1).max(60).default(10),
  CUSTOMER_OTP_MAX_ATTEMPTS: z.coerce.number().min(3).max(20).default(5),
  /** Storefront customer JWT access token validity (days). */
  CUSTOMER_JWT_EXPIRES_DAYS: z.coerce.number().min(1).max(365).default(30),
});

type ParsedEnv = z.infer<typeof schema>;
export type Env = Omit<ParsedEnv, 'INTERNAL_JWT_ACCESS_SECRET'> & {
  INTERNAL_JWT_ACCESS_SECRET: string;
};

function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const msg = parsed.error.flatten().fieldErrors;
    throw new Error(`Invalid environment: ${JSON.stringify(msg)}`);
  }
  const d = parsed.data;
  let internalSecret = d.INTERNAL_JWT_ACCESS_SECRET?.trim();
  if (!internalSecret || internalSecret.length < 32) {
    if (d.NODE_ENV === 'production') {
      throw new Error(
        'INTERNAL_JWT_ACCESS_SECRET is required in production (min 32 characters). Copy from backend/.env.example.',
      );
    }
    internalSecret = createHash('sha256')
      .update(`internal-dashboard:${d.JWT_ACCESS_SECRET}`, 'utf8')
      .digest('hex');
  }
  return { ...d, INTERNAL_JWT_ACCESS_SECRET: internalSecret };
}

export const env = loadEnv();
