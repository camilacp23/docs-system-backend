/**
 * Initial seed (decisions "Siembra", FR-26, NFR-02, NFR-20): first administrator and reserved account.
 *
 * Idempotent and conservative: it never modifies an existing row. It runs as docs_app WITHOUT an audit context, so
 * the triggers record actor NULL and db_role docs_app. It creates no applications and no SAR data (that is the
 * initial load of FR-26, at the end of Phase 3).
 *
 * @module db/seed
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { SeedConfig } from '../config/seed.js';
import type { Database } from './prisma.js';
import { RESERVED_ACCOUNT_NAME } from './reservedAccount.js';

/** The seed cannot continue without touching existing data; nothing was written. */
export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedError';
  }
}

export type SeedResult = { admin: 'created' | 'exists'; reserved: 'created' | 'exists' };

/**
 * Seeds the first administrator and the reserved account.
 *
 * @param db - Database connected as docs_app.
 * @param config - Validated seed configuration.
 * @returns What was created and what already existed.
 * @throws {SeedError} When the reserved account exists with another role or status (nothing is modified).
 */
export async function runSeed(db: Pick<Database, 'base'>, config: SeedConfig): Promise<SeedResult> {
  const { base } = db;
  const [admin, reserved] = await Promise.all([
    base.user.findUnique({ where: { email: config.adminEmail }, select: { id: true } }),
    base.user.findUnique({ where: { email: config.integrationUserEmail }, select: { role: true, status: true } }),
  ]);
  if (reserved && (reserved.role !== 'READER' || reserved.status !== 'INACTIVE')) {
    throw new SeedError(
      `The reserved account ${config.integrationUserEmail} already exists as ${reserved.role} / ${reserved.status} instead of READER / INACTIVE. Nothing was modified; fix it in the database and run the seed again`,
    );
  }

  const adminHash = admin ? undefined : await bcrypt.hash(config.adminPassword, config.bcryptCost);
  // 32 random bytes, never stored or shown: the hash can never match a known password.
  const reservedHash = reserved ? undefined : await bcrypt.hash(randomBytes(32).toString('base64'), config.bcryptCost);

  // One transaction without audit context: both accounts or none, audited with actor NULL (NFR-20).
  await base.$transaction(async (tx) => {
    if (adminHash !== undefined) {
      await tx.user.create({
        data: {
          name: config.adminName,
          email: config.adminEmail,
          passwordHash: adminHash,
          role: 'ADMINISTRATOR',
          status: 'ACTIVE',
        },
      });
    }
    if (reservedHash !== undefined) {
      await tx.user.create({
        data: {
          name: RESERVED_ACCOUNT_NAME,
          email: config.integrationUserEmail,
          passwordHash: reservedHash,
          role: 'READER',
          status: 'INACTIVE',
        },
      });
    }
  });

  return { admin: admin ? 'exists' : 'created', reserved: reserved ? 'exists' : 'created' };
}
