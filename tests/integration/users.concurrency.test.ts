/**
 * The last-active-administrator rule under concurrency (FR-03; SDD Table 62). Two administrators acting on each
 * other at the same time can never leave zero active administrators: every change locks the target and all active
 * administrators in one ordered statement (`lockTargetAndActiveAdmins`) and counts afterwards.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { prepareAuthUsers } from '../helpers/auth.js';
import { activeAdmins, adminsOf, asUser } from '../helpers/users.js';

describe('users: last active administrator under concurrency', () => {
  let t: TestApp;
  let a: { id: number; token: string };
  let s: { id: number; token: string };

  before(async () => {
    t = await startTestApp();
    await prepareAuthUsers(t);
    ({ a, s } = await adminsOf(t));
  });
  after(async () => {
    await t.close();
  });

  const reset = async () => {
    await t.owner.query(`UPDATE app_user SET role = 'ADMINISTRATOR', status = 'ACTIVE' WHERE id = ANY($1)`, [
      [a.id, s.id],
    ]);
  };

  it('setup: exactly two active administrators', async () => {
    assert.equal(await activeAdmins(t), 2);
  });

  it('two administrators demoting each other at once: never zero, at most one succeeds (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      await reset();
      const [x, y] = await Promise.all([
        asUser(t, a.token).put(`/users/${s.id}/role`, { role: 'READER' }),
        asUser(t, s.token).put(`/users/${a.id}/role`, { role: 'READER' }),
      ]);
      const statuses = [x.status, y.status].sort();
      // The loser is 422 LAST_ACTIVE_ADMIN, or 403 when the winner committed before the loser's authorization.
      assert.equal(statuses[0], 200, `round ${round}: ${statuses.join(',')}`);
      assert.ok(statuses[1] === 422 || statuses[1] === 403, `round ${round}: ${statuses.join(',')}`);
      assert.equal(await activeAdmins(t), 1, `round ${round}`);
    }
  });

  it('two administrators deactivating each other at once (DELETE and PUT): never zero', async () => {
    for (let round = 0; round < 10; round++) {
      await reset();
      const forUser = (id: number) => ({ name: 'N', email: `${id}@x.local`, status: 'INACTIVE' });
      const rows = await t.db.base.user.findMany({ where: { id: { in: [a.id, s.id] } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const viaPut = (token: string, id: number) =>
        asUser(t, token).put(`/users/${id}`, { ...forUser(id), name: byId.get(id)!.name, email: byId.get(id)!.email });
      const [x, y] =
        round % 2 === 0
          ? await Promise.all([
              asUser(t, a.token).delete(`/users/${s.id}`),
              asUser(t, s.token).delete(`/users/${a.id}`),
            ])
          : await Promise.all([viaPut(a.token, s.id), viaPut(s.token, a.id)]);
      const ok = [x.status, y.status].filter((c) => c === 200 || c === 204);
      assert.equal(ok.length, 1, `round ${round}: ${x.status},${y.status}`);
      assert.equal(await activeAdmins(t), 1, `round ${round}`);
    }
  });

  /**
   * Deterministic version: the owner connection locks administrator `a` and changes them without committing. The
   * request (authenticated while `a` still looks active) must WAIT for that lock; once the owner commits, the rule is
   * evaluated on the committed data.
   */
  const withHeldLock = async (hold: string, request: () => ReturnType<ReturnType<typeof asUser>['get']>) => {
    await reset();
    await t.owner.query('BEGIN');
    try {
      await t.owner.query(`SELECT id FROM app_user WHERE id = $1 FOR UPDATE`, [a.id]);
      await t.owner.query(hold, [a.id]);
      let settled = false;
      const pending = request().then((res) => {
        settled = true;
        return res;
      });
      await sleep(600);
      assert.equal(settled, false, 'the request must wait for the row lock');
      await t.owner.query('COMMIT');
      return await pending;
    } catch (error) {
      await t.owner.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  };

  it('DELETE waits for a concurrent change and then answers 422 LAST_ACTIVE_ADMIN', async () => {
    // a (authenticated while active) deactivates s; meanwhile a itself is deactivated by someone else, uncommitted.
    const res = await withHeldLock(`UPDATE app_user SET status = 'INACTIVE' WHERE id = $1`, () =>
      asUser(t, a.token).delete(`/users/${s.id}`),
    );
    assert.equal(res.status, 422);
    assert.equal(bodyOf(res).code, 'LAST_ACTIVE_ADMIN');
    assert.equal(await activeAdmins(t), 1);
    assert.equal((await t.db.base.user.findUniqueOrThrow({ where: { id: s.id } })).status, 'ACTIVE');
  });

  it('PUT/role waits for the lock of the other administrator and re-counts on committed data', async () => {
    // s demotes ITSELF while a (the only other active administrator) is being demoted by someone else, uncommitted.
    const res = await withHeldLock(`UPDATE app_user SET role = 'READER' WHERE id = $1`, () =>
      asUser(t, s.token).put(`/users/${s.id}/role`, { role: 'READER' }),
    );
    assert.equal(res.status, 422);
    assert.equal(bodyOf(res).code, 'LAST_ACTIVE_ADMIN');
    assert.equal(await activeAdmins(t), 1);
    assert.equal((await t.db.base.user.findUniqueOrThrow({ where: { id: s.id } })).role, 'ADMINISTRATOR');
  });

  it('PUT status waits for the lock and answers 422 LAST_ACTIVE_ADMIN on committed data', async () => {
    // Same as DELETE, through PUT: the owner deactivates the actor `a`; once committed, s is the last administrator.
    const row = await t.db.base.user.findUniqueOrThrow({ where: { id: s.id } });
    const res = await withHeldLock(`UPDATE app_user SET status = 'INACTIVE' WHERE id = $1`, () =>
      asUser(t, a.token).put(`/users/${s.id}`, { name: row.name, email: row.email, status: 'INACTIVE' }),
    );
    assert.equal(res.status, 422);
    assert.equal(bodyOf(res).code, 'LAST_ACTIVE_ADMIN');
    assert.equal(await activeAdmins(t), 1);
  });
});
