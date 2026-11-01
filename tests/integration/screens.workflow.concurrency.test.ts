/**
 * The documentation workflow under concurrency (FR-14, FR-24; D-62, D-88): `/status` and `/review` lock the screen row
 * FOR UPDATE and judge the status and the ETag inside the transaction, so of two simultaneous decisions only one wins.
 * Every test repeats the race in several rounds, since one lucky round proves nothing. Without the lock these tests
 * fail (both requests read the same status or the same ETag and both write).
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication } from '../helpers/fixtures.js';
import { createScreenInStatus, detailsOf, screenOf } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

const ROUNDS = 15;

describe('screens workflow: concurrency', () => {
  let t: TestApp;
  let app: { id: number; name: string };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Workflow racers' });
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const admin = () => asUser(t, t.users.admin.token);
  const rowsOf = async (sql: string, params: unknown[]): Promise<unknown[]> =>
    (await t.owner.query(sql, params)).rows as unknown[];

  it('APPROVE and RETURN at the same time: one 200 and one 422 NOT_IN_REVIEW, one comment and one event, in every round', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { screen } = await createScreenInStatus(t, dev(), app.id, 'IN_REVIEW');
      const [approve, ret] = await Promise.all([
        admin().post(`/screens/${screen.id}/review`, { decision: 'APPROVE', comment: 'approved' }),
        admin().post(`/screens/${screen.id}/review`, { decision: 'RETURN', comment: 'returned' }),
      ]);
      const label = `round ${round}: ${approve.status}/${ret.status} ${JSON.stringify([approve.body, ret.body])}`;
      assert.deepEqual([approve.status, ret.status].sort(), [200, 422], label);
      const winner = approve.status === 200 ? approve : ret;
      const loser = approve.status === 200 ? ret : approve;
      assert.equal(bodyOf(loser).code, 'NOT_IN_REVIEW', label);

      const expected = approve.status === 200 ? 'APPROVED' : 'IN_PROGRESS';
      assert.equal(screenOf(winner).documentationStatus, expected, label);
      assert.equal(screenOf(await dev().get(`/screens/${screen.id}`)).documentationStatus, expected, label);

      // Exactly the winner's comment and event exist: the loser wrote nothing.
      const comments = await rowsOf(`SELECT text, review_decision FROM comment WHERE screen_id = $1`, [screen.id]);
      assert.deepEqual(
        comments,
        [
          approve.status === 200
            ? { text: 'approved', review_decision: 'APPROVE' }
            : { text: 'returned', review_decision: 'RETURN' },
        ],
        label,
      );
      const events = await rowsOf(
        `SELECT event_name FROM audit_log WHERE action = 'EVENT' AND entity_type = 'screen' AND entity_id = $1`,
        [String(screen.id)],
      );
      assert.deepEqual(
        events,
        [{ event_name: approve.status === 200 ? 'DOCUMENTATION_APPROVED' : 'DOCUMENTATION_RETURNED' }],
        label,
      );
    }
  });

  it('two APPROVEs at the same time: one 200 and one 422 NOT_IN_REVIEW, one event', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { screen } = await createScreenInStatus(t, dev(), app.id, 'IN_REVIEW');
      const [a, b] = await Promise.all([
        admin().post(`/screens/${screen.id}/review`, { decision: 'APPROVE' }),
        admin().post(`/screens/${screen.id}/review`, { decision: 'APPROVE' }),
      ]);
      const label = `round ${round}: ${a.status}/${b.status}`;
      assert.deepEqual([a.status, b.status].sort(), [200, 422], label);
      assert.equal(bodyOf(a.status === 422 ? a : b).code, 'NOT_IN_REVIEW', label);
      const events = await rowsOf(
        `SELECT 1 FROM audit_log WHERE action = 'EVENT' AND entity_type = 'screen' AND entity_id = $1`,
        [String(screen.id)],
      );
      assert.equal(events.length, 1, label);
    }
  });

  it('two /status with the same If-Match: one 200 and one 412 with the winner ETag, in every round', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { screen, etag } = await createScreenInStatus(t, dev(), app.id, 'DRAFT');
      const [a, b] = await Promise.all([
        dev().put(`/screens/${screen.id}/status`, { status: 'IN_PROGRESS' }, etag),
        admin().put(`/screens/${screen.id}/status`, { status: 'UNDOCUMENTED' }, etag),
      ]);
      const label = `round ${round}: ${a.status}/${b.status} ${JSON.stringify([a.body, b.body])}`;
      assert.deepEqual([a.status, b.status].sort(), [200, 412], label);
      const winner = a.status === 200 ? a : b;
      const loser = a.status === 200 ? b : a;
      assert.equal(bodyOf(loser).code, 'PRECONDITION_FAILED', label);
      assert.equal(detailsOf(loser).currentETag, winner.headers.etag, label);
      const expected = a.status === 200 ? 'IN_PROGRESS' : 'UNDOCUMENTED';
      assert.equal(screenOf(await dev().get(`/screens/${screen.id}`)).documentationStatus, expected, label);
    }
  });

  it('two /status to the same status without If-Match: one 200 and one 422 INVALID_TRANSITION (the same status)', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { screen } = await createScreenInStatus(t, dev(), app.id, 'DRAFT');
      const [a, b] = await Promise.all([
        dev().put(`/screens/${screen.id}/status`, { status: 'IN_PROGRESS' }),
        admin().put(`/screens/${screen.id}/status`, { status: 'IN_PROGRESS' }),
      ]);
      const label = `round ${round}: ${a.status}/${b.status} ${JSON.stringify([a.body, b.body])}`;
      assert.deepEqual([a.status, b.status].sort(), [200, 422], label);
      const loser = a.status === 422 ? a : b;
      assert.equal(bodyOf(loser).code, 'INVALID_TRANSITION', label);
      assert.deepEqual(detailsOf(loser), { from: 'IN_PROGRESS', to: 'IN_PROGRESS' }, label);
    }
  });

  it('a review and a withdraw at the same time never leave an approval over a withdrawn screen without its event', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { screen } = await createScreenInStatus(t, dev(), app.id, 'IN_REVIEW');
      const [review, withdraw] = await Promise.all([
        admin().post(`/screens/${screen.id}/review`, { decision: 'APPROVE', comment: 'ok' }),
        dev().put(`/screens/${screen.id}/status`, { status: 'IN_PROGRESS' }),
      ]);
      const label = `round ${round}: ${review.status}/${withdraw.status} ${JSON.stringify([review.body, withdraw.body])}`;
      // Serialized: either the review wins and the withdraw then reopens (APPROVED -> IN_PROGRESS), or the withdraw
      // wins and the review finds the screen no longer in review.
      assert.equal(withdraw.status, 200, label);
      const events = await rowsOf(
        `SELECT 1 FROM audit_log WHERE action = 'EVENT' AND entity_type = 'screen' AND entity_id = $1`,
        [String(screen.id)],
      );
      if (review.status === 200) {
        assert.equal(events.length, 1, label);
      } else {
        assert.equal(review.status, 422, label);
        assert.equal(bodyOf(review).code, 'NOT_IN_REVIEW', label);
        assert.equal(events.length, 0, label);
      }
      assert.equal(screenOf(await dev().get(`/screens/${screen.id}`)).documentationStatus, 'IN_PROGRESS', label);
    }
  });
});
