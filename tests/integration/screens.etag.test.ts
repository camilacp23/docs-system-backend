/**
 * ETag of a screen with its counters (D-101; D-62, D-71, D-72): the ETag is `W/"<updatedAt ms>-<pendingSubtasks>-
 * <commentCount>"`, `If-None-Match` compares all of it (so a Jira ticket created, refreshed or changed by the webhook,
 * or a comment, ends a 304), `If-Match` compares only the `updatedAt` part (a change of the counters is never a 412),
 * the former format `W/"<ms>"` is still accepted and any other format is a 412. The Jira side runs against the
 * in-process simulator, never the real Jira. No fixed waits.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { bearer } from '../helpers/app.js';
import { insertApplication, insertComments, insertScreen } from '../helpers/fixtures.js';
import { startJiraApp, type JiraApp } from '../helpers/jiraApp.js';
import { arrange, postSigned, statusField, updatedBody } from '../helpers/jiraWebhook.js';
import {
  createScreenInStatus,
  createScreenVia,
  detailsOf,
  putBodyOf,
  screenOf,
  templateWith,
  type ScreenBody,
} from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

const FORMAT = /^W\/"\d+-\d+-\d+"$/;
/** The `updatedAt` part of a screen ETag. */
const msOf = (etag: string): string => /^W\/"(\d+)-/.exec(etag)![1]!;

describe('ETag of a screen with its counters (D-101)', () => {
  let t: JiraApp;
  before(async () => {
    t = await startJiraApp({ client: { timeoutMs: 400, breakerFailureThreshold: 1000 } });
  });
  after(async () => {
    await t.closeAll();
  });
  beforeEach(async () => {
    await t.control('/__sim/reset');
    await t.owner.query('DELETE FROM jira_ticket');
  });

  const dev = () => asUser(t, t.users.developer.token);
  const read = (screenId: number, ifNoneMatch?: string) => {
    const r = t.http.get(`/api/v1/screens/${screenId}`).set('Authorization', bearer(t.users.reader.token));
    return ifNoneMatch === undefined ? r : r.set('If-None-Match', ifNoneMatch);
  };
  const etagNow = async (screenId: number): Promise<string> => String((await read(screenId)).headers.etag);
  const refresh = (screenId: number) => dev().get(`/screens/${screenId}/jira-tickets?refresh=true`);
  const move = (screenId: number, status: string, ifMatch?: string) =>
    dev().put(`/screens/${screenId}/status`, { status }, ifMatch);
  /** `GET` with the previous ETag must be 200 with the new one; and with the new one, 304. */
  async function assertMoved(screenId: number, before: string): Promise<string> {
    const after = await etagNow(screenId);
    assert.match(after, FORMAT);
    assert.notEqual(after, before);
    assert.equal((await read(screenId, before)).status, 200, 'the old ETag no longer matches');
    assert.equal((await read(screenId, after)).status, 304, 'the new one does');
    return after;
  }

  describe('the validator of the reads (If-None-Match compares all of it)', () => {
    it('is W/"<ms>-<pendingSubtasks>-<commentCount>", the same in every GET, and 304 when nothing changed', async () => {
      const application = await insertApplication(t);
      const screen = await insertScreen(t, application.id);
      const first = await read(screen.id);
      assert.equal(first.status, 200);
      const data = screenOf(first);
      assert.equal(first.headers.etag, `W/"${new Date(data.updatedAt).getTime()}-0-0"`);
      assert.equal((await read(screen.id, String(first.headers.etag))).status, 304);
      assert.equal(await etagNow(screen.id), first.headers.etag, 'stable while nothing changes');
    });

    it('changes when a Jira ticket is created: 200 with the old ETag, 304 with the new one', async () => {
      const application = await insertApplication(t);
      const screen = await insertScreen(t, application.id);
      const before = await etagNow(screen.id);
      const created = await dev().post(`/screens/${screen.id}/jira-ticket`, {
        newStory: { summary: 'Story' },
        subtask: { summary: 'Subtask 1' },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const after = await assertMoved(screen.id, before);
      assert.equal(msOf(after), msOf(before), 'updated_at did not move: only the counter did');
      assert.match(after, /-1-0"$/);
    });

    it('changes when a refresh changes the state of a Subtask', async () => {
      const a = await arrange(t, 2);
      const before = await etagNow(a.screenId);
      assert.match(before, /-2-0"$/);
      await t.control(`/__sim/issues/${a.subtasks[0]!.key}/status`, { category: 'done' });
      assert.equal((await refresh(a.screenId)).status, 200);
      const after = await assertMoved(a.screenId, before);
      assert.match(after, /-1-0"$/);
      // A refresh that changes nothing leaves the ETag, so the client still gets its 304.
      assert.equal((await refresh(a.screenId)).status, 200);
      assert.equal(await etagNow(a.screenId), after);
      assert.equal((await read(a.screenId, after)).status, 304);
    });

    it('changes when a webhook event changes the state of a Subtask', async () => {
      const a = await arrange(t, 2);
      const before = await etagNow(a.screenId);
      const synced = (
        await t.owner.query<{ t: Date }>(`SELECT last_synced_at AS t FROM jira_ticket WHERE id = $1`, [
          a.subtasks[0]!.id,
        ])
      ).rows[0]!.t.getTime();
      const body = updatedBody(a.subtasks[0]!, { status: statusField('done') }, synced + 5);
      assert.equal((await postSigned(t, body)).status, 204);
      const after = await assertMoved(a.screenId, before);
      assert.match(after, /-1-0"$/);
    });

    it('changes when a comment is added', async () => {
      const application = await insertApplication(t);
      const screen = await insertScreen(t, application.id);
      const before = await etagNow(screen.id);
      await insertComments(t, screen.id, 1);
      const after = await assertMoved(screen.id, before);
      assert.match(after, /-0-1"$/);
    });

    it('changes when the screen changes, and the answers of POST, PUT and /status carry the same ETag as GET', async () => {
      const application = await insertApplication(t);
      const created = await dev().post('/screens', {
        applicationId: application.id,
        name: 'Etag screen',
        miroLink: null,
        template: templateWith({ onStart: 'text' }),
        components: [],
        variableLinks: [],
        collectionLinks: [],
        navigations: [],
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const screen = screenOf(created);
      assert.equal(created.headers.etag, await etagNow(screen.id));
      const put = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screen, { template: templateWith({ onStart: 'changed' }) }),
        String(created.headers.etag),
      );
      assert.equal(put.status, 200, JSON.stringify(put.body));
      assert.equal(put.headers.etag, await etagNow(screen.id));
      assert.notEqual(put.headers.etag, created.headers.etag);
      const moved = await move(screen.id, 'IN_PROGRESS');
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(moved.headers.etag, await etagNow(screen.id));
    });
  });

  describe('If-Match compares only the updatedAt part', () => {
    async function arrangeScreen(): Promise<{ screen: ScreenBody; etag: string }> {
      const application = await insertApplication(t);
      return createScreenVia(dev(), application.id, { name: `Counters ${application.id}` });
    }

    it('a PUT with the ETag from before a change of the counters is not a 412, and answers the current ETag', async () => {
      const { screen, etag } = await arrangeScreen();
      await insertComments(t, screen.id, 2); // comments change the counters, not updated_at
      assert.notEqual(await etagNow(screen.id), etag);
      const res = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screen, { template: templateWith({ onStart: 'edited' }) }),
        etag,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.headers.etag, await etagNow(screen.id));
      assert.match(String(res.headers.etag), /-0-2"$/);
    });

    it('also for a Jira ticket created between the read and the save', async () => {
      const { screen, etag } = await arrangeScreen();
      const ticket = await dev().post(`/screens/${screen.id}/jira-ticket`, {
        newStory: { summary: 'Story' },
        subtask: { summary: 'Subtask' },
      });
      assert.equal(ticket.status, 201, JSON.stringify(ticket.body));
      const res = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screen, { template: templateWith({ onStart: 'edited' }) }),
        etag,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    it('PUT /status with the ETag from before a change of the counters is not a 412 either', async () => {
      const application = await insertApplication(t);
      const { screen, etag } = await createScreenInStatus(t, dev(), application.id, 'DRAFT');
      await insertComments(t, screen.id, 1);
      const res = await move(screen.id, 'IN_PROGRESS', etag);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.headers.etag, await etagNow(screen.id));
    });

    it('a PUT after a real change of the screen is a 412 with the full current ETag', async () => {
      const { screen, etag } = await arrangeScreen();
      const winner = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screen, { template: templateWith({ onStart: 'winner' }) }),
        etag,
      );
      assert.equal(winner.status, 200);
      const loser = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screen, { template: templateWith({ onStart: 'loser' }) }),
        etag,
      );
      assert.equal(loser.status, 412);
      assert.deepEqual(detailsOf(loser), { element: 'screen', currentETag: winner.headers.etag });
      assert.match(String(detailsOf(loser).currentETag), FORMAT);
    });

    it('a real change and a change of the counters together: still a 412 (updatedAt moved)', async () => {
      const { screen, etag } = await arrangeScreen();
      await dev().put(`/screens/${screen.id}`, putBodyOf(screen, { name: `${screen.name} 2` }), etag);
      await insertComments(t, screen.id, 1);
      const res = await dev().put(`/screens/${screen.id}`, putBodyOf(screen, { name: `${screen.name} 3` }), etag);
      assert.equal(res.status, 412);
      assert.equal(detailsOf(res).currentETag, await etagNow(screen.id));
    });

    it('/status after a real change is a 412 with the full current ETag', async () => {
      const application = await insertApplication(t);
      const { screen, etag } = await createScreenInStatus(t, dev(), application.id, 'DRAFT');
      assert.equal((await move(screen.id, 'IN_PROGRESS', etag)).status, 200);
      const res = await move(screen.id, 'DRAFT', etag);
      assert.equal(res.status, 412);
      assert.deepEqual(detailsOf(res), { element: 'screen', currentETag: await etagNow(screen.id) });
    });

    it('the former format W/"<ms>" is still accepted (PUT and /status)', async () => {
      const { screen, etag } = await arrangeScreen();
      const former = `W/"${msOf(etag)}"`;
      const put = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screen, { template: templateWith({ onStart: 'former' }) }),
        former,
      );
      assert.equal(put.status, 200, JSON.stringify(put.body));
      const next = `W/"${msOf(String(put.headers.etag))}"`;
      const moved = await move(screen.id, 'IN_PROGRESS', next);
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      // The former format with a stale value is still a 412.
      assert.equal((await move(screen.id, 'DRAFT', former)).status, 412);
    });

    it('any other format is a 412 with the current ETag', async () => {
      const { screen, etag } = await arrangeScreen();
      const ms = msOf(etag);
      for (const supplied of [ms, `"${ms}"`, `W/"${ms}-1"`, `W/"${ms}-1-2-3"`, `W/"${ms}-a-b"`, `W/"x"`, '*']) {
        const res = await dev().put(`/screens/${screen.id}`, putBodyOf(screen), supplied);
        assert.equal(res.status, 412, `If-Match ${supplied}`);
        assert.deepEqual(detailsOf(res), { element: 'screen', currentETag: etag });
      }
    });
  });

  describe('D-71 (a PUT that changes nothing)', () => {
    it('writes nothing and answers 200 with the same ETag when the counters did not change', async () => {
      const application = await insertApplication(t);
      const { screen, etag } = await createScreenVia(dev(), application.id, { name: 'Same etag' });
      const res = await dev().put(`/screens/${screen.id}`, putBodyOf(screen), etag);
      assert.equal(res.status, 200);
      assert.equal(res.headers.etag, etag);
      assert.equal(await etagNow(screen.id), etag);
    });

    it('answers the current ETag, with the new counters, when only the counters changed', async () => {
      const application = await insertApplication(t);
      const { screen, etag } = await createScreenVia(dev(), application.id, { name: 'Counters only' });
      await insertComments(t, screen.id, 1);
      const res = await dev().put(`/screens/${screen.id}`, putBodyOf(screen), etag);
      assert.equal(res.status, 200);
      assert.equal(res.headers.etag, await etagNow(screen.id));
      assert.equal(msOf(String(res.headers.etag)), msOf(etag), 'updated_at was not touched');
    });
  });
});
