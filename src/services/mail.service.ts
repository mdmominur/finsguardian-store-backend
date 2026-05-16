import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

type MailConfig = {
  host: string;
  port: number;
  encryption: string;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
};

function readString(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const v = (obj as Record<string, unknown>)[key];
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

function readNumber(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const v = (obj as Record<string, unknown>)[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function readMailConfigFromEnv(): MailConfig | null {
  const host = env.MAIL_HOST?.trim() || '';
  const username = env.MAIL_USERNAME?.trim() || '';
  const password = env.MAIL_PASSWORD?.trim() || '';
  const fromAddress = env.MAIL_FROM_ADDRESS?.trim() || '';
  if (!host || !username || !password || !fromAddress) return null;
  return {
    host,
    port: env.MAIL_PORT,
    encryption: env.MAIL_ENCRYPTION,
    username,
    password,
    fromAddress,
    fromName: env.MAIL_FROM_NAME,
  };
}

/**
 * Shop-level SMTP settings (optional), stored in `shops.settings`.
 *
 * Shape (suggested):
 * `{ mail: { smtp: { host, port, encryption, username, password, fromAddress, fromName } } }`
 *
 * If shop settings are missing/incomplete, we fall back to system env config.
 */
function readMailConfigFromShopSettings(settings: unknown): Partial<MailConfig> | null {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  const mail = (settings as Record<string, unknown>).mail;
  if (!mail || typeof mail !== 'object' || Array.isArray(mail)) return null;
  const smtp = (mail as Record<string, unknown>).smtp;
  if (!smtp || typeof smtp !== 'object' || Array.isArray(smtp)) return null;

  return {
    host: readString(smtp, 'host') ?? undefined,
    port: readNumber(smtp, 'port') ?? undefined,
    encryption: readString(smtp, 'encryption') ?? undefined,
    username: readString(smtp, 'username') ?? undefined,
    password: readString(smtp, 'password') ?? undefined,
    fromAddress: readString(smtp, 'fromAddress') ?? undefined,
    fromName: readString(smtp, 'fromName') ?? undefined,
  };
}

function resolveMailConfig(shopSettings?: unknown): MailConfig | null {
  const base = readMailConfigFromEnv();
  const override = shopSettings ? readMailConfigFromShopSettings(shopSettings) : null;
  if (!override) return base;

  const merged: MailConfig | null = {
    host: override.host ?? base?.host ?? '',
    port: override.port ?? base?.port ?? env.MAIL_PORT,
    encryption: override.encryption ?? base?.encryption ?? env.MAIL_ENCRYPTION,
    username: override.username ?? base?.username ?? '',
    password: override.password ?? base?.password ?? '',
    fromAddress: override.fromAddress ?? base?.fromAddress ?? '',
    fromName: override.fromName ?? base?.fromName ?? env.MAIL_FROM_NAME,
  };

  if (!merged.host || !merged.username || !merged.password || !merged.fromAddress) {
    return base; // fallback to system if override incomplete
  }
  return merged;
}

export function isMailConfigured(shopSettings?: unknown): boolean {
  return Boolean(resolveMailConfig(shopSettings));
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  shopSettings?: unknown;
}): Promise<void> {
  const cfg = resolveMailConfig(opts.shopSettings);
  if (!cfg) {
    throw new Error('Mail is not configured (set MAIL_HOST, MAIL_USERNAME, MAIL_PASSWORD, MAIL_FROM_ADDRESS)');
  }

  const secure = cfg.encryption === 'ssl' || cfg.port === 465;

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure,
    auth: {
      user: cfg.username,
      pass: cfg.password,
    },
  });

  await transporter.sendMail({
    from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });
}

export function publicAppBaseUrl(): string {
  const u = (env.PUBLIC_APP_URL || env.CORS_ORIGIN || '').replace(/\/$/, '');
  return u;
}

export async function sendShopRegistrationOtpEmail(opts: {
  to: string;
  shopName: string;
  otp: string;
}): Promise<void> {
  const subject = `${env.MAIL_FROM_NAME} — shop registration code`;
  const text = `Your verification code is: ${opts.otp}\n\nShop: ${opts.shopName}\n\nThis code expires in ${env.REGISTRATION_OTP_TTL_MIN} minutes.`;
  const html = `
    <p>Your verification code is:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:4px;">${opts.otp}</p>
    <p>Shop: <strong>${escapeHtml(opts.shopName)}</strong></p>
    <p style="color:#666;font-size:14px;">This code expires in ${env.REGISTRATION_OTP_TTL_MIN} minutes. If you did not request this, you can ignore this email.</p>
  `.trim();
  await sendMail({ to: opts.to, subject, text, html });
}

export async function sendInternalDashboardOtpEmail(opts: {
  to: string;
  displayName: string;
  otp: string;
  ttlMin: number;
}): Promise<void> {
  const subject = `${env.MAIL_FROM_NAME} — internal dashboard sign-in code`;
  const text = `Your sign-in code is: ${opts.otp}\n\nHello ${opts.displayName},\n\nThis code expires in ${opts.ttlMin} minutes. If you did not request this, ignore this email.`;
  const html = `
    <p>Hello <strong>${escapeHtml(opts.displayName)}</strong>,</p>
    <p>Your internal dashboard sign-in code is:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:4px;">${escapeHtml(opts.otp)}</p>
    <p style="color:#666;font-size:14px;">This code expires in ${opts.ttlMin} minutes. If you did not request this, you can ignore this email.</p>
  `.trim();
  await sendMail({ to: opts.to, subject, text, html });
}

export async function sendCustomerSigninOtpEmail(opts: {
  to: string;
  shopName: string;
  otp: string;
  ttlMin: number;
  shopSettings?: unknown;
}): Promise<void> {
  const subject = `${env.MAIL_FROM_NAME} — sign-in code`;
  const text = `Your sign-in code is: ${opts.otp}\n\nShop: ${opts.shopName}\n\nThis code expires in ${opts.ttlMin} minutes. If you did not request this, ignore this email.`;
  const html = `
    <p>Your sign-in code is:</p>
    <p style="font-size:28px;font-weight:700;letter-spacing:4px;">${escapeHtml(opts.otp)}</p>
    <p>Shop: <strong>${escapeHtml(opts.shopName)}</strong></p>
    <p style="color:#666;font-size:14px;">This code expires in ${opts.ttlMin} minutes. If you did not request this, you can ignore this email.</p>
  `.trim();
  await sendMail({ to: opts.to, subject, text, html, shopSettings: opts.shopSettings });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
