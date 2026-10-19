/**
 * Routes of Module 1 (authentication): binds each operationId of the contract to its handler. Roles are not declared
 * here; the three operations are public and the contract (x-roles) is the only source of authorization (D-39).
 *
 * @module modules/auth/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import { createAuthController } from './controller.js';
import { createAuthService } from './service.js';

/**
 * Handlers of `login`, `refreshSession` and `logout`.
 *
 * @param db - Database connected as docs_app.
 */
export function authHandlers(db: Pick<Database, 'base' | 'auditedTransaction'>): OperationHandlers {
  const controller = createAuthController(createAuthService(db));
  return {
    login: controller.login,
    refreshSession: controller.refresh,
    logout: controller.logout,
  };
}
