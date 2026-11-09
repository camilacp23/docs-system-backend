/**
 * Routes of the variables module (Module 2): binds each operationId of the contract to its handler. Roles are not
 * declared here; the contract (x-roles) is the only source of authorization (D-39).
 *
 * @module modules/variables/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import { createApplicationService } from '../applications/service.js';
import { createScreenLookup } from '../screens/service.js';
import { createVariablesController } from './controller.js';
import { createVariableService } from './service.js';

/**
 * Handlers of the /variables operations.
 *
 * @param db - Database connected as docs_app.
 */
export function variablesHandlers(db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>): OperationHandlers {
  const applications = createApplicationService(db);
  const screens = createScreenLookup();
  const controller = createVariablesController(createVariableService(db, applications, screens));
  return {
    listVariables: controller.list,
    createVariable: controller.create,
    getVariable: controller.get,
    updateVariable: controller.update,
    deleteVariable: controller.remove,
    getVariableDependencies: controller.dependencies,
  };
}
