/**
 * Module 6, the order of the results (D-105 f): the exact name match first, then the normalized name by code point
 * (`COLLATE "C"`), the type and the id. The order must not depend on the collation of the database, which differs
 * between Windows and the Ubuntu runner, so the expected lists below are written by hand and the database is also asked
 * to sort the same names with an ICU collation to show that they WOULD sort differently.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import {
  insertApplication,
  insertCollection,
  insertComponent,
  insertScreen,
  insertVariable,
} from '../helpers/fixtures.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { keysOf, namesOf, searchOk } from '../helpers/search.js';
import { resultComparator } from '../helpers/searchOrder.js';

/** Names that sort differently under most collations: case, accents, underscore, digits, ñ. */
const NAMES = ['Zeta', 'alpha', 'Álamo', '_under', '9x', '10x', 'ñandú', 'Beta', 'beta2', 'apple', 'Apple2'];

/** The same names in code point order of their normalized form (written by hand). */
const EXPECTED = ['10x', '9x', '_under', 'Álamo', 'alpha', 'apple', 'Apple2', 'Beta', 'beta2', 'Zeta', 'ñandú'];

describe('search: order', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();
  let appId: number;

  before(async () => {
    t = await startTestApp();
    try {
      appId = (await insertApplication(t, { name: 'Order app' })).id;
      for (const name of NAMES) await insertVariable(t, appId, { name });
      // The same normalized name in the four types, and two names around it.
      const screen = await insertScreen(t, appId, { name: 'ALPHA' });
      await insertCollection(t, appId, { name: 'Alpha' });
      await insertComponent(t, appId, screen.id, { name: 'alpHa' });
      await insertVariable(t, appId, { name: 'aaalpha' });
      await insertVariable(t, appId, { name: 'Alphabet' });
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  it('sorts by the normalized name by code point, whatever the collation of the database', async () => {
    const body = await searchOk(t, { applicationId: appId, types: 'VARIABLE', pageSize: 100 });
    const withoutExtras = namesOf(body).filter((name) => NAMES.includes(name));
    assert.deepEqual(withoutExtras, EXPECTED);
  });

  it('the same names do sort differently with an ICU collation (so this test can tell)', async (ctx) => {
    let icu: string[];
    try {
      const r = await t.owner.query<{ n: string }>(
        `SELECT n FROM unnest($1::text[]) AS n ORDER BY n COLLATE "und-x-icu"`,
        [NAMES],
      );
      icu = r.rows.map((row) => row.n);
    } catch (error) {
      ctx.skip(
        `SKIPPED: the ICU collation "und-x-icu" is not available in this database (${(error as Error).message})`,
      );
      return;
    }
    if (JSON.stringify(icu) === JSON.stringify(EXPECTED)) {
      ctx.skip('SKIPPED: the ICU collation sorts these names like code point order, so it cannot show a difference');
      return;
    }
    assert.notDeepEqual(icu, EXPECTED);
  });

  it('with a text: the exact name match comes first (every type, by type and id), then the rest by name', async () => {
    const body = await searchOk(t, { applicationId: appId, q: ' alpha ', pageSize: 100 });
    assert.deepEqual(
      body.data.map((r) => `${r.type}:${r.name}`),
      [
        'SCREEN:ALPHA',
        'VARIABLE:alpha',
        'COLLECTION:Alpha',
        'COMPONENT:alpHa',
        'VARIABLE:aaalpha',
        'VARIABLE:Alphabet',
      ],
    );
    assert.deepEqual(
      body.data.map((r) => r.matchedIn),
      Array(6).fill('name'),
    );
  });

  it('the exact match ignores accents: "alamo" puts "Álamo" first', async () => {
    const body = await searchOk(t, { applicationId: appId, q: 'ALAMO', pageSize: 100 });
    assert.deepEqual(namesOf(body), ['Álamo']);
  });

  it('without a text there is no exact-match term: name, type and id, with no NULL in the order', async () => {
    const all = await searchOk(t, {
      applicationId: appId,
      types: 'SCREEN,VARIABLE,COLLECTION,COMPONENT',
      pageSize: 100,
    });
    const expected = [...all.data].sort(resultComparator(undefined));
    assert.deepEqual(
      keysOf(all),
      expected.map((r) => `${r.type}:${r.id}`),
    );
    const alphas = all.data.filter((r) => r.name.toLowerCase() === 'alpha').map((r) => r.type);
    assert.deepEqual(alphas, ['SCREEN', 'VARIABLE', 'COLLECTION', 'COMPONENT']);
  });

  it('with a text, the whole list follows the oracle', async () => {
    const found = await searchOk(t, { applicationId: appId, q: 'al', pageSize: 100 });
    assert.deepEqual(
      keysOf(found),
      [...found.data].sort(resultComparator('al')).map((r) => `${r.type}:${r.id}`),
    );
  });

  it('never sends two statements at once on one database connection (no pg deprecation notice)', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pgOverlap.stop(), []);
  });
});
