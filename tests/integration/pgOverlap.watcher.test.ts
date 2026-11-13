/**
 * The detector of overlapping queries (tests/helpers/pgWarnings.ts) really sees the notice of `pg`: two statements sent at
 * once on one client are reported, one after the other are not. Without this, "no notice" in other tests would prove nothing.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { allowPgOverlap, trackPgOverlap } from '../helpers/pgOverlap.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

// The only declared exception of the global check (tests/setup/failOnPgOverlap.ts): this file overlaps statements on purpose.
allowPgOverlap('tests the detectors of overlapping statements, so it provokes them');

describe('pg overlap detector', () => {
  let testDb: TestDb | undefined;
  let client: pg.Client | undefined;

  before(async () => {
    try {
      testDb = await createTestDb();
      client = new pg.Client({ connectionString: testDb.ownerUrl });
      await client.connect();
    } catch (error) {
      await release();
      throw error;
    }
  });
  after(release);

  /** Closes the client and drops the database, whatever failed. */
  async function release(): Promise<void> {
    try {
      await client?.end();
    } finally {
      client = undefined;
      await testDb?.drop();
      testDb = undefined;
    }
  }

  it('sees two statements sent at once, and nothing for statements sent one after the other', async () => {
    const quiet = watchPgOverlap();
    await client!.query('SELECT 1');
    await client!.query('SELECT 2');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(quiet.stop(), []);

    const loud = watchPgOverlap();
    await Promise.all([client!.query('SELECT 1'), client!.query('SELECT 2'), client!.query('SELECT 3')]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loud.stop().length, 1, 'pg words the notice once per process');
  });

  it('the exact counter sees every overlapping statement, with its text, and none for statements in series', async () => {
    const serial = trackPgOverlap();
    await client!.query('SELECT 1');
    await client!.query('SELECT 2');
    assert.deepEqual(serial.stop(), []);

    const parallel = trackPgOverlap();
    await Promise.all([client!.query('SELECT 11'), client!.query('SELECT 12'), client!.query('SELECT 13')]);
    assert.deepEqual(
      parallel.stop().map((o) => o.sql),
      ['SELECT 12', 'SELECT 13'],
      'the first statement runs alone; each one sent while another was pending is counted',
    );
  });
});
