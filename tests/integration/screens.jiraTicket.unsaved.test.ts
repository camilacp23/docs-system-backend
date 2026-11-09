/**
 * Module 4, POST /screens/{id}/jira-ticket: nothing created in Jira is left unexplained (FR-12; D-31, D-94). The
 * screen is deleted, the write fails or the application is archived WHILE the request is creating issues. The change
 * is made by a hook that runs just before the creation call leaves for the simulator, so the order is deterministic
 * and no wait is needed.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { bodyOf } from '../helpers/app.js';
import { deleteScreen, insertApplication, insertScreen, setApplicationStatus } from '../helpers/fixtures.js';
import { startJiraApp, type JiraApp } from '../helpers/jiraApp.js';
import { detailsOf } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const body = { newStory: { summary: 'Story' }, subtask: { summary: 'Subtask' } };
const SAVE_FAILED_MESSAGE = (keys: string) =>
  `These Jira issues were created but couldn't be saved here: ${keys}. Delete them in Jira, then try again.`;
const MESSAGE = (keys: string) =>
  `The screen was deleted while the tickets were being created. These Jira issues weren't saved here: ${keys}. Delete them in Jira if you don't need them.`;

describe('POST /screens/{id}/jira-ticket: changes while the request is running', () => {
  let t: JiraApp;
  /** Runs before the n-th creation (1 = the Epic, 2 = the Story, 3 = the Subtask) reaches Jira. */
  let before_: ((n: number) => Promise<void>) | null = null;
  let creations = 0;
  before(async () => {
    t = await startJiraApp({
      deps: (base) => ({
        ...base,
        fetch: async (input, init) => {
          if (urlOf(input).endsWith('/rest/api/3/issue')) {
            creations += 1;
            if (before_ !== null) await before_(creations);
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
    before_ = null;
    creations = 0;
    t.logs.length = 0;
  });

  const post = (screenId: number) =>
    asUser(t, t.users.developer.token)
      .post(`/screens/${screenId}/jira-ticket`, body)
      .then((res) => res);
  const logLines = (): Record<string, unknown>[] => t.logs.map((l) => JSON.parse(l) as Record<string, unknown>);

  it('screen deleted while the Epic is being created: 502 with the Epic as unsaved, in the answer and in the log', async () => {
    const application = await insertApplication(t);
    const screen = await insertScreen(t, application.id);
    before_ = async (n) => {
      if (n === 1) await deleteScreen(t, screen.id);
    };
    const res = await post(screen.id);
    assert.equal(res.status, 502);
    assert.equal(bodyOf(res).code, 'JIRA_PARTIAL_FAILURE');
    assert.equal(bodyOf(res).message, MESSAGE('TECHEA-1'));
    assert.deepEqual(bodyOf(res).details, {
      created: { epic: 'TECHEA-1' },
      unsaved: ['TECHEA-1'],
      reason: 'SCREEN_DELETED',
    });
    assert.equal((await t.simState()).issues.length, 1, 'nothing else was created');
    assert.equal(creations, 1, 'the Story was not attempted');
    const entry = logLines().find((l) => l['msg'] === 'Jira created issues that could not be saved');
    assert.equal(entry?.['level'], 50);
    assert.deepEqual(entry?.['unsaved'], ['TECHEA-1']);
    assert.equal(entry?.['reason'], 'SCREEN_DELETED');
    assert.equal(entry?.['screenId'], screen.id);
  });

  it('screen deleted while the Story is being created: the Epic, saved and then removed with the screen, is listed too', async () => {
    const application = await insertApplication(t);
    const screen = await insertScreen(t, application.id);
    before_ = async (n) => {
      if (n === 2) await deleteScreen(t, screen.id);
    };
    const res = await post(screen.id);
    assert.equal(res.status, 502);
    assert.equal(bodyOf(res).code, 'JIRA_PARTIAL_FAILURE');
    assert.equal(bodyOf(res).message, MESSAGE('TECHEA-1, TECHEA-2'));
    assert.deepEqual(bodyOf(res).details, {
      created: { epic: 'TECHEA-1', story: 'TECHEA-2' },
      unsaved: ['TECHEA-1', 'TECHEA-2'],
      reason: 'SCREEN_DELETED',
    });
    assert.deepEqual(
      (await t.simState()).issues.map((i) => i.key),
      ['TECHEA-1', 'TECHEA-2'],
      'the Subtask was never created',
    );
    assert.equal((await t.owner.query('SELECT 1 FROM jira_ticket')).rowCount, 0);
  });

  it('a write that fails: only the issue that was not saved is unsaved, and what was saved stays', async () => {
    const application = await insertApplication(t);
    const screen = await insertScreen(t, application.id);
    const other = await insertScreen(t, application.id);
    // Someone already holds the key the Story will get: the insert violates the unique key of Jira's issue.
    before_ = async (n) => {
      if (n !== 2) return;
      await t.owner.query(
        `INSERT INTO jira_ticket (screen_id, jira_issue_id, jira_issue_key, hierarchy_level, issue_type, summary,
                                  status, status_category, created_by)
         VALUES ($1, '10001', 'TECHEA-2', 'EPIC', 'Epic', 'Squatter', 'To Do', 'TO_DO', $2)`,
        [other.id, t.users.admin.id],
      );
    };
    const res = await post(screen.id);
    assert.equal(res.status, 502);
    assert.equal(bodyOf(res).code, 'JIRA_PARTIAL_FAILURE');
    assert.equal(bodyOf(res).message, SAVE_FAILED_MESSAGE('TECHEA-2'), 'its own message: the screen was not deleted');
    assert.deepEqual(bodyOf(res).details, {
      created: { epic: 'TECHEA-1', story: 'TECHEA-2' },
      unsaved: ['TECHEA-2'],
      reason: 'SAVE_FAILED',
    });
    assert.equal((await t.ticketsOf(screen.id)).length, 1, 'the Epic stays saved');
    const entry = logLines().find((l) => l['msg'] === 'Jira created issues that could not be saved');
    assert.deepEqual(entry?.['unsaved'], ['TECHEA-2']);
    assert.equal(entry?.['reason'], 'SAVE_FAILED');
    assert.equal(entry?.['code'], 'P2002', 'the code of the error, never its message (it carries the values)');
    assert.doesNotMatch(t.logs.join('\n'), /Squatter/);
  });

  it('application archived while the request runs: the issues already in Jira are saved, with a warning', async () => {
    const application = await insertApplication(t);
    const screen = await insertScreen(t, application.id);
    before_ = async (n) => {
      if (n === 2) await setApplicationStatus(t, application.id, 'ARCHIVED');
    };
    const res = await post(screen.id);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await t.ticketsOf(screen.id)).length, 3, 'nothing created in Jira is left unexplained');
    const warnings = logLines().filter(
      (l) =>
        l['msg'] === 'the application was archived while the tickets were being created; the issue was saved anyway',
    );
    assert.deepEqual(
      warnings.map((w) => [w['level'], w['key'], w['screenId'], w['applicationId']]),
      [
        [40, 'TECHEA-2', screen.id, application.id],
        [40, 'TECHEA-3', screen.id, application.id],
      ],
      'the Epic was saved before the archiving; the Story and the Subtask after',
    );
    // From now on the application is read-only (CP-01).
    const next = await post(screen.id);
    assert.equal(next.status, 422);
    assert.equal(bodyOf(next).code, 'APPLICATION_ARCHIVED');
    assert.equal(detailsOf(next)['applicationId'], application.id);
  });
});
