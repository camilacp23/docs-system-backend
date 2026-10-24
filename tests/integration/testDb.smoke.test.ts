/** Smoke test of the disposable-database helper: template, clone, roles and audit_log privileges (FR-20). */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

describe('testDb helper', () => {
  let db: TestDb;
  let app: pg.Client;
  let owner: pg.Client;

  before(async () => {
    db = await createTestDb();
    app = new pg.Client({ connectionString: db.appUrl });
    owner = new pg.Client({ connectionString: db.ownerUrl });
    await app.connect();
    await owner.connect();
  });

  after(async () => {
    await app.end();
    await owner.end();
    await db.drop();
  });

  it('creates a disposable docs_test_* database, never docs_system', async () => {
    assert.match(db.name, /^docs_test_[a-f0-9]{12}$/);
    const current = await app.query<{ db: string; usr: string }>(
      'SELECT current_database() AS db, current_user AS usr',
    );
    assert.equal(current.rows[0]?.db, db.name);
    assert.equal(current.rows[0]?.usr, 'docs_app');
  });

  it('has the migrated schema (audit_log and app_user tables)', async () => {
    const tables = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('audit_log', 'app_user')`,
    );
    assert.equal(tables.rows[0]?.n, '2');
  });

  it('lets docs_app read audit_log', async () => {
    const rows = await app.query('SELECT 1 FROM audit_log LIMIT 1');
    assert.ok(rows.rowCount !== null);
  });

  for (const statement of [
    'INSERT INTO audit_log DEFAULT VALUES',
    'UPDATE audit_log SET id = id',
    'DELETE FROM audit_log',
    'TRUNCATE audit_log',
  ]) {
    it(`denies docs_app to write audit_log: ${statement}`, async () => {
      await assert.rejects(app.query(statement), (error: pg.DatabaseError) => error.code === '42501');
    });
  }

  it('drops the database on drop()', async () => {
    const extra = await createTestDb();
    await extra.drop();
    const check = await owner.query('SELECT 1 FROM pg_database WHERE datname = $1', [extra.name]);
    assert.equal(check.rowCount, 0);
  });

  it('drop() waits for a docs_app session that is still closing instead of failing with 42501', async () => {
    const extra = await createTestDb();
    const session = new pg.Client({ connectionString: extra.appUrl });
    await session.connect();
    // docs_owner may not terminate docs_app backends, so a plain DROP ... WITH (FORCE) would fail while it is open.
    const closing = new Promise<void>((resolve) => setTimeout(resolve, 400)).then(() => session.end());
    await extra.drop();
    await closing;
    const check = await owner.query('SELECT 1 FROM pg_database WHERE datname = $1', [extra.name]);
    assert.equal(check.rowCount, 0);
  });

  it('drop() reports the sessions that never close (a leak) instead of ignoring the error', async () => {
    const extra = await createTestDb();
    const leaked = new pg.Client({ connectionString: extra.appUrl });
    await leaked.connect();
    try {
      await assert.rejects(
        () => extra.drop(500),
        (error: Error) => /could not drop docs_test_/.test(error.message) && error.message.includes('docs_app'),
      );
    } finally {
      await leaked.end();
      await extra.drop();
    }
  });
});
