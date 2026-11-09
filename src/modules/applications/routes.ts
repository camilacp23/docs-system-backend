/**
 * Routes of the applications module (FR-27, NFR-16): binds each operationId of the contract to its handler. Roles are
 * not declared here; the contract (x-roles) is the only source of authorization (D-39).
 *
 * @module modules/applications/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import { createApplicationsController } from './controller.js';
import { createApplicationService } from './service.js';

/**
 * Handlers of the four application operations.
 *
 * @param db - Database connected as docs_app.
 */
export function applicationsHandlers(db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>): OperationHandlers {
  const controller = createApplicationsController(createApplicationService(db));
  return {
    listApplications: controller.list,
    createApplication: controller.create,
    getApplication: controller.get,
    updateApplication: controller.update,
  };
}
