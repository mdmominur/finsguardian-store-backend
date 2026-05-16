import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notificationOutbox, shops } from '../db/schema/index.js';

export type AjkerHisabChannels = {
  SMS: boolean;
  EMAIL: boolean;
};

export type AjkerHisabConfig = {
  enabled: boolean;
  time: string; // "HH:mm" in Asia/Dhaka
  channels: AjkerHisabChannels;
  smsRecipient: string | null;
  emailRecipient: string | null;
};

const DEFAULT_CONFIG: AjkerHisabConfig = {
  enabled: true,
  time: '22:00',
  channels: { SMS: false, EMAIL: false },
  smsRecipient: null,
  emailRecipient: null,
};

export async function getAjkerHisabConfig(shopId: string) {
  const [shop] = await db
    .select()
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  const settings = (shop?.settings ?? {}) as Record<string, unknown>;
  const stored = settings.ajkerHisabConfig as AjkerHisabConfig | undefined;

  const config: AjkerHisabConfig = {
    ...DEFAULT_CONFIG,
    ...(stored ?? {}),
    channels: {
      ...DEFAULT_CONFIG.channels,
      ...(stored?.channels ?? {}),
    },
  };

  // Read latest outbox attempt for template "ajker_hisab".
  const [last] = await db
    .select()
    .from(notificationOutbox)
    .where(
      and(
        eq(notificationOutbox.shopId, shopId),
        sql`${notificationOutbox.payload} ->> 'template' = 'ajker_hisab'`,
      ),
    )
    .orderBy(desc(notificationOutbox.createdAt))
    .limit(1);

  return {
    config,
    last: last
      ? {
          status: last.status,
          createdAt: last.createdAt,
          sentAt: last.sentAt,
          attempts: last.attempts,
          lastError: last.lastError,
        }
      : null,
  };
}

export async function updateAjkerHisabConfig(
  shopId: string,
  input: AjkerHisabConfig,
) {
  const [shop] = await db
    .select()
    .from(shops)
    .where(eq(shops.id, shopId))
    .limit(1);

  if (!shop) throw new Error('Shop not found');

  const settings = (shop.settings ?? {}) as Record<string, unknown>;
  const nextSettings = {
    ...settings,
    ajkerHisabConfig: input,
  };

  await db.update(shops).set({ settings: nextSettings }).where(eq(shops.id, shopId));

  return { config: input };
}

