/**
 * Routes of Module 1 (users): binds each operationId of the contract to its handler. Roles are not declared here;
 * the contract (x-roles, x-rule) is the only source of authorization (D-39).
 *
 * @module modules/users/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import { createUsersController } from './controller.js';
import { createUserService } from './service.js';

/**
 * Handlers of the six user operations.
 *
 * @param db - Database connected as docs_app.
 */
export function usersHandlers(db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>): OperationHandlers {
  const controller = createUsersController(createUserService(db));
  return {
    listUsers: controller.list,
    createUser: controller.create,
    getUser: controller.get,
    updateUser: controller.update,
    deactivateUser: controller.deactivate,
    changeUserRole: controller.changeRole,
  };
}
