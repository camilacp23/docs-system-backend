/**
 * Module 4, POST /screens/{id}/jira-ticket under concurrency (FR-12; D-31, D-93): simultaneous first tickets of a
 * screen must create ONE Epic in Jira. The local unique index would arrive too late (the second Epic would already
 * exist in Jira), so the proof counts the Epics the simulator holds, over several rounds. Removing the per-screen
 * serialization makes it fail. No fixed waits: the race is widened by yielding before every creation, and the order is
 * driven by gates.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { bodyOf } from '../helpers/app.js';
import { insertApplication, insertScreen } from '../helpers/fixtures.js';
import { startJiraApp, type JiraApp } from '../helpers/jiraApp.js';
import { asUser } from '../helpers/users.js';

type Created = {
  epic: { id: number; jiraIssueKey: string };
  story: { id: number };
  subtask: { id: number };
  created: string[];
};
const createdOf = (res: { body: unknown }): Created => (res.body as { data: Created }).data;

const ROUNDS = 8;
const CALLERS = 5;
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** A gate a test opens by hand: `reached()` tells the test the held call arrived. */
function makeGate(word: string) {
  let reached!: () => void;
  let open!: () => void;
  const hasReached = new Promise<void>((resolve) => (reached = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { word, reached, opened, hasReached, open };
}

describe('POST /screens/{id}/jira-ticket: concurrency', () => {
  let t: JiraApp;
  /** A creation whose body contains the gate's word waits until the test opens the gate. */
  let gate: ReturnType<typeof makeGate> | null = null;
  before(async () => {
    t = await startJiraApp({
      client: { timeoutMs: 5_000, breakerFailureThreshold: 1000 },
      deps: (base) => ({
        ...base,
        fetch: async (input, init) => {
          if (urlOf(input).endsWith('/rest/api/3/issue')) {
            // Yield so the other requests reach their own creation: without serialization they all see "no Epic".
            await turn();
            await turn();
            const body = typeof init?.body === 'string' ? init.body : '';
            if (gate !== null && body.includes(gate.word)) {
              gate.reached();
              await gate.opened;
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
  beforeEach(() => {
    gate = null;
  });

  /** Sends at once: a supertest request is lazy and would not start until someone awaits it. */
  const post = (role: 'admin' | 'developer', screenId: number, body: object) =>
    asUser(t, t.users[role].token)
      .post(`/screens/${screenId}/jira-ticket`, body)
      .then((res) => res);
  const epicsInJira = async (summary: string): Promise<number> =>
    (await t.simState()).issues.filter((i) => i.level === 'EPIC' && i.summary === summary).length;

  it(`${ROUNDS} rounds of ${CALLERS} simultaneous first tickets create exactly one Epic per screen`, async () => {
    const application = await insertApplication(t);
    for (let round = 1; round <= ROUNDS; round++) {
      const screen = await insertScreen(t, application.id);
      const roles = Array.from({ length: CALLERS }, (_, i): 'admin' | 'developer' =>
        i % 2 === 0 ? 'admin' : 'developer',
      );
      const responses = await Promise.all(
        roles.map((role, i) =>
          post(role, screen.id, {
            newStory: { summary: `Story ${round}.${i}` },
            subtask: { summary: `Subtask ${round}.${i}` },
          }),
        ),
      );
      assert.equal(await epicsInJira(`${screen.name} (${application.name})`), 1, `round ${round}: Epics in Jira`);
      responses.forEach((res, i) =>
        assert.equal(res.status, 201, `round ${round} caller ${i}: ${JSON.stringify(res.body)}`),
      );
      const data = responses.map(createdOf);

      const rows = await t.ticketsOf(screen.id);
      assert.equal(rows.filter((r) => r.hierarchy_level === 'EPIC').length, 1, 'Epics saved locally');
      assert.equal(rows.length, 1 + 2 * CALLERS);
      assert.equal(new Set(data.map((d) => d.epic.id)).size, 1, 'every response shows the same Epic');
      assert.equal(new Set(data.map((d) => d.story.id)).size, CALLERS, 'each request has its own Story');
      const creators = data.map((d, i) => ({ i, made: d.created.includes('EPIC') })).filter((c) => c.made);
      assert.equal(creators.length, 1, 'exactly one request reports having created the Epic');

      // The caller of each request is the actor of what it created, also after waiting for the Epic.
      const epicRow = rows.find((r) => r.hierarchy_level === 'EPIC')!;
      assert.equal(epicRow.created_by, t.users[roles[creators[0]!.i]!].id);
      const byId = new Map(rows.map((r) => [r.id, r.created_by]));
      data.forEach((d, i) => {
        assert.equal(byId.get(d.story.id), t.users[roles[i]!].id, `Story of caller ${i}`);
        assert.equal(byId.get(d.subtask.id), t.users[roles[i]!].id, `Subtask of caller ${i}`);
      });
      const audit = await t.owner.query<{ entity_id: string; actor_user_id: number }>(
        `SELECT entity_id, actor_user_id FROM audit_log
          WHERE entity_type = 'jira_ticket' AND action = 'CREATE' AND entity_id = ANY($1)`,
        [rows.map((r) => String(r.id))],
      );
      assert.equal(audit.rows.length, rows.length);
      for (const a of audit.rows) {
        assert.equal(a.actor_user_id, byId.get(Number(a.entity_id)), `audit of ${a.entity_id}`);
      }
    }
    assert.equal((await t.simState()).issues.filter((i) => i.level === 'EPIC').length, ROUNDS);
  });

  it('the screens do not wait for each other: a held Epic of one screen does not hold another', async () => {
    const application = await insertApplication(t);
    const slow = await insertScreen(t, application.id, { name: 'GATED screen' });
    const quick = await insertScreen(t, application.id, { name: 'Quick screen' });
    const g = makeGate('GATED screen');
    gate = g;
    const held = post('admin', slow.id, { newStory: { summary: 'S' }, subtask: { summary: 'T' } });
    await g.hasReached; // the Epic of the slow screen is inside the critical section, waiting
    const other = await post('developer', quick.id, { newStory: { summary: 'S' }, subtask: { summary: 'T' } });
    assert.equal(other.status, 201, 'the other screen finished while the first one is held');
    g.open();
    assert.equal((await held).status, 201);
  });

  it('a waiting request holds no database connection: 30 queued requests do not block the database', async () => {
    const application = await insertApplication(t);
    const screen = await insertScreen(t, application.id, { name: 'GATED pool' });
    const g = makeGate('GATED pool');
    gate = g;
    const waiting = Array.from({ length: 30 }, (_, i) =>
      post('developer', screen.id, { newStory: { summary: `S${i}` }, subtask: { summary: `T${i}` } }),
    );
    await g.hasReached;
    // The Epic is held with the others queued behind it; the database still answers.
    const read = await asUser(t, t.users.admin.token).get(`/screens/${screen.id}`);
    assert.equal(read.status, 200);
    g.open();
    const results = await Promise.all(waiting);
    assert.ok(results.every((r) => r.status === 201));
    assert.equal(await epicsInJira(`GATED pool (${application.name})`), 1);
  });

  it('when the request holding the Epic fails, the next one creates it: still one Epic', async () => {
    const application = await insertApplication(t);
    const screen = await insertScreen(t, application.id);
    await t.control('/__sim/faults', { kind: '500', appliesTo: 'create', count: 1 });
    const responses = await Promise.all(
      [1, 2, 3].map((i) =>
        post('developer', screen.id, { newStory: { summary: `S${i}` }, subtask: { summary: `T${i}` } }),
      ),
    );
    const failed = responses.filter((r) => r.status === 502);
    assert.equal(failed.length, 1);
    assert.equal(bodyOf(failed[0]!).code, 'JIRA_UNAVAILABLE');
    assert.equal(responses.filter((r) => r.status === 201).length, 2);
    assert.equal(await epicsInJira(`${screen.name} (${application.name})`), 1);
    assert.equal((await t.ticketsOf(screen.id)).filter((r) => r.hierarchy_level === 'EPIC').length, 1);
  });
});
