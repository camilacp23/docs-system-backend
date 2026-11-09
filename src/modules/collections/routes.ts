/**
 * Routes of the collections module (Module 3): binds each operationId of the contract to its handler. Roles are not
 * declared here; the contract (x-roles) is the only source of authorization (D-39).
 *
 * @module modules/collections/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import { createApplicationService } from '../applications/service.js';
import { createScreenLookup } from '../screens/service.js';
import { createVariableService } from '../variables/service.js';
import { createCollectionsController } from './controller.js';
import { createCollectionService } from './service.js';

/**
 * Handlers of the /collections operations.
 *
 * @param db - Database connected as docs_app.
 */
export function collectionsHandlers(db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>): OperationHandlers {
  const applications = createApplicationService(db);
  const screens = createScreenLookup();
  const variables = createVariableService(db, applications, screens);
  const controller = createCollectionsController(createCollectionService(db, applications, screens, variables));
  return {
    listCollections: controller.list,
    createCollection: controller.create,
    getCollection: controller.get,
    updateCollection: controller.update,
    deleteCollection: controller.remove,
    listCollectionFields: controller.listFields,
  };
}
