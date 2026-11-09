/**
 * The real application over a disposable database (CLAUDE.md rule 10): `startTestApp()` clones the template,
 * connects as docs_app, mounts the contract and seeds one active user per role plus an inactive one.
 */
import './env.js';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import supertest from 'supertest';
import { buildApp, type BuiltApp } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config/index.js';
import { createPrisma, type Database } from '../../src/db/prisma.js';
import { createLogger, type Logger } from '../../src/http/logger.js';
import type { OperationHandlers } from '../../src/http/operations.js';
import type { JiraClient } from '../../src/integrations/jira/index.js';
import { signAccessToken } from '../../src/security/tokens.js';
import { assertJiraConfigIsLocal, assertLocalJiraBaseUrl } from './jiraGuard.js';
import { createTestDb, type TestDb } from './testDb.js';

/** Shape of an error body ({ code, message, details }); `details` lists only the keys the tests read. */
export type ApiBody = {
  code: string;
  message: string;
  details: {
    reason?: string;
    requiredRoles: string[];
    fields: { field: string; rule: string; message: string }[];
    requestId?: string;
    element?: string;
  };
};

/** Typed view of `res.body` (supertest types it as any). */
export const bodyOf = (res: { body: unknown }): ApiBody => res.body as ApiBody;

export const TEST_ORIGIN = 'http://localhost:5173';

/**
 * An error the server logged (pino level error or above): the log of a 500, found by the `requestId` that the client
 * received in `details.requestId`. Only the diagnostic fields are kept, never the request headers or body.
 *
 * Database and Prisma errors log their class, the Prisma code, the SQLSTATE and the constraint, table and model, but
 * not their message or stack, because those embed the values of the query (the server's own policy). Any other error
 * also logs its message and stack.
 */
export type ServerErrorLog = {
  requestId: string | undefined;
  method?: string;
  path?: string;
  msg?: string;
  reason?: string;
  errorClass?: string;
  code?: string;
  prismaCode?: string;
  sqlstate?: string;
  constraint?: string;
  table?: string;
  model?: string;
  message?: string;
  stack?: string;
};

/** The fields of a server log line that explain an error. */
const SERVER_ERROR_FIELDS = [
  'method',
  'path',
  'msg',
  'reason',
  'errorClass',
  'code',
  'prismaCode',
  'sqlstate',
  'constraint',
  'table',
  'model',
  'message',
  'stack',
] as const;

/**
 * Collects the errors a server logs and prints the failure of each request as it happens. Feed it every line of the
 * pino destination of the server of a test (`startTestApp` does; so does any test that builds its own server).
 *
 * The line was already redacted by pino, and only the diagnostic fields are printed (`[server error] requestId=...`),
 * so the cause of a 500 is in the output of the test that received it. Only the failure of a request is printed (the
 * line of the error handler); the other error lines (Jira, the HTTP logger) are kept in `entries` but not printed.
 *
 * @param report - Print the failures to stderr (default true).
 */
export function serverErrorSink(report = true): { entries: ServerErrorLog[]; accept: (line: string) => void } {
  const entries: ServerErrorLog[] = [];
  return {
    entries,
    accept: (line) => {
      const failure = parseServerError(line);
      if (failure === undefined) return;
      entries.push(failure);
      if (report && failure.msg === 'request failed') {
        console.error(`[server error] requestId=${failure.requestId ?? '-'} ${JSON.stringify(failure)}`);
      }
    },
  };
}

/** The error entry of a log line, or `undefined` when the line is not an error (level 50 or above) or not JSON. */
function parseServerError(line: string): ServerErrorLog | undefined {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof entry['level'] !== 'number' || entry['level'] < 50) return undefined;
  const found: ServerErrorLog = { requestId: typeof entry['requestId'] === 'string' ? entry['requestId'] : undefined };
  for (const field of SERVER_ERROR_FIELDS) {
    const value = entry[field];
    if (typeof value === 'string') found[field] = value;
  }
  return found;
}

export type TestApp = {
  testDb: TestDb;
  config: AppConfig;
  db: Database;
  built: BuiltApp;
  /** supertest agent bound to the app. */
  http: ReturnType<typeof supertest>;
  /** docs_owner connection for fixtures that docs_app may not write. */
  owner: pg.Client;
  /** Lines written by the application logger (JSON). */
  logs: string[];
  /**
   * The errors the server logged so far, with their `requestId`. A test that gets a 500 finds there why (the same
   * failure of a request is also printed to stderr as soon as it is written, unless `reportServerErrors` is false).
   */
  errorLogs: () => ServerErrorLog[];
  users: Record<'admin' | 'developer' | 'reader' | 'inactive', { id: number; token: string }>;
  close: () => Promise<void>;
};

/** Environment of the test configuration (explicit: nothing is read from the shell). */
export function testEnv(appUrl: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    LOG_LEVEL: 'info',
    APP_DATABASE_URL: appUrl,
    JWT_KEYS: `test:${randomBytes(32).toString('base64')}`,
    FRONTEND_ORIGIN: TEST_ORIGIN,
    INTEGRATION_USER_EMAIL: 'integracion.jira@system.local',
    BCRYPT_COST: '4',
    ...overrides,
  };
}

/**
 * Starts the application on a new disposable database.
 *
 * @param options - Module handlers, an alternative contract and extra environment values.
 */
export async function startTestApp(
  options: {
    handlers?: OperationHandlers;
    openapiPath?: string;
    env?: Record<string, string>;
    /** Builds the Jira client the application uses (tests pass one with a fake `fetch` or short thresholds). */
    jira?: (logger: Logger) => JiraClient;
    /** Issues per page of the Jira refresh search. */
    refreshPageSize?: number;
    /**
     * Print each error the server logs to stderr as it happens (default true). A test that causes a server error on
     * purpose passes false.
     */
    reportServerErrors?: boolean;
  } = {},
): Promise<TestApp> {
  // Never reach the real Jira from a test; checked before a database is created.
  assertLocalJiraBaseUrl(options.env?.['JIRA_BASE_URL'], 'test application');
  const testDb = await createTestDb();
  const owner = new pg.Client({ connectionString: testDb.ownerUrl });
  await owner.connect();
  const db = createPrisma(testDb.appUrl);
  const logs: string[] = [];
  const config = loadConfig(testEnv(testDb.appUrl, options.env));
  assertJiraConfigIsLocal(config.jira, 'test application');
  const sink = serverErrorSink(options.reportServerErrors ?? true);
  const logger = createLogger(config, {
    write: (line: string) => {
      logs.push(line);
      sink.accept(line);
    },
  });
  const built = buildApp({
    config,
    db,
    logger,
    ...(options.jira ? { jira: options.jira(logger) } : {}),
    ...(options.refreshPageSize ? { refreshPageSize: options.refreshPageSize } : {}),
    ...(options.handlers ? { handlers: options.handlers } : {}),
    ...(options.openapiPath ? { openapiPath: options.openapiPath } : {}),
  });

  const insert = async (name: string, email: string, role: string, status: string): Promise<number> => {
    const r = await owner.query<{ id: number }>(
      `INSERT INTO app_user (name, email, password_hash, role, status) VALUES ($1, $2, 'not-a-real-hash', $3::user_role, $4::user_status) RETURNING id`,
      [name, email, role, status],
    );
    return r.rows[0]!.id;
  };
  const ids = {
    admin: await insert('Ada Admin', 'admin@test.local', 'ADMINISTRATOR', 'ACTIVE'),
    developer: await insert('Dev Eloper', 'dev@test.local', 'DEVELOPER', 'ACTIVE'),
    reader: await insert('Rea Der', 'reader@test.local', 'READER', 'ACTIVE'),
    inactive: await insert('Ina Ctive', 'inactive@test.local', 'DEVELOPER', 'INACTIVE'),
  };
  const users = Object.fromEntries(
    Object.entries(ids).map(([k, id]) => [k, { id, token: signAccessToken(id) }]),
  ) as TestApp['users'];

  return {
    testDb,
    config,
    db,
    built,
    http: supertest(built.app),
    owner,
    logs,
    errorLogs: () => [...sink.entries],
    users,
    close: async () => {
      await db.base.$disconnect();
      await owner.end();
      await testDb.drop();
    },
  };
}

/** `Authorization` header value for a user of `startTestApp`. */
export const bearer = (token: string): string => `Bearer ${token}`;
