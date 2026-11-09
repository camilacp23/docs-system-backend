/**
 * Registry of module handlers by `operationId` (SDD D-42). Each module adds its operations here when it is
 * built; an operation of the contract without an entry answers 404 NOT_IMPLEMENTED (development only).
 *
 * @module modules
 */
import type { Database } from '../db/prisma.js';
import type { Logger } from '../http/logger.js';
import type { JiraClient } from '../integrations/jira/index.js';
import type { OperationHandlers } from '../http/operations.js';
import { applicationsHandlers } from './applications/routes.js';
import { authHandlers } from './auth/routes.js';
import { collectionsHandlers } from './collections/routes.js';
import { dependenciesHandlers } from './dependencies/routes.js';
import { screensHandlers } from './screens/routes.js';
import { usersHandlers } from './users/routes.js';
import { variablesHandlers } from './variables/routes.js';

/**
 * Builds the handlers of every implemented module.
 *
 * @param deps - The database the services use, and the Jira client with the base URL of the links it builds.
 */
export function createModuleHandlers(deps: {
  db: Database;
  jira: JiraClient;
  jiraBaseUrl: string | undefined;
  defaultProjectKey: string | undefined;
  logger: Logger;
  integrationUserEmail: string;
  refreshPageSize?: number;
}): OperationHandlers {
  return {
    ...authHandlers(deps.db),
    ...usersHandlers(deps.db),
    ...applicationsHandlers(deps.db),
    ...screensHandlers(deps.db, {
      jira: deps.jira,
      jiraBaseUrl: deps.jiraBaseUrl,
      defaultProjectKey: deps.defaultProjectKey,
      logger: deps.logger,
      integrationUserEmail: deps.integrationUserEmail,
      ...(deps.refreshPageSize === undefined ? {} : { refreshPageSize: deps.refreshPageSize }),
    }),
    ...variablesHandlers(deps.db),
    ...collectionsHandlers(deps.db),
    ...dependenciesHandlers(deps.db),
  };
}
