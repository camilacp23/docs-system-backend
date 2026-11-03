/**
 * Jira client (SRS 3.9, SDD Table 60, D-45, D-89): timeout, retries only for reads, backoff, Retry-After, circuit
 * breaker, mapping and the HTTPS restriction. Timers are simulated (`mock.timers`): no real waits.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  createJiraClient,
  JiraCircuitOpenError,
  JiraConfigurationError,
  JiraNotConfiguredError,
  JiraProtocolError,
  JiraRequestError,
  JiraUnavailableError,
  JiraValidationError,
  keysJql,
  missingJiraSettings,
  type JiraClient,
} from '../../src/integrations/jira/index.js';
import type { JiraConfig } from '../../src/config/env.js';

const FULL: JiraConfig = {
  baseUrl: 'https://site.atlassian.net',
  email: 'tech.account@example.org',
  apiToken: 'TOKEN-SECRET-123',
  projectKey: 'TECHEA',
  issueTypeEpicId: '10000',
  issueTypeStoryId: '10001',
  issueTypeSubtaskId: '10002',
  webhookSecret: 'WEBHOOK-SECRET-456',
};

type Reply = {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  hang?: boolean;
  reject?: boolean;
};
type Call = { url: string; init: RequestInit; at: number };

/** A `fetch` that answers from a script (the last reply repeats) and records every call with the simulated time. */
function scripted(replies: Reply[]): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input instanceof Request ? input.url : input.toString(), init: init ?? {}, at: Date.now() });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)] ?? {};
    if (r.hang === true) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    if (r.reject === true) return Promise.reject(new TypeError('fetch failed'));
    const text = r.text ?? (r.json === undefined ? '' : JSON.stringify(r.json));
    return Promise.resolve(new Response(text === '' ? null : text, { status: r.status ?? 200, headers: r.headers }));
  }) as typeof fetch;
  return { fn, calls };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Advances the simulated time until the promise settles, then returns it (so a rejection propagates). */
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 100 && !done; i++) {
    await flush();
    if (!done) mock.timers.runAll();
  }
  await flush();
  return p;
}

const rawIssue = (key = 'TECHEA-3'): unknown => ({
  id: '10003',
  key,
  fields: {
    summary: 'Validar el correo',
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    issuetype: { name: 'Subtask', hierarchyLevel: -1 },
    parent: { id: '10002', key: 'TECHEA-2' },
  },
});

const screen = { screenId: 7, screenName: 'Login', applicationName: 'SAR' };
const subtask = { level: 'SUBTASK', summary: 'Do it', screen, parentKey: 'TECHEA-2' } as const;
const make = (fetchFn: typeof fetch, jira: JiraConfig = FULL, overrides = {}): JiraClient =>
  createJiraClient(jira, { fetch: fetchFn }, overrides);

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 }));
afterEach(() => mock.timers.reset());

describe('requests', () => {
  it('uses Basic auth with email:token in base64, JSON, and no redirects', async () => {
    const { fn, calls } = scripted([{ json: rawIssue() }]);
    await drive(make(fn).getIssue('TECHEA-3'));
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(
      headers['Authorization'],
      `Basic ${Buffer.from('tech.account@example.org:TOKEN-SECRET-123').toString('base64')}`,
    );
    assert.equal(headers['Accept'], 'application/json');
    assert.equal(calls[0]?.init.redirect, 'manual');
  });

  it('creates with project, issuetype by id, summary, ADF description and parent', async () => {
    const { fn, calls } = scripted([{ status: 201, json: { id: '10005', key: 'TECHEA-5', self: 'https://x/10005' } }]);
    const created = await drive(make(fn).createIssue({ ...subtask, description: 'Context line' }));
    assert.deepEqual(created, { id: '10005', key: 'TECHEA-5', self: 'https://x/10005' });
    assert.equal(calls[0]?.url, 'https://site.atlassian.net/rest/api/3/issue');
    assert.equal(calls[0]?.init.method, 'POST');
    const body = JSON.parse(calls[0]?.init.body as string) as { fields: Record<string, unknown> };
    assert.deepEqual(body.fields['project'], { key: 'TECHEA' });
    assert.deepEqual(body.fields['issuetype'], { id: '10002' });
    assert.deepEqual(body.fields['parent'], { key: 'TECHEA-2' });
    assert.equal(body.fields['summary'], 'Do it');
    const adf = body.fields['description'] as { type: string; version: number; content: unknown[] };
    assert.equal(adf.type, 'doc');
    assert.equal(adf.version, 1);
    assert.equal(adf.content.length, 2);
  });

  it('picks the issue type id of each level, and an Epic has no parent', async () => {
    const { fn, calls } = scripted([{ status: 201, json: { id: '1', key: 'TECHEA-1', self: '' } }]);
    const client = make(fn);
    await drive(client.createIssue({ level: 'EPIC', summary: 'Login', screen }));
    await drive(client.createIssue({ level: 'STANDARD', summary: 'Story', screen, parentKey: 'TECHEA-1' }));
    const types = calls.map(
      (c) => (JSON.parse(c.init.body as string) as { fields: { issuetype: { id: string } } }).fields.issuetype.id,
    );
    assert.deepEqual(types, ['10000', '10001']);
    const first = JSON.parse(calls[0]?.init.body as string) as { fields: Record<string, unknown> };
    assert.equal('parent' in first.fields, false);
  });

  it('reads with the issue endpoint and searches with search/jql, never the retired /search', async () => {
    const { fn, calls } = scripted([{ json: rawIssue() }, { json: { issues: [rawIssue()] } }]);
    const client = make(fn);
    await drive(client.getIssue('TECHEA-3'));
    await drive(client.searchIssues({ jql: keysJql(['TECHEA-3']) }));
    assert.equal(calls[0]?.url.startsWith('https://site.atlassian.net/rest/api/3/issue/TECHEA-3?'), true);
    assert.equal(calls[0]?.init.method, 'GET');
    assert.equal(calls[1]?.url, 'https://site.atlassian.net/rest/api/3/search/jql');
    assert.equal(calls[1]?.init.method, 'POST');
    assert.ok(calls.every((c) => !/\/rest\/api\/3\/search(\?|$)/.test(c.url)));
  });

  it('creates in the project given with the call, which replaces the configured one (D-91)', async () => {
    const { fn, calls } = scripted([{ status: 201, json: { id: '1', key: 'OTHER-1', self: '' } }]);
    await drive(make(fn).createIssue({ ...subtask, projectKey: 'OTHER' }));
    const body = JSON.parse(calls[0]?.init.body as string) as { fields: { project: unknown } };
    assert.deepEqual(body.fields.project, { key: 'OTHER' });
  });

  it('refuses invalid input before calling Jira', async () => {
    const { fn, calls } = scripted([{}]);
    const client = make(fn);
    const bad = [
      client.createIssue({ ...subtask, summary: '' }),
      client.createIssue({ ...subtask, summary: 'x'.repeat(256) }),
      client.createIssue({ ...subtask, summary: 'two\nlines' }),
      client.createIssue({ level: 'SUBTASK', summary: 'No parent', screen }),
      client.createIssue({ level: 'EPIC', summary: 'Epic', screen, parentKey: 'TECHEA-1' }),
      client.createIssue({ ...subtask, parentKey: 'bad key' }),
      client.createIssue({ ...subtask, projectKey: 'bad key' }),
      client.getIssue('../admin'),
      client.searchIssues({ jql: ' ' }),
    ];
    for (const p of bad) await assert.rejects(p, JiraValidationError);
    assert.throws(() => keysJql([]), JiraValidationError);
    assert.throws(() => keysJql(['TECHEA-1) OR (project = X']), JiraValidationError);
    assert.equal(keysJql(['TECHEA-1', 'TECHEA-2']), 'key in (TECHEA-1, TECHEA-2)');
    assert.equal(calls.length, 0);
  });
});

describe('response mapping', () => {
  it('maps a read to the fields of SDD Table 23', async () => {
    const { fn } = scripted([{ json: rawIssue() }]);
    const issue = await drive(make(fn).getIssue('TECHEA-3'));
    assert.equal(issue.statusCategory, 'TO_DO');
    assert.equal(issue.hierarchyLevel, 'SUBTASK');
    assert.deepEqual(issue.parent, { id: '10002', key: 'TECHEA-2' });
  });

  it('returns the next page token and leaves out issues that are not modelled', async () => {
    const odd = {
      id: '9',
      key: 'TECHEA-9',
      fields: { ...(rawIssue() as { fields: object }).fields, issuetype: { name: 'X', hierarchyLevel: 2 } },
    };
    const { fn, calls } = scripted([{ json: { issues: [rawIssue('TECHEA-3'), odd], nextPageToken: 'tok' } }]);
    const page = await drive(
      make(fn).searchIssues({ jql: 'project = TECHEA', maxResults: 5000, nextPageToken: 'prev' }),
    );
    assert.deepEqual(
      page.issues.map((i) => i.key),
      ['TECHEA-3'],
    );
    assert.deepEqual(page.skipped, ['TECHEA-9']);
    assert.equal(page.nextPageToken, 'tok');
    const sent = JSON.parse(calls[0]?.init.body as string) as { maxResults: number; nextPageToken: string };
    assert.equal(sent.maxResults, 100);
    assert.equal(sent.nextPageToken, 'prev');
  });

  it('treats unmodelled data as a protocol error that does not count as a Jira failure', async () => {
    const { fn } = scripted([{ json: { id: '1', key: 'TECHEA-1', fields: { summary: 's' } } }]);
    const client = make(fn);
    for (let i = 0; i < 8; i++) await assert.rejects(drive(client.getIssue('TECHEA-1')), JiraProtocolError);
    assert.equal(client.status().state, 'closed');
  });
});

describe('timeout and retries (SDD Table 60)', () => {
  it('fails a call at exactly 10 s with TIMEOUT', async () => {
    const { fn, calls } = scripted([{ hang: true }]);
    const p = make(fn).createIssue(subtask);
    const result = p.then(
      () => 'ok',
      (e: unknown) => e,
    );
    await flush();
    mock.timers.tick(9_999);
    await flush();
    assert.equal(calls.length, 1);
    mock.timers.tick(1);
    const error = await result;
    assert.ok(error instanceof JiraUnavailableError);
    assert.equal(error.reason, 'TIMEOUT');
  });

  it('never retries a creation: network error, timeout, 500 and 429 make exactly one call', async () => {
    for (const reply of [
      { reject: true },
      { hang: true },
      { status: 500 },
      { status: 429, headers: { 'retry-after': '1' } },
    ]) {
      const { fn, calls } = scripted([reply]);
      await assert.rejects(drive(make(fn).createIssue(subtask)), JiraUnavailableError);
      assert.equal(calls.length, 1, JSON.stringify(reply));
    }
  });

  it('retries a read twice with backoff 500 ms then 1000 ms', async () => {
    const { fn, calls } = scripted([{ status: 503 }, { reject: true }, { json: rawIssue() }]);
    const issue = await drive(make(fn).getIssue('TECHEA-3'));
    assert.equal(issue.key, 'TECHEA-3');
    assert.deepEqual(
      calls.map((c) => c.at),
      [0, 500, 1_500],
    );
  });

  it('sends a search once when asked to, and that attempt still counts for the circuit breaker (D-94)', async () => {
    const { fn, calls } = scripted([{ status: 503 }]);
    const client = make(fn, FULL, { breakerFailureThreshold: 2 });
    for (let i = 0; i < 2; i++) {
      await assert.rejects(
        drive(client.searchIssues({ jql: keysJql(['TECHEA-3']), singleAttempt: true })),
        (e: unknown) => e instanceof JiraUnavailableError && e.reason === 'SERVER_ERROR',
      );
    }
    assert.equal(calls.length, 2, 'one call per search, no retries');
    assert.equal(client.status().state, 'open');
    assert.equal(client.jiraAvailable, false);
  });

  it('gives up after the third attempt of a read', async () => {
    const { fn, calls } = scripted([{ status: 500 }]);
    await assert.rejects(
      drive(make(fn).getIssue('TECHEA-3')),
      (e: unknown) => e instanceof JiraUnavailableError && e.reason === 'SERVER_ERROR',
    );
    assert.equal(calls.length, 3);
  });

  it('retries a JQL search (a read sent with POST) and a timed-out read', async () => {
    const { fn, calls } = scripted([{ hang: true }, { json: { issues: [] } }]);
    const page = await drive(make(fn).searchIssues({ jql: 'project = TECHEA' }));
    assert.equal(page.issues.length, 0);
    assert.deepEqual(
      calls.map((c) => c.at),
      [0, 10_500],
    );
  });

  it('waits for Retry-After (seconds, or an HTTP date) before retrying a read on 429', async () => {
    const date = new Date(4_000).toUTCString().replace(/:\d\d /, ':04 '); // HTTP dates have whole seconds
    for (const [value, expected] of [
      ['3', 3_000],
      [date, 4_000],
    ] as const) {
      mock.timers.reset();
      mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      const { fn, calls } = scripted([{ status: 429, headers: { 'retry-after': value } }, { json: rawIssue() }]);
      await drive(make(fn).getIssue('TECHEA-3'));
      assert.deepEqual(
        calls.map((c) => c.at),
        [0, expected],
        value,
      );
    }
  });

  it('does not wait when Retry-After is longer than 10 s: it fails with RATE_LIMITED at once', async () => {
    const { fn, calls } = scripted([{ status: 429, headers: { 'retry-after': '11' } }, { json: rawIssue() }]);
    await assert.rejects(
      drive(make(fn).getIssue('TECHEA-3')),
      (e: unknown) => e instanceof JiraUnavailableError && e.reason === 'RATE_LIMITED',
    );
    assert.equal(calls.length, 1);
    assert.equal(Date.now(), 0);
  });

  it('falls back to the backoff when a 429 has no Retry-After', async () => {
    const { fn, calls } = scripted([{ status: 429 }, { json: rawIssue() }]);
    await drive(make(fn).getIssue('TECHEA-3'));
    assert.deepEqual(
      calls.map((c) => c.at),
      [0, 500],
    );
  });

  it('does not retry what Jira answered: 400 and 404 are request errors, 401 and 403 configuration errors', async () => {
    const cases: [number, (e: unknown) => boolean][] = [
      [400, (e) => e instanceof JiraRequestError && e.status === 400],
      [404, (e) => e instanceof JiraRequestError && e.reason === 'NOT_FOUND'],
      [401, (e) => e instanceof JiraConfigurationError && e.reason === 'AUTH_REJECTED'],
      [403, (e) => e instanceof JiraConfigurationError && e.reason === 'FORBIDDEN'],
    ];
    for (const [status, check] of cases) {
      const { fn, calls } = scripted([{ status, json: { errorMessages: ['Issue does not exist'], errors: {} } }]);
      await assert.rejects(drive(make(fn).getIssue('TECHEA-3')), check, String(status));
      assert.equal(calls.length, 1, String(status));
    }
  });

  it('keeps the messages Jira sent on a request error', async () => {
    const { fn } = scripted([{ status: 400, json: { errorMessages: ['A'], errors: { summary: 'B' } } }]);
    await assert.rejects(
      drive(make(fn).createIssue(subtask)),
      (e: unknown) => e instanceof JiraRequestError && e.jiraMessages.join() === 'A,B',
    );
  });

  it('treats a redirect as a failure and never follows it', async () => {
    const { fn, calls } = scripted([{ status: 302, headers: { location: 'http://evil.example/' } }]);
    await assert.rejects(
      drive(make(fn).createIssue(subtask)),
      (e: unknown) => e instanceof JiraUnavailableError && e.reason === 'REDIRECT',
    );
    assert.equal(calls.length, 1);
  });

  it('treats a 2xx that is not JSON as BAD_RESPONSE', async () => {
    const { fn } = scripted([{ status: 200, text: '<html>login</html>' }]);
    await assert.rejects(
      drive(make(fn).createIssue(subtask)),
      (e: unknown) => e instanceof JiraUnavailableError && e.reason === 'BAD_RESPONSE',
    );
  });

  it('uses the thresholds it is given', async () => {
    const { fn, calls } = scripted([{ status: 500 }]);
    await assert.rejects(drive(make(fn, FULL, { maxReadRetries: 1, backoffBaseMs: 10 }).getIssue('TECHEA-3')));
    assert.deepEqual(
      calls.map((c) => c.at),
      [0, 10],
    );
  });
});

describe('circuit breaker (5 failures, 60 s, one trial call)', () => {
  const failCreate = (client: JiraClient): Promise<unknown> =>
    drive(client.createIssue(subtask)).catch((e: unknown) => e);

  it('opens after 5 consecutive failures and then fails at once without calling Jira', async () => {
    const { fn, calls } = scripted([{ status: 500 }]);
    const client = make(fn);
    for (let i = 0; i < 4; i++) await failCreate(client);
    assert.equal(client.jiraAvailable, true);
    await failCreate(client);
    assert.equal(client.jiraAvailable, false);
    assert.equal(client.status().state, 'open');
    assert.equal(client.status().lastFailure, 'SERVER_ERROR');
    const before = calls.length;
    await assert.rejects(drive(client.getIssue('TECHEA-3')), JiraCircuitOpenError);
    await assert.rejects(drive(client.createIssue(subtask)), JiraCircuitOpenError);
    assert.equal(calls.length, before);
  });

  it('counts a success, and an answer from Jira, as breaking the streak', async () => {
    const { fn } = scripted([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 404 },
      { status: 500 },
    ]);
    const client = make(fn);
    for (let i = 0; i < 4; i++) await failCreate(client);
    await failCreate(client); // 404: Jira answered
    await failCreate(client); // first failure of a new streak
    assert.equal(client.status().state, 'closed');
  });

  it('counts timeouts, 429 and 401 as failures too', async () => {
    for (const reply of [{ hang: true }, { status: 429 }, { status: 401 }, { reject: true }]) {
      mock.timers.reset();
      mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      const client = make(scripted([reply]).fn);
      for (let i = 0; i < 5; i++) await failCreate(client);
      assert.equal(client.status().state, 'open', JSON.stringify(reply));
    }
  });

  it('stays open for 60 s, then lets exactly one trial call through, with a single attempt', async () => {
    const { fn, calls } = scripted([{ status: 500 }]);
    const client = make(fn);
    for (let i = 0; i < 5; i++) await failCreate(client);
    mock.timers.tick(59_999);
    assert.equal(client.status().state, 'open');
    mock.timers.tick(1);
    assert.equal(client.status().state, 'half-open');
    assert.equal(client.jiraAvailable, true);
    const before = calls.length;
    // The trial is a read, which would normally have 3 attempts: here it has one.
    await assert.rejects(drive(client.getIssue('TECHEA-3')), JiraUnavailableError);
    assert.equal(calls.length - before, 1);
    assert.equal(client.status().state, 'open', 'a failed trial opens it again for 60 s');
    mock.timers.tick(59_999);
    assert.equal(client.status().state, 'open');
  });

  it('closes after a successful trial (a read or a creation) and reads retry again afterwards', async () => {
    for (const trial of ['read', 'create'] as const) {
      mock.timers.reset();
      mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
      const replies: Reply[] = [
        ...Array.from({ length: 5 }, () => ({ status: 500 })),
        trial === 'read' ? { json: rawIssue() } : { status: 201, json: { id: '1', key: 'TECHEA-1', self: '' } },
        { status: 500 },
        { json: rawIssue() },
      ];
      const { fn, calls } = scripted(replies);
      const client = make(fn);
      for (let i = 0; i < 5; i++) await failCreate(client);
      mock.timers.tick(60_000);
      await drive<unknown>(trial === 'read' ? client.getIssue('TECHEA-3') : client.createIssue(subtask));
      assert.equal(client.status().state, 'closed', trial);
      assert.equal(client.status().lastFailure, null);
      await drive(client.getIssue('TECHEA-3')); // fails once, retried, succeeds: retries are back
      assert.equal(calls.length, 8, trial);
    }
  });

  it('lets only one trial call through while it is in flight', async () => {
    const { fn, calls } = scripted([...Array.from({ length: 5 }, () => ({ status: 500 })), { hang: true }]);
    const client = make(fn);
    for (let i = 0; i < 5; i++) await failCreate(client);
    mock.timers.tick(60_000);
    const trial = client.getIssue('TECHEA-3').catch((e: unknown) => e);
    await flush();
    assert.equal(calls.length, 6);
    await assert.rejects(client.getIssue('TECHEA-4'), JiraCircuitOpenError);
    assert.equal(calls.length, 6);
    mock.timers.tick(10_000);
    assert.ok((await trial) instanceof JiraUnavailableError);
  });
});

describe('configuration (D-89)', () => {
  it('without variables it makes no call and reports itself unavailable', async () => {
    const { fn, calls } = scripted([{ json: rawIssue() }]);
    const client = make(fn, {});
    assert.equal(client.jiraAvailable, false);
    assert.deepEqual(client.status(), { configured: false, state: 'closed', lastFailure: null });
    await assert.rejects(client.getIssue('TECHEA-3'), JiraNotConfiguredError);
    await assert.rejects(client.createIssue(subtask), JiraNotConfiguredError);
    await assert.rejects(client.searchIssues({ jql: 'project = TECHEA' }), JiraNotConfiguredError);
    assert.equal(calls.length, 0);
  });

  it('reads work without the project and issue types; creation names what is missing, never a value', async () => {
    const { fn } = scripted([{ json: rawIssue() }]);
    const { projectKey: _p, issueTypeEpicId: _e, ...reads } = FULL;
    const client = make(fn, reads);
    assert.equal(client.jiraAvailable, true);
    await drive(client.getIssue('TECHEA-3'));
    await assert.rejects(client.createIssue(subtask), (e: unknown) => {
      assert.ok(e instanceof JiraNotConfiguredError);
      assert.deepEqual(e.missing, ['JIRA_PROJECT_KEY', 'JIRA_ISSUETYPE_EPIC_ID']);
      assert.doesNotMatch(e.message, /TOKEN-SECRET|atlassian/);
      return true;
    });
  });

  it('creation does not need JIRA_PROJECT_KEY when the call brings the project', async () => {
    const { fn } = scripted([{ status: 201, json: { id: '1', key: 'OTHER-1', self: '' } }]);
    const { projectKey: _p, ...noProject } = FULL;
    const client = make(fn, noProject);
    await assert.rejects(client.createIssue(subtask), (e: unknown) => {
      assert.ok(e instanceof JiraNotConfiguredError);
      assert.deepEqual(e.missing, ['JIRA_PROJECT_KEY']);
      return true;
    });
    const created = await drive(client.createIssue({ ...subtask, projectKey: 'OTHER' }));
    assert.equal(created.key, 'OTHER-1');
  });

  it('lists the missing variables by name', () => {
    assert.deepEqual(missingJiraSettings({}).length, 8);
    assert.deepEqual(missingJiraSettings(FULL), []);
    assert.deepEqual(missingJiraSettings({ ...FULL, webhookSecret: undefined }), ['JIRA_WEBHOOK_SECRET']);
  });
});

describe('base URL restriction (NFR-04)', () => {
  const create = (baseUrl: string, production = false): JiraClient =>
    createJiraClient({ ...FULL, baseUrl }, { fetch: scripted([{}]).fn }, { production });

  it('accepts https and, outside production, http for localhost and 127.0.0.1', () => {
    for (const url of ['https://site.atlassian.net', 'http://localhost:3002', 'http://127.0.0.1:3002']) {
      assert.doesNotThrow(() => create(url), url);
    }
  });

  it('rejects other http hosts, and any http in production', () => {
    for (const url of [
      'http://site.atlassian.net',
      'http://localhost.evil.example',
      'https://u:p@site.atlassian.net',
    ]) {
      assert.throws(() => create(url), /Jira base URL/, url);
    }
    assert.throws(() => create('http://localhost:3002', true), /production/);
  });

  it('does not put the URL in the error message', () => {
    assert.throws(
      () => create('http://secret-host.example'),
      (e: Error) => !/secret-host/.test(e.message),
    );
  });
});
