import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { db, type DbExecutor } from '../db/client.js';
import {
  financeAccountMovements,
  financeAccounts,
  financeTransfers,
} from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { money2 } from './supplier-po-settlement.service.js';

type DefaultFinRow = {
  name: string;
  kind: 'CASH' | 'BANK' | 'MFS' | 'OTHER';
  provider: string | null;
  sortOrder: number;
};

/** First-time seed per shop: one cashbook wallet. Add bKash/bank/etc. from Accounts UI. */
export const DEFAULT_FINANCE_ACCOUNTS: DefaultFinRow[] = [
  { name: 'Cash in hand', kind: 'CASH', provider: null, sortOrder: 0 },
];

export async function seedFinanceAccountsTx(tx: DbExecutor, shopId: string): Promise<void> {
  const [row] = await tx
    .select({ id: financeAccounts.id })
    .from(financeAccounts)
    .where(eq(financeAccounts.shopId, shopId))
    .limit(1);
  if (row) return;
  await tx.insert(financeAccounts).values(
    DEFAULT_FINANCE_ACCOUNTS.map((d) => ({
      shopId,
      name: d.name,
      kind: d.kind,
      provider: d.provider,
      sortOrder: d.sortOrder,
    })),
  );
}

export async function ensureDefaultFinanceAccounts(shopId: string): Promise<void> {
  await seedFinanceAccountsTx(db, shopId);
}

export async function getFinanceAccountForShop(
  tx: DbExecutor,
  shopId: string,
  accountId: string,
): Promise<typeof financeAccounts.$inferSelect> {
  const [a] = await tx
    .select()
    .from(financeAccounts)
    .where(
      and(
        eq(financeAccounts.id, accountId),
        eq(financeAccounts.shopId, shopId),
        eq(financeAccounts.isActive, true),
      ),
    )
    .limit(1);
  if (!a) throw AppError.badRequest('Finance account not found or inactive for this shop');
  return a;
}

export async function insertMovementTx(
  tx: DbExecutor,
  input: {
    shopId: string;
    accountId: string;
    delta: string;
    refTable: 'supplier_payments' | 'expenses' | 'finance_transfers' | 'opening_balance' | null;
    refId: string | null;
    note?: string | null;
    createdBy: string | null;
  },
) {
  const d = Number(input.delta);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) {
    throw AppError.badRequest('Movement delta must be non-zero');
  }
  await tx.insert(financeAccountMovements).values({
    shopId: input.shopId,
    accountId: input.accountId,
    delta: money2(d),
    refTable: input.refTable ?? null,
    refId: input.refId ?? null,
    note: input.note ?? null,
    createdBy: input.createdBy,
  });
}

export async function listAccountsWithBalances(shopId: string) {
  // No auto-seed: Finance wallets are now managed manually via the Finance UI.
  const accounts = await db
    .select()
    .from(financeAccounts)
    .where(eq(financeAccounts.shopId, shopId))
    .orderBy(desc(financeAccounts.isActive), asc(financeAccounts.sortOrder), asc(financeAccounts.name));

  const out = [];
  for (const a of accounts) {
    const [b] = await db
      .select({
        sum: sql<string>`coalesce(sum(${financeAccountMovements.delta}::numeric), 0)::text`,
      })
      .from(financeAccountMovements)
      .where(
        and(eq(financeAccountMovements.shopId, shopId), eq(financeAccountMovements.accountId, a.id)),
      );
    out.push({ ...a, balance: b?.sum ?? '0' });
  }
  return out;
}

export async function listMovements(
  shopId: string,
  opts: { accountId?: string; limit: number; offset: number },
) {
  const conds = [eq(financeAccountMovements.shopId, shopId)];
  if (opts.accountId) {
    conds.push(eq(financeAccountMovements.accountId, opts.accountId));
  }
  return db
    .select({
      id: financeAccountMovements.id,
      accountId: financeAccountMovements.accountId,
      accountName: financeAccounts.name,
      delta: financeAccountMovements.delta,
      refTable: financeAccountMovements.refTable,
      refId: financeAccountMovements.refId,
      note: financeAccountMovements.note,
      createdAt: financeAccountMovements.createdAt,
    })
    .from(financeAccountMovements)
    .innerJoin(financeAccounts, eq(financeAccounts.id, financeAccountMovements.accountId))
    .where(and(...conds))
    .orderBy(desc(financeAccountMovements.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);
}

export async function createTransfer(
  shopId: string,
  userId: string | null,
  input: { fromAccountId: string; toAccountId: string; amount: string; note?: string | null },
) {
  if (input.fromAccountId === input.toAccountId) {
    throw AppError.badRequest('Transfer accounts must differ');
  }
  const amt = Number(input.amount);
  if (!Number.isFinite(amt) || amt <= 0) throw AppError.badRequest('Transfer amount must be positive');

  return db.transaction(async (tx) => {
    await getFinanceAccountForShop(tx, shopId, input.fromAccountId);
    await getFinanceAccountForShop(tx, shopId, input.toAccountId);

    const [tr] = await tx
      .insert(financeTransfers)
      .values({
        shopId,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amount: money2(amt),
        note: input.note ?? null,
        createdBy: userId,
      })
      .returning();

    if (!tr) throw AppError.conflict('Transfer record failed');

    await insertMovementTx(tx, {
      shopId,
      accountId: input.fromAccountId,
      delta: money2(-amt),
      refTable: 'finance_transfers',
      refId: tr.id,
      note: input.note ?? null,
      createdBy: userId,
    });
    await insertMovementTx(tx, {
      shopId,
      accountId: input.toAccountId,
      delta: money2(amt),
      refTable: 'finance_transfers',
      refId: tr.id,
      note: input.note ?? null,
      createdBy: userId,
    });

    return tr;
  });
}

export async function postOpeningBalance(
  shopId: string,
  userId: string | null,
  input: { accountId: string; delta: string; note?: string | null },
) {
  const d = Number(input.delta);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) {
    throw AppError.badRequest('Opening adjustment must be non-zero');
  }

  return db.transaction(async (tx) => {
    await getFinanceAccountForShop(tx, shopId, input.accountId);
    await insertMovementTx(tx, {
      shopId,
      accountId: input.accountId,
      delta: money2(d),
      refTable: 'opening_balance',
      refId: null,
      note: input.note?.trim() || 'Opening / adjustment',
      createdBy: userId,
    });
    return { ok: true };
  });
}

const FIN_KINDS = ['CASH', 'BANK', 'MFS', 'OTHER'] as const;
type FinKind = (typeof FIN_KINDS)[number];
const MFS_PROVIDERS = ['BKASH', 'NAGAD', 'ROCKET'] as const;

function parseCreateFinanceAccount(input: {
  name: string;
  kind: string;
  provider?: string | null;
}): { name: string; kind: FinKind; provider: string | null } {
  const name = input.name.trim();
  if (!name) throw AppError.badRequest('Account name is required');
  const kindUpper = input.kind.trim().toUpperCase();
  if (!(FIN_KINDS as readonly string[]).includes(kindUpper)) {
    throw AppError.badRequest('Invalid account kind');
  }
  const kind = kindUpper as FinKind;
  let provider: string | null =
    input.provider === undefined || input.provider === null || input.provider === ''
      ? null
      : String(input.provider).toUpperCase();
  if (kind !== 'MFS') {
    if (provider) throw AppError.badRequest('Provider is only used for MFS (mobile wallet) accounts');
    provider = null;
  } else if (provider && !MFS_PROVIDERS.includes(provider as (typeof MFS_PROVIDERS)[number])) {
    throw AppError.badRequest('Invalid MFS provider (use BKASH, NAGAD, or ROCKET)');
  }
  return { name, kind, provider };
}

export async function createFinanceAccount(
  shopId: string,
  input: { name: string; kind: string; provider?: string | null },
) {
  await ensureDefaultFinanceAccounts(shopId);
  const v = parseCreateFinanceAccount(input);
  const [mxRow] = await db
    .select({
      n: sql<number>`coalesce(max(${financeAccounts.sortOrder}), -1)::int`,
    })
    .from(financeAccounts)
    .where(eq(financeAccounts.shopId, shopId));
  const sortOrder = (mxRow?.n ?? -1) + 1;
  const [row] = await db
    .insert(financeAccounts)
    .values({
      shopId,
      name: v.name,
      kind: v.kind,
      provider: v.provider,
      sortOrder,
      isActive: true,
    })
    .returning();
  if (!row) throw AppError.conflict('Could not create finance account');
  return row;
}

export async function updateFinanceAccount(
  shopId: string,
  accountId: string,
  input: { name?: string; isActive?: boolean; sortOrder?: number },
) {
  const [existing] = await db
    .select()
    .from(financeAccounts)
    .where(and(eq(financeAccounts.id, accountId), eq(financeAccounts.shopId, shopId)))
    .limit(1);
  if (!existing) throw AppError.notFound('Finance account not found');

  if (input.isActive === false) {
    const others = await db
      .select({ id: financeAccounts.id })
      .from(financeAccounts)
      .where(
        and(
          eq(financeAccounts.shopId, shopId),
          eq(financeAccounts.isActive, true),
          ne(financeAccounts.id, accountId),
        ),
      );
    if (others.length === 0) {
      throw AppError.badRequest('At least one cashbook account must stay active.');
    }
  }

  const patch: Partial<typeof financeAccounts.$inferInsert> = {};
  if (input.name !== undefined) {
    const t = input.name.trim();
    if (!t) throw AppError.badRequest('Account name is required');
    patch.name = t;
  }
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;

  if (Object.keys(patch).length === 0) return existing;

  const [row] = await db
    .update(financeAccounts)
    .set(patch)
    .where(eq(financeAccounts.id, accountId))
    .returning();
  return row!;
}
