import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { expenseCategories, expenses, shopPaymentMethods } from '../db/schema/index.js';
import { AppError } from '../lib/errors.js';
import { money2 } from './supplier-po-settlement.service.js';

export async function ensureDefaultExpenseCategories(shopId: string) {
  const defaults = [
    'Rent',
    'Utilities',
    'Cha-Nasta',
    'Transportation',
    'Courier',
    'Other',
  ];

  for (let i = 0; i < defaults.length; i++) {
    const name = defaults[i]!;
    await db
      .insert(expenseCategories)
      .values({ shopId, name, sortOrder: i })
      .onConflictDoNothing({
        target: [expenseCategories.shopId, expenseCategories.name],
      });
  }
}

export async function listCategories(shopId: string) {
  return db
    .select()
    .from(expenseCategories)
    .where(eq(expenseCategories.shopId, shopId))
    .orderBy(expenseCategories.sortOrder);
}

export async function createExpense(
  shopId: string,
  userId: string,
  input: {
    categoryId: string;
    paymentMethodId: string;
    amount: string;
    spentAt?: string;
    note?: string | null;
  },
) {
  const amt = Number(input.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    throw AppError.badRequest('Amount must be positive');
  }

  return db.transaction(async (tx) => {
    const [cat] = await tx
      .select()
      .from(expenseCategories)
      .where(and(eq(expenseCategories.id, input.categoryId), eq(expenseCategories.shopId, shopId)))
      .limit(1);
    if (!cat) throw AppError.badRequest('Expense category not found for this shop');

    const [pm] = await tx
      .select()
      .from(shopPaymentMethods)
      .where(and(eq(shopPaymentMethods.id, input.paymentMethodId), eq(shopPaymentMethods.shopId, shopId), eq(shopPaymentMethods.isActive, true)))
      .limit(1);
    if (!pm) throw AppError.badRequest('Payment method not found or inactive');

    const [row] = await tx
      .insert(expenses)
      .values({
        shopId,
        categoryId: input.categoryId,
        paymentMethodId: input.paymentMethodId,
        financeAccountId: null,
        amount: money2(amt),
        spentAt: input.spentAt ? new Date(input.spentAt) : new Date(),
        note: input.note ?? null,
        createdBy: userId,
      })
      .returning();

    if (!row) throw AppError.conflict('Could not create expense');
    return { ...row, paymentMethodName: pm.name };
  });
}

export async function listExpenses(
  shopId: string,
  opts: { limit: number; offset: number; from?: Date; to?: Date },
) {
  const conds = [eq(expenses.shopId, shopId)];
  if (opts.from) conds.push(gte(expenses.spentAt, opts.from));
  if (opts.to) conds.push(lte(expenses.spentAt, opts.to));

  return db
    .select({
      id: expenses.id,
      shopId: expenses.shopId,
      categoryId: expenses.categoryId,
      categoryName: expenseCategories.name,
      paymentMethodId: expenses.paymentMethodId,
      paymentMethodName: shopPaymentMethods.name,
      amount: expenses.amount,
      spentAt: expenses.spentAt,
      note: expenses.note,
      createdBy: expenses.createdBy,
      createdAt: expenses.createdAt,
    })
    .from(expenses)
    .leftJoin(shopPaymentMethods, eq(shopPaymentMethods.id, expenses.paymentMethodId))
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .where(and(...conds))
    .orderBy(desc(expenses.spentAt))
    .limit(opts.limit)
    .offset(opts.offset);
}
