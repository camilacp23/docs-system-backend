/**
 * D-69 under concurrency: the database does not forbid two CONTEXT variables with the same name and no origin screen
 * (the partial unique index does not compare NULL), so the service checks the name inside the transaction and
 * serializes the writers with an advisory lock per application. Two simultaneous creations: one 201 and one 409.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { VARIABLE_NAME_LOCK_SPACE } from '../../src/modules/variables/repository.js';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication, insertScreen } from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';
import { createBodyOf, putBodyOf, variableOf } from '../helpers/variables.js';

describe('variables: concurrent names (D-69)', () => {
  let t: TestApp;
  let app: { id: number; name: string };
  let screen: { id: number };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Race app' });
    screen = await insertScreen(t, app.id);
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const countNamed = async (name: string): Promise<number> =>
    Number(
      (
        await t.owner.query<{ n: string }>(
          `SELECT count(*) AS n FROM variable WHERE application_id = $1 AND name = $2`,
          [app.id, name],
        )
      ).rows[0]!.n,
    );

  it('two simultaneous creations of the same nameless context variable: one 201 and one 409, in every round', async () => {
    for (let round = 0; round < 8; round += 1) {
      const name = `locRace${round}`;
      const body = createBodyOf(app.id, { name, scope: 'CONTEXT' });
      const results = await Promise.all([dev().post('/variables', body), dev().post('/variables', body)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], `round ${round}`);
      const loser = results.find((r) => r.status === 409)!;
      assert.equal(bodyOf(loser).code, 'DUPLICATE_NAME');
      assert.equal(bodyOf(loser).message, `A context variable named ${name} already exists in Race app.`);
      assert.equal(await countNamed(name), 1, `round ${round}`);
    }
  });

  it('a creation and a PUT that end with the same nameless context name: exactly one of them wins', async () => {
    const existing = variableOf(await dev().post('/variables', createBodyOf(app.id, { name: 'gToRename' })));
    const [created, renamed] = await Promise.all([
      dev().post('/variables', createBodyOf(app.id, { name: 'locPutRace', scope: 'CONTEXT' })),
      dev().put(`/variables/${existing.id}`, putBodyOf(existing, { name: 'locPutRace', scope: 'CONTEXT' })),
    ]);
    const outcome = `${created.status}/${renamed.status}`;
    assert.ok(outcome === '201/409' || outcome === '409/200', outcome);
    assert.equal(await countNamed('locPutRace'), 1);
  });

  it('the lock is really taken: a nameless creation waits while another session holds the application lock', async () => {
    const holder = new pg.Client({ connectionString: t.testDb.ownerUrl });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::int, $2::int)', [VARIABLE_NAME_LOCK_SPACE, app.id]);
      let settled = false;
      const pending = dev()
        .post('/variables', createBodyOf(app.id, { name: 'locWaits', scope: 'CONTEXT' }))
        .then((res) => {
          settled = true;
          return res;
        });
      // Creations that do not need the lock (GLOBAL, or with an origin screen) are not delayed by it.
      const free = await dev().post('/variables', createBodyOf(app.id, { name: 'gNotWaiting' }));
      assert.equal(free.status, 201);
      await sleep(400);
      assert.equal(settled, false, 'the nameless creation must be waiting for the lock');
      await holder.query('SELECT pg_advisory_unlock($1::int, $2::int)', [VARIABLE_NAME_LOCK_SPACE, app.id]);
      assert.equal((await pending).status, 201);
    } finally {
      await holder.end();
    }
  });

  it('a lock on another application does not delay this one', async () => {
    const other = await insertApplication(t, { name: 'Other race app' });
    const holder = new pg.Client({ connectionString: t.testDb.ownerUrl });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1::int, $2::int)', [VARIABLE_NAME_LOCK_SPACE, other.id]);
      const res = await dev().post('/variables', createBodyOf(app.id, { name: 'locIndependent', scope: 'CONTEXT' }));
      assert.equal(res.status, 201);
    } finally {
      await holder.end();
    }
  });

  it('simultaneous GLOBAL duplicates and CONTEXT duplicates with origin are 409 (the unique index is the backstop)', async () => {
    for (const over of [{ scope: 'GLOBAL' }, { scope: 'CONTEXT', originScreenId: screen.id }]) {
      const body = createBodyOf(app.id, { name: `dbRace${over.scope}`, ...over });
      const results = await Promise.all([dev().post('/variables', body), dev().post('/variables', body)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409], over.scope);
      assert.equal(bodyOf(results.find((r) => r.status === 409)!).code, 'DUPLICATE_NAME');
    }
  });
});
