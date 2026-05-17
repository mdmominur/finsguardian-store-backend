import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

function escapeHtml(unsafe: string | null | undefined): string {
  if (!unsafe) return '';
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

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

function resolveMailConfig(shopSettings?: unknown, fallbackName?: string): MailConfig | null {
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
    fromName: override.fromName ?? fallbackName ?? base?.fromName ?? env.MAIL_FROM_NAME,
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
  fallbackName?: string;
}): Promise<void> {
  const cfg = resolveMailConfig(opts.shopSettings, opts.fallbackName);
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
    connectionTimeout: 10000, // 10 seconds
    greetingTimeout: 10000,   // 10 seconds
    socketTimeout: 10000,     // 10 seconds
  });

  try {
    await transporter.sendMail({
      from: `"${cfg.fromName}" <${cfg.fromAddress}>`,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
  } catch (err) {
    console.error(`[sendMail] Failed to send email to ${opts.to}:`, err);
    throw err;
  }
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
  const brand = env.MAIL_FROM_NAME || 'FinsGuardian';
  const subject = `${brand} — shop registration code`;
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
  const brand = env.MAIL_FROM_NAME || 'FinsGuardian';
  const subject = `${brand} — internal dashboard sign-in code`;
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
  const subject = `${opts.shopName} — sign-in code`;
  const text = `Your sign-in code is: ${opts.otp}\n\nShop: ${opts.shopName}\n\nThis code expires in ${opts.ttlMin} minutes. If you did not request this, ignore this email.`;
  const html = `
    <div style="font-family:sans-serif;max-width:600px;">
      <p>Your sign-in code is:</p>
      <p style="font-size:32px;font-weight:700;letter-spacing:4px;color:#2563eb;">${escapeHtml(opts.otp)}</p>
      <p>Shop: <strong>${escapeHtml(opts.shopName)}</strong></p>
      <p style="color:#666;font-size:14px;margin-top:24px;">This code expires in ${opts.ttlMin} minutes. If you did not request this, you can ignore this email.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;" />
      <p style="color:#999;font-size:12px;">Powered by FinsGuardian</p>
    </div>
  `.trim();
  await sendMail({
    to: opts.to,
    subject,
    text,
    html,
    shopSettings: opts.shopSettings,
    fallbackName: opts.shopName,
  });
}

export async function sendOrderConfirmationEmail(opts: {
  to: string;
  shopName: string;
  shopLogo?: string | null;
  shopContact?: {
    email: string | null;
    phone: string | null;
    address: string | null;
  } | null;
  orderRef: string;
  subtotal: string;
  deliveryCharge: string;
  total: string;
  items: { name: string; qty: number; total: string }[];
  customer: {
    name: string;
    email: string | null;
    phone: string | null;
    address: string | null;
  };
  shopSettings?: unknown;
}): Promise<void> {
  const subject = `${opts.shopName} — Order Confirmed #${opts.orderRef}`;

  const itemsHtml = opts.items
    .map(
      (it) => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #f0f0f0;">
        <div style="font-weight:600;color:#1a1a1a;">${escapeHtml(it.name)}</div>
        <div style="font-size:13px;color:#666;">Quantity: ${it.qty}</div>
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #f0f0f0;text-align:right;vertical-align:top;font-weight:600;color:#1a1a1a;">
        ${it.total}
      </td>
    </tr>
  `,
    )
    .join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #333; margin: 0; padding: 0; background-color: #f8fafc; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px 6px; }
        .header { text-align: center; margin-bottom: 24px; padding-top: 10px; }
        .logo { max-height: 50px; max-width: 180px; margin-bottom: 8px; }
        .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .order-badge { display: inline-block; background: #f1f5f9; color: #475569; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; margin-bottom: 16px; }
        .section-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin: 32px 0 12px 0; border-bottom: 1px solid #f1f5f9; padding-bottom: 6px; }
        .footer { text-align: center; margin-top: 40px; color: #94a3b8; font-size: 11px; padding-bottom: 30px; }
        
        @media only screen and (max-width: 600px) {
          .card { padding: 16px; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          ${opts.shopLogo ? `<img src="${opts.shopLogo}" alt="${escapeHtml(opts.shopName)}" class="logo">` : `<h1 style="margin:0;font-size:24px;font-weight:800;color:#0f172a;">${escapeHtml(opts.shopName)}</h1>`}
        </div>
        
        <div class="card">
          <div style="display:flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px;">
            <div>
              <div class="order-badge">Order Confirmed</div>
              <h2 style="margin:0 0 4px 0;font-size:20px;color:#0f172a;">Thanks for your order!</h2>
              <p style="margin:0;color:#64748b;font-size:14px;">Order <strong>#${opts.orderRef}</strong></p>
            </div>
            <div style="text-align: right;">
              <div style="font-size:12px; color:#94a3b8; text-transform: uppercase; font-weight:700;">Date</div>
              <div style="font-size:14px; color:#0f172a; font-weight:600;">${new Date().toLocaleDateString()}</div>
            </div>
          </div>

          <div style="background: #f8fafc; border-radius: 8px; padding: 16px; margin-bottom: 32px;">
            <div style="font-size:11px; font-weight:700; color:#94a3b8; text-transform: uppercase; letter-spacing:0.5px; margin-bottom:8px;">Shipping To</div>
            <div style="font-size:14px; color:#0f172a; font-weight:600;">${escapeHtml(opts.customer.name)}</div>
            <div style="font-size:13px; color:#64748b; margin-top:4px;">
              ${opts.customer.address ? `${escapeHtml(opts.customer.address)}<br/>` : ''}
              ${opts.customer.phone ? `${escapeHtml(opts.customer.phone)}<br/>` : ''}
              ${opts.customer.email ? `${escapeHtml(opts.customer.email)}` : ''}
            </div>
          </div>

          <div class="section-title">Order Items</div>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="text-align:left; font-size:12px; color:#94a3b8;">
                <th style="padding-bottom:12px;">Description</th>
                <th style="text-align:right; padding-bottom:12px;">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml}
            </tbody>
          </table>

          <div style="margin-top:20px; border-top: 1px solid #f1f5f9; padding-top: 20px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="color:#64748b;padding:4px 0;font-size:14px;">Subtotal</td>
                <td style="text-align:right;color:#0f172a;padding:4px 0;font-weight:600;font-size:14px;">${opts.subtotal}</td>
              </tr>
              <tr>
                <td style="color:#64748b;padding:4px 0;font-size:14px;">Delivery Fee</td>
                <td style="text-align:right;color:#0f172a;padding:4px 0;font-weight:600;font-size:14px;">${opts.deliveryCharge}</td>
              </tr>
              <tr style="font-size:18px;font-weight:800;color:#0f172a;">
                <td style="padding:12px 0 0 0; border-top: 2px solid #f1f5f9; margin-top:10px;">Total Amount</td>
                <td style="text-align:right;padding:12px 0 0 0; border-top: 2px solid #f1f5f9; margin-top:10px; color:#2563eb;">${opts.total}</td>
              </tr>
            </table>
          </div>

          <div style="margin-top:40px; padding-top: 24px; border-top: 1px dashed #e2e8f0;">
            <div style="font-size:11px; font-weight:700; color:#94a3b8; text-transform: uppercase; letter-spacing:0.5px; margin-bottom:8px;">Contact ${escapeHtml(opts.shopName)}</div>
            <div style="font-size:13px; color:#64748b;">
              ${opts.shopContact?.address ? `${escapeHtml(opts.shopContact.address)}<br/>` : ''}
              ${opts.shopContact?.phone ? `Phone: ${escapeHtml(opts.shopContact.phone)}<br/>` : ''}
              ${opts.shopContact?.email ? `Email: ${escapeHtml(opts.shopContact.email)}` : ''}
            </div>
          </div>

        </div>

        <div class="footer">
          <p>This is a computer generated invoice. Thank you for your business!</p>
          <p style="margin-top:16px; font-weight:700; letter-spacing:2px; color:#cbd5e1;">POWERED BY FINSGUARDIAN</p>
        </div>
      </div>
    </body>
    </html>
  `.trim();

  const text = `Order Confirmed #${opts.orderRef}\n\nHi ${opts.customer.name},\n\nThank you for your order from ${opts.shopName}.\n\nTotal: ${opts.total}\n\nShipping to: ${opts.customer.address || 'N/A'}`;

  await sendMail({
    to: opts.to,
    subject,
    text,
    html,
    shopSettings: opts.shopSettings,
    fallbackName: opts.shopName,
  });
}
