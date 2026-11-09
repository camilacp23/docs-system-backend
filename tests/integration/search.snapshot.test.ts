/**
 * Module 6, one snapshot per search (FR-18): the total and the page are read in the same REPEATABLE READ transaction,
 * so an element committed or deleted by another connection between the two statements is in neither or in both. The
 * repository takes an optional callback that production never passes; here it commits a write with the owner
 * connection after the total was read and before the page is. Without REPEATABLE READ the page would disagree with the
 * total.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication, insertVariable } from '../helpers/fixtures.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { createSearchRepository } from '../../src/modules/search/repository.js';
import { createSearchService } from '../../src/modules/search/service.js';

describe('search: one snapshot per read', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();
  let applicationId: number;
  const names = ['snapA', 'snapB', 'snapC', 'snapD'];
  let counter = 0;

  before(async () => {
    t = await startTestApp();
    try {
      applicationId = (await insertApplication(t, { name: 'Snapshot app' })).id;
      for (const name of names) await insertVariable(t, applicationId, { name });
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  const plain = () => createSearchService(createSearchRepository(t.db));
  /** A service whose repository runs `change` once, inside the snapshot, between the total and the page. */
  const racing = (change: () => Promise<unknown>) => {
    let done = false;
    return createSearchService(
      createSearchRepository(t.db, {
        afterCount: async () => {
          if (done) return;
          done = true;
          await change();
        },
      }),
    );
  };
  const read = (service: ReturnType<typeof plain>, skip: number, take: number) =>
    service.search({ applicationId, q: 'snap', skip, take });
  const add = () => async () => {
    counter += 1;
    await insertVariable(t, applicationId, { name: `snapNew${counter}` });
  };

  it('an element committed by another connection between the total and the page is in neither', async () => {
    const before = await read(plain(), 0, 100);
    assert.equal(before.data.length, before.total);

    const during = await read(racing(add()), 0, 100);
    assert.equal(during.total, before.total, 'the total is from the snapshot');
    assert.equal(during.data.length, during.total, 'and so is the page');
    assert.ok(!during.data.some((r) => r.name.startsWith('snapNew')));

    const next = await read(plain(), 0, 100);
    assert.equal(next.total, before.total + 1, 'the next read, a new snapshot, sees the committed element');
    assert.equal(next.data.length, next.total);
  });

  it('an element deleted by another connection between the two statements is still in both', async () => {
    const victim = await insertVariable(t, applicationId, { name: 'snapVictim' });
    const before = await read(plain(), 0, 100);
    const during = await read(
      racing(() => t.owner.query(`DELETE FROM documented_element WHERE id = $1`, [victim.id])),
      0,
      100,
    );
    assert.equal(during.total, before.total);
    assert.equal(during.data.length, during.total);
    assert.ok(
      during.data.some((r) => r.name === 'snapVictim'),
      'the snapshot still holds it',
    );
    assert.equal((await read(plain(), 0, 100)).total, before.total - 1);
  });

  it('a page in the middle of the list does not shift under the reader', async () => {
    const total = (await read(plain(), 0, 1)).total;
    const expected = (await read(plain(), 1, 2)).data.map((r) => r.id);
    const during = await read(racing(add()), 1, 2);
    assert.equal(during.total, total);
    assert.deepEqual(
      during.data.map((r) => r.id),
      expected,
    );
    assert.equal((await read(plain(), 0, 1)).total, total + 1);
  });

  it('never sends two statements at once on one database connection (no pg deprecation notice)', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pgOverlap.stop(), []);
  });
});
