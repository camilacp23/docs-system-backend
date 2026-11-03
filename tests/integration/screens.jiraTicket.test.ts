/**
 * Module 4, POST /screens/{id}/jira-ticket (FR-12; SDD Table 50 and Figure 24; D-06, D-15, D-31, D-45, D-90 to D-94)
 * against the in-process Jira simulator, never the real Jira: the three happy paths, the order of the errors, every
 * 502 case, partial failures with retries that do not duplicate, that a creation is never retried, the provisional
 * and the real state of the issues, the audit trail and the roles. No fixed waits: the only real time is the short
 * timeout the client is given where a timeout is the subject.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { bodyOf, type TestApp } from '../helpers/app.js';
import { createApplication } from '../helpers/applications.js';
import { insertApplication, insertScreen, setApplicationStatus } from '../helpers/fixtures.js';
import { startJiraApp, type JiraApp } from '../helpers/jiraApp.js';
import { detailsOf } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

type Ticket = {
  id: number;
  jiraIssueKey: string;
  hierarchyLevel: string;
  issueType: string;
  summary: string;
  status: string;
  statusCategory: string;
  url: string;
  lastSyncedAt: string;
};
type Created = { epic: Ticket; story: Ticket; subtask: Ticket; created: string[] };
const createdOf = (res: { body: unknown }): Created => (res.body as { data: Created }).data;

const newBody = (n = 1) => ({
  newStory: { summary: `Story ${n}` },
  subtask: { summary: `Subtask ${n}`, description: 'First line\nSecond line' },
});

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

/** Log lines of the application as objects. */
const logLines = (t: TestApp): Record<string, unknown>[] => t.logs.map((l) => JSON.parse(l) as Record<string, unknown>);

describe('POST /screens/{id}/jira-ticket (FR-12)', () => {
  let t: JiraApp;
  /** Bodies of the creations the client sent to the simulator (D-91: the project of each one). */
  let sent: { fields: { project: { key: string }; issuetype: { id: string }; summary: string } }[] = [];
  let beforeSearch: (() => Promise<void>) | null = null;
  before(async () => {
    t = await startJiraApp({
      client: { timeoutMs: 400, breakerFailureThreshold: 1000 },
      deps: (base) => ({
        ...base,
        fetch: async (input, init) => {
          if (urlOf(input).endsWith('/rest/api/3/issue') && typeof init?.body === 'string') {
            sent.push(JSON.parse(init.body) as (typeof sent)[number]);
          }
          if (urlOf(input).endsWith('/rest/api/3/search/jql') && beforeSearch !== null) await beforeSearch();
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
    sent = [];
    beforeSearch = null;
    t.logs.length = 0;
  });

  const as = (role: 'admin' | 'developer' | 'reader') => asUser(t, t.users[role].token);
  const post = (screenId: number, body: object, role: 'admin' | 'developer' | 'reader' = 'developer') =>
    as(role).post(`/screens/${screenId}/jira-ticket`, body);
  async function arrange(status?: 'IN_REVIEW') {
    const application = await insertApplication(t);
    const screen = await insertScreen(t, application.id, status === undefined ? {} : { documentationStatus: status });
    return { application, screen };
  }
  const simLevels = async () => (await t.simState()).issues.map((i) => i.level);

  describe('happy paths', () => {
    it('first ticket of a screen: creates the Epic, a new Story under it and the Subtask under the Story', async () => {
      const { application, screen } = await arrange();
      const res = await post(screen.id, newBody());
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const data = createdOf(res);
      assert.deepEqual(data.created, ['EPIC', 'STANDARD', 'SUBTASK']);
      assert.equal(data.epic.hierarchyLevel, 'EPIC');
      assert.equal(data.story.hierarchyLevel, 'STANDARD');
      assert.equal(data.subtask.hierarchyLevel, 'SUBTASK');
      assert.equal(data.epic.summary, `${screen.name} (${application.name})`, 'D-91');
      assert.equal(data.story.summary, 'Story 1');
      assert.equal(data.subtask.summary, 'Subtask 1');
      assert.deepEqual(
        [data.epic.issueType, data.story.issueType, data.subtask.issueType],
        ['Epic', 'Story', 'Subtask'],
      );
      assert.equal(data.subtask.status, 'To Do');
      assert.equal(data.subtask.statusCategory, 'TO_DO');
      assert.equal(data.epic.url, `${t.sim.baseUrl}/browse/${data.epic.jiraIssueKey}`);
      assert.ok(!Number.isNaN(Date.parse(data.subtask.lastSyncedAt)));

      const state = await t.simState();
      assert.deepEqual(
        state.issues.map((i) => [i.level, i.parentKey]),
        [
          ['EPIC', null],
          ['STANDARD', data.epic.jiraIssueKey],
          ['SUBTASK', data.story.jiraIssueKey],
        ],
      );
      assert.equal((await t.createCalls()).length, 3);

      const rows = await t.ticketsOf(screen.id);
      assert.deepEqual(
        rows.map((r) => [r.id, r.hierarchy_level, r.jira_issue_key, r.parent_ticket_id, r.created_by]),
        [
          [data.epic.id, 'EPIC', data.epic.jiraIssueKey, null, t.users.developer.id],
          [data.story.id, 'STANDARD', data.story.jiraIssueKey, data.epic.id, t.users.developer.id],
          [data.subtask.id, 'SUBTASK', data.subtask.jiraIssueKey, data.story.id, t.users.developer.id],
        ],
      );
      assert.equal(res.headers['location'], undefined, 'the contract declares no Location for this operation');
    });

    it('second ticket with the existing Story: only the Subtask is created', async () => {
      const { screen } = await arrange();
      const first = createdOf(await post(screen.id, newBody(1)));
      const before = (await t.createCalls()).length;
      const res = await post(screen.id, { storyId: first.story.id, subtask: { summary: 'Another to do' } });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const data = createdOf(res);
      assert.deepEqual(data.created, ['SUBTASK']);
      assert.equal(data.epic.id, first.epic.id);
      assert.equal(data.story.id, first.story.id);
      assert.notEqual(data.subtask.id, first.subtask.id);
      assert.equal((await t.createCalls()).length - before, 1);
      const issues = (await t.simState()).issues;
      assert.equal(issues.length, 4);
      assert.equal(issues.find((i) => i.key === data.subtask.jiraIssueKey)?.parentKey, first.story.jiraIssueKey);
    });

    it('second ticket with a new Story: a Story and a Subtask under the existing Epic', async () => {
      const { screen } = await arrange();
      const first = createdOf(await post(screen.id, newBody(1)));
      const before = (await t.createCalls()).length;
      const res = await post(screen.id, newBody(2));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const data = createdOf(res);
      assert.deepEqual(data.created, ['STANDARD', 'SUBTASK']);
      assert.equal(data.epic.id, first.epic.id);
      assert.notEqual(data.story.id, first.story.id);
      assert.equal((await t.createCalls()).length - before, 2);
      const issues = (await t.simState()).issues;
      assert.equal(issues.filter((i) => i.level === 'EPIC').length, 1);
      assert.equal(issues.find((i) => i.key === data.story.jiraIssueKey)?.parentKey, first.epic.jiraIssueKey);
      assert.equal((await t.ticketsOf(screen.id)).length, 5);
    });

    it('accepts a screen IN_REVIEW (D-92) and the App (OnStart) screen', async () => {
      const review = await arrange('IN_REVIEW');
      assert.equal((await post(review.screen.id, newBody())).status, 201);
      const application = await insertApplication(t);
      const res = await post(application.appContextScreenId, newBody());
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.match(createdOf(res).epic.summary, new RegExp(`\\(${application.name}\\)$`));
    });

    it('uses the project of the application, or JIRA_PROJECT_KEY when it has none (D-91)', async () => {
      const { screen } = await arrange();
      assert.equal((await post(screen.id, newBody())).status, 201);
      assert.deepEqual(
        sent.map((s) => s.fields.project.key),
        ['TECHEA', 'TECHEA', 'TECHEA'],
      );
      assert.deepEqual(
        sent.map((s) => s.fields.issuetype.id),
        ['10100', '10101', '10102'],
        'the issue types are asked by the configured ids',
      );
    });

    it('a project key on the application replaces the configured one, and a 400 from Jira is JIRA_UNAVAILABLE with an error log', async () => {
      const app = await createApplication(t, t.users.admin.token, { jiraProjectKey: 'OTHER' });
      const screen = await insertScreen(t, app.application.id);
      const res = await post(screen.id, newBody());
      assert.equal(res.status, 502);
      assert.equal(bodyOf(res).code, 'JIRA_UNAVAILABLE');
      assert.equal(sent[0]?.fields.project.key, 'OTHER');
      assert.equal(sent.length, 1, 'the creation is not retried');
      const entry = logLines(t).find((l) => l['msg'] === 'Jira did not create the issue');
      assert.equal(entry?.['level'], 50, 'error');
      assert.equal(entry?.['status'], 400);
      assert.equal(entry?.['outcome'], 'not_created');
      assert.equal(entry?.['screenId'], screen.id);
      const text = t.logs.join('\n');
      assert.doesNotMatch(text, new RegExp(`${t.sim.apiToken}|${t.sim.email}|127\\.0\\.0\\.1:${t.sim.port}`));
      assert.equal((await t.ticketsOf(screen.id)).length, 0);
    });
  });

  describe('roles', () => {
    it('Administrator and Developer create tickets; Reader is refused before any Jira call', async () => {
      const { screen } = await arrange();
      assert.equal((await post(screen.id, newBody(1), 'admin')).status, 201);
      assert.equal((await post(screen.id, newBody(2), 'developer')).status, 201);
      const calls = (await t.createCalls()).length;
      const reader = await post(screen.id, newBody(3), 'reader');
      assert.equal(reader.status, 403);
      assert.equal(bodyOf(reader).code, 'FORBIDDEN');
      assert.deepEqual(bodyOf(reader).details.requiredRoles, ['ADMINISTRATOR', 'DEVELOPER']);
      assert.equal((await t.createCalls()).length, calls);
      const anonymous = await t.http.post(`/api/v1/screens/${screen.id}/jira-ticket`).send(newBody());
      assert.equal(anonymous.status, 401);
    });
  });

  describe('errors, in order: 400, 404, APPLICATION_ARCHIVED, STORY_NOT_IN_SCREEN, 502', () => {
    const noJiraCall = async (): Promise<void> => assert.equal((await t.simState()).calls.length, 0);

    it('400 from the validator: the body must have the subtask and exactly one of storyId and newStory', async () => {
      const { screen } = await arrange();
      const bad: object[] = [
        {},
        { newStory: { summary: 'S' } },
        { storyId: 1 },
        { storyId: 1, newStory: { summary: 'S' }, subtask: { summary: 'T' } },
        { subtask: { summary: 'T' } },
        { newStory: { summary: '' }, subtask: { summary: 'T' } },
        { newStory: { summary: 'S' }, subtask: { summary: 'x'.repeat(256) } },
        { storyId: 0, subtask: { summary: 'T' } },
        { newStory: { summary: 'S' }, subtask: { summary: 'T' }, extra: 1 },
      ];
      for (const body of bad) assert.equal((await post(screen.id, body)).status, 400, JSON.stringify(body));
      await noJiraCall();
    });

    it('400 for a blank summary (required), a summary with line breaks (singleLine) and one over 255 characters', async () => {
      const { screen } = await arrange();
      const blank = await post(screen.id, { storyId: 1, subtask: { summary: '   ' } });
      assert.equal(blank.status, 400);
      assert.deepEqual(bodyOf(blank).details.fields, [
        { field: 'subtask.summary', rule: 'required', message: 'This value is required.' },
      ]);
      const lines = await post(screen.id, { newStory: { summary: 'a\nb' }, subtask: { summary: 'c\r\nd' } });
      assert.equal(lines.status, 400);
      assert.equal(bodyOf(lines).code, 'VALIDATION_ERROR');
      assert.deepEqual(bodyOf(lines).details.fields, [
        { field: 'newStory.summary', rule: 'singleLine', message: 'Summary must be a single line.' },
        { field: 'subtask.summary', rule: 'singleLine', message: 'Summary must be a single line.' },
      ]);
      const onlyBreaks = await post(screen.id, { storyId: 1, subtask: { summary: '\n' } });
      assert.equal(bodyOf(onlyBreaks).details.fields[0]?.rule, 'required');
      // 150 emoji are 150 characters for the validator and 300 for Jira.
      const long = await post(screen.id, { storyId: 1, subtask: { summary: '😀'.repeat(150) } });
      assert.equal(long.status, 400);
      assert.equal(bodyOf(long).details.fields[0]?.field, 'subtask.summary');
      assert.equal(bodyOf(long).details.fields[0]?.rule, 'maxLength');
      await noJiraCall();
    });

    it('400 comes before 404, and 404 before everything else', async () => {
      assert.equal((await post(999_999, { subtask: { summary: 'T' } })).status, 400);
      const missing = await post(999_999, newBody());
      assert.equal(missing.status, 404);
      assert.equal(bodyOf(missing).code, 'NOT_FOUND');
      assert.equal(bodyOf(missing).details.element, 'screen');
      assert.equal((await post(3_000_000_000, newBody())).status, 404, 'an id beyond integer is a 404');
      assert.equal((await post(Number.MAX_SAFE_INTEGER, newBody())).status, 404);
      await noJiraCall();
    });

    it('422 APPLICATION_ARCHIVED for every role, before STORY_NOT_IN_SCREEN and before Jira', async () => {
      const { application, screen } = await arrange();
      await setApplicationStatus(t, application.id, 'ARCHIVED');
      for (const role of ['admin', 'developer'] as const) {
        const res = await post(screen.id, { storyId: 424242, subtask: { summary: 'T' } }, role);
        assert.equal(res.status, 422, role);
        assert.equal(bodyOf(res).code, 'APPLICATION_ARCHIVED');
        assert.equal(detailsOf(res)['applicationId'], application.id);
      }
      await noJiraCall();
    });

    it('422 STORY_NOT_IN_SCREEN: unknown id, id beyond integer, Story of another screen, an Epic and a Subtask', async () => {
      const { screen } = await arrange();
      const other = await arrange();
      const mine = createdOf(await post(screen.id, newBody(1)));
      const theirs = createdOf(await post(other.screen.id, newBody(2)));
      const calls = (await t.createCalls()).length;
      const cases: [string, number][] = [
        ['unknown id', 987_654],
        ['id beyond integer', 3_000_000_000],
        ['Story of another screen', theirs.story.id],
        ['Epic of this screen', mine.epic.id],
        ['Subtask of this screen', mine.subtask.id],
        ['Epic of another screen', theirs.epic.id],
      ];
      for (const [name, storyId] of cases) {
        const res = await post(screen.id, { storyId, subtask: { summary: 'T' } });
        assert.equal(res.status, 422, name);
        assert.equal(bodyOf(res).code, 'STORY_NOT_IN_SCREEN', name);
        assert.equal(bodyOf(res).message, "That story doesn't belong to this screen. Refresh the list and pick again.");
        assert.deepEqual(bodyOf(res).details, { storyId }, name);
      }
      assert.equal((await t.createCalls()).length, calls, 'nothing is created in Jira');
      assert.equal((await t.ticketsOf(screen.id)).length, 3);
    });
  });

  describe('JIRA_UNAVAILABLE: nothing was created', () => {
    const MESSAGE = "Jira isn't responding. The to-do wasn't created. Try again in a few minutes.";

    it('5xx on the first creation: one attempt, nothing saved, and the next request works', async () => {
      const { screen } = await arrange();
      await t.control('/__sim/faults', { kind: '500', appliesTo: 'create', count: 3 });
      const res = await post(screen.id, newBody());
      assert.equal(res.status, 502);
      assert.equal(bodyOf(res).code, 'JIRA_UNAVAILABLE');
      assert.equal(bodyOf(res).message, MESSAGE);
      assert.equal(bodyOf(res).details, null);
      assert.equal((await t.createCalls()).length, 1, 'a creation is never retried (Table 60)');
      assert.equal((await t.simState()).issues.length, 0);
      assert.equal((await t.ticketsOf(screen.id)).length, 0);
      const entry = logLines(t).find((l) => l['msg'] === 'Jira did not create the issue');
      assert.equal(entry?.['outcome'], 'unknown', 'a 5xx may have come after the creation');
    });

    it('timeout: nothing saved, one attempt, logged with outcome unknown, the screen and the parent key', async () => {
      const { screen } = await arrange();
      const first = createdOf(await post(screen.id, newBody(1)));
      await t.control('/__sim/faults', { kind: 'timeout', appliesTo: 'create', count: 1 });
      const before = (await t.createCalls()).length;
      const res = await post(screen.id, { storyId: first.story.id, subtask: { summary: 'Slow one' } });
      assert.equal(res.status, 502);
      assert.equal(bodyOf(res).code, 'JIRA_UNAVAILABLE');
      assert.equal((await t.createCalls()).length - before, 1);
      assert.equal((await t.ticketsOf(screen.id)).length, 3, 'a Subtask of an existing Story: nothing new was created');
      const entry = logLines(t).find((l) => l['msg'] === 'Jira did not create the issue');
      assert.equal(entry?.['level'], 50);
      assert.equal(entry?.['outcome'], 'unknown');
      assert.equal(entry?.['reason'], 'TIMEOUT');
      assert.equal(entry?.['screenId'], screen.id);
      assert.equal(entry?.['parentKey'], first.story.jiraIssueKey);
      assert.equal((await post(screen.id, { storyId: first.story.id, subtask: { summary: 'Fast one' } })).status, 201);
    });

    it('a Subtask that fails under an existing Story is JIRA_UNAVAILABLE, not a partial failure', async () => {
      const { screen } = await arrange();
      const first = createdOf(await post(screen.id, newBody(1)));
      await t.control('/__sim/faults', { kind: '503', appliesTo: 'create', count: 1 });
      const res = await post(screen.id, { storyId: first.story.id, subtask: { summary: 'T' } });
      assert.equal(res.status, 502);
      assert.equal(bodyOf(res).code, 'JIRA_UNAVAILABLE');
    });

    it('401 and 429 from Jira are JIRA_UNAVAILABLE too, and the credentials never reach the log', async () => {
      const { screen } = await arrange();
      for (const kind of ['401', '429'] as const) {
        await t.control('/__sim/faults', { kind, appliesTo: 'create', count: 1 });
        const res = await post(screen.id, newBody());
        assert.equal(res.status, 502, kind);
        assert.equal(bodyOf(res).code, 'JIRA_UNAVAILABLE', kind);
      }
      assert.doesNotMatch(t.logs.join('\n'), new RegExp(`${t.sim.apiToken}|${t.sim.email}`));
    });
  });

  describe('JIRA_PARTIAL_FAILURE: a retry never duplicates', () => {
    it('Epic created, Story failed: the epic-only message, the Epic is saved, and the retry reuses it', async () => {
      const { screen } = await arrange();
      await t.control('/__sim/fail-after-create', { level: 'EPIC', count: 1 });
      const res = await post(screen.id, newBody());
      assert.equal(res.status, 502);
      assert.equal(bodyOf(res).code, 'JIRA_PARTIAL_FAILURE');
      assert.equal(
        bodyOf(res).message,
        "The epic TECHEA-1 was created, but the story and the to-do weren't. Try again to add them to that epic.",
      );
      assert.deepEqual(bodyOf(res).details, { key: 'TECHEA-1', created: { epic: 'TECHEA-1' } });
      const rows = await t.ticketsOf(screen.id);
      assert.deepEqual(
        rows.map((r) => [r.hierarchy_level, r.jira_issue_key]),
        [['EPIC', 'TECHEA-1']],
      );
      assert.equal((await t.createCalls()).length, 2, 'the Story creation was tried once and not retried');

      const retry = await post(screen.id, newBody());
      assert.equal(retry.status, 201, JSON.stringify(retry.body));
      assert.deepEqual(createdOf(retry).created, ['STANDARD', 'SUBTASK']);
      assert.equal(createdOf(retry).epic.id, rows[0]!.id);
      const levels = await simLevels();
      assert.equal(levels.filter((l) => l === 'EPIC').length, 1, 'the Epic was not created again');
      assert.equal(levels.length, 3);
    });

    it('Epic and Story created, Subtask failed: details list them with the local id of the Story; retrying with storyId does not duplicate', async () => {
      const { screen } = await arrange();
      await t.control('/__sim/fail-after-create', { level: 'STANDARD', count: 1 });
      const res = await post(screen.id, newBody());
      assert.equal(res.status, 502);
      assert.equal(bodyOf(res).code, 'JIRA_PARTIAL_FAILURE');
      assert.equal(
        bodyOf(res).message,
        "The story TECHEA-2 was created, but the to-do wasn't. Try again to add it to that story.",
      );
      const rows = await t.ticketsOf(screen.id);
      const story = rows.find((r) => r.hierarchy_level === 'STANDARD')!;
      assert.deepEqual(bodyOf(res).details, {
        key: 'TECHEA-2',
        created: { epic: 'TECHEA-1', story: 'TECHEA-2' },
        storyId: story.id,
      });
      assert.equal(rows.length, 2);

      const retry = await post(screen.id, { storyId: story.id, subtask: { summary: 'Subtask 1' } });
      assert.equal(retry.status, 201, JSON.stringify(retry.body));
      assert.deepEqual(createdOf(retry).created, ['SUBTASK']);
      assert.equal(createdOf(retry).story.id, story.id);
      assert.deepEqual(await simLevels(), ['EPIC', 'STANDARD', 'SUBTASK']);
      assert.equal((await t.ticketsOf(screen.id)).length, 3);
    });

    it('a Story created under an existing Epic and a failed Subtask: the Epic is not listed as created', async () => {
      const { screen } = await arrange();
      createdOf(await post(screen.id, newBody(1)));
      await t.control('/__sim/fail-after-create', { level: 'STANDARD', count: 1 });
      const res = await post(screen.id, newBody(2));
      assert.equal(res.status, 502);
      assert.equal(bodyOf(res).code, 'JIRA_PARTIAL_FAILURE');
      const details = detailsOf(res);
      assert.deepEqual(details['created'], { story: details['key'] });
      assert.equal(typeof details['storyId'], 'number');
    });
  });

  describe('state of the created issues (D-90)', () => {
    it('stores provisional values on creation and replaces them with what Jira reports in one final search', async () => {
      const { screen } = await arrange();
      let storedWhenSearching: Awaited<ReturnType<JiraApp['ticketsOf']>> = [];
      // Runs when the final search is about to leave: the issues are saved already, and Jira moves the Subtask.
      beforeSearch = async () => {
        storedWhenSearching = await t.ticketsOf(screen.id);
        const subtask = (await t.simState()).issues.find((i) => i.level === 'SUBTASK')!;
        await t.control(`/__sim/issues/${subtask.key}/status`, { status: 'In Progress' });
      };
      const res = await post(screen.id, newBody());
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.deepEqual(
        storedWhenSearching.map((r) => [r.hierarchy_level, r.issue_type, r.status, r.status_category]),
        [
          ['EPIC', 'Epic', 'To Do', 'TO_DO'],
          ['STANDARD', 'Story', 'To Do', 'TO_DO'],
          ['SUBTASK', 'Subtask', 'To Do', 'TO_DO'],
        ],
        'the provisional values were already stored',
      );
      const data = createdOf(res);
      assert.deepEqual([data.subtask.status, data.subtask.statusCategory], ['In Progress', 'IN_PROGRESS']);
      assert.deepEqual([data.epic.status, data.epic.statusCategory], ['To Do', 'TO_DO']);
      const rows = await t.ticketsOf(screen.id);
      assert.deepEqual(
        rows.map((r) => [r.hierarchy_level, r.status, r.status_category]),
        [
          ['EPIC', 'To Do', 'TO_DO'],
          ['STANDARD', 'To Do', 'TO_DO'],
          ['SUBTASK', 'In Progress', 'IN_PROGRESS'],
        ],
      );
      const searches = (await t.simState()).calls.filter((c) => c.path === '/rest/api/3/search/jql');
      assert.equal(searches.length, 1, 'a single search for all the keys');
      assert.ok(Date.parse(data.subtask.lastSyncedAt) >= Date.parse(data.epic.lastSyncedAt) - 1);
    });

    it('a failed final search still answers 201 with the provisional values, after one single attempt', async () => {
      const { screen } = await arrange();
      await t.control('/__sim/faults', { kind: '500', appliesTo: 'read', count: 5 });
      const res = await post(screen.id, newBody());
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const data = createdOf(res);
      assert.deepEqual(data.created, ['EPIC', 'STANDARD', 'SUBTASK']);
      for (const ticket of [data.epic, data.story, data.subtask]) {
        assert.equal(ticket.status, 'To Do');
        assert.equal(ticket.statusCategory, 'TO_DO');
      }
      const searches = (await t.simState()).calls.filter((c) => c.path === '/rest/api/3/search/jql');
      assert.equal(searches.length, 1, 'no retries for a 201 already decided (D-94)');
      const warning = logLines(t).find((l) => l['operation'] === 'syncCreatedIssues');
      assert.equal(warning?.['level'], 40);
      assert.equal(warning?.['reason'], 'SERVER_ERROR');
      assert.equal((await t.ticketsOf(screen.id)).length, 3);
    });
  });

  describe('audit (NFR-20)', () => {
    it('every ticket is a separate audited CREATE by the caller, with the integration of the request as db role docs_app', async () => {
      const { screen } = await arrange();
      const res = await post(screen.id, newBody(), 'developer');
      assert.equal(res.status, 201);
      const data = createdOf(res);
      const ids = [data.epic.id, data.story.id, data.subtask.id];
      const audit = await t.owner.query<{ action: string; actor_user_id: number; db_role: string; entity_id: string }>(
        `SELECT action, actor_user_id, db_role, entity_id FROM audit_log
          WHERE entity_type = 'jira_ticket' AND action = 'CREATE' AND entity_id = ANY($1) ORDER BY id`,
        [ids.map(String)],
      );
      assert.deepEqual(
        audit.rows.map((r) => r.entity_id),
        ids.map(String),
        'one CREATE per issue, in creation order',
      );
      for (const row of audit.rows) {
        assert.equal(row.actor_user_id, t.users.developer.id);
        assert.equal(row.db_role, 'docs_app');
      }
      // The final synchronization is audited too, with the same actor.
      const updates = await t.owner.query<{ actor_user_id: number }>(
        `SELECT actor_user_id FROM audit_log WHERE entity_type = 'jira_ticket' AND action = 'UPDATE' AND entity_id = ANY($1)`,
        [ids.map(String)],
      );
      for (const row of updates.rows) assert.equal(row.actor_user_id, t.users.developer.id);
    });

    it('created_by and the audit follow the caller of each request', async () => {
      const { screen } = await arrange();
      const first = createdOf(await post(screen.id, newBody(1), 'admin'));
      const second = createdOf(await post(screen.id, newBody(2), 'developer'));
      const rows = await t.ticketsOf(screen.id);
      const by = new Map(rows.map((r) => [r.id, r.created_by]));
      assert.equal(by.get(first.epic.id), t.users.admin.id);
      assert.equal(by.get(first.subtask.id), t.users.admin.id);
      assert.equal(by.get(second.story.id), t.users.developer.id);
      assert.equal(by.get(second.subtask.id), t.users.developer.id);
      assert.equal(second.epic.id, first.epic.id);
    });
  });
});
