/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any --
   the simulator's JSON answers are inspected field by field; typing every Jira shape here would only repeat the code. */
/**
 * The local Jira simulator: Jira Cloud v3 shapes, Basic auth, keys, hierarchy, statuses, injected faults, signed
 * webhook deliveries, and the real Jira client running against it. It runs in process on a random port.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  createJiraClient,
  JiraRequestError,
  JiraUnavailableError,
  verifyJiraSignature,
} from '../../src/integrations/jira/index.js';
import {
  SIMULATOR_DEFAULTS,
  signWebhookBody,
  startJiraSimulator,
  type JiraSimulator,
  type SimWebhookDelivery,
} from '../helpers/jiraSimulator.js';

const T = SIMULATOR_DEFAULTS.issueTypeIds;
const screen = { screenId: 1, screenName: 'Login', applicationName: 'SAR' };

let sim: JiraSimulator;
before(async () => {
  sim = await startJiraSimulator();
});
after(async () => {
  await sim.close();
});
beforeEach(async () => {
  await control('/__sim/reset');
});
afterEach(() => undefined);

const auth = (): string => `Basic ${Buffer.from(`${sim.email}:${sim.apiToken}`).toString('base64')}`;

async function api(method: string, path: string, body?: unknown, authorization: string | null = auth()) {
  const res = await fetch(`${sim.baseUrl}${path}`, {
    method,
    headers: {
      ...(authorization === null ? {} : { Authorization: authorization }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    json: (text === '' ? null : JSON.parse(text)) as Record<string, any>,
  };
}
const control = (path: string, body: unknown = {}) => api('POST', path, body, null);
const create = (typeId: string, summary: string, parentKey?: string) =>
  api('POST', '/rest/api/3/issue', {
    fields: {
      project: { key: 'TECHEA' },
      issuetype: { id: typeId },
      summary,
      ...(parentKey === undefined ? {} : { parent: { key: parentKey } }),
    },
  });
const hierarchy = async () => {
  const epic = (await create(T.epic, 'Login')).json['key'] as string;
  const story = (await create(T.story, 'Story', epic)).json['key'] as string;
  const subtask = (await create(T.subtask, 'Task', story)).json['key'] as string;
  return { epic, story, subtask };
};

describe('authentication', () => {
  it('answers 401 without credentials and with wrong ones, on every endpoint', async () => {
    for (const authorization of [null, 'Basic ' + Buffer.from('a:b').toString('base64'), 'Bearer x']) {
      assert.equal((await api('GET', '/rest/api/3/issue/TECHEA-1', undefined, authorization)).status, 401);
      assert.equal(
        (await api('POST', '/rest/api/3/search/jql', { jql: 'project = TECHEA' }, authorization)).status,
        401,
      );
      assert.equal(
        (await create(T.epic, 'x').then(() => api('POST', '/rest/api/3/issue', {}, authorization))).status,
        401,
      );
    }
  });
});

describe('creating issues', () => {
  it('numbers keys TECHEA-1, TECHEA-2, ... and ids from 10000, and returns id, key and self', async () => {
    const first = await create(T.epic, 'Login');
    const second = await create(T.epic, 'Other');
    assert.equal(first.status, 201);
    assert.deepEqual(Object.keys(first.json).sort(), ['id', 'key', 'self']);
    assert.equal(first.json['key'], 'TECHEA-1');
    assert.equal(first.json['id'], '10000');
    assert.equal(second.json['key'], 'TECHEA-2');
    assert.equal(first.json['self'], `${sim.baseUrl}/rest/api/3/issue/10000`);
  });

  it('enforces the hierarchy: Story -> Epic, Subtask -> Story, Epic without parent', async () => {
    const { epic, story } = await hierarchy();
    const cases: [string, string, string | undefined, string][] = [
      [T.epic, 'E', epic, 'parent'],
      [T.subtask, 'S', undefined, 'parent'],
      [T.subtask, 'S', epic, 'parent'],
      [T.story, 'S', story, 'parent'],
      [T.story, 'S', 'TECHEA-999', 'parent'],
      ['999', 'S', undefined, 'issuetype'],
    ];
    for (const [type, summary, parent, field] of cases) {
      const res = await create(type, summary, parent);
      assert.equal(res.status, 400, `${type} ${parent}`);
      assert.ok(field in res.json['errors'], field);
    }
    assert.equal((await create(T.story, 'Orphan story')).status, 201, 'a Story may exist without an Epic');
  });

  it('validates the project, the summary and the ADF description', async () => {
    const body = (fields: object) =>
      api('POST', '/rest/api/3/issue', {
        fields: { project: { key: 'TECHEA' }, issuetype: { id: T.epic }, summary: 's', ...fields },
      });
    assert.ok('project' in (await body({ project: { key: 'OTHER' } })).json['errors']);
    assert.ok('summary' in (await body({ summary: '' })).json['errors']);
    assert.ok('summary' in (await body({ summary: 'x'.repeat(256) })).json['errors']);
    assert.ok('summary' in (await body({ summary: 'a\nb' })).json['errors']);
    assert.ok('description' in (await body({ description: 'plain text' })).json['errors']);
    assert.ok(
      'description' in
        (
          await body({
            description: {
              type: 'doc',
              version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }],
            },
          })
        ).json['errors'],
    );
    const ok = await body({
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
      },
    });
    assert.equal(ok.status, 201);
    assert.equal((await api('POST', '/rest/api/3/issue', undefined)).status, 400);
  });
});

describe('reading issues', () => {
  it('returns the issue by key or id with status, category, type, hierarchy level and parent', async () => {
    const { epic, story } = await hierarchy();
    const bySubtaskKey = await api('GET', '/rest/api/3/issue/TECHEA-3');
    assert.equal(bySubtaskKey.status, 200);
    const f = bySubtaskKey.json['fields'];
    assert.deepEqual(
      [
        f.summary,
        f.status.name,
        f.status.statusCategory.key,
        f.issuetype.name,
        f.issuetype.hierarchyLevel,
        f.issuetype.subtask,
        f.parent.key,
      ],
      ['Task', 'To Do', 'new', 'Subtask', -1, true, story],
    );
    const byId = await api('GET', '/rest/api/3/issue/10001');
    assert.equal(byId.json['key'], story);
    assert.equal(byId.json['fields'].issuetype.hierarchyLevel, 0);
    assert.equal(byId.json['fields'].parent.key, epic);
    assert.equal((await api('GET', '/rest/api/3/issue/10000')).json['fields'].issuetype.hierarchyLevel, 1);
    assert.equal('parent' in (await api('GET', '/rest/api/3/issue/10000')).json['fields'], false);
  });

  it('answers 404 in Jira format for an unknown issue', async () => {
    const res = await api('GET', '/rest/api/3/issue/TECHEA-404');
    assert.equal(res.status, 404);
    assert.deepEqual(Object.keys(res.json).sort(), ['errorMessages', 'errors']);
  });
});

describe('JQL search', () => {
  it('filters by project, key and parent, and pages with nextPageToken', async () => {
    const { epic, story } = await hierarchy();
    const keysOf = async (jql: string, extra = {}) => {
      const res = await api('POST', '/rest/api/3/search/jql', { jql, ...extra });
      assert.equal(res.status, 200, jql);
      return { keys: (res.json['issues'] as { key: string }[]).map((i) => i.key), res };
    };
    assert.deepEqual((await keysOf('project = TECHEA ORDER BY key')).keys, [epic, story, 'TECHEA-3']);
    assert.deepEqual((await keysOf('key in (TECHEA-1, TECHEA-3)')).keys, [epic, 'TECHEA-3']);
    assert.deepEqual((await keysOf(`project = TECHEA AND parent = ${epic}`)).keys, [story]);
    assert.deepEqual((await keysOf('issuekey = TECHEA-2')).keys, [story]);
    assert.deepEqual((await keysOf('project = OTHER')).keys, []);

    const p1 = await keysOf('project = TECHEA', { maxResults: 2 });
    assert.deepEqual(p1.keys, [epic, story]);
    assert.equal(p1.res.json['isLast'], false);
    const p2 = await keysOf('project = TECHEA', { maxResults: 2, nextPageToken: p1.res.json['nextPageToken'] });
    assert.deepEqual(p2.keys, ['TECHEA-3']);
    assert.equal(p2.res.json['isLast'], true);
    assert.equal('nextPageToken' in p2.res.json, false);
  });

  it('rejects JQL outside its subset, and the retired GET /search answers 410', async () => {
    for (const jql of ['', 'summary ~ "x"', 'project = TECHEA OR project = X', 'key in (TECHEA-1) AND status = Done']) {
      assert.equal((await api('POST', '/rest/api/3/search/jql', { jql })).status, 400, jql);
    }
    assert.equal((await api('GET', '/rest/api/3/search?jql=project%3DTECHEA')).status, 410);
    assert.equal((await api('POST', '/rest/api/3/search', { jql: 'project = TECHEA' })).status, 404);
  });
});

describe('control endpoints', () => {
  it('reset clears issues, counters, faults and the call log', async () => {
    await hierarchy();
    await control('/__sim/faults', { kind: '500' });
    await control('/__sim/reset');
    const state = (await api('GET', '/__sim/state', undefined, null)).json;
    assert.deepEqual([state['issues'], state['faults'], state['calls']], [[], [], []]);
    assert.equal((await create(T.epic, 'Again')).json['key'], 'TECHEA-1');
  });

  it('are not part of the Jira API paths and need no credentials', async () => {
    assert.equal((await api('GET', '/__sim/state', undefined, null)).status, 200);
    assert.equal((await api('GET', '/rest/api/3/__sim/state')).status, 404);
  });

  it('injects the next N 5xx answers, then recovers', async () => {
    await control('/__sim/faults', { kind: '503', count: 2 });
    assert.deepEqual(
      [(await create(T.epic, 'a')).status, (await create(T.epic, 'a')).status, (await create(T.epic, 'a')).status],
      [503, 503, 201],
    );
  });

  it('injects 429 with Retry-After, 401 and 403', async () => {
    await control('/__sim/faults', { kind: '429', retryAfterSeconds: 7 });
    const limited = await api('GET', '/rest/api/3/issue/TECHEA-1');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '7');
    await control('/__sim/faults', { kind: '401' });
    await control('/__sim/faults', { kind: '403' });
    assert.deepEqual(
      [(await api('GET', '/rest/api/3/issue/1')).status, (await api('GET', '/rest/api/3/issue/1')).status],
      [401, 403],
    );
  });

  it('limits a fault to reads or to creations', async () => {
    await control('/__sim/faults', { kind: '500', count: 1, appliesTo: 'read' });
    assert.equal((await create(T.epic, 'a')).status, 201, 'creation unaffected');
    assert.equal((await api('GET', '/rest/api/3/issue/TECHEA-1')).status, 500);
    await control('/__sim/faults', { kind: '500', count: 1, appliesTo: 'create' });
    assert.equal((await api('GET', '/rest/api/3/issue/TECHEA-1')).status, 200, 'read unaffected');
    assert.equal((await create(T.epic, 'b')).status, 500);
  });

  it('records the calls, with the fault that answered them', async () => {
    await control('/__sim/faults', { kind: '502' });
    await create(T.epic, 'a');
    await create(T.epic, 'a');
    const calls = (await api('GET', '/__sim/state', undefined, null)).json['calls'] as {
      fault: string | null;
      status: number;
      authorized: boolean;
    }[];
    assert.deepEqual(
      calls.map((c) => [c.fault, c.status, c.authorized]),
      [
        ['502', 502, false],
        [null, 201, true],
      ],
    );
  });

  it('fails the creations that follow a created Epic or Story (partial failure), then recovers', async () => {
    await control('/__sim/fail-after-create', { level: 'EPIC' });
    assert.equal((await create(T.epic, 'Epic')).status, 201);
    assert.equal((await create(T.story, 'Story', 'TECHEA-1')).status, 500);
    assert.equal((await create(T.story, 'Story', 'TECHEA-1')).status, 201);

    await control('/__sim/fail-after-create', { level: 'STANDARD', count: 2 });
    assert.equal((await create(T.story, 'Second story', 'TECHEA-1')).status, 201);
    assert.equal((await create(T.subtask, 't', 'TECHEA-3')).status, 500);
    assert.equal((await create(T.subtask, 't', 'TECHEA-3')).status, 500);
    assert.equal((await create(T.subtask, 't', 'TECHEA-3')).status, 201);
    assert.equal((await control('/__sim/fail-after-create', { level: 'SUBTASK' })).status, 400);
  });

  it('rejects unknown faults', async () => {
    assert.equal((await control('/__sim/faults', { kind: '418' })).status, 400);
    assert.equal((await control('/__sim/faults', { kind: '500', appliesTo: 'some' })).status, 400);
  });
});

describe('webhook deliveries', () => {
  const status = async (key: string, body: object): Promise<SimWebhookDelivery> =>
    (await control(`/__sim/issues/${key}/status`, body)).json as unknown as SimWebhookDelivery;

  it('changes the status and returns a signed event the API signature check accepts', async () => {
    const { subtask } = await hierarchy();
    const delivery = await status(subtask, { status: 'In Progress' });
    const event = JSON.parse(delivery.rawBody) as Record<string, any>;
    assert.equal(event['webhookEvent'], 'jira:issue_updated');
    assert.equal(event['issue'].key, subtask);
    assert.equal(event['issue'].fields.status.statusCategory.key, 'indeterminate');
    assert.equal(event['issue'].fields.issuetype.hierarchyLevel, -1);
    assert.equal(event['issue'].fields.parent.key, 'TECHEA-2');
    assert.equal(typeof event['timestamp'], 'number');
    assert.deepEqual(event['changelog'].items[0], { field: 'status', fromString: 'To Do', toString: 'In Progress' });
    const raw = Buffer.from(delivery.rawBody);
    assert.equal(verifyJiraSignature(raw, delivery.headers['x-hub-signature'], sim.webhookSecret), true);
    assert.equal(delivery.headers['x-hub-signature'], signWebhookBody(delivery.rawBody, sim.webhookSecret));
    assert.match(delivery.headers['x-hub-signature'], /^sha256=[0-9a-f]{64}$/);
    assert.equal(verifyJiraSignature(raw, delivery.headers['x-hub-signature'], 'another-secret'), false);
    assert.equal(
      verifyJiraSignature(
        Buffer.from(JSON.stringify(event, null, 2)),
        delivery.headers['x-hub-signature'],
        sim.webhookSecret,
      ),
      false,
    );
    assert.ok(delivery.headers['x-atlassian-webhook-identifier'].length > 10);
    assert.equal((await api('GET', `/rest/api/3/issue/${subtask}`)).json['fields'].status.name, 'In Progress');
  });

  it('accepts a status name or a category, and gives each status its category', async () => {
    const { subtask } = await hierarchy();
    const expected: [object, string, string][] = [
      [{ category: 'done' }, 'Done', 'done'],
      [{ status: 'to do' }, 'To Do', 'new'],
      [{ category: 'indeterminate' }, 'In Progress', 'indeterminate'],
    ];
    for (const [body, name, category] of expected) {
      await status(subtask, body);
      const f = (await api('GET', `/rest/api/3/issue/${subtask}`)).json['fields'];
      assert.deepEqual([f.status.name, f.status.statusCategory.key], [name, category]);
    }
    assert.equal((await control(`/__sim/issues/${subtask}/status`, { status: 'Blocked' })).status, 400);
    assert.equal((await control('/__sim/issues/TECHEA-99/status', { status: 'Done' })).status, 404);
  });

  it('can stamp an event in the past, to test out-of-order deliveries', async () => {
    const { subtask } = await hierarchy();
    const delivery = await status(subtask, { category: 'done', timestamp: 1000 });
    assert.equal((JSON.parse(delivery.rawBody) as { timestamp: number }).timestamp, 1000);
  });

  it('produces the deleted event and removes the issue', async () => {
    const { subtask } = await hierarchy();
    const delivery = (await control(`/__sim/issues/${subtask}/delete`)).json as unknown as SimWebhookDelivery;
    assert.equal((JSON.parse(delivery.rawBody) as { webhookEvent: string }).webhookEvent, 'jira:issue_deleted');
    assert.equal(
      verifyJiraSignature(Buffer.from(delivery.rawBody), delivery.headers['x-hub-signature'], sim.webhookSecret),
      true,
    );
    assert.equal((await api('GET', `/rest/api/3/issue/${subtask}`)).status, 404);
  });

  it('edits an issue: a signed updated event, a moved key that its children follow and that the old key still finds', async () => {
    const { epic, story, subtask } = await hierarchy();
    const delivery = (await control(`/__sim/issues/${epic}/edit`, { key: 'TECHEA-900', summary: 'Renamed' }))
      .json as unknown as SimWebhookDelivery;
    const event = JSON.parse(delivery.rawBody) as { webhookEvent: string; issue: { key: string; fields: any } };
    assert.equal(event.webhookEvent, 'jira:issue_updated');
    assert.deepEqual([event.issue.key, event.issue.fields.summary], ['TECHEA-900', 'Renamed']);
    assert.equal(
      verifyJiraSignature(Buffer.from(delivery.rawBody), delivery.headers['x-hub-signature'], sim.webhookSecret),
      true,
    );
    assert.equal((await api('GET', `/rest/api/3/issue/${story}`)).json['fields'].parent.key, 'TECHEA-900');
    const byOldKey = await api('POST', '/rest/api/3/search/jql', { jql: `key in (${epic})` });
    assert.deepEqual(
      (byOldKey.json['issues'] as { key: string }[]).map((i) => i.key),
      ['TECHEA-900'],
    );
    // A subtask can be moved under another story too.
    await control(`/__sim/issues/${subtask}/edit`, { parentKey: 'TECHEA-900' });
    assert.equal((await api('GET', `/rest/api/3/issue/${subtask}`)).json['fields'].parent.key, 'TECHEA-900');
    assert.equal((await control('/__sim/issues/TECHEA-99/edit', { summary: 'x' })).status, 404);
  });
});

describe('the Jira client against the simulator', () => {
  const client = (overrides = {}) => createJiraClient(sim.jiraConfig(), {}, overrides);

  it('creates the Epic, Story and Subtask, reads them back and searches them', async () => {
    const c = client();
    const epic = await c.createIssue({ level: 'EPIC', summary: 'Login', screen });
    const story = await c.createIssue({ level: 'STANDARD', summary: 'Story', screen, parentKey: epic.key });
    const subtask = await c.createIssue({
      level: 'SUBTASK',
      summary: 'Task',
      description: 'Context',
      screen,
      parentKey: story.key,
    });
    const issue = await c.getIssue(subtask.key);
    assert.deepEqual(
      [issue.hierarchyLevel, issue.statusCategory, issue.status, issue.parent?.key],
      ['SUBTASK', 'TO_DO', 'To Do', story.key],
    );
    await control(`/__sim/issues/${subtask.key}/status`, { category: 'done' });
    assert.equal((await c.getIssue(subtask.id)).statusCategory, 'DONE');
    const page = await c.searchIssues({ jql: `project = TECHEA AND parent = ${story.key}` });
    assert.deepEqual(
      page.issues.map((i) => i.key),
      [subtask.key],
    );
    const stored = (await api('GET', `/rest/api/3/issue/${subtask.key}`)).json['fields'].description;
    assert.equal(stored.content.length, 2, 'the ADF carries the text and the screen reference');
  });

  it('reports a rejection of its credentials as a configuration error', async () => {
    const c = createJiraClient({ ...sim.jiraConfig(), apiToken: 'wrong' });
    await assert.rejects(c.getIssue('TECHEA-1'), { name: 'JiraConfigurationError', reason: 'AUTH_REJECTED' });
  });

  it('a hierarchy error is a request error that does not count as an outage', async () => {
    const c = client();
    await assert.rejects(
      c.createIssue({ level: 'SUBTASK', summary: 'x', screen, parentKey: 'TECHEA-77' }),
      JiraRequestError,
    );
    assert.equal(c.status().state, 'closed');
  });

  it('a partial failure leaves the Epic created and the client can finish after a retry', async () => {
    const c = client();
    await control('/__sim/fail-after-create', { level: 'EPIC' });
    const epic = await c.createIssue({ level: 'EPIC', summary: 'Login', screen });
    await assert.rejects(
      c.createIssue({ level: 'STANDARD', summary: 'S', screen, parentKey: epic.key }),
      JiraUnavailableError,
    );
    const state = (await api('GET', '/__sim/state', undefined, null)).json['calls'] as {
      method: string;
      status: number;
    }[];
    assert.equal(state.filter((x) => x.method === 'POST').length, 2, 'the failed creation was not retried');
    const story = await c.createIssue({ level: 'STANDARD', summary: 'S', screen, parentKey: epic.key });
    assert.equal(story.key, 'TECHEA-2');
  });

  it('retries a read through injected 5xx and honours Retry-After on 429', async () => {
    const c = client({ backoffBaseMs: 1 });
    const epic = await c.createIssue({ level: 'EPIC', summary: 'Login', screen });
    await control('/__sim/faults', { kind: '503', count: 2, appliesTo: 'read' });
    assert.equal((await c.getIssue(epic.key)).key, epic.key);
    await control('/__sim/faults', { kind: '429', retryAfterSeconds: 0 });
    assert.equal((await c.getIssue(epic.key)).key, epic.key);
    const reads = ((await api('GET', '/__sim/state', undefined, null)).json['calls'] as { method: string }[]).filter(
      (x) => x.method === 'GET',
    );
    assert.equal(reads.length, 3 + 2);
  });

  it('times out against a simulator that never answers (injected limit of 50 ms, no race: it never responds)', async () => {
    const c = client({ timeoutMs: 50, maxReadRetries: 0 });
    await control('/__sim/faults', { kind: 'timeout', count: 2 });
    await assert.rejects(c.getIssue('TECHEA-1'), { name: 'JiraUnavailableError', reason: 'TIMEOUT' });
    await assert.rejects(c.createIssue({ level: 'EPIC', summary: 'x', screen }), { reason: 'TIMEOUT' });
    assert.equal((await control('/__sim/reset')).status, 200);
  });

  it('opens its circuit after 5 failed creations against the simulator, and calls stop reaching it', async () => {
    const c = client();
    await control('/__sim/faults', { kind: '500', count: 100 });
    for (let i = 0; i < 5; i++)
      await assert.rejects(c.createIssue({ level: 'EPIC', summary: 'x', screen }), JiraUnavailableError);
    assert.equal(c.jiraAvailable, false);
    await assert.rejects(c.createIssue({ level: 'EPIC', summary: 'x', screen }), { name: 'JiraCircuitOpenError' });
    const posts = ((await api('GET', '/__sim/state', undefined, null)).json['calls'] as unknown[]).length;
    assert.equal(posts, 5);
  });
});
