/**
 * Disposable PostgreSQL databases for tests (Phase 3 decision "Pruebas", CLAUDE.md rule 10).
 *
 * - `ensureTemplate()` creates (or reuses) the template database `docs_test_template` by applying
 *   `prisma migrate deploy` as docs_owner. A SHA-256 of `prisma/migrations` (plus the template setup version)
 *   is stored in the database COMMENT; the template is rebuilt only when it changes.
 * - `createTestDb()` clones the template into `docs_test_<random>` and returns the connection URLs for docs_app
 *   (the one the API uses) and docs_owner, plus `drop()` to delete it.
 *
 * Safety: every database it creates or drops must match `docs_test_*`; it never connects to `docs_system`.
 * Credentials come from DATABASE_URL / APP_DATABASE_URL (.env, or .env.test overrides, or the environment);
 * a URL without password falls back to pgpass / PGPASSWORD (read by the pg driver). Nothing secret is printed.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS_DIR = join(ROOT, 'prisma', 'migrations');
const PRISMA_CLI = join(ROOT, 'node_modules', 'prisma', 'build', 'index.js');

/** Bump when the template setup below changes, so existing templates are rebuilt. */
const TEMPLATE_SETUP_VERSION = '1';
export const TEMPLATE_NAME = 'docs_test_template';
const TEST_DB_PATTERN = /^docs_test_[a-z0-9_]+$/;
/** Arbitrary key shared by all test processes to serialize template creation and cloning. */
const ADVISORY_LOCK_KEY = 7_302_026;

// .env.test (optional) wins over .env; real environment variables win over both.
dotenv.config({ path: join(ROOT, '.env.test'), quiet: true });
dotenv.config({ path: join(ROOT, '.env'), quiet: true });

export type TestDb = {
  /** Database name (`docs_test_<random>`). */
  name: string;
  /** Connection URL of the API role (docs_app): give it to createPrisma / the app under test. */
  appUrl: string;
  /** Connection URL of the owner role (docs_owner): for fixtures that docs_app may not write. */
  ownerUrl: string;
  /** Drops the database (idempotent). */
  drop: () => Promise<void>;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example / .env.test.example)`);
  return value;
}

/** Same server and credentials as `baseUrl`, different database. */
export function withDatabase(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function assertTestDatabase(name: string): void {
  if (!TEST_DB_PATTERN.test(name)) throw new Error(`Refusing to touch database "${name}": not a docs_test_* database`);
}

/** Connection to the maintenance database as docs_owner (CREATEDB), used to create and drop databases. */
export async function connectMaintenance(): Promise<pg.Client> {
  const maintenanceDb = process.env.TEST_DB_MAINTENANCE_DB ?? 'postgres';
  if (/^docs_system$/i.test(maintenanceDb)) throw new Error('TEST_DB_MAINTENANCE_DB must not be docs_system');
  const client = new pg.Client({ connectionString: withDatabase(requireEnv('DATABASE_URL'), maintenanceDb) });
  await client.connect();
  return client;
}

/** SHA-256 over the relative path and bytes of every file under prisma/migrations, plus the setup version. */
export function migrationsHash(): string {
  const hash = createHash('sha256').update(`setup:${TEMPLATE_SETUP_VERSION}\n`);
  const walk = (dir: string): string[] =>
    readdirSync(dir)
      .sort()
      .flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? walk(full) : [full];
      });
  for (const file of walk(MIGRATIONS_DIR)) {
    hash.update(relative(MIGRATIONS_DIR, file).replaceAll('\\', '/')).update('\0').update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Runs `prisma migrate deploy` against `ownerUrl` (docs_owner). Output is kept; the URL is never echoed. */
function migrateDeploy(ownerUrl: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: ownerUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`prisma migrate deploy failed (exit ${String(code)}):\n${output.split(ownerUrl).join('<url>')}`),
        );
    });
  });
}

/** Mirrors bootstrap/01_roles_and_database.sql for a fresh database (roles are cluster-wide and already exist). */
async function configureTemplateDatabase(ownerUrl: string, database: string): Promise<void> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
    await client.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO docs_app`);
    await client.query('ALTER SCHEMA public OWNER TO docs_owner');
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  } finally {
    await client.end();
  }
}

/**
 * Creates `docs_test_template` if it does not exist or its migrations hash is stale.
 * Safe to call from several processes at once (serialized with an advisory lock).
 * @returns whether an existing up-to-date template was reused.
 */
export async function ensureTemplate(): Promise<{ reused: boolean }> {
  const expected = `migrations:${migrationsHash()}`;
  const admin = await connectMaintenance();
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    const found = await admin.query<{ comment: string | null }>(
      `SELECT shobj_description(oid, 'pg_database') AS comment FROM pg_database WHERE datname = $1`,
      [TEMPLATE_NAME],
    );
    if (found.rows[0]?.comment === expected) return { reused: true };
    if (found.rows.length > 0) await admin.query(`DROP DATABASE ${TEMPLATE_NAME} WITH (FORCE)`);

    await admin.query(`CREATE DATABASE ${TEMPLATE_NAME} OWNER docs_owner`);
    const ownerUrl = withDatabase(requireEnv('DATABASE_URL'), TEMPLATE_NAME);
    await configureTemplateDatabase(ownerUrl, TEMPLATE_NAME);
    await migrateDeploy(ownerUrl);
    // The comment is written last: a half-built template is never considered up to date.
    await admin.query(`COMMENT ON DATABASE ${TEMPLATE_NAME} IS '${expected}'`);
    return { reused: false };
  } finally {
    await admin.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    await admin.end();
  }
}

/** Clones the template into a new `docs_test_<random>` database. Call `drop()` when the test file ends. */
export async function createTestDb(): Promise<TestDb> {
  await ensureTemplate();
  const name = `docs_test_${randomBytes(6).toString('hex')}`;
  assertTestDatabase(name);
  const admin = await connectMaintenance();
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_NAME} OWNER docs_owner`);
  } finally {
    await admin.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => undefined);
    await admin.end();
  }

  let dropped = false;
  return {
    name,
    appUrl: withDatabase(requireEnv('APP_DATABASE_URL'), name),
    ownerUrl: withDatabase(requireEnv('DATABASE_URL'), name),
    drop: async () => {
      if (dropped) return;
      assertTestDatabase(name);
      const dropper = await connectMaintenance();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        dropped = true;
      } finally {
        await dropper.end();
      }
    },
  };
}
