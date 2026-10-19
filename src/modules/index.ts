/**
 * Registry of module handlers by `operationId` (SDD D-42). Each module adds its operations here when it is
 * built; an operation of the contract without an entry answers 404 NOT_IMPLEMENTED (development only).
 *
 * @module modules
 */
import type { Database } from '../db/prisma.js';
import type { OperationHandlers } from '../http/operations.js';
import { authHandlers } from './auth/routes.js';
import { usersHandlers } from './users/routes.js';

/**
 * Builds the handlers of every implemented module.
 *
 * @param deps - The database the services use.
 */
export function createModuleHandlers(deps: { db: Database }): OperationHandlers {
  return { ...authHandlers(deps.db), ...usersHandlers(deps.db) };
}
