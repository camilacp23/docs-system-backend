/**
 * Routes of the screens module (Module 4): binds each implemented operationId of the contract to its handler. Roles
 * are not declared here; the contract (x-roles) is the only source of authorization (D-39). The Jira operations are the creation of
 * tickets, the tree and the signed webhook (whose raw body and signature are handled by `http/jiraWebhookGate`). The comment of a review is written through the comments service, which has no endpoints yet.
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
import { createIntegrationActor } from './jiraActor.js';
import { createJiraTicketService } from './jiraTickets.js';
import { createJiraTreeService } from './jiraTree.js';
import { createJiraWebhookService } from './jiraWebhook.js';
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
    /** E-mail of the reserved account that Jira-caused writes are attributed to (D-31, D-51). */
    integrationUserEmail: string;
    /** Issues per page of the refresh search (tests use a small one). */
    refreshPageSize?: number;
  },
): OperationHandlers {
  const applications = createApplicationService(db);
  const lookup = createScreenLookup();
  const variables = createVariableService(db, applications, lookup);
  const collections = createCollectionService(db, applications, lookup, variables);
  const runAsIntegration = createIntegrationActor(db, jiraDeps.integrationUserEmail);
  const controller = createScreensController(
    createScreenService(db, applications, variables, collections, createCommentService()),
    createJiraTicketService({ db, applications, ...jiraDeps }),
    createJiraTreeService({
      db,
      applications,
      jira: jiraDeps.jira,
      jiraBaseUrl: jiraDeps.jiraBaseUrl,
      logger: jiraDeps.logger,
      runAsIntegration,
      ...(jiraDeps.refreshPageSize === undefined ? {} : { pageSize: jiraDeps.refreshPageSize }),
    }),
    createJiraWebhookService({ db, applications, logger: jiraDeps.logger, runAsIntegration }),
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
    listJiraTickets: controller.listJiraTickets,
    receiveJiraWebhook: controller.receiveJiraWebhook,
  };
}
