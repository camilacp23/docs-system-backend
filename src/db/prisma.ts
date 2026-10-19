/**
 * Prisma Client with audit context (approved decision 3.2).
 *
 * Every write must run in a transaction that first executes
 *   SELECT set_config('app.user_id', <user id from the JWT>, true)
 * so the PostgreSQL audit trigger can read the acting user. `true` makes the
 * setting transaction-local: it cannot leak to another request through the
 * connection pool.
 *
 * - auditContext (AsyncLocalStorage) carries the user id of the current HTTP
 *   request; an Express middleware opens it after JWT validation.
 * - Single-operation writes (create, update, delete, *Many, upsert, nested
 *   writes) are wrapped automatically by the `audit-context` extension.
 * - Multi-step writes and raw SQL writes MUST use `auditedTransaction`.
 *
 * Prisma ORM 7.10.0 · driver adapter @prisma/adapter-pg 7.10.0
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export type AuditContext = { userId: number };
export const auditContext = new AsyncLocalStorage<AuditContext>();

const WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

type BaseTx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

export function createPrisma(connectionString: string) {
  const base = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  const setActor = (userId: number) => base.$executeRaw`SELECT set_config('app.user_id', ${String(userId)}, true)`;

  const prisma = base.$extends({
    name: 'audit-context',
    query: {
      $allModels: {
        async $allOperations({ operation, args, query }) {
          const ctx = auditContext.getStore();
          if (!ctx || !WRITE_OPERATIONS.has(operation)) return query(args);
          // Batch transaction: set_config and the write share one DB transaction.
          const [, result] = await base.$transaction([setActor(ctx.userId), query(args)]);
          return result;
        },
      },
    },
  });

  /**
   * Interactive transaction for multi-step or raw-SQL writes. The callback
   * receives the NON-extended transaction client (the actor is already set,
   * so the extension must not wrap its operations again).
   */
  async function auditedTransaction<T>(fn: (tx: BaseTx) => Promise<T>): Promise<T> {
    const ctx = auditContext.getStore();
    if (!ctx) throw new Error('auditedTransaction requires an audit context (authenticated request)');
    return base.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${String(ctx.userId)}, true)`;
      return fn(tx as BaseTx);
    });
  }

  return { prisma, auditedTransaction, base };
}

/**
 * Express middleware (after the JWT middleware has set req.user):
 *   app.use((req, _res, next) =>
 *     req.user ? auditContext.run({ userId: req.user.id }, next) : next());
 */
