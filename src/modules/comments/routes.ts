/**
 * Routes of the comments module (Module 10): binds each operationId of the contract to its handler. Roles are not
 * declared here; the contract (x-roles, x-rule) is the only source of authorization (D-39). `AUTHOR_ONLY` is a data
 * rule and is applied in the service. `reviewScreen` belongs to the screens module, which writes its comment through
 * the comments service.
 *
 * @module modules/comments/routes
 */
import type { Database } from '../../db/prisma.js';
import type { OperationHandlers } from '../../http/operations.js';
import { createApplicationService } from '../applications/service.js';
import { createScreenLookup } from '../screens/service.js';
import { createCommentsController } from './controller.js';
import { createCommentService } from './service.js';

/**
 * Handlers of the comments operations.
 *
 * @param db - Database connected as docs_app.
 */
export function commentsHandlers(db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>): OperationHandlers {
  const controller = createCommentsController(
    createCommentService(db, createApplicationService(db), createScreenLookup()),
  );
  return {
    listComments: controller.list,
    createComment: controller.create,
    updateComment: controller.update,
  };
}
