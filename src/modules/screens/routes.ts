/**
 * Routes of the screens module (Module 4): binds each implemented operationId of the contract to its handler. Roles
 * are not declared here; the contract (x-roles) is the only source of authorization (D-39). Only the listing is
 * implemented so far (B-09).
 *
 * @module modules/screens/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import { createApplicationService } from '../applications/service.js';
import { createScreensController } from './controller.js';
import { createScreenService } from './service.js';

/**
 * Handlers of the implemented screen operations.
 *
 * @param db - Database connected as docs_app.
 */
export function screensHandlers(db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>): OperationHandlers {
  const service = createScreenService(db, createApplicationService(db));
  return { listScreens: createScreensController(service).list };
}
