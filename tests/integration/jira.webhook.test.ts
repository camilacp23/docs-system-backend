/**
 * Module 4, POST /integrations/jira/webhook (FR-12, NFR-06, NFR-14; SDD 7.2.8, Table 53; D-31, D-96, D-97) against the
 * in-process Jira simulator (its signed deliveries) and with hand-built bodies: the signature checked on the raw body
 * before anything parses it, validation, every way a delivery is ignored, updates, hierarchy changes that do not fit,
 * deletions with cascade, the attribution to the reserved account, writes only when something tracked changed, and
 * that nothing sensitive is logged. No fixed waits.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { bodyOf } from '../helpers/app.js';
import { setApplicationStatus } from '../helpers/fixtures.js';
import { startJiraApp, type JiraApp } from '../helpers/jiraApp.js';
import { signWebhookBody, type SimWebhookDelivery } from '../helpers/jiraSimulator.js';
import {
  arrange,
  bearerOf,
  deletedBody,
  post,
  postSigned,
  statusField,
  updatedBody,
  WEBHOOK_PATH,
  type Arranged,
} from '../helpers/jiraWebhook.js';

type Row = {
  jira_issue_key: string;
  summary: string;
  status: string;
  status_category: string;
  issue_type: string;
  parent_ticket_id: number | null;
  parent_level: string | null;
  hierarchy_level: string;
  last_synced_at: Date;
};

describe('POST /integrations/jira/webhook', () => {
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
    t.logs.length = 0;
  });

  const rowOf = async (id: number): Promise<Row | undefined> =>
    (await t.owner.query<Row>(`SELECT * FROM jira_ticket WHERE id = $1`, [id])).rows[0];
  const must = async (id: number): Promise<Row> => {
    const r = await rowOf(id);
    assert.ok(r, `ticket ${id} should exist`);
    return r;
  };
  const auditCount = async () =>
    Number(
      (await t.owner.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE entity_type = 'jira_ticket'`))
        .rows[0]!.n,
    );
  const logs = () => t.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
  const outcomes = () => logs().filter((l) => l['operation'] === 'receiveJiraWebhook' && l['outcome'] !== undefined);
  const warns = (reason: string) => logs().filter((l) => l['level'] === 40 && l['reason'] === reason);
  /** The time of the row's last synchronization, to build events before, at and after it. */
  const syncedAt = async (id: number) => (await must(id)).last_synced_at.getTime();

  describe('signature (Table 53 step 1)', () => {
    it('a delivery of the simulator is accepted with 204 and no body, whatever the Bearer', async () => {
      const a = await arrange(t, 1);
      await t.control(`/__sim/issues/${a.subtasks[0]!.key}/status`, { category: 'done' }); // changes nothing locally
      const body = updatedBody(
        a.subtasks[0]!,
        { status: statusField('done') },
        (await syncedAt(a.subtasks[0]!.id)) + 5,
      );
      const res = await postSigned(t, body).set('Authorization', bearerOf(t));
      assert.equal(res.status, 204);
      assert.equal(res.text, '');
      assert.ok(res.headers['x-request-id']);
      assert.equal((await must(a.subtasks[0]!.id)).status_category, 'DONE');
    });

    it('applies a real delivery of the simulator (headers as Jira sends them)', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      const sent = await fetch(`${t.sim.baseUrl}/__sim/issues/${sub.key}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category: 'indeterminate', timestamp: (await syncedAt(sub.id)) + 50 }),
      });
      const delivery = (await sent.json()) as SimWebhookDelivery;
      const res = await post(t, delivery.rawBody, delivery.headers);
      assert.equal(res.status, 204);
      const row = await must(sub.id);
      assert.deepEqual([row.status, row.status_category], ['In Progress', 'IN_PROGRESS']);
      assert.ok(
        outcomes().some(
          (l) => l['outcome'] === 'applied' && l['deliveryId'] === delivery.headers['x-atlassian-webhook-identifier'],
        ),
      );
    });

    it('a tampered body, a wrong secret, a missing or malformed header and a re-serialized body are 401 INVALID_SIGNATURE', async () => {
      const a = await arrange(t, 1);
      const ts = (await syncedAt(a.subtasks[0]!.id)) + 10;
      const body = updatedBody(a.subtasks[0]!, { summary: 'Changed' }, ts);
      const good = signWebhookBody(body, t.sim.webhookSecret);
      const cases: [string, string, Record<string, string>][] = [
        ['tampered body', body.replace('Changed', 'Chenged'), { 'X-Hub-Signature': good }],
        ['wrong secret', body, { 'X-Hub-Signature': signWebhookBody(body, 'another-secret') }],
        ['no header', body, {}],
        ['not hex', body, { 'X-Hub-Signature': 'sha256=zz' }],
        ['another method', body, { 'X-Hub-Signature': good.replace('sha256', 'sha1') }],
        ['truncated', body, { 'X-Hub-Signature': good.slice(0, 30) }],
        ['re-serialized', JSON.stringify(JSON.parse(body), null, 2), { 'X-Hub-Signature': good }],
      ];
      for (const [label, raw, headers] of cases) {
        const res = await post(t, raw, headers);
        assert.equal(res.status, 401, label);
        assert.deepEqual(
          res.body,
          { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature.', details: null },
          label,
        );
      }
      assert.equal((await must(a.subtasks[0]!.id)).summary, 'Subtask 1', 'nothing was written');
      assert.equal(warns('SIGNATURE_MISMATCH').length, cases.length);
    });

    it('the signature is checked before the body is parsed: unsigned invalid JSON is 401, signed invalid JSON is 400', async () => {
      assert.equal((await post(t, '{not json')).status, 401);
      assert.equal((await postSigned(t, '{not json')).status, 400);
    });

    it('also by another spelling of the path (case, trailing "/"): the JSON parser never gets the body first', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      for (const path of [
        '/API/v1/integrations/jira/webhook',
        `${WEBHOOK_PATH}/`,
        '/api/V1/Integrations/JIRA/Webhook/',
      ]) {
        assert.equal((await post(t, '{not json', {}, path)).status, 401, path);
        const body = updatedBody(sub, { summary: `Via ${path}` }, Date.now() + 1000);
        assert.equal((await postSigned(t, body, {}, path)).status, 204, path);
        assert.equal((await must(sub.id)).summary, `Via ${path}`);
      }
    });

    it('a body over 1 MB is 413 PAYLOAD_TOO_LARGE', async () => {
      const res = await post(t, JSON.stringify({ a: 'x'.repeat(1_100_000) }));
      assert.equal(res.status, 413);
      assert.equal(bodyOf(res).code, 'PAYLOAD_TOO_LARGE');
    });

    it('a content type other than JSON is read raw too', async () => {
      const a = await arrange(t, 1);
      const body = updatedBody(a.subtasks[0]!, { summary: 'As text' }, Date.now() + 1000);
      const res = await t.http
        .post(WEBHOOK_PATH)
        .set('Content-Type', 'text/plain')
        .set('X-Hub-Signature', signWebhookBody(body, t.sim.webhookSecret))
        .send(body);
      assert.equal(res.status, 204);
    });
  });

  describe('validation (step 2): 400 VALIDATION_ERROR with the field', () => {
    const fieldsOf = (res: { body: unknown }) => bodyOf(res).details.fields.map((f) => [f.field, f.rule]);
    const ok = { webhookEvent: 'jira:issue_updated', issue: { id: '1', key: 'TECHEA-1' } };
    const cases: [string, unknown, string[][]][] = [
      ['not JSON', '{oops', [['body', 'type']]],
      ['an array', '[]', [['body', 'type']]],
      ['no webhookEvent', { issue: ok.issue }, [['webhookEvent', 'required']]],
      ['an unknown webhookEvent', { ...ok, webhookEvent: 'comment_created' }, [['webhookEvent', 'enum']]],
      ['no issue', { webhookEvent: ok.webhookEvent }, [['issue', 'required']]],
      ['no issue.id', { ...ok, issue: { key: 'TECHEA-1' } }, [['issue.id', 'required']]],
      ['a numeric issue.id', { ...ok, issue: { id: 7, key: 'TECHEA-1' } }, [['issue.id', 'type']]],
      ['an empty issue.id', { ...ok, issue: { id: '' } }, [['issue.id', 'type']]],
      ['an issue.id over 32 characters', { ...ok, issue: { id: '1'.repeat(33) } }, [['issue.id', 'type']]],
      ['a timestamp that is not an integer', { ...ok, timestamp: 'now' }, [['timestamp', 'type']]],
    ];
    for (const [label, body, expected] of cases) {
      it(label, async () => {
        const res = await postSigned(t, typeof body === 'string' ? body : JSON.stringify(body));
        assert.equal(res.status, 400);
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
        assert.deepEqual(fieldsOf(res), expected);
      });
    }
  });

  describe('deliveries that are ignored with 204', () => {
    it('an issue that is not tracked locally (step 3)', async () => {
      const a = await arrange(t, 1);
      const audit = await auditCount();
      const stranger = { ...a.subtasks[0]!, issueId: '99999999', key: 'TECHEA-4040' };
      assert.equal((await postSigned(t, updatedBody(stranger, { summary: 'x' }, Date.now() + 99))).status, 204);
      assert.equal((await postSigned(t, deletedBody(stranger, Date.now() + 99))).status, 204);
      assert.equal(await auditCount(), audit);
      assert.equal(outcomes().filter((l) => l['outcome'] === 'ignored_untracked').length, 2);
    });

    it('jira:issue_created (even for a tracked issue)', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      const body = JSON.stringify({
        webhookEvent: 'jira:issue_created',
        timestamp: Date.now() + 1000,
        issue: { id: sub.issueId, key: sub.key, fields: { summary: 'Created?' } },
      });
      assert.equal((await postSigned(t, body)).status, 204);
      assert.equal((await must(sub.id)).summary, 'Subtask 1');
      assert.ok(outcomes().some((l) => l['outcome'] === 'ignored_created'));
    });

    it('an event older than last_synced_at is ignored; an equal timestamp is applied (step 4, D-96)', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      const at = await syncedAt(sub.id);
      assert.equal((await postSigned(t, updatedBody(sub, { summary: 'Older' }, at - 1))).status, 204);
      assert.equal((await must(sub.id)).summary, 'Subtask 1');
      assert.ok(outcomes().some((l) => l['outcome'] === 'ignored_stale'));
      assert.equal((await postSigned(t, updatedBody(sub, { summary: 'Equal' }, at))).status, 204);
      assert.equal((await must(sub.id)).summary, 'Equal');
    });

    it('an older deletion does not delete', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      assert.equal((await postSigned(t, deletedBody(sub, (await syncedAt(sub.id)) - 1))).status, 204);
      assert.ok(await rowOf(sub.id));
    });

    it('an archived application: neither updates nor deletions are applied', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      await setApplicationStatus(t, a.applicationId, 'ARCHIVED');
      const audit = await auditCount();
      const later = Date.now() + 5000;
      assert.equal((await postSigned(t, updatedBody(sub, { summary: 'Archived' }, later))).status, 204);
      assert.equal((await postSigned(t, deletedBody(a.story, later))).status, 204);
      assert.equal((await must(sub.id)).summary, 'Subtask 1');
      assert.ok(await rowOf(a.story.id));
      assert.equal(await auditCount(), audit);
      assert.equal(outcomes().filter((l) => l['outcome'] === 'ignored_archived').length, 2);
    });
  });

  describe('updated (step 5)', () => {
    it('copies status, category, summary and key, with last_synced_at = the timestamp of the event', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      const ts = (await syncedAt(sub.id)) + 12345;
      const body = updatedBody(sub, { summary: 'New summary', status: statusField('indeterminate', 'En curso') }, ts, {
        key: 'TECHEA-777',
      });
      assert.equal((await postSigned(t, body)).status, 204);
      const row = await must(sub.id);
      assert.deepEqual(
        [row.summary, row.status, row.status_category, row.jira_issue_key, row.last_synced_at.getTime()],
        ['New summary', 'En curso', 'IN_PROGRESS', 'TECHEA-777', ts],
      );
      assert.equal(row.issue_type, 'Subtask', 'issue_type is only corrected by the refresh (D-96)');
    });

    it('maps the three categories', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      let ts = await syncedAt(sub.id);
      for (const [category, expected] of [
        ['done', 'DONE'],
        ['new', 'TO_DO'],
        ['indeterminate', 'IN_PROGRESS'],
      ] as const) {
        ts += 10;
        assert.equal(
          (await postSigned(t, updatedBody(sub, { status: statusField(category, `S-${category}`) }, ts))).status,
          204,
        );
        assert.equal((await must(sub.id)).status_category, expected);
      }
    });

    it('copies only what is present; an unknown category is skipped with a warn and the rest applies', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      const ts = (await syncedAt(sub.id)) + 10;
      const body = updatedBody(
        sub,
        { summary: 'Only this', status: { name: 'Odd', statusCategory: { key: 'undefined' } } },
        ts,
      );
      assert.equal((await postSigned(t, body)).status, 204);
      const row = await must(sub.id);
      assert.deepEqual([row.summary, row.status, row.status_category], ['Only this', 'Odd', 'TO_DO']);
      assert.equal(warns('CATEGORY_UNKNOWN').length, 1);
    });

    it('without a timestamp the moment of receipt is used', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      const before = Date.now();
      assert.equal((await postSigned(t, updatedBody(sub, { summary: 'No timestamp' }))).status, 204);
      const row = await must(sub.id);
      assert.equal(row.summary, 'No timestamp');
      assert.ok(row.last_synced_at.getTime() >= before);
    });

    it('a key that another ticket holds is not changed (warn); the other fields apply (D-96)', async () => {
      const a = await arrange(t, 2);
      const [first, second] = a.subtasks as [(typeof a.subtasks)[0], (typeof a.subtasks)[0]];
      const ts = (await syncedAt(first.id)) + 10;
      assert.equal(
        (await postSigned(t, updatedBody(first, { summary: 'Keeps its key' }, ts, { key: second.key }))).status,
        204,
      );
      const row = await must(first.id);
      assert.deepEqual([row.jira_issue_key, row.summary], [first.key, 'Keeps its key']);
      assert.equal(warns('KEY_CONFLICT').length, 1);
    });

    it('a key that is not a Jira key is skipped with a warn instead of failing the delivery', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      const ts = (await syncedAt(sub.id)) + 10;
      assert.equal((await postSigned(t, updatedBody(sub, { summary: 'Fine' }, ts, { key: 'not a key' }))).status, 204);
      assert.deepEqual([(await must(sub.id)).jira_issue_key, (await must(sub.id)).summary], [sub.key, 'Fine']);
      assert.equal(warns('KEY_INVALID').length, 1);
    });
  });

  describe('hierarchy that no longer fits is kept (D-96)', () => {
    it('a Subtask moved to another Story of the same screen follows', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      const created = (
        (
          await t.http
            .post(`/api/v1/screens/${a.screenId}/jira-ticket`)
            .set('Authorization', bearerOf(t))
            .send({ newStory: { summary: 'Story 2' }, subtask: { summary: 'Other' } })
        ).body as { data: { story: { id: number; jiraIssueKey: string } } }
      ).data;
      const other = (
        await t.owner.query<{ jira_issue_id: string }>(`SELECT jira_issue_id FROM jira_ticket WHERE id = $1`, [
          created.story.id,
        ])
      ).rows[0]!.jira_issue_id;
      const ts = Date.now() + 10_000;
      const body = updatedBody(
        sub,
        { parent: { id: other, key: created.story.jiraIssueKey }, issuetype: { name: 'Subtask', hierarchyLevel: -1 } },
        ts,
      );
      assert.equal((await postSigned(t, body)).status, 204);
      const row = await must(sub.id);
      assert.deepEqual([row.parent_ticket_id, row.parent_level], [created.story.id, 'STANDARD']);
    });

    const keepCases: [string, (a: Arranged, other: string) => Record<string, unknown>, string][] = [
      [
        'a parent that is not tracked',
        () => ({ parent: { id: '88888888', key: 'TECHEA-8888' } }),
        'PARENT_NOT_FITTING',
      ],
      [
        'a parent of the wrong level (the Epic for a Subtask)',
        (a) => ({ parent: { id: a.epic.issueId, key: a.epic.key } }),
        'PARENT_NOT_FITTING',
      ],
      ['a parent of another screen', (_a, other) => ({ parent: { id: other, key: 'TECHEA-9' } }), 'PARENT_NOT_FITTING'],
      ['no parent at all', () => ({}), 'PARENT_MISSING'],
      ['a different hierarchy level', () => ({ issuetype: { name: 'Story', hierarchyLevel: 0 } }), 'LEVEL_CHANGED'],
      ['an unmodelled hierarchy level', () => ({ issuetype: { name: 'Odd', hierarchyLevel: 5 } }), 'LEVEL_UNKNOWN'],
    ];
    for (const [label, build, reason] of keepCases) {
      it(`${label}: structure kept, the other fields updated, one warn`, async () => {
        const a = await arrange(t, 1);
        const sub = a.subtasks[0]!;
        const elsewhere = await arrange(t, 1);
        const before = await must(sub.id);
        const fields = {
          summary: `Updated (${reason})`,
          status: statusField('done'),
          ...build(a, elsewhere.story.issueId),
        };
        assert.equal((await postSigned(t, updatedBody(sub, fields, before.last_synced_at.getTime() + 10))).status, 204);
        const row = await must(sub.id);
        assert.deepEqual(
          [row.parent_ticket_id, row.parent_level, row.hierarchy_level],
          [before.parent_ticket_id, before.parent_level, before.hierarchy_level],
        );
        assert.deepEqual([row.summary, row.status_category], [`Updated (${reason})`, 'DONE']);
        assert.equal(warns(reason).length, 1, reason);
        // The warn names no key, body or secret.
        assert.ok(!JSON.stringify(warns(reason)[0]).includes('TECHEA-'));
      });
    }

    it('an Epic that suddenly has a parent keeps being an Epic', async () => {
      const a = await arrange(t, 1);
      const ts = (await syncedAt(a.epic.id)) + 10;
      const body = updatedBody(
        a.epic,
        { summary: 'Epic renamed', parent: { id: a.story.issueId, key: a.story.key } },
        ts,
      );
      assert.equal((await postSigned(t, body)).status, 204);
      const row = await must(a.epic.id);
      assert.deepEqual([row.parent_ticket_id, row.summary], [null, 'Epic renamed']);
      assert.equal(warns('PARENT_NOT_FITTING').length, 1);
    });
  });

  describe('no empty writes (D-97)', () => {
    it('an event with nothing tracked changed writes nothing: no audit rows, same last_synced_at', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      const before = await must(sub.id);
      const audit = await auditCount();
      const same = {
        summary: before.summary,
        status: statusField('new', before.status),
        issuetype: { name: 'Subtask', hierarchyLevel: -1 },
        description: 'A comment or assignee changed in Jira',
        assignee: { accountId: 'x' },
      };
      const parent = await t.owner.query<{ jira_issue_id: string; jira_issue_key: string }>(
        `SELECT jira_issue_id, jira_issue_key FROM jira_ticket WHERE id = $1`,
        [a.story.id],
      );
      const body = updatedBody(
        sub,
        { ...same, parent: { id: parent.rows[0]!.jira_issue_id, key: parent.rows[0]!.jira_issue_key } },
        before.last_synced_at.getTime() + 500,
      );
      assert.equal((await postSigned(t, body)).status, 204);
      assert.equal(
        (await postSigned(t, updatedBody(sub, undefined, before.last_synced_at.getTime() + 600))).status,
        204,
      );
      assert.equal(await auditCount(), audit);
      assert.equal((await must(sub.id)).last_synced_at.getTime(), before.last_synced_at.getTime());
      assert.equal(outcomes().filter((l) => l['outcome'] === 'ignored_unchanged').length, 2);
    });
  });

  describe('deleted (step 5)', () => {
    it('deletes the local row', async () => {
      const a = await arrange(t, 2);
      const sub = a.subtasks[0]!;
      assert.equal((await postSigned(t, deletedBody(sub, Date.now() + 1000))).status, 204);
      assert.equal(await rowOf(sub.id), undefined);
      assert.ok(await rowOf(a.subtasks[1]!.id));
    });

    it('deleting a Story deletes its Subtasks too; deleting the Epic deletes the whole tree (FK of Table 30)', async () => {
      const a = await arrange(t, 2);
      assert.equal((await postSigned(t, deletedBody(a.story, Date.now() + 1000))).status, 204);
      assert.equal((await t.ticketsOf(a.screenId)).length, 1, 'only the Epic is left');
      assert.equal((await postSigned(t, deletedBody(a.epic, Date.now() + 2000))).status, 204);
      assert.equal((await t.ticketsOf(a.screenId)).length, 0);
    });

    it('a deletion by the simulator is applied from its signed delivery', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      const sent = await fetch(`${t.sim.baseUrl}/__sim/issues/${sub.key}/delete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ timestamp: (await syncedAt(sub.id)) + 1 }),
      });
      const delivery = (await sent.json()) as SimWebhookDelivery;
      assert.equal((await post(t, delivery.rawBody, delivery.headers)).status, 204);
      assert.equal(await rowOf(sub.id), undefined);
    });
  });

  describe('actor (D-31, D-51, NFR-20)', () => {
    it('every write of a delivery, also the cascade, is attributed to the reserved account', async () => {
      const a = await arrange(t, 2);
      const sub = a.subtasks[0]!;
      const lastBefore = Number(
        (await t.owner.query<{ m: string }>(`SELECT coalesce(max(id), 0) AS m FROM audit_log`)).rows[0]!.m,
      );
      assert.equal((await postSigned(t, updatedBody(sub, { summary: 'By Jira' }, Date.now() + 500))).status, 204);
      assert.equal((await postSigned(t, deletedBody(a.story, Date.now() + 1000))).status, 204);
      const rows = await t.owner.query<{ action: string; actor_user_id: number; db_role: string; entity_id: string }>(
        `SELECT action, actor_user_id, db_role, entity_id FROM audit_log
          WHERE id > $2 AND entity_type = 'jira_ticket' AND action IN ('UPDATE', 'DELETE') AND entity_id = ANY($1) ORDER BY id DESC`,
        [[sub.id, a.story.id, a.subtasks[1]!.id].map(String), lastBefore],
      );
      const deleted = rows.rows
        .filter((r) => r.action === 'DELETE')
        .map((r) => r.entity_id)
        .sort();
      assert.deepEqual(
        deleted,
        [sub.id, a.story.id, a.subtasks[1]!.id].map(String).sort(),
        'the Story and its two Subtasks',
      );
      assert.ok(rows.rows.some((r) => r.action === 'UPDATE' && r.entity_id === String(sub.id)));
      for (const r of rows.rows) {
        assert.equal(r.actor_user_id, t.reservedId);
        assert.equal(r.db_role, 'docs_app');
      }
    });
  });

  describe('logging (NFR-06)', () => {
    it('no log line contains the body, the signature, the secret or a header', async () => {
      const a = await arrange(t, 1);
      const sub = a.subtasks[0]!;
      const body = updatedBody(
        sub,
        { summary: 'Sensitive summary text', parent: { id: '1', key: 'TECHEA-1' } },
        Date.now() + 1000,
      );
      const signature = signWebhookBody(body, t.sim.webhookSecret);
      await postSigned(t, body, { 'X-Atlassian-Webhook-Identifier': 'delivery-1234.abc' });
      await post(t, body, { 'X-Hub-Signature': signature.replace(/.$/, '0') });
      await postSigned(t, '{bad');
      const text = t.logs.join('\n');
      for (const secret of [
        t.sim.webhookSecret,
        signature,
        'Sensitive summary text',
        'x-hub-signature',
        'X-Hub-Signature',
        sub.key,
      ]) {
        assert.ok(!text.includes(secret), `the log contains ${secret.slice(0, 12)}…`);
      }
      assert.ok(
        outcomes().some((l) => l['deliveryId'] === 'delivery-1234.abc'),
        'the safe delivery id is traced',
      );
    });

    it('an identifier that is not safe is not logged', async () => {
      const a = await arrange(t, 1);
      const body = updatedBody(a.subtasks[0]!, { summary: 'Id test' }, Date.now() + 1000);
      await postSigned(t, body, { 'X-Atlassian-Webhook-Identifier': 'x'.repeat(101) });
      assert.ok(outcomes().every((l) => l['deliveryId'] === undefined));
    });
  });
});
