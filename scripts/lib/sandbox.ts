/**
 * Shared pieces of the Bruno sandbox tooling: the isolated database `docs_sandbox`, its credentials file and the
 * environment of the sandbox API. Nothing here can touch `docs_system`: the only database it creates or drops is the
 * exact name `docs_sandbox`, and the administrator password never comes from the development `.env`.
 *
 * @module scripts/lib/sandbox
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPasswordPattern } from '../../src/config/seed.js';
import { createPrisma } from '../../src/db/prisma.js';
import { runSeed } from '../../src/db/seed.js';
import { assertLocalJiraBaseUrl, JIRA_ENV_NAMES } from '../../tests/helpers/jiraGuard.js';
import { SIMULATOR_DEFAULTS } from '../../tests/helpers/jiraSimulator.js';
import { connectMaintenance, ensureTemplate, TEMPLATE_NAME, withDatabase } from '../../tests/helpers/testDb.js';
import { insertSandboxFixtures, SANDBOX_DB } from './sandboxFixtures.js';

export { SANDBOX_DB };

/** Port of the sandbox API (the development API uses 3000). */
export const SANDBOX_PORT = 3001;
/** Port of the local Jira simulator of the sandbox (never a real Jira). */
export const SANDBOX_JIRA_PORT = 3002;
export const SANDBOX_ADMIN_NAME = 'Sandbox Administrator';
export const SANDBOX_ADMIN_EMAIL = 'admin@sandbox.local';
export const SANDBOX_RESERVED_EMAIL = 'integracion.jira@system.local';
/** Same value as `.env.example`: the cookie endpoints accept only this Origin. */
export const SANDBOX_FRONTEND_ORIGIN = 'http://localhost:5173';
/** Lowest cost the configuration accepts (BCRYPT_COST min 4): keeps the sandbox run fast. */
export const SANDBOX_BCRYPT_COST = 4;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Git-ignored file (`.env*` in the collection's .gitignore) read by Bruno as `process.env`. */
export const SANDBOX_ENV_FILE = join(ROOT, 'bruno', 'docs-system-api', '.env');

const PASSWORD_LENGTH = 24;
const ALPHANUMERIC = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** What the Jira simulator of the sandbox and the sandbox API share; generated on every `sandbox:db`. */
export type SandboxJira = { baseUrl: string; email: string; apiToken: string; webhookSecret: string };

/** Lines of the credentials file with the simulator's URL and per-run secrets (never a real Jira, never a real secret). */
function jiraLines(): string {
  return [
    `SANDBOX_JIRA_BASE_URL=http://127.0.0.1:${SANDBOX_JIRA_PORT}`,
    'SANDBOX_JIRA_EMAIL=sandbox.jira@example.org',
    `SANDBOX_JIRA_API_TOKEN=${randomBytes(16).toString('hex')}`,
    `SANDBOX_JIRA_WEBHOOK_SECRET=${randomBytes(24).toString('hex')}`,
    '',
  ].join('\n');
}

/**
 * Reads `SANDBOX_JIRA_*` from the generated credentials file (`npm run sandbox:db` writes it). It reads that file only,
 * never the development `.env`, and returns nothing but those four keys.
 *
 * @returns The simulator settings, or null when the file or the keys are missing.
 * @throws {Error} When the URL does not point to localhost or 127.0.0.1.
 */
export function readSandboxJira(): SandboxJira | null {
  if (!existsSync(SANDBOX_ENV_FILE)) return null;
  const values = new Map<string, string>();
  for (const line of readFileSync(SANDBOX_ENV_FILE, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && line.startsWith('SANDBOX_JIRA_')) values.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const baseUrl = values.get('SANDBOX_JIRA_BASE_URL');
  const email = values.get('SANDBOX_JIRA_EMAIL');
  const apiToken = values.get('SANDBOX_JIRA_API_TOKEN');
  const webhookSecret = values.get('SANDBOX_JIRA_WEBHOOK_SECRET');
  if (!baseUrl || !email || !apiToken || !webhookSecret) return null;
  assertLocalJiraBaseUrl(baseUrl, 'sandbox');
  return { baseUrl, email, apiToken, webhookSecret };
}

/** Refuses any database name other than the exact sandbox name. */
function assertSandbox(name: string): void {
  if (name !== SANDBOX_DB) throw new Error(`Refusing to touch database "${name}": only ${SANDBOX_DB} is allowed`);
}

/**
 * Random password that meets the contract policy (letters and digits, 12-128 characters).
 *
 * @returns A new password; callers must never print it.
 */
export function generatePassword(): string {
  const pick = (): string => ALPHANUMERIC[randomBytes(1)[0]! % ALPHANUMERIC.length]!;
  for (;;) {
    const candidate = Array.from({ length: PASSWORD_LENGTH }, pick).join('');
    if (/[A-Za-z]/.test(candidate) && /\d/.test(candidate)) return candidate;
  }
}

/** Connection URL of the API role (docs_app) for `docs_sandbox`: host and credentials come from the development env. */
export function sandboxAppUrl(): string {
  const base = process.env.APP_DATABASE_URL;
  if (!base) throw new Error('APP_DATABASE_URL is not set (see .env.example)');
  return withDatabase(base, SANDBOX_DB);
}

/** Connection URL of docs_owner (host and credentials of the development env; the database is replaced by the caller). */
function requireOwnerUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL is not set (see .env.example)');
  return base;
}

/** Drops `docs_sandbox` (no error when it does not exist). */
export async function dropSandbox(): Promise<void> {
  assertSandbox(SANDBOX_DB);
  const admin = await connectMaintenance();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SANDBOX_DB} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/**
 * Recreates `docs_sandbox` from `docs_test_template`, seeds the administrator and the reserved account, inserts the "Sandbox Fixtures" application, and writes the
 * credentials file of the collection.
 *
 * @returns Nothing; the generated password is only written to {@link SANDBOX_ENV_FILE}.
 */
export async function recreateSandbox(): Promise<void> {
  assertSandbox(SANDBOX_DB);
  await ensureTemplate();
  const admin = await connectMaintenance();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SANDBOX_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SANDBOX_DB} TEMPLATE ${TEMPLATE_NAME} OWNER docs_owner`);
  } finally {
    await admin.end();
  }

  const password = generatePassword();
  if (!loadPasswordPattern().test(password)) throw new Error('Generated password does not meet the policy');
  const db = createPrisma(sandboxAppUrl());
  let reservedId: number;
  try {
    await runSeed(db, {
      appDatabaseUrl: sandboxAppUrl(),
      bcryptCost: SANDBOX_BCRYPT_COST,
      adminName: SANDBOX_ADMIN_NAME,
      adminEmail: SANDBOX_ADMIN_EMAIL,
      adminPassword: password,
      integrationUserEmail: SANDBOX_RESERVED_EMAIL,
    });
    // The collection needs the real id of the reserved account (it is hidden from the API); read it by e-mail.
    const reserved = await db.base.user.findUnique({ where: { email: SANDBOX_RESERVED_EMAIL }, select: { id: true } });
    if (!reserved) throw new Error('The reserved account was not created by the seed');
    reservedId = reserved.id;
  } finally {
    await db.base.$disconnect();
  }

  const fixtures = await insertSandboxFixtures(withDatabase(requireOwnerUrl(), SANDBOX_DB), SANDBOX_ADMIN_EMAIL);

  writeFileSync(
    SANDBOX_ENV_FILE,
    `SANDBOX_ADMIN_EMAIL=${SANDBOX_ADMIN_EMAIL}\nSANDBOX_ADMIN_PASSWORD=${password}\nSANDBOX_RESERVED_EMAIL=${SANDBOX_RESERVED_EMAIL}\nSANDBOX_RESERVED_ID=${reservedId}
` +
      `SANDBOX_FIXTURES_APP_ID=${fixtures.applicationId}
SANDBOX_FIXTURES_SCREEN_A_ID=${fixtures.screenAId}
` +
      `SANDBOX_FIXTURES_SCREEN_B_ID=${fixtures.screenBId}
SANDBOX_FIXTURES_VARIABLE_ID=${fixtures.sharedVariableId}
` +
      `SANDBOX_FIXTURES_LINKED_VARIABLE_ID=${fixtures.linkedVariableId}
SANDBOX_FIXTURES_COLLECTION_ID=${fixtures.collectionId}
SANDBOX_FIXTURES_DOCUMENTED_COLLECTION_ID=${fixtures.documentedCollectionId}
` +
      jiraLines(),
    { mode: 0o600 },
  );
}

/**
 * Environment of the sandbox API. The development `.env` only supplies the docs_app host and credentials (through
 * {@link sandboxAppUrl}); every other value is fixed here or generated per start.
 */
export function sandboxApiEnv(jira: SandboxJira | null = readSandboxJira()): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...sandboxJiraEnv(jira),
    NODE_ENV: 'development',
    PORT: String(SANDBOX_PORT),
    LOG_LEVEL: 'warn',
    TRUST_PROXY: 'false',
    APP_DATABASE_URL: sandboxAppUrl(),
    JWT_KEYS: `sandbox:${randomBytes(32).toString('base64')}`,
    JWT_ACCESS_TTL_SECONDS: '28800',
    SESSION_MAX_SECONDS: '43200',
    BCRYPT_COST: String(SANDBOX_BCRYPT_COST),
    FRONTEND_ORIGIN: SANDBOX_FRONTEND_ORIGIN,
    RATE_LIMIT_SESSION_MAX: '30',
    RATE_LIMIT_SESSION_WINDOW_MINUTES: '15',
    INTEGRATION_USER_EMAIL: SANDBOX_RESERVED_EMAIL,
  };
}

/**
 * The `JIRA_*` variables of the sandbox API. The development `.env` may hold the real Jira, so EVERY variable is set
 * here, empty when there is no simulator: the loader of `.env` never overrides a variable that already exists.
 *
 * @param jira - Settings of the simulator (null = Jira not configured, the API runs with jiraAvailable = false).
 * @returns All eight Jira variables.
 * @throws {Error} When the URL does not point to localhost or 127.0.0.1.
 */
export function sandboxJiraEnv(jira: SandboxJira | null): Record<(typeof JIRA_ENV_NAMES)[number], string> {
  if (jira === null)
    return Object.fromEntries(JIRA_ENV_NAMES.map((n) => [n, ''])) as Record<(typeof JIRA_ENV_NAMES)[number], string>;
  assertLocalJiraBaseUrl(jira.baseUrl, 'sandbox API');
  return {
    JIRA_BASE_URL: jira.baseUrl,
    JIRA_EMAIL: jira.email,
    JIRA_API_TOKEN: jira.apiToken,
    JIRA_PROJECT_KEY: SIMULATOR_DEFAULTS.projectKey,
    JIRA_ISSUETYPE_EPIC_ID: SIMULATOR_DEFAULTS.issueTypeIds.epic,
    JIRA_ISSUETYPE_STORY_ID: SIMULATOR_DEFAULTS.issueTypeIds.story,
    JIRA_ISSUETYPE_SUBTASK_ID: SIMULATOR_DEFAULTS.issueTypeIds.subtask,
    JIRA_WEBHOOK_SECRET: jira.webhookSecret,
  };
}
