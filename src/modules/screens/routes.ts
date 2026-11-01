/**
 * Routes of the screens module (Module 4): binds each implemented operationId of the contract to its handler. Roles
 * are not declared here; the contract (x-roles) is the only source of authorization (D-39). The review and the Jira
 * operations of the module are not implemented yet.
 *
 * @module modules/screens/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import { createApplicationService } from '../applications/service.js';
import { createCollectionService } from '../collections/service.js';
import { createVariableService } from '../variables/service.js';
import { createScreensController } from './controller.js';
import { createScreenLookup, createScreenService } from './service.js';

/**
 * Handlers of the implemented screen operations.
 *
 * @param db - Database connected as docs_app.
 */
export function screensHandlers(db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>): OperationHandlers {
  const applications = createApplicationService(db);
  const lookup = createScreenLookup();
  const variables = createVariableService(db, applications, lookup);
  const collections = createCollectionService(db, applications, lookup, variables);
  const controller = createScreensController(createScreenService(db, applications, variables, collections));
  return {
    listScreens: controller.list,
    createScreen: controller.create,
    getScreen: controller.get,
    updateScreen: controller.update,
    deleteScreen: controller.remove,
    changeScreenStatus: controller.changeStatus,
  };
}
