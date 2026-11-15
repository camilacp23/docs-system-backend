/**
 * Entry point: loads and validates the configuration, connects as docs_app, mounts the contract, listens on PORT
 * and shuts down in order on SIGINT / SIGTERM (stop accepting, finish in-flight requests, close Prisma).
 *
 * @module server
 */
import './config/loadEnvFile.js'; // must stay first: src/security/config.ts reads the environment on import
import { ConfigError, loadConfig, type AppConfig } from './config/index.js';
import { createPrisma } from './db/prisma.js';
import { assertReservedAccount, ReservedAccountError } from './db/reservedAccount.js';
import { buildApp } from './app.js';
import { createLogger } from './http/logger.js';
import { StartupError } from './http/operations.js';
import { missingJiraSettings } from './integrations/jira/index.js';

/** Time given to in-flight requests before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

function readConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config);
  const db = createPrisma(config.appDatabaseUrl);

  try {
    await db.base.$queryRaw`SELECT 1`; // fail fast if the database is unreachable
    await assertReservedAccount(db, config.integrationUserEmail); // actor of the webhook writes (TODO_FASE3 #3)
    const { app, policies, notImplemented, jira, reportWorker } = buildApp({ config, db, logger });
    const missingJira = missingJiraSettings(config.jira);
    if (missingJira.length > 0) {
      // D-89 / NFR-14: the API starts without Jira. Only the NAMES of the missing variables are logged.
      logger.warn(
        { missing: missingJira, jiraAvailable: jira.jiraAvailable },
        'Jira is not fully configured: ticket features are unavailable until the variables are set',
      );
    }
    logger.info(
      { total: policies.size, notImplemented: notImplemented.length, operations: notImplemented },
      `${notImplemented.length} of ${policies.size} operations are not implemented yet (they answer 404 NOT_IMPLEMENTED)`,
    );

    if (config.reports.workerEnabled) reportWorker.start();
    else logger.warn('the report worker is disabled (REPORT_WORKER_ENABLED=false): reports stay PENDING');

    const server = app.listen(config.port, () => {
      logger.info({ port: config.port, env: config.nodeEnv }, 'API listening');
    });

    let closing = false;
    const shutdown = (signal: string): void => {
      if (closing) return;
      closing = true;
      logger.info({ signal }, 'shutting down');
      const timer = setTimeout(() => {
        logger.error('shutdown timed out; exiting');
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      timer.unref();
      // The report being generated gets its grace (shorter than SHUTDOWN_TIMEOUT_MS) and, if it does not finish, stays PENDING.
      const workerStopped = reportWorker.stop().catch((e: unknown) => {
        logger.error({ err: e instanceof Error ? e.message : 'unknown' }, 'report worker stop');
      });
      server.close((err) => {
        workerStopped
          .then(() => db.base.$disconnect())
          .catch((e: unknown) => logger.error({ err: e instanceof Error ? e.message : 'unknown' }, 'prisma disconnect'))
          .finally(() => process.exit(err ? 1 : 0));
      });
      server.closeIdleConnections();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (e) {
    await db.base.$disconnect().catch(() => undefined);
    if (e instanceof ReservedAccountError) {
      logger.fatal({ reason: e.message }, 'reserved account check failed: refusing to start');
    } else if (e instanceof StartupError || (e instanceof Error && /x-roles/.test(e.message))) {
      logger.fatal({ reason: e.message }, 'the contract is inconsistent: refusing to start');
    } else {
      logger.fatal({ err: e instanceof Error ? e.message : 'unknown' }, 'could not start');
    }
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
