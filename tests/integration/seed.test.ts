/**
 * Initial seed and start-up check of the reserved account, on a disposable database (FR-26, NFR-20, D-51,
 * TODO_FASE3 #3). The seed runs as docs_app, like the API.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { loadSeedConfig, type SeedConfig } from '../../src/config/seed.js';
import { createPrisma, type Database } from '../../src/db/prisma.js';
import { assertReservedAccount, ReservedAccountError } from '../../src/db/reservedAccount.js';
import { runSeed, SeedError } from '../../src/db/seed.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

const ADMIN_PASSWORD = 'correct-horse-9';
const RESERVED_EMAIL = 'integracion.jira@system.local';

describe('db:seed and reserved account', () => {
  let testDb: TestDb;
  let owner: pg.Client;
  let db: Database;
  let config: SeedConfig;

  const seedEnv = (): NodeJS.ProcessEnv => ({
    APP_DATABASE_URL: testDb.appUrl,
    BCRYPT_COST: '4',
    SEED_ADMIN_NAME: 'Ada Admin',
    SEED_ADMIN_EMAIL: 'Ada.Admin@Example.com',
    SEED_ADMIN_PASSWORD: ADMIN_PASSWORD,
    INTEGRATION_USER_EMAIL: RESERVED_EMAIL,
  });
  const users = async () =>
    (
      await owner.query<{ email: string; role: string; status: string; password_hash: string }>(
        'SELECT email, role, status, password_hash FROM app_user ORDER BY id',
      )
    ).rows;

  before(async () => {
    testDb = await createTestDb();
    owner = new pg.Client({ connectionString: testDb.ownerUrl });
    await owner.connect();
    db = createPrisma(testDb.appUrl);
    config = loadSeedConfig(seedEnv());
  });
  after(async () => {
    await db.base.$disconnect();
    await owner.end();
    await testDb.drop();
  });
  beforeEach(async () => {
    await owner.query('DELETE FROM app_user'); // audit rows keep a NULL actor, so nothing references app_user
  });

  it('creates exactly two users and a second run changes nothing', async () => {
    assert.deepEqual(await runSeed(db, config), { admin: 'created', reserved: 'created' });
    const first = await users();
    assert.equal(first.length, 2);
    assert.deepEqual(
      first.map((u) => [u.email, u.role, u.status]),
      [
        ['ada.admin@example.com', 'ADMINISTRATOR', 'ACTIVE'],
        [RESERVED_EMAIL, 'READER', 'INACTIVE'],
      ],
    );
    assert.deepEqual(await runSeed(db, config), { admin: 'exists', reserved: 'exists' });
    assert.deepEqual(await users(), first);
  });

  it('hashes the administrator password and leaves the reserved hash unusable', async () => {
    await runSeed(db, config);
    const [admin, reserved] = await users();
    const bcrypt = (await import('bcryptjs')).default;
    assert.ok(await bcrypt.compare(ADMIN_PASSWORD, admin?.password_hash ?? ''));
    assert.ok(reserved?.password_hash.startsWith('$2'));
    assert.ok(!(await bcrypt.compare(ADMIN_PASSWORD, reserved?.password_hash ?? '')));
  });

  it('does not modify an existing administrator', async () => {
    await runSeed(db, config);
    await owner.query(`UPDATE app_user SET name = 'Renamed', role = 'DEVELOPER' WHERE email = 'ada.admin@example.com'`);
    const before = await users();
    assert.deepEqual(await runSeed(db, config), { admin: 'exists', reserved: 'exists' });
    assert.deepEqual(await users(), before);
  });

  it('fails without modifying an altered reserved account, and creates nothing', async () => {
    await owner.query(
      `INSERT INTO app_user (name, email, password_hash, role, status)
       VALUES ('Integración Jira', $1, 'x', 'DEVELOPER', 'ACTIVE')`,
      [RESERVED_EMAIL],
    );
    await assert.rejects(
      runSeed(db, config),
      (e: unknown) => e instanceof SeedError && /DEVELOPER \/ ACTIVE/.test(e.message),
    );
    const rows = await users();
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0]?.role, rows[0]?.status, rows[0]?.password_hash], ['DEVELOPER', 'ACTIVE', 'x']);
  });

  it('rejects a password outside the policy and equal e-mails before touching the database', () => {
    assert.throws(
      () => loadSeedConfig({ ...seedEnv(), SEED_ADMIN_PASSWORD: 'onlyletterslong' }),
      /SEED_ADMIN_PASSWORD/,
    );
    assert.throws(
      () => loadSeedConfig({ ...seedEnv(), SEED_ADMIN_EMAIL: RESERVED_EMAIL }),
      /SEED_ADMIN_EMAIL: must differ/,
    );
  });

  it('is audited with actor NULL and db_role docs_app (NFR-20)', async () => {
    const since =
      (await owner.query<{ m: string | null }>('SELECT max(id)::text AS m FROM audit_log')).rows[0]?.m ?? '0';
    await runSeed(db, config);
    const audit = await owner.query<{ actor_user_id: number | null; db_role: string; action: string }>(
      `SELECT actor_user_id, db_role, action FROM audit_log
        WHERE id > $1 AND entity_type = 'app_user' ORDER BY id`,
      [since],
    );
    assert.equal(audit.rows.length, 2);
    for (const row of audit.rows) {
      assert.equal(row.actor_user_id, null);
      assert.equal(row.db_role, 'docs_app');
      assert.equal(row.action, 'CREATE');
    }
  });

  it('assertReservedAccount: missing, altered and correct', async () => {
    await assert.rejects(
      assertReservedAccount(db, RESERVED_EMAIL),
      (e: unknown) => e instanceof ReservedAccountError && /Run npm run db:seed/.test(e.message),
    );
    await runSeed(db, config);
    assert.equal(typeof (await assertReservedAccount(db, RESERVED_EMAIL)), 'number');
    await owner.query(`UPDATE app_user SET status = 'ACTIVE' WHERE email = $1`, [RESERVED_EMAIL]);
    await assert.rejects(assertReservedAccount(db, RESERVED_EMAIL), ReservedAccountError);
  });

  describe('server start-up', () => {
    /** Starts src/server.ts against the disposable database and resolves with its first decisive output. */
    const startServer = (): Promise<{ outcome: 'listening' | 'exited'; output: string; stop: () => void }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
          env: {
            ...process.env,
            NODE_ENV: 'test',
            PORT: String(30_000 + Math.floor(Math.random() * 20_000)),
            LOG_LEVEL: 'info',
            APP_DATABASE_URL: testDb.appUrl,
            JWT_KEYS: `test:${randomBytes(32).toString('base64')}`,
            FRONTEND_ORIGIN: 'http://localhost:5173',
            INTEGRATION_USER_EMAIL: RESERVED_EMAIL,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        const stop = (): void => void child.kill();
        const timer = setTimeout(() => {
          stop();
          reject(new Error(`server did not start or exit in time:\n${output}`));
        }, 60_000);
        const onData = (chunk: Buffer): void => {
          output += chunk.toString();
          if (output.includes('API listening')) {
            clearTimeout(timer);
            resolve({ outcome: 'listening', output, stop });
          }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('close', () => {
          clearTimeout(timer);
          resolve({ outcome: 'exited', output, stop });
        });
      });

    it('refuses to start without the reserved account and starts with it', async () => {
      const refused = await startServer();
      assert.equal(refused.outcome, 'exited');
      assert.match(refused.output, /Run npm run db:seed/);

      await runSeed(db, config);
      const started = await startServer();
      started.stop();
      assert.equal(started.outcome, 'listening');
    });
  });
});
