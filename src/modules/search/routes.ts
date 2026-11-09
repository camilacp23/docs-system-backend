/**
 * Routes of the search module (Module 6): binds each operationId of the contract to its handler. Roles are not
 * declared here; the contract (x-roles) is the only source of authorization (D-39).
 *
 * @module modules/search/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import { createSearchController } from './controller.js';
import { createSearchRepository, type SearchHooks } from './repository.js';
import { createSearchService } from './service.js';

/**
 * Handlers of the /search operation.
 *
 * @param db - Database connected as docs_app.
 * @param hooks - Test hooks of the repository; production passes none.
 */
export function searchHandlers(db: Pick<Database, 'base'>, hooks?: SearchHooks): OperationHandlers {
  const controller = createSearchController(createSearchService(createSearchRepository(db, hooks)));
  return { search: controller.search };
}
