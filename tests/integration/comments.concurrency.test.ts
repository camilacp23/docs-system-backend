/**
 * Concurrency of the comments (D-47, D-71, D-123, D-132), in several rounds each.
 *
 * - Two edits with the same `If-Match`: exactly one writes and the other is a 412. The comment is locked FOR UPDATE and
 *   the `If-Match` is compared on the locked row, so the second edit reads what the first committed. The queue is built
 *   on purpose (a connection of the test holds the row lock until both requests are waiting), so the race does not depend
 *   on timing: without the lock both edits compare against the same old state and both answer 200.
 * - A comment while the application is being archived: the guard of D-47 (FOR SHARE on the application) makes the
 *   comment wait for the archiving in progress and then answer 422; nothing is written after the archiving.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { applicationOf, createApplication, putBodyOf } from '../helpers/applications.js';
import { commentOf, storedComments, waitForLockWaiters } from '../helpers/comments.js';
import { insertApplication, insertScreen } from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';

const ROUNDS = 8;

/** What a request answered. */
type Reply = { status: number; body: unknown; headers: Record<string, unknown> };

describe('comments: concurrency', () => {
  let t: TestApp;
  let screenId: number;

  before(async () => {
    t = await startTestApp();
    const app = await insertApplication(t, { name: 'Contended' });
    screenId = (await insertScreen(t, app.id)).id;
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const admin = () => asUser(t, t.users.admin.token);
  /** `.then` makes superagent send the request now; a bare request is only sent when awaited. */
  const send = (request: PromiseLike<Reply>): Promise<Reply> => Promise.resolve(request).then((r) => r);

  describe('two PUT with the same If-Match', () => {
    it(`queued behind the row lock: exactly one writes and the other is a 412, in every round (${ROUNDS} rounds)`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const created = await dev().post(`/screens/${screenId}/comments`, { text: `round ${round}` });
        const id = commentOf(created).id;
        const etag = String(created.headers.etag);
        await t.owner.query('BEGIN');
        let results: Reply[];
        try {
          await t.owner.query('SELECT id FROM comment WHERE id = $1 FOR UPDATE', [id]);
          const pending = [
            send(dev().put(`/comments/${id}`, { text: `A ${round}` }, etag)),
            send(dev().put(`/comments/${id}`, { text: `B ${round}` }, etag)),
          ];
          assert.equal(await waitForLockWaiters(t, 2), true, `round ${round}: both edits are queued behind the lock`);
          await t.owner.query('COMMIT');
          results = await Promise.all(pending);
        } catch (error) {
          await t.owner.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
        const label = `round ${round}: ${results.map((r) => r.status).join('/')}`;
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 412], label);
        const winner = results.find((r) => r.status === 200)!;
        const loser = results.find((r) => r.status === 412)!;
        assert.equal(bodyOf(loser).code, 'PRECONDITION_FAILED', label);
        assert.deepEqual((loser.body as { details: object }).details, {
          element: 'comment',
          currentETag: winner.headers.etag,
        });
        const stored = (await storedComments(t, screenId)).find((r) => r.id === id)!;
        assert.equal(stored.text, commentOf(winner).text, label);
        const updates = await t.owner.query(
          `SELECT 1 FROM audit_log WHERE entity_type = 'comment' AND entity_id = $1 AND action = 'UPDATE'`,
          [String(id)],
        );
        assert.equal(updates.rowCount, 1, `${label}: one UPDATE in the audit log`);
      }
    });

    it(`fired at the same time, with no help: exactly one 200 and one 412 (${ROUNDS} rounds)`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const created = await dev().post(`/screens/${screenId}/comments`, { text: `free ${round}` });
        const id = commentOf(created).id;
        const etag = String(created.headers.etag);
        const results = await Promise.all([
          send(dev().put(`/comments/${id}`, { text: `A ${round}` }, etag)),
          send(dev().put(`/comments/${id}`, { text: `B ${round}` }, etag)),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 412], `round ${round}`);
      }
    });
  });

  describe('a comment while the application is archived (the guard of D-47)', () => {
    it(`the comment waits for the archiving in progress and then is a 422; nothing is written (${ROUNDS} rounds)`, async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const app = await insertApplication(t);
        const screen = await insertScreen(t, app.id);
        const own = await dev().post(`/screens/${screen.id}/comments`, { text: 'before' });
        assert.equal(own.status, 201);
        await t.owner.query('BEGIN');
        let created;
        let edited;
        try {
          await t.owner.query(`UPDATE application SET status = 'ARCHIVED' WHERE id = $1`, [app.id]);
          created = send(dev().post(`/screens/${screen.id}/comments`, { text: `late ${round}` }));
          edited = send(dev().put(`/comments/${commentOf(own).id}`, { text: `late edit ${round}` }));
          assert.equal(
            await waitForLockWaiters(t, 2),
            true,
            `round ${round}: the comment and the edit wait for the archiving`,
          );
          await t.owner.query('COMMIT');
        } catch (error) {
          await t.owner.query('ROLLBACK').catch(() => undefined);
          throw error;
        }
        const [post, put] = await Promise.all([created, edited]);
        assert.equal(post.status, 422, `round ${round}: ${JSON.stringify(post.body)}`);
        assert.equal(bodyOf(post).code, 'APPLICATION_ARCHIVED');
        assert.equal(put.status, 422, `round ${round}`);
        assert.deepEqual(
          (await storedComments(t, screen.id)).map((r) => r.text),
          ['before'],
          `round ${round}: nothing was written after the archiving`,
        );
      }
    });

    it(`commenting while the API archives the application: 201 (ordered before the archiving) or 422, never a comment after it (${ROUNDS} rounds)`, async () => {
      const seen = new Set<number>();
      for (let round = 0; round < ROUNDS; round += 1) {
        const { application } = await createApplication(t, t.users.admin.token);
        const screen = await insertScreen(t, application.id);
        const [post, archive] = await Promise.all([
          send(dev().post(`/screens/${screen.id}/comments`, { text: `race ${round}` })),
          send(admin().put(`/applications/${application.id}`, putBodyOf(application, { status: 'ARCHIVED' }))),
        ]);
        const label = `round ${round}: ${post.status}/${archive.status}`;
        assert.equal(archive.status, 200, label);
        assert.ok(post.status === 201 || post.status === 422, label);
        seen.add(post.status);
        const stored = await storedComments(t, screen.id);
        assert.equal(stored.length, post.status === 201 ? 1 : 0, label);
        // Whatever won, the application is archived now and a new comment is refused.
        assert.equal(applicationOf(await admin().get(`/applications/${application.id}`)).status, 'ARCHIVED');
        assert.equal((await dev().post(`/screens/${screen.id}/comments`, { text: 'after' })).status, 422, label);
      }
      assert.ok(seen.size >= 1);
    });
  });
});
