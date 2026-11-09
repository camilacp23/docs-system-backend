/**
 * Module 4 under concurrency (NFR-08; D-62, D-71): two PUTs with the same If-Match never both win because the screen
 * row is locked FOR UPDATE and the ETag is compared inside the transaction; two creations with the same name are
 * serialized by the unique index (translated to 409); a PUT and a DELETE never leave a half-written screen. Every
 * test repeats the race in several rounds, since one lucky round proves nothing.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication, insertScreen, insertVariable } from '../helpers/fixtures.js';
import { createBodyOf, createScreenVia, putBodyOf, screenOf, templateWith } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';
import { putBodyOf as variablePut, variableOf } from '../helpers/variables.js';

const ROUNDS = 12;

describe('screens: concurrency', () => {
  let t: TestApp;
  let app: { id: number; name: string };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Screen racers' });
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const admin = () => asUser(t, t.users.admin.token);

  it('two PUTs with the same If-Match: one 200 and one 412 with currentETag, in every round', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { screen, etag } = await createScreenVia(dev(), app.id, { name: `Race put ${round}` });
      const [a, b] = await Promise.all([
        dev().put(`/screens/${screen.id}`, putBodyOf(screen, { template: templateWith({ onStart: 'from A' }) }), etag),
        admin().put(
          `/screens/${screen.id}`,
          putBodyOf(screen, { template: templateWith({ onStart: 'from B' }) }),
          etag,
        ),
      ]);
      const label = `round ${round}: ${a.status}/${b.status} ${JSON.stringify([a.body, b.body])}`;
      assert.deepEqual([a.status, b.status].sort(), [200, 412], label);
      const winner = a.status === 200 ? a : b;
      const loser = a.status === 200 ? b : a;
      assert.equal(bodyOf(loser).code, 'PRECONDITION_FAILED', label);
      assert.equal(
        (loser.body as { details: { currentETag: string } }).details.currentETag,
        winner.headers.etag,
        label,
      );
      const stored = screenOf(await dev().get(`/screens/${screen.id}`));
      assert.equal(stored.template.onStart, a.status === 200 ? 'from A' : 'from B', label);
    }
  });

  it('two PUTs that swap different component names with the same If-Match: one wins, the screen is never mixed', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { screen, etag } = await createScreenVia(dev(), app.id, {
        name: `Race swap ${round}`,
        components: [
          { name: 'left', type: 'T' },
          { name: 'right', type: 'T' },
        ],
      });
      const [left, right] = ['left', 'right'].map((n) => screen.components.find((c) => c.name === n)!);
      const swap = {
        components: [
          { id: left!.id, name: 'right', type: 'T' },
          { id: right!.id, name: 'left', type: 'T' },
        ],
      };
      const [a, b] = await Promise.all([
        dev().put(`/screens/${screen.id}`, putBodyOf(screen, swap), etag),
        admin().put(`/screens/${screen.id}`, putBodyOf(screen, swap), etag),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [200, 412], `round ${round}`);
      const names = screenOf(await dev().get(`/screens/${screen.id}`))
        .components.map((c) => c.name)
        .sort();
      assert.deepEqual(names, ['left', 'right'], `round ${round}`);
    }
  });

  it('two creations with the same name: one 201 and one 409 DUPLICATE_NAME, in every round', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const body = createBodyOf(app.id, { name: `Race create ${round}` });
      const [a, b] = await Promise.all([dev().post('/screens', body), admin().post('/screens', body)]);
      const label = `round ${round}: ${a.status}/${b.status} ${JSON.stringify([a.body, b.body])}`;
      assert.deepEqual([a.status, b.status].sort(), [201, 409], label);
      const loser = a.status === 409 ? a : b;
      assert.equal(bodyOf(loser).code, 'DUPLICATE_NAME', label);
      assert.deepEqual((loser.body as { details: unknown }).details, {
        field: 'name',
        type: 'screen',
        name: `Race create ${round}`,
        application: 'Screen racers',
        container: 'application',
      });
      const count = await t.owner.query(`SELECT 1 FROM screen WHERE application_id = $1 AND name = $2`, [
        app.id,
        `Race create ${round}`,
      ]);
      assert.equal(count.rowCount, 1, label);
    }
  });

  it('a PUT and a DELETE of the same screen: the PUT is 200 or 404, the DELETE 204, never a 500 or a half screen', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { screen, etag } = await createScreenVia(dev(), app.id, {
        name: `Race delete ${round}`,
        components: [{ name: 'c', type: 'T' }],
      });
      const [update, remove] = await Promise.all([
        dev().put(`/screens/${screen.id}`, putBodyOf(screen, { components: [{ name: 'd', type: 'T' }] }), etag),
        dev().delete(`/screens/${screen.id}`),
      ]);
      const label = `round ${round}: ${update.status}/${remove.status}`;
      assert.equal(remove.status, 204, label);
      assert.ok([200, 404].includes(update.status), label);
      assert.equal((await dev().get(`/screens/${screen.id}`)).status, 404, label);
      const left = await t.owner.query(`SELECT 1 FROM component WHERE screen_id = $1`, [screen.id]);
      assert.equal(left.rowCount, 0, label);
    }
  });

  it('a link to a context variable and the removal of its origin never commit together (CP-07)', async () => {
    const holderOrigin = await insertScreen(t, app.id, { name: 'Race origin' });
    for (let round = 0; round < ROUNDS; round += 1) {
      const ctx = await insertVariable(t, app.id, {
        name: `locRace${round}`,
        scope: 'CONTEXT',
        originScreenId: holderOrigin.id,
      });
      const { screen, etag } = await createScreenVia(dev(), app.id, { name: `Race linker ${round}` });
      const variable = variableOf(await dev().get(`/variables/${ctx.id}`));
      const [linked, orphaned] = await Promise.all([
        dev().put(
          `/screens/${screen.id}`,
          putBodyOf(screen, { variableLinks: [{ variableId: ctx.id, accessMode: 'WRITE', usedIn: 'nav.Go' }] }),
          etag,
        ),
        dev().put(`/variables/${ctx.id}`, variablePut(variable, { originScreenId: null })),
      ]);
      const label = `round ${round}: ${linked.status}/${orphaned.status} ${JSON.stringify([linked.body, orphaned.body])}`;
      // Whatever wins, a link to a context variable without origin must not exist.
      const bad = await t.owner.query(
        `SELECT 1 FROM screen_variable sv JOIN variable v ON v.id = sv.variable_id
          WHERE v.scope = 'CONTEXT' AND v.origin_screen_id IS NULL AND sv.variable_id = $1`,
        [ctx.id],
      );
      assert.equal(bad.rowCount, 0, label);
      assert.ok([linked.status, orphaned.status].includes(200), label);
    }
  });
});
