/**
 * Shared pieces of the Bruno sandbox tooling: the isolated database `docs_sandbox`, its credentials file and the
 * environment of the sandbox API. Nothing here can touch `docs_system`: the only database it creates or drops is the
 * exact name `docs_sandbox`, and the administrator password never comes from the development `.env`.
 *
 * @module scripts/lib/sandbox
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPasswordPattern } from '../../src/config/seed.js';
import { createPrisma } from '../../src/db/prisma.js';
import { runSeed } from '../../src/db/seed.js';
import { connectMaintenance, ensureTemplate, TEMPLATE_NAME, withDatabase } from '../../tests/helpers/testDb.js';

/** The only database these scripts create or drop. */
export const SANDBOX_DB = 'docs_sandbox';
/** Port of the sandbox API (the development API uses 3000). */
export const SANDBOX_PORT = 3001;
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
 * Recreates `docs_sandbox` from `docs_test_template`, seeds the administrator and the reserved account, and writes the
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

  writeFileSync(
    SANDBOX_ENV_FILE,
    `SANDBOX_ADMIN_EMAIL=${SANDBOX_ADMIN_EMAIL}\nSANDBOX_ADMIN_PASSWORD=${password}\nSANDBOX_RESERVED_EMAIL=${SANDBOX_RESERVED_EMAIL}\nSANDBOX_RESERVED_ID=${reservedId}\n`,
    { mode: 0o600 },
  );
}

/**
 * Environment of the sandbox API. The development `.env` only supplies the docs_app host and credentials (through
 * {@link sandboxAppUrl}); every other value is fixed here or generated per start.
 */
export function sandboxApiEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
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
