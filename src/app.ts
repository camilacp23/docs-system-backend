/**
 * The real Express application (SDD Section 4.1, Figure 3).
 *
 * Chain, in this order: helmet -> CORS -> requestId and access log -> Jira webhook gate (raw body + signature, only
 * its path) -> JSON body (1 MB; skipped for the webhook, whose body the gate already read) -> cookies -> /auth rate limits -> [per operation: authenticate -> authorize -> request validation ->
 * handler] -> 404 ROUTE_NOT_FOUND -> errorHandler.
 *
 * The request id and the log come BEFORE the body parser (the SDD lists them after it) so that a 400 or 413
 * produced by the parser also carries X-Request-Id and appears in the log.
 *
 * @module app
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import type { AppConfig } from './config/env.js';
import type { Database } from './db/prisma.js';

import { corsPolicy, requestValidator, securityHeaders } from './http/chain.js';
import { createErrorHandler, routeNotFound } from './http/errorHandler.js';
import { jiraWebhookGate } from './http/jiraWebhookGate.js';
import { createLogger, type Logger } from './http/logger.js';
import { createApplicationReportWorker, type ReportWorker } from './jobs/reports/index.js';
import { createJiraClient, type JiraClient } from './integrations/jira/index.js';
import { authRateLimit } from './http/rateLimit.js';
import { registerOperations, type OperationHandlers } from './http/operations.js';
import { requestContext } from './http/requestContext.js';
import { createModuleHandlers } from './modules/index.js';
import { configureSecurity } from './security/config.js';
import { loadPolicies, type OperationPolicy } from './security/rbac.js';

/** `api/openapi.yaml` of this repository. */
export const DEFAULT_OPENAPI_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'api',
  'openapi.yaml',
);

const JSON_BODY_LIMIT = '1mb';

export type BuildAppOptions = {
  config: AppConfig;
  db: Database;
  /** Contract to mount (tests pass a modified copy). Default: `api/openapi.yaml`. */
  openapiPath?: string;
  /** Module handlers by operationId. Default: the registry of `src/modules`. */
  handlers?: OperationHandlers;
  logger?: Logger;
  /** Jira client (tests pass one over the simulator). Default: built from `config.jira`. */
  jira?: JiraClient;
  /** Issues per page of the Jira refresh search (tests pass a small one). Default: the maximum. */
  refreshPageSize?: number;
  /** Report worker (tests pass one with their own generators). Default: the application's, not started. */
  reportWorker?: ReportWorker;
};

export type BuiltApp = {
  app: Express;
  policies: Map<string, OperationPolicy>;
  /** Operations without a handler yet (they answer 404 NOT_IMPLEMENTED). */
  notImplemented: string[];
  logger: Logger;
  /** Isolated Jira client (NFR-14); the Jira operations use it from the next tasks on. */
  jira: JiraClient;
  /** The report worker of this process; the server starts it, tests call `runOnce`. */
  reportWorker: ReportWorker;
};

/**
 * Builds the application. It throws (the server does not start) when an operation of the contract has no
 * `x-roles`, or has empty roles without being one of the public operations.
 *
 * @param options - Validated configuration, database and optional overrides for tests.
 * @returns The Express app, the policies generated from the contract and the pending operations.
 */
export function buildApp(options: BuildAppOptions): BuiltApp {
  const { config, db } = options;
  const logger = options.logger ?? createLogger(config);
  const jira =
    options.jira ?? createJiraClient(config.jira, { logger }, { production: config.nodeEnv === 'production' });
  const reportWorker =
    options.reportWorker ?? createApplicationReportWorker({ db, logger, jira, config: config.reports });
  const policies = loadPolicies(options.openapiPath ?? DEFAULT_OPENAPI_PATH);

  configureSecurity({
    keys: config.jwtKeys,
    accessTtlSeconds: config.jwtAccessTtlSeconds,
    sessionMaxSeconds: config.sessionMaxSeconds,
    bcryptCost: config.bcryptCost,
    allowedOrigin: config.frontendOrigin,
    integrationUserEmail: config.integrationUserEmail,
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders());
  app.use(corsPolicy(config));
  app.use(requestContext(logger));

  // The Jira webhook is signed over its RAW body. Its gate (raw body + signature) is registered BEFORE the JSON parser
  // and by the same router as the operation, so a path that only differs in case or by a trailing "/" cannot reach the
  // parser first; once the gate has read the body, express.json skips it.
  const webhookPath = [...policies.values()].find((p) => p.rule === 'JIRA_SIGNATURE')?.expressPath;
  if (webhookPath !== undefined) app.post(webhookPath, ...jiraWebhookGate(config.jira.webhookSecret, logger));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(cookieParser());

  app.use('/api/v1/auth', authRateLimit(config));

  const notImplemented = registerOperations(app, {
    policies,
    handlers:
      options.handlers ??
      createModuleHandlers({
        db,
        jira,
        jiraBaseUrl: config.jira.baseUrl,
        defaultProjectKey: config.jira.projectKey,
        logger,
        integrationUserEmail: config.integrationUserEmail,
        onReportQueued: () => reportWorker.wake(),
        ...(options.refreshPageSize === undefined ? {} : { refreshPageSize: options.refreshPageSize }),
      }),
    validator: requestValidator(options.openapiPath ?? DEFAULT_OPENAPI_PATH),
    db,
  });

  app.use(routeNotFound);
  app.use(createErrorHandler({ db, logger }));
  return { app, policies, notImplemented, logger, jira, reportWorker };
}
