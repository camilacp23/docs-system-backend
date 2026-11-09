/**
 * Module 6, the light version of the performance test: an application of about 200 elements with long-ish templates.
 * It checks that the search answers what the data says, without measuring any time. The measured version, with about
 * 2000 elements and 17 MB of text, is `tests/perf/search.performance.test.ts` (`npm run test:perf`).
 *
 * The expected totals are counted with plain SQL (`ILIKE`) on the data, independently of the search.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication } from '../helpers/fixtures.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { keysOf, searchOk } from '../helpers/search.js';
import { loadSearchData, type SearchDataSize } from '../helpers/searchData.js';

const SIZE: SearchDataSize = {
  screens: 50,
  variables: 50,
  collections: 50,
  components: 50,
  fieldsPerCollection: 3,
  links: 80,
  repeat: 10,
};

describe('search: about 200 elements', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();
  let applicationId: number;

  before(async () => {
    t = await startTestApp();
    try {
      applicationId = (await insertApplication(t, { name: 'Scale app' })).id;
      await loadSearchData(t, applicationId, SIZE);
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  /** How many elements contain the text in a field the search reads, counted with plain SQL. */
  const countContaining = async (word: string): Promise<number> => {
    const like = `%${word}%`;
    const r = await t.owner.query<{ n: string }>(
      `SELECT (SELECT count(*) FROM screen WHERE application_id = $1 AND (on_start ILIKE $2 OR working_process ILIKE $2
                OR architecture ILIKE $2 OR data_model ILIKE $2 OR requirements ILIKE $2 OR known_issues ILIKE $2
                OR risks ILIKE $2))
            + (SELECT count(*) FROM variable WHERE application_id = $1 AND description ILIKE $2)
            + (SELECT count(*) FROM collection WHERE application_id = $1 AND description ILIKE $2)
            + (SELECT count(*) FROM component WHERE application_id = $1 AND description ILIKE $2) AS n`,
      [applicationId, like],
    );
    return Number(r.rows[0]!.n);
  };

  it('has about 200 elements besides App (OnStart)', async () => {
    const r = await t.owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM documented_element WHERE application_id = $1`,
      [applicationId],
    );
    assert.equal(Number(r.rows[0]!.n), 200 + 1);
  });

  it('a common text: the total is what the data holds, the page is full and the matches are in the right field', async () => {
    const expected = await countContaining('filtro');
    assert.ok(expected > 20, 'the premise: more than a page');
    const body = await searchOk(t, { applicationId, q: 'FILTRO' });
    assert.equal(body.total, expected);
    assert.equal(body.data.length, 20);
    assert.equal(new Set(keysOf(body)).size, 20, 'one result per element');
    for (const r of body.data) {
      assert.equal(r.matchedIn, r.type === 'SCREEN' ? 'template' : 'description', `${r.type} ${r.id}`);
      const snippet = r.snippet ?? '';
      assert.ok(snippet.toLowerCase().includes('filtro'), `${r.type} ${r.id} has a snippet around the match`);
      assert.ok(snippet.length <= 300);
    }
  });

  it('every page of it adds up to the total, in a stable order', async () => {
    const expected = await countContaining('filtro');
    const all: string[] = [];
    for (let page = 1; page <= Math.ceil(expected / 50); page += 1) {
      const body = await searchOk(t, { applicationId, q: 'filtro', pageSize: 50, page });
      assert.equal(body.total, expected);
      all.push(...keysOf(body));
    }
    assert.equal(all.length, expected);
    assert.equal(new Set(all).size, expected);
  });

  it('a text that finds nothing', async () => {
    const body = await searchOk(t, { applicationId, q: 'zzqxjk' });
    assert.deepEqual([body.total, body.data], [0, []]);
  });

  it('filters only: the variables present in PROD', async () => {
    const body = await searchOk(t, { applicationId, types: 'VARIABLE,COLLECTION', environment: 'PROD', pageSize: 100 });
    const r = await t.owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM element_environment ee JOIN documented_element e ON e.id = ee.element_id
        WHERE e.application_id = $1 AND ee.environment = 'PROD'`,
      [applicationId],
    );
    assert.equal(body.total, Number(r.rows[0]!.n));
    assert.equal(body.total, SIZE.variables / 2);
  });

  it('a high page of a text that matches every screen, and a page beyond the end', async () => {
    const first = await searchOk(t, { applicationId, q: 'lorem', pageSize: 20 });
    assert.equal(first.total, SIZE.screens);
    const last = await searchOk(t, { applicationId, q: 'lorem', pageSize: 20, page: Math.ceil(first.total / 20) });
    assert.equal(last.data.length, first.total - 20 * (Math.ceil(first.total / 20) - 1));
    const beyond = await searchOk(t, { applicationId, q: 'lorem', pageSize: 20, page: 99 });
    assert.deepEqual([beyond.data, beyond.total], [[], first.total]);
  });

  it('never sends two statements at once on one database connection (no pg deprecation notice)', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pgOverlap.stop(), []);
  });
});
