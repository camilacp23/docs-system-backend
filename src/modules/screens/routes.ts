/**
 * Routes of the screens module (Module 4): binds each implemented operationId of the contract to its handler. Roles
 * are not declared here; the contract (x-roles) is the only source of authorization (D-39). Of the Jira operations only the creation of
 * tickets is implemented so far. The comment of a review is written through the comments service, which has no endpoints yet.
 *
 * @module modules/screens/routes
 */
import type { Database } from '../../db/prisma.js';
import type { Logger } from '../../http/logger.js';
import type { OperationHandlers } from '../../http/operations.js';
import type { JiraClient } from '../../integrations/jira/index.js';
import { createApplicationService } from '../applications/service.js';
import { createCollectionService } from '../collections/service.js';
import { createCommentService } from '../comments/service.js';
import { createVariableService } from '../variables/service.js';
import { createScreensController } from './controller.js';
import { createJiraTicketService } from './jiraTickets.js';
import { createScreenLookup, createScreenService } from './service.js';

/**
 * Handlers of the implemented screen operations.
 *
 * @param db - Database connected as docs_app.
 * @param jiraDeps - The Jira client, the base URL of its links, the project used when an application has none
 *   (D-91) and the logger.
 */
export function screensHandlers(
  db: Pick<Database, 'base' | 'prisma' | 'auditedTransaction'>,
  jiraDeps: {
    jira: JiraClient;
    jiraBaseUrl: string | undefined;
    defaultProjectKey: string | undefined;
    logger: Logger;
  },
): OperationHandlers {
  const applications = createApplicationService(db);
  const lookup = createScreenLookup();
  const variables = createVariableService(db, applications, lookup);
  const collections = createCollectionService(db, applications, lookup, variables);
  const controller = createScreensController(
    createScreenService(db, applications, variables, collections, createCommentService()),
    createJiraTicketService({ db, applications, ...jiraDeps }),
  );
  return {
    listScreens: controller.list,
    createScreen: controller.create,
    getScreen: controller.get,
    updateScreen: controller.update,
    deleteScreen: controller.remove,
    changeScreenStatus: controller.changeStatus,
    reviewScreen: controller.review,
    createJiraTicket: controller.createJiraTicket,
  };
}
