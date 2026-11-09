/**
 * Routes of the audit module (Module 8): binds each operationId of the contract to its handler. Roles are not
 * declared here; the contract (x-roles, x-rule) is the only source of authorization (D-39).
 *
 * @module modules/audit/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import { createAuditController } from './controller.js';
import { createAuditRepository, type AuditHooks } from './repository.js';
import { createAuditService, type AuditService } from './service.js';

/**
 * The audit service, for the modules that read the audit history (the dashboard reads the recent activity through it).
 *
 * @param db - Database connected as docs_app.
 * @param hooks - Test hooks of the repository; production passes none.
 */
export function createAuditModuleService(db: Pick<Database, 'base'>, hooks?: AuditHooks): AuditService {
  return createAuditService(createAuditRepository(db, hooks));
}

/**
 * Handlers of the /audit-log operations.
 *
 * @param db - Database connected as docs_app.
 * @param hooks - Test hooks of the repository; production passes none.
 */
export function auditHandlers(db: Pick<Database, 'base'>, hooks?: AuditHooks): OperationHandlers {
  const controller = createAuditController(createAuditModuleService(db, hooks));
  return { listAuditLog: controller.list };
}
