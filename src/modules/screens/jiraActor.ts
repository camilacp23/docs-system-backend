/**
 * The actor of the writes that Jira causes (refresh and webhook): the reserved account "Integración Jira"
 * (D-31, D-51), found through INTEGRATION_USER_EMAIL.
 *
 * @module modules/screens/jiraActor
 */
import { auditContext, type Database } from '../../db/prisma.js';
import { assertReservedAccount } from '../../db/reservedAccount.js';

/** Runs `fn` with the reserved account as the audit actor. */
export type RunAsIntegration = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Builds the function that runs work as the reserved account. The id is looked up once and kept: the API refuses to
 * start without the account, and a failed lookup is not cached.
 *
 * @param db - Database connected as docs_app.
 * @param email - Lowercase e-mail of the reserved account (INTEGRATION_USER_EMAIL).
 */
export function createIntegrationActor(db: Pick<Database, 'base'>, email: string): RunAsIntegration {
  let userId: number | null = null;
  return async (fn) => {
    userId ??= await assertReservedAccount(db, email);
    return auditContext.run({ userId }, fn);
  };
}
