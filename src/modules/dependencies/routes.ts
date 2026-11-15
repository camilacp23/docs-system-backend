/**
 * Routes of the dependencies module (Module 5): binds each operationId of the contract to its handler. Roles are not
 * declared here; the contract (x-roles) is the only source of authorization (D-39).
 *
 * @module modules/dependencies/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import { createDependenciesController } from './controller.js';
import { createDependenciesRepository, type DependenciesHooks } from './repository.js';
import { createDependenciesService, type DependenciesService } from './service.js';

/**
 * The dependencies service, for the modules that read the graph (the report's Dependencies part reads it through it).
 *
 * @param db - Database connected as docs_app.
 * @param hooks - Test hooks of the repository; production passes none.
 */
export function createDependenciesModuleService(
  db: Pick<Database, 'base'>,
  hooks?: DependenciesHooks,
): DependenciesService {
  return createDependenciesService(createDependenciesRepository(db, hooks));
}

/**
 * Handlers of the /dependencies operations.
 *
 * @param db - Database connected as docs_app.
 * @param hooks - Test hooks of the repository; production passes none.
 */
export function dependenciesHandlers(db: Pick<Database, 'base'>, hooks?: DependenciesHooks): OperationHandlers {
  const controller = createDependenciesController(createDependenciesModuleService(db, hooks));
  return {
    getDependencyGraph: controller.graph,
    getNodeNeighborhood: controller.neighborhood,
  };
}
