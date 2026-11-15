/**
 * The report worker of the API process (SDD 4.1: `src/jobs/reports`). It reads the dashboard figures and the dependency
 * graph through their services, so the Summary and the Dependencies parts are the ones the screens show.
 *
 * @module jobs/reports
 */
import type { ReportsConfig } from '../../config/env.js';
import type { Database } from '../../db/prisma.js';
import type { Logger } from '../../http/logger.js';
import type { JiraClient } from '../../integrations/jira/index.js';
import { createDashboardModuleService } from '../../modules/dashboard/routes.js';
import { createDependenciesModuleService } from '../../modules/dependencies/routes.js';
import { createReportWorker, type ReportWorker, type WorkerHooks } from './worker.js';
import type { Generator } from './types.js';

export type { ReportWorker, RunResult, WorkerHooks } from './worker.js';

/**
 * Creates the worker of the application (not started: the server starts it, tests call `runOnce`).
 *
 * @param deps - Database, logger, the Jira client (only its state is read, by the dashboard figures) and the limits.
 * @param test - Replacements for tests: generators and hooks.
 */
export function createApplicationReportWorker(
  deps: { db: Database; logger: Logger; jira: Pick<JiraClient, 'jiraAvailable'>; config: ReportsConfig },
  test: { generators?: { PDF?: Generator; XLSX?: Generator }; hooks?: WorkerHooks; maxContentChars?: number } = {},
): ReportWorker {
  return createReportWorker({
    db: deps.db,
    logger: deps.logger,
    config: deps.config,
    dashboard: createDashboardModuleService(deps.db, { jira: deps.jira }),
    dependencies: createDependenciesModuleService(deps.db),
    ...test,
  });
}
