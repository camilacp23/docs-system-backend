/**
 * Routes of the dashboard module (Module 7): binds each operationId of the contract to its handler. Roles are not
 * declared here; the contract (x-roles, x-rule) is the only source of authorization (D-39).
 *
 * @module modules/dashboard/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import type { JiraClient } from '../../integrations/jira/index.js';
import { createAuditModuleService } from '../audit/routes.js';
import type { AuditService } from '../audit/service.js';
import { createDashboardController } from './controller.js';
import { createDashboardRepository, type DashboardHooks } from './repository.js';
import { createDashboardService } from './service.js';

/**
 * Handlers of the /dashboard/indicators operation.
 *
 * @param db - Database connected as docs_app.
 * @param deps - The Jira client (only its state is read), and the audit service (tests may pass one that records its
 *   calls; production uses the module's own).
 * @param hooks - Test hooks of the repository; production passes none.
 */
export function dashboardHandlers(
  db: Pick<Database, 'base'>,
  deps: { jira: Pick<JiraClient, 'jiraAvailable'>; audit?: Pick<AuditService, 'recentActivity'> },
  hooks?: DashboardHooks,
): OperationHandlers {
  const audit = deps.audit ?? createAuditModuleService(db);
  const service = createDashboardService(createDashboardRepository(db, hooks), audit, deps.jira);
  return { getIndicators: createDashboardController(service).indicators };
}
