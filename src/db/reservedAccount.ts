/**
 * The reserved account "Integración Jira" (D-31, D-40, D-51, CP-06): READER, INACTIVE, identified by
 * INTEGRATION_USER_EMAIL. It is the actor of webhook writes, so the API refuses to start without it.
 *
 * @module db/reservedAccount
 */
import type { Database } from './prisma.js';

/** Display name of the reserved account. */
export const RESERVED_ACCOUNT_NAME = 'Integración Jira';

/** The reserved account is missing or differs from the required shape (READER, INACTIVE). */
export class ReservedAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReservedAccountError';
  }
}

/**
 * Checks that the reserved account exists and is READER / INACTIVE.
 *
 * @param db - Database (docs_app).
 * @param email - Lowercase e-mail of the reserved account (INTEGRATION_USER_EMAIL).
 * @returns The id of the reserved account.
 * @throws {ReservedAccountError} When it does not exist or has another role or status.
 */
export async function assertReservedAccount(db: Pick<Database, 'base'>, email: string): Promise<number> {
  const user = await db.base.user.findUnique({
    where: { email },
    select: { id: true, role: true, status: true },
  });
  if (!user) {
    throw new ReservedAccountError(
      `The reserved account "${RESERVED_ACCOUNT_NAME}" (${email}) does not exist. Run npm run db:seed`,
    );
  }
  if (user.role !== 'READER' || user.status !== 'INACTIVE') {
    throw new ReservedAccountError(
      `The reserved account "${RESERVED_ACCOUNT_NAME}" (${email}) must be READER and INACTIVE but is ${user.role} and ${user.status}. Fix it in the database; npm run db:seed does not modify it`,
    );
  }
  return user.id;
}
