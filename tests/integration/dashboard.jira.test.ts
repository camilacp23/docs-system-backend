/**
 * Module 7, the Jira figures (FR-19, NFR-14; D-106 c, d): the pending Subtasks and the last synchronization come from
 * the local copy, and `jiraAvailable` from the state of the client alone. The endpoint NEVER calls Jira: in every
 * state the simulator receives no request and the `fetch` of the client is never called.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createJiraClient } from '../../src/integrations/jira/index.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { getIndicators, indicatorsOk } from '../helpers/dashboard.js';
import { insertApplication, insertScreen, insertSubtasks } from '../helpers/fixtures.js';
import { startJiraApp, type JiraApp } from '../helpers/jiraApp.js';
import { asUser } from '../helpers/users.js';

/** A `fetch` that counts what the client sends and passes it on. */
function countingFetch() {
  const urls: string[] = [];
  const spy: typeof fetch = (...args) => {
    const target = args[0];
    urls.push(typeof target === 'string' ? target : target instanceof URL ? target.href : target.url);
    return fetch(...args);
  };
  return { urls, spy };
}

describe('dashboard: Jira figures from the local copy', () => {
  describe('available', () => {
    let t: JiraApp;
    const sent = countingFetch();
    before(async () => {
      t = await startJiraApp({ deps: (base) => ({ ...base, fetch: sent.spy }) });
    });
    after(async () => {
      await t.closeAll();
    });
    const simCalls = async () => (await t.simState()).calls.length;

    it('pending Subtasks: only the Subtasks that are not DONE; Epics and Stories do not count', async () => {
      const app = await insertApplication(t);
      const one = await insertScreen(t, app.id);
      const two = await insertScreen(t, app.id);
      await insertSubtasks(t, one.id, ['TO_DO', 'IN_PROGRESS', 'DONE']);
      await insertSubtasks(t, two.id, ['DONE', 'DONE']);
      const before = { sim: await simCalls(), fetch: sent.urls.length };
      for (const token of [t.users.admin.token, t.users.developer.token, t.users.reader.token]) {
        const { jira } = await indicatorsOk(t, app.id, token);
        // Each chain has an Epic and a Story in TO_DO: if they counted the figure would be 6.
        assert.equal(jira.pendingSubtasks, 2);
        assert.equal(jira.jiraAvailable, true);
      }
      assert.deepEqual({ sim: await simCalls(), fetch: sent.urls.length }, before, 'Jira received no request');
    });

    it('an application without tickets: 0 pending and lastSyncedAt null', async () => {
      const app = await insertApplication(t);
      const { jira } = await indicatorsOk(t, app.id);
      assert.deepEqual(jira, { pendingSubtasks: 0, jiraAvailable: true, lastSyncedAt: null });
    });

    it('lastSyncedAt is the latest of any ticket of the application, not of another one', async () => {
      const app = await insertApplication(t);
      const other = await insertApplication(t);
      const screen = await insertScreen(t, app.id);
      const otherScreen = await insertScreen(t, other.id);
      const ids = await insertSubtasks(t, screen.id, ['TO_DO', 'DONE']);
      await insertSubtasks(t, otherScreen.id, ['TO_DO']);
      const setSynced = (screenId: number, at: string) =>
        t.owner.query(`UPDATE jira_ticket SET last_synced_at = $2 WHERE screen_id = $1`, [screenId, at]);
      await setSynced(screen.id, '2026-11-01T10:00:00.000Z');
      await t.owner.query(`UPDATE jira_ticket SET last_synced_at = $2 WHERE id = $1`, [
        ids[1],
        '2026-11-05T08:30:15.123Z',
      ]);
      await setSynced(otherScreen.id, '2026-12-31T00:00:00.000Z');
      assert.equal((await indicatorsOk(t, app.id)).jira.lastSyncedAt, '2026-11-05T08:30:15.123Z');
      assert.equal((await indicatorsOk(t, other.id)).jira.lastSyncedAt, '2026-12-31T00:00:00.000Z');
    });

    it('the Subtasks of another application are not counted', async () => {
      const app = await insertApplication(t);
      const other = await insertApplication(t);
      await insertSubtasks(t, (await insertScreen(t, other.id)).id, ['TO_DO', 'TO_DO', 'IN_PROGRESS']);
      assert.equal((await indicatorsOk(t, app.id)).jira.pendingSubtasks, 0);
      assert.equal((await indicatorsOk(t, other.id)).jira.pendingSubtasks, 3);
    });

    it('the figure follows the local copy when a ticket changes category', async () => {
      const app = await insertApplication(t);
      const screen = await insertScreen(t, app.id);
      const ids = await insertSubtasks(t, screen.id, ['TO_DO', 'TO_DO']);
      assert.equal((await indicatorsOk(t, app.id)).jira.pendingSubtasks, 2);
      await t.owner.query(`UPDATE jira_ticket SET status_category = 'DONE' WHERE id = $1`, [ids[0]]);
      assert.equal((await indicatorsOk(t, app.id)).jira.pendingSubtasks, 1);
    });
  });

  describe('not configured', () => {
    let t: TestApp;
    const sent = countingFetch();
    before(async () => {
      t = await startTestApp({ jira: (logger) => createJiraClient({}, { logger, fetch: sent.spy }) });
    });
    after(async () => {
      await t.close();
    });

    it('jiraAvailable is false, the copy is still served and nothing is sent', async () => {
      const app = await insertApplication(t);
      const screen = await insertScreen(t, app.id);
      await insertSubtasks(t, screen.id, ['TO_DO']);
      for (const token of [t.users.admin.token, t.users.developer.token, t.users.reader.token]) {
        const { jira } = await indicatorsOk(t, app.id, token);
        assert.equal(jira.jiraAvailable, false);
        assert.equal(jira.pendingSubtasks, 1);
        assert.notEqual(jira.lastSyncedAt, null);
      }
      assert.equal(sent.urls.length, 0, 'the client sent nothing');
    });
  });

  describe('circuit breaker open', () => {
    let t: JiraApp;
    const sent = countingFetch();
    before(async () => {
      t = await startJiraApp({
        client: { breakerFailureThreshold: 1, timeoutMs: 400 },
        deps: (base) => ({ ...base, fetch: sent.spy }),
      });
    });
    after(async () => {
      await t.closeAll();
    });

    it('jiraAvailable is false and the endpoint does not touch Jira, not even to probe it', async () => {
      const app = await insertApplication(t);
      const screen = await insertScreen(t, app.id);
      await insertSubtasks(t, screen.id, ['TO_DO', 'IN_PROGRESS']);
      // A failed creation, on a screen of its own, opens the circuit (threshold 1).
      const empty = await insertScreen(t, app.id);
      await t.control('/__sim/faults', { kind: '500', appliesTo: 'create', count: 1 });
      const created = await asUser(t, t.users.developer.token).post(`/screens/${empty.id}/jira-ticket`, {
        newStory: { summary: 'Story' },
        subtask: { summary: 'Subtask' },
      });
      assert.equal(created.status, 502, JSON.stringify(created.body));
      assert.equal(t.jira.jiraAvailable, false);

      const before = { sim: (await t.simState()).calls.length, fetch: sent.urls.length };
      for (const token of [t.users.admin.token, t.users.developer.token, t.users.reader.token]) {
        const { jira } = await indicatorsOk(t, app.id, token);
        assert.equal(jira.jiraAvailable, false);
        assert.equal(jira.pendingSubtasks, 2);
      }
      assert.deepEqual({ sim: (await t.simState()).calls.length, fetch: sent.urls.length }, before);
      assert.equal(t.jira.jiraAvailable, false, 'and the circuit is still open');
    });

    it('a 404 still answers like any other when the circuit is open', async () => {
      const res = await getIndicators(t, 999999);
      assert.equal(res.status, 404);
    });
  });
});
