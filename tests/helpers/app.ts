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
import { createLogger } from '../../src/http/logger.js';
import type { OperationHandlers } from '../../src/http/operations.js';
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
  options: { handlers?: OperationHandlers; openapiPath?: string; env?: Record<string, string> } = {},
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
  const logger = createLogger(config, { write: (line: string) => void logs.push(line) });
  const built = buildApp({
    config,
    db,
    logger,
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
