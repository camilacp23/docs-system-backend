/**
 * Module 4, POST /integrations/jira/webhook under concurrency (Table 53 step 4 and 5; D-31, D-96, D-97): two
 * simultaneous and out-of-order deliveries for the same ticket must leave the state of the NEWER event, whatever the
 * order in which they are processed. The race is made deterministic without sleeping: a second session holds the row
 * lock, the deliveries are sent one at a time until each one is waiting on the database, and then the lock is
 * released, so the order in which they are served is the order in which they arrived. Removing `FOR UPDATE` from the
 * lookup of the ticket makes the older event overwrite the newer one and this test fails.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { startJiraApp, type JiraApp } from '../helpers/jiraApp.js';
import { arrange, postSigned, statusField, updatedBody } from '../helpers/jiraWebhook.js';

const ROUNDS = 6;
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('POST /integrations/jira/webhook: concurrent and out-of-order deliveries', () => {
  let t: JiraApp;
  let holder: pg.Client;
  let holderPid: number;
  before(async () => {
    t = await startJiraApp();
    holder = new pg.Client({ connectionString: t.testDb.ownerUrl });
    await holder.connect();
    holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  });
  after(async () => {
    await holder.end();
    await t.closeAll();
  });
  beforeEach(async () => {
    await t.control('/__sim/reset');
    await t.owner.query('DELETE FROM jira_ticket');
  });

  /**
   * Sessions blocked by the one that holds the row lock, directly or queued behind another waiter (the second one waits
   * for the tuple lock of the first). `pg_blocking_pids` is visible to every role (the activity of
   * docs_app is not visible to the owner), and it counts only OUR waiters, not those of tests running in parallel.
   */
  const waiting = async (): Promise<number> =>
    Number(
      (
        await t.owner.query<{ n: string }>(
          `WITH RECURSIVE waiters(pid) AS (
             SELECT pid FROM pg_locks WHERE NOT granted AND $1 = ANY(pg_blocking_pids(pid))
             UNION
             SELECT l.pid FROM pg_locks l JOIN waiters w ON w.pid = ANY(pg_blocking_pids(l.pid)) WHERE NOT l.granted
           ) SELECT count(DISTINCT pid) AS n FROM waiters`,
          [holderPid],
        )
      ).rows[0]!.n,
    );
  const until = async (condition: () => Promise<boolean>): Promise<void> => {
    while (!(await condition())) await turn();
  };
  const rowOf = async (id: number) =>
    (
      await t.owner.query<{ status: string; status_category: string; summary: string; last_synced_at: Date }>(
        `SELECT status, status_category, summary, last_synced_at FROM jira_ticket WHERE id = $1`,
        [id],
      )
    ).rows[0]!;
  const auditUpdates = async (id: number): Promise<number> =>
    Number(
      (
        await t.owner.query<{ n: string }>(
          `SELECT count(*) AS n FROM audit_log WHERE entity_type = 'jira_ticket' AND action = 'UPDATE' AND entity_id = $1`,
          [String(id)],
        )
      ).rows[0]!.n,
    );

  it(`an older event never overwrites a newer one, in either order of arrival (${ROUNDS} rounds)`, async () => {
    const a = await arrange(t, 1);
    const sub = a.subtasks[0]!;
    // Warms the lookup of the reserved account so that nothing but the row lock can make a delivery wait.
    await postSigned(t, updatedBody(sub, { summary: 'Warm-up' }, Date.now()));
    let base = (await rowOf(sub.id)).last_synced_at.getTime();

    for (let round = 0; round < ROUNDS; round++) {
      const olderTs = base + 10;
      const newerTs = base + 20;
      const older = updatedBody(sub, { summary: `older ${round}`, status: statusField('done') }, olderTs);
      const newer = updatedBody(sub, { summary: `newer ${round}`, status: statusField('indeterminate') }, newerTs);
      // Even rounds: the newer one arrives first; odd rounds: the older one arrives first.
      const order = round % 2 === 0 ? [newer, older] : [older, newer];

      await holder.query('BEGIN');
      await holder.query('SELECT id FROM jira_ticket WHERE id = $1 FOR UPDATE', [sub.id]);
      const responses: Promise<number>[] = [];
      for (const [index, body] of order.entries()) {
        responses.push(postSigned(t, body).then((res) => res.status));
        await until(async () => (await waiting()) >= index + 1);
      }
      await holder.query('COMMIT');
      assert.deepEqual(await Promise.all(responses), [204, 204]);

      const row = await rowOf(sub.id);
      assert.deepEqual(
        [row.summary, row.status_category, row.last_synced_at.getTime()],
        [`newer ${round}`, 'IN_PROGRESS', newerTs],
        `round ${round}: the final state is the newer event's`,
      );
      base = newerTs;
    }
  });

  it('the same delivery twice at once is applied once: one audit entry (D-97)', async () => {
    const a = await arrange(t, 1);
    const sub = a.subtasks[0]!;
    await postSigned(t, updatedBody(sub, { summary: 'Warm-up' }, Date.now()));
    const before = await auditUpdates(sub.id);
    const at = (await rowOf(sub.id)).last_synced_at.getTime() + 10;
    const body = updatedBody(sub, { summary: 'Once', status: statusField('done') }, at);

    await holder.query('BEGIN');
    await holder.query('SELECT id FROM jira_ticket WHERE id = $1 FOR UPDATE', [sub.id]);
    const responses = [postSigned(t, body), postSigned(t, body)].map((r) => r.then((res) => res.status));
    await until(async () => (await waiting()) >= 2);
    await holder.query('COMMIT');
    assert.deepEqual(await Promise.all(responses), [204, 204]);
    assert.equal((await rowOf(sub.id)).summary, 'Once');
    assert.equal((await auditUpdates(sub.id)) - before, 1);
  });
});
