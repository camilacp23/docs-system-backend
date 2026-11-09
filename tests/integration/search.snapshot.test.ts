/**
 * Module 6, one snapshot per search (FR-18). The page carries its total in the same statement, so the total and the
 * page always come from one scan. Only a page beyond the end has no row to carry the total, and then a second
 * statement counts; it runs in the same REPEATABLE READ transaction, so its total is the one of the snapshot even if
 * another connection committed in between. The repository takes an optional callback that production never passes; here
 * it commits a write with the owner connection between those two statements. Without REPEATABLE READ the total would
 * count the new element and the old one would disappear.
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
  /** A service whose repository runs `change` once, inside the snapshot, between the page and the count. */
  const racing = (change: () => Promise<unknown>) => {
    const calls = { n: 0 };
    const service = createSearchService(
      createSearchRepository(t.db, {
        afterPage: async () => {
          calls.n += 1;
          if (calls.n === 1) await change();
        },
      }),
    );
    return { service, calls };
  };
  const read = (service: ReturnType<typeof plain>, skip: number, take: number) =>
    service.search({ applicationId, q: 'snap', skip, take });
  const add = () => async () => {
    counter += 1;
    await insertVariable(t, applicationId, { name: `snapNew${counter}` });
  };

  it('a page with rows is one statement: the total comes with it and nothing can come between', async () => {
    const { service, calls } = racing(add());
    const during = await read(service, 0, 2);
    assert.equal(calls.n, 0, 'no second statement was needed');
    assert.equal(during.data.length, 2);
    assert.equal(during.total, (await read(plain(), 0, 100)).total, 'the total counts every match, not the page');
  });

  it('a page beyond the end counts in the same snapshot: an element committed in between is not in the total', async () => {
    const before = await read(plain(), 0, 100);
    const { service, calls } = racing(add());
    const during = await read(service, 50, 20);
    assert.equal(calls.n, 1, 'the page was empty, so the total was counted by a second statement');
    assert.deepEqual(during.data, []);
    assert.equal(during.total, before.total, 'the total is from the snapshot');

    const next = await read(plain(), 0, 100);
    assert.equal(next.total, before.total + 1, 'the next read, a new snapshot, sees the committed element');
    assert.equal(next.data.length, next.total);
  });

  it('an element deleted between the two statements is still in the total', async () => {
    const victim = await insertVariable(t, applicationId, { name: 'snapVictim' });
    const before = await read(plain(), 0, 100);
    const { service } = racing(() => t.owner.query(`DELETE FROM documented_element WHERE id = $1`, [victim.id]));
    const during = await read(service, 50, 20);
    assert.equal(during.total, before.total, 'the snapshot still counts it');
    assert.equal((await read(plain(), 0, 100)).total, before.total - 1);
  });

  it('a search with no match is one statement and has total 0', async () => {
    const { service, calls } = racing(add());
    const none = await service.search({ applicationId, q: 'zzqxjk', skip: 0, take: 20 });
    assert.deepEqual([none.data.length, none.total, calls.n], [0, 0, 0]);
  });

  it('never sends two statements at once on one database connection (no pg deprecation notice)', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pgOverlap.stop(), []);
  });
});
