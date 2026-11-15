/**
 * Module 4, GET /screens/{id}/jira-tickets (FR-12; SDD Table 50; D-72, D-95, D-97) against the in-process Jira
 * simulator, never the real Jira: the tree and its order, the local copy without refresh, the refresh with
 * pagination, issues that were moved, the attribution of the refresh to the reserved account, writes only when a
 * tracked column changed, every way the refresh can fail (always 200 and stale, NFR-14), archived applications, the
 * newer-webhook guard, roles and ETag/304. No fixed waits.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { bearer, bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { insertApplication, insertScreen, insertSubtasks, setApplicationStatus } from '../helpers/fixtures.js';
import { startJiraApp, type JiraApp } from '../helpers/jiraApp.js';
import { asUser } from '../helpers/users.js';

type Ticket = {
  id: number;
  jiraIssueKey: string;
  hierarchyLevel: string;
  issueType: string;
  summary: string;
  status: string;
  statusCategory: string;
  url: string | null;
  lastSyncedAt: string;
};
type Tree = {
  epic: Ticket | null;
  stories: (Ticket & { subtasks: Ticket[] })[];
  sync: { jiraAvailable: boolean; stale: boolean; lastSyncedAt: string | null };
};
const treeOf = (res: { body: unknown }): Tree => (res.body as { data: Tree }).data;
type Created = { epic: Ticket; story: Ticket; subtask: Ticket };
const createdOf = (res: { body: unknown }): Created => (res.body as { data: Created }).data;

const logLines = (t: TestApp): Record<string, unknown>[] => t.logs.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('GET /screens/{id}/jira-tickets (FR-12)', () => {
  let t: JiraApp;
  let searchCalls = 0;
  let failFromSearch: number | null = null;
  before(async () => {
    // A page of two issues makes a screen with six tickets a three-page search.
    t = await startJiraApp({
      refreshPageSize: 2,
      client: { timeoutMs: 400, breakerFailureThreshold: 1000, maxReadRetries: 0, backoffBaseMs: 1 },
      deps: (base) => ({
        ...base,
        fetch: async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url.endsWith('/rest/api/3/search/jql')) {
            searchCalls += 1;
            // Makes every search from the n-th on fail (the failure of a later page).
            if (failFromSearch !== null && searchCalls >= failFromSearch) {
              await t.control('/__sim/faults', { kind: '503', appliesTo: 'read', count: 100 });
              failFromSearch = null;
            }
          }
          return fetch(input, init);
        },
      }),
    });
  });
  after(async () => {
    await t.closeAll();
  });
  beforeEach(async () => {
    await t.control('/__sim/reset');
    await t.owner.query('DELETE FROM jira_ticket');
    t.logs.length = 0;
    searchCalls = 0;
    failFromSearch = null;
  });

  const as = (role: 'admin' | 'developer' | 'reader') => asUser(t, t.users[role].token);
  const get = (screenId: number, refresh?: boolean, role: 'admin' | 'developer' | 'reader' = 'developer') =>
    as(role).get(`/screens/${screenId}/jira-tickets${refresh === undefined ? '' : `?refresh=${refresh}`}`);
  const searches = async () => (await t.simState()).calls.filter((c) => c.path === '/rest/api/3/search/jql').length;
  const auditCount = async () =>
    Number(
      (await t.owner.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE entity_type = 'jira_ticket'`))
        .rows[0]!.n,
    );
  const rowOf = async (id: number) =>
    (
      await t.owner.query<{
        jira_issue_key: string;
        summary: string;
        status: string;
        status_category: string;
        issue_type: string;
        last_synced_at: Date;
      }>(`SELECT * FROM jira_ticket WHERE id = $1`, [id])
    ).rows[0]!;

  /** A screen with an Epic, a Story and `count` Subtasks created through the API (and so present in the simulator). */
  async function arrange(count = 4) {
    const application = await insertApplication(t);
    const screen = await insertScreen(t, application.id);
    const first = createdOf(
      await as('developer').post(`/screens/${screen.id}/jira-ticket`, {
        newStory: { summary: 'Story' },
        subtask: { summary: 'Subtask 1' },
      }),
    );
    const subtasks = [first.subtask];
    for (let n = 2; n <= count; n++) {
      const next = createdOf(
        await as('developer').post(`/screens/${screen.id}/jira-ticket`, {
          storyId: first.story.id,
          subtask: { summary: `Subtask ${n}` },
        }),
      );
      subtasks.push(next.subtask);
    }
    return { application, screen, epic: first.epic, story: first.story, subtasks };
  }

  describe('without refresh', () => {
    it('404 for a screen that does not exist, also beyond the integer range; 401 without a token', async () => {
      const missing = await get(999999);
      assert.equal(missing.status, 404);
      assert.equal(bodyOf(missing).code, 'NOT_FOUND');
      assert.equal((await get(2147483648)).status, 404);
      assert.equal((await t.http.get('/api/v1/screens/1/jira-tickets')).status, 401);
    });

    it('a screen without an Epic: an empty tree and sync without a date', async () => {
      const application = await insertApplication(t);
      const screen = await insertScreen(t, application.id);
      const res = await get(screen.id);
      assert.equal(res.status, 200);
      await assertConformsToContract(res);
      assert.deepEqual(treeOf(res), {
        epic: null,
        stories: [],
        sync: { jiraAvailable: true, stale: false, lastSyncedAt: null },
      });
    });

    it('returns the local copy as { epic, stories[ { subtasks } ], sync } in creation order, without calling Jira', async () => {
      const a = await arrange(2);
      // A second Story with its own Subtask, created after the first.
      const second = createdOf(
        await as('developer').post(`/screens/${a.screen.id}/jira-ticket`, {
          newStory: { summary: 'Story B' },
          subtask: { summary: 'B1' },
        }),
      );
      const before = await searches();
      const res = await get(a.screen.id);
      assert.equal(res.status, 200);
      await assertConformsToContract(res);
      const tree = treeOf(res);
      assert.equal(tree.epic?.id, a.epic.id);
      assert.equal(tree.epic?.url, `${t.sim.baseUrl}/browse/${a.epic.jiraIssueKey}`);
      assert.deepEqual(
        tree.stories.map((s) => [s.id, s.subtasks.map((x) => x.id)]),
        [
          [a.story.id, a.subtasks.map((x) => x.id)],
          [second.story.id, [second.subtask.id]],
        ],
      );
      assert.equal(tree.sync.jiraAvailable, true);
      assert.equal(tree.sync.stale, false);
      const newest = Math.max(
        ...(
          await t.owner.query<{ t: Date }>(`SELECT last_synced_at AS t FROM jira_ticket WHERE screen_id = $1`, [
            a.screen.id,
          ])
        ).rows.map((r) => r.t.getTime()),
      );
      assert.equal(Date.parse(tree.sync.lastSyncedAt!), newest, 'the newest last_synced_at of the copy');
      assert.equal(await searches(), before, 'no call to Jira');
      assert.equal(res.headers['x-request-id'] !== undefined, true);
    });

    it('refresh=false is the same as omitting it', async () => {
      const a = await arrange(1);
      const before = await searches();
      assert.deepEqual(treeOf(await get(a.screen.id, false)), treeOf(await get(a.screen.id)));
      assert.equal(await searches(), before);
    });

    it('sends a weak ETag and answers 304 to a matching If-None-Match (D-72)', async () => {
      const a = await arrange(1);
      const first = await t.http
        .get(`/api/v1/screens/${a.screen.id}/jira-tickets`)
        .set('Authorization', bearer(t.users.reader.token));
      assert.equal(first.status, 200);
      const etag = first.headers['etag'];
      assert.match(String(etag), /^W\//);
      const again = await t.http
        .get(`/api/v1/screens/${a.screen.id}/jira-tickets`)
        .set('Authorization', bearer(t.users.reader.token))
        .set('If-None-Match', String(etag));
      assert.equal(again.status, 304);
      assert.equal(again.text, '');
    });

    it('any role can read it', async () => {
      const a = await arrange(1);
      for (const role of ['admin', 'developer', 'reader'] as const)
        assert.equal((await get(a.screen.id, undefined, role)).status, 200);
    });
  });

  describe('refresh=true', () => {
    it('brings the copy up to date from Jira across several pages, with the search batched by key', async () => {
      const a = await arrange(4); // Epic + Story + 4 Subtasks = 6 issues = 3 pages of 2
      const [s1, s2, s3] = a.subtasks as [Ticket, Ticket, Ticket];
      await t.control(`/__sim/issues/${s1.jiraIssueKey}/status`, { category: 'done' });
      await t.control(`/__sim/issues/${s2.jiraIssueKey}/status`, { status: 'In Progress' });
      await t.control(`/__sim/issues/${s3.jiraIssueKey}/edit`, { summary: 'Renamed in Jira' });
      await t.control(`/__sim/issues/${a.epic.jiraIssueKey}/edit`, { key: 'TECHEA-900' });
      const before = await searches();
      const started = Date.now();

      const res = await get(a.screen.id, true);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await searches()) - before, 3, 'three pages');
      const tree = treeOf(res);
      assert.equal(tree.epic?.jiraIssueKey, 'TECHEA-900', 'a moved issue is matched by its stable id (D-95)');
      const subtasks = tree.stories[0]!.subtasks;
      assert.deepEqual(
        subtasks.map((s) => [s.status, s.statusCategory]),
        [
          ['Done', 'DONE'],
          ['In Progress', 'IN_PROGRESS'],
          ['To Do', 'TO_DO'],
          ['To Do', 'TO_DO'],
        ],
      );
      assert.equal(subtasks[2]!.summary, 'Renamed in Jira');
      assert.deepEqual(tree.sync.jiraAvailable && !tree.sync.stale, true);
      assert.ok(Date.parse(tree.sync.lastSyncedAt!) >= started, 'sync.lastSyncedAt is the moment of the read');
      assert.equal((await rowOf(a.epic.id)).jira_issue_key, 'TECHEA-900');
      assert.ok((await rowOf(s1.id)).last_synced_at.getTime() >= started);
      // Rows that did not change keep their date (D-97).
      assert.ok((await rowOf(subtasks[3]!.id)).last_synced_at.getTime() < started);
    });

    it('corrects issue_type too, and writes as the reserved account, not as the caller', async () => {
      const a = await arrange(1);
      await t.owner.query(`UPDATE jira_ticket SET issue_type = 'Provisional' WHERE id = $1`, [a.subtasks[0]!.id]);
      await t.control(`/__sim/issues/${a.subtasks[0]!.jiraIssueKey}/status`, { category: 'done' });
      const audit = await auditCount();
      assert.equal((await get(a.screen.id, true, 'reader')).status, 200);
      assert.equal((await rowOf(a.subtasks[0]!.id)).issue_type, 'Subtask');
      const rows = await t.owner.query<{ actor_user_id: number; db_role: string }>(
        `SELECT actor_user_id, db_role FROM audit_log
          WHERE entity_type = 'jira_ticket' AND action = 'UPDATE' AND entity_id = $1 ORDER BY id DESC LIMIT 1`,
        [String(a.subtasks[0]!.id)],
      );
      assert.equal(rows.rows[0]!.actor_user_id, t.reservedId);
      assert.notEqual(t.reservedId, t.users.reader.id);
      assert.equal(rows.rows[0]!.db_role, 'docs_app');
      assert.equal((await auditCount()) - audit, 1, 'one changed row, one audit entry');
    });

    it('a refresh without changes writes nothing: no audit rows, same dates, and sync.lastSyncedAt is still the read (D-97)', async () => {
      const a = await arrange(2);
      const audit = await auditCount();
      const copy = await t.owner.query(`SELECT id, last_synced_at, updated_at FROM jira_ticket ORDER BY id`);
      const started = Date.now();
      const res = await get(a.screen.id, true);
      assert.equal(res.status, 200);
      assert.equal(treeOf(res).sync.stale, false);
      assert.ok(Date.parse(treeOf(res).sync.lastSyncedAt!) >= started);
      assert.equal(await auditCount(), audit);
      assert.deepEqual(
        (await t.owner.query(`SELECT id, last_synced_at, updated_at FROM jira_ticket ORDER BY id`)).rows,
        copy.rows,
      );
    });

    it('never deletes: a row that Jira no longer has stays', async () => {
      const a = await arrange(2);
      await t.control(`/__sim/issues/${a.subtasks[0]!.jiraIssueKey}/delete`);
      const res = await get(a.screen.id, true);
      assert.equal(res.status, 200);
      assert.equal(treeOf(res).stories[0]!.subtasks.length, 2);
      assert.equal((await t.ticketsOf(a.screen.id)).length, 4);
    });

    it('a row newer than the read (a webhook got there first) is not overwritten', async () => {
      const a = await arrange(1);
      await t.owner.query(
        `UPDATE jira_ticket SET status = 'Webhook value', last_synced_at = now() + interval '1 hour' WHERE id = $1`,
        [a.subtasks[0]!.id],
      );
      await t.control(`/__sim/issues/${a.subtasks[0]!.jiraIssueKey}/status`, { category: 'done' });
      assert.equal((await get(a.screen.id, true)).status, 200);
      assert.equal((await rowOf(a.subtasks[0]!.id)).status, 'Webhook value');
    });

    it('a key that another local row holds is not changed (warn); the next refresh fixes it', async () => {
      const a = await arrange(2);
      const [first, second] = a.subtasks as [Ticket, Ticket];
      // In Jira the two Subtasks swap keys through a third one: the lower id now wants the key of the higher id.
      await t.control(`/__sim/issues/${second.jiraIssueKey}/edit`, { key: 'TECHEA-950' });
      await t.control(`/__sim/issues/${first.jiraIssueKey}/edit`, { key: second.jiraIssueKey });
      const res = await get(a.screen.id, true);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await rowOf(first.id)).jira_issue_key, first.jiraIssueKey, 'kept');
      assert.equal((await rowOf(second.id)).jira_issue_key, 'TECHEA-950');
      assert.ok(logLines(t).some((l) => l['reason'] === 'KEY_CONFLICT' && l['level'] === 40));
      assert.equal((await get(a.screen.id, true)).status, 200);
      assert.equal((await rowOf(first.id)).jira_issue_key, second.jiraIssueKey);
    });

    it('Reader can refresh ("Query only"): 200 and the copy is updated', async () => {
      const a = await arrange(1);
      await t.control(`/__sim/issues/${a.subtasks[0]!.jiraIssueKey}/status`, { category: 'done' });
      const res = await get(a.screen.id, true, 'reader');
      assert.equal(res.status, 200);
      assert.equal(treeOf(res).stories[0]!.subtasks[0]!.statusCategory, 'DONE');
    });

    it('a screen without tickets completes without calling Jira', async () => {
      const application = await insertApplication(t);
      const screen = await insertScreen(t, application.id);
      const before = await searches();
      const res = await get(screen.id, true);
      assert.equal(treeOf(res).sync.stale, false);
      assert.equal(await searches(), before);
    });
  });

  describe('refresh that cannot be completed: 200, the local copy and stale (NFR-14)', () => {
    it('Jira fails (503): nothing is written', async () => {
      const a = await arrange(2);
      await t.control(`/__sim/issues/${a.subtasks[0]!.jiraIssueKey}/status`, { category: 'done' });
      await t.control('/__sim/faults', { kind: '503', appliesTo: 'read', count: 100 });
      const audit = await auditCount();
      const res = await get(a.screen.id, true);
      assert.equal(res.status, 200);
      const tree = treeOf(res);
      assert.equal(tree.sync.stale, true);
      assert.equal(tree.stories[0]!.subtasks[0]!.statusCategory, 'TO_DO', 'the copy as it was');
      assert.equal(await auditCount(), audit);
      assert.ok(logLines(t).some((l) => l['operation'] === 'refreshJiraTickets'));
    });

    it('Jira rejects the credentials (401): 200 and stale', async () => {
      const a = await arrange(1);
      await t.control('/__sim/faults', { kind: '401', appliesTo: 'read', count: 100 });
      const res = await get(a.screen.id, true);
      assert.equal(res.status, 200);
      assert.equal(treeOf(res).sync.stale, true);
    });

    it('a failure on the second page writes nothing at all, not even what the first page brought', async () => {
      const a = await arrange(3); // 5 issues: three pages of two
      await t.control(`/__sim/issues/${a.subtasks[0]!.jiraIssueKey}/status`, { category: 'done' });
      await t.control(`/__sim/issues/${a.epic.jiraIssueKey}/edit`, { summary: 'Changed in Jira' });
      const audit = await auditCount();
      searchCalls = 0;
      failFromSearch = 2;
      const res = await get(a.screen.id, true);
      assert.equal(res.status, 200);
      assert.equal(treeOf(res).sync.stale, true);
      assert.equal(treeOf(res).epic?.summary, a.epic.summary);
      assert.equal(treeOf(res).stories[0]!.subtasks[0]!.statusCategory, 'TO_DO');
      assert.equal(await auditCount(), audit);
    });

    it('an archived application: no call to Jira, no writes, stale', async () => {
      const a = await arrange(1);
      await t.control(`/__sim/issues/${a.subtasks[0]!.jiraIssueKey}/status`, { category: 'done' });
      await setApplicationStatus(t, a.application.id, 'ARCHIVED');
      const before = await searches();
      const audit = await auditCount();
      const res = await get(a.screen.id, true);
      assert.equal(res.status, 200);
      assert.equal(treeOf(res).sync.stale, true);
      assert.equal(treeOf(res).stories[0]!.subtasks[0]!.statusCategory, 'TO_DO');
      assert.equal(await searches(), before);
      assert.equal(await auditCount(), audit);
      // Without refresh the archived application's copy is simply read.
      assert.equal(treeOf(await get(a.screen.id)).sync.stale, false);
    });
  });
});

describe('GET /screens/{id}/jira-tickets when Jira cannot be used', () => {
  describe('not configured', () => {
    let t: TestApp;
    before(async () => {
      t = await startTestApp();
    });
    after(async () => {
      await t.close();
    });

    it('reads the copy; refresh=true answers 200, stale and jiraAvailable false', async () => {
      const application = await insertApplication(t);
      const screen = await insertScreen(t, application.id);
      await insertSubtasks(t, screen.id, ['TO_DO', 'DONE']);
      const api = asUser(t, t.users.developer.token);
      // Without JIRA_BASE_URL there is no absolute link to build: `url` is null and the answer still conforms (D-111).
      const plainRes = await api.get(`/screens/${screen.id}/jira-tickets`);
      await assertConformsToContract(plainRes);
      const plain = treeOf(plainRes);
      assert.deepEqual(
        plain.stories[0]!.subtasks.map((s) => s.url),
        [null, null],
      );
      assert.equal(plain.stories[0]!.subtasks.length, 2);
      assert.deepEqual([plain.sync.jiraAvailable, plain.sync.stale], [false, false]);
      const refreshed = await api.get(`/screens/${screen.id}/jira-tickets?refresh=true`);
      assert.equal(refreshed.status, 200);
      assert.deepEqual([treeOf(refreshed).sync.jiraAvailable, treeOf(refreshed).sync.stale], [false, true]);
      assert.equal(treeOf(refreshed).stories[0]!.subtasks.length, 2);
    });
  });

  describe('circuit breaker open', () => {
    let breaker: JiraApp;
    before(async () => {
      breaker = await startJiraApp({ client: { breakerFailureThreshold: 1, timeoutMs: 400, maxReadRetries: 0 } });
    });
    after(async () => {
      await breaker.closeAll();
    });

    it('after a failure that opens it the next refresh does not call Jira', async () => {
      const application = await insertApplication(breaker);
      const screen = await insertScreen(breaker, application.id);
      await insertSubtasks(breaker, screen.id, ['TO_DO']);
      const api = asUser(breaker, breaker.users.reader.token);
      await breaker.control('/__sim/faults', { kind: '500', appliesTo: 'read', count: 1 });
      const first = await api.get(`/screens/${screen.id}/jira-tickets?refresh=true`);
      assert.equal(first.status, 200);
      assert.equal(treeOf(first).sync.stale, true);
      const calls = (await breaker.simState()).calls.length;
      const second = await api.get(`/screens/${screen.id}/jira-tickets?refresh=true`);
      assert.equal(second.status, 200);
      assert.deepEqual([treeOf(second).sync.jiraAvailable, treeOf(second).sync.stale], [false, true]);
      assert.equal((await breaker.simState()).calls.length, calls, 'no call while the circuit is open');
    });
  });
});
