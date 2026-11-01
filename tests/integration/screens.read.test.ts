/**
 * Module 4, GET /screens/{id} (FR-10, FR-14; SDD Table 50; D-62, D-72): the Screen representation with its template,
 * components, links and navigations, the ETag and 304, the roles, and the operations of the module that are still
 * not implemented.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import {
  insertApplication,
  insertComments,
  insertScreen,
  insertSubtasks,
  insertVariable,
} from '../helpers/fixtures.js';
import { createBodyOf, screenOf, templateWith } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

describe('screens: GET /screens/{id}', () => {
  let t: TestApp;
  let app: { id: number; name: string };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Screen readers' });
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const reader = () => asUser(t, t.users.reader.token);

  it('200 returns the Screen with ETag W/"<updatedAt ms>", author, counters and the origin rows flagged', async () => {
    const origin = await insertScreen(t, app.id, { name: 'Origin' });
    const variable = await insertVariable(t, app.id, {
      name: 'locOrigin',
      scope: 'CONTEXT',
      originScreenId: origin.id,
    });
    await insertSubtasks(t, origin.id, ['TO_DO', 'DONE', 'IN_PROGRESS']);
    await insertComments(t, origin.id, 2);
    const res = await reader().get(`/screens/${origin.id}`);
    assert.equal(res.status, 200);
    const screen = screenOf(res);
    assert.equal(res.headers.etag, `W/"${new Date(screen.updatedAt).getTime()}"`);
    assert.equal(screen.name, 'Origin');
    assert.equal(screen.applicationId, app.id);
    assert.equal(screen.isAppContext, false);
    assert.equal(screen.documentationStatus, 'UNDOCUMENTED');
    assert.deepEqual(screen.author, { id: t.users.admin.id, name: 'Ada Admin' });
    assert.equal(screen.pendingSubtasks, 2);
    assert.equal(screen.commentCount, 2);
    assert.deepEqual(Object.keys(screen.template).sort(), [
      'architecture',
      'dataModel',
      'knownIssues',
      'onStart',
      'requirements',
      'risks',
      'workingProcess',
    ]);
    assert.deepEqual(
      screen.variableLinks.map((l) => [l.variable.id, l.accessMode, l.usedIn, l.isOrigin]),
      [[variable.id, 'WRITE', 'origin', true]],
    );
    assert.deepEqual([screen.components, screen.collectionLinks, screen.navigations], [[], [], []]);
  });

  it('returns the components with their uses, the links and the navigations of a screen created through the API', async () => {
    const v = await insertVariable(t, app.id, { name: 'gRead' });
    const target = await insertScreen(t, app.id, { name: 'Target' });
    const created = await dev().post(
      '/screens',
      createBodyOf(app.id, {
        name: 'Complete',
        miroLink: 'https://miro.com/app/board/x/',
        template: templateWith({ workingProcess: 'Lists requests.' }),
        components: [
          {
            name: 'btnFilter',
            type: 'Button',
            onSelect: 'Navigate(Target)',
            description: 'Filters',
            uses: [{ targetType: 'VARIABLE', targetId: v.id, description: 'reads' }],
          },
        ],
        variableLinks: [{ variableId: v.id, accessMode: 'READ', usedIn: 'btnFilter.OnSelect' }],
        navigations: [{ targetScreenId: target.id, description: 'On select' }],
      }),
    );
    assert.equal(created.status, 201);
    const res = await reader().get(`/screens/${screenOf(created).id}`);
    const screen = screenOf(res);
    assert.equal(screen.miroLink, 'https://miro.com/app/board/x/');
    assert.equal(screen.documentationStatus, 'DRAFT');
    assert.deepEqual(
      screen.components.map((c) => [
        c.name,
        c.type,
        c.onSelect,
        c.description,
        c.uses.map((u) => [u.targetType, u.target.id, u.description]),
      ]),
      [['btnFilter', 'Button', 'Navigate(Target)', 'Filters', [['VARIABLE', v.id, 'reads']]]],
    );
    assert.deepEqual(
      screen.navigations.map((n) => [n.targetScreen.id, n.description]),
      [[target.id, 'On select']],
    );
  });

  it('If-None-Match with the current ETag is 304 without a body; a stale one is 200 (D-72)', async () => {
    const s = await insertScreen(t, app.id);
    const first = await dev().get(`/screens/${s.id}`);
    const etag = String(first.headers.etag);
    const same = await dev().get(`/screens/${s.id}`).set('If-None-Match', etag);
    assert.equal(same.status, 304);
    assert.deepEqual(same.body, {});
    assert.equal((await dev().get(`/screens/${s.id}`).set('If-None-Match', 'W/"1"')).status, 200);
  });

  it('404 NOT_FOUND for a screen that does not exist or whose id cannot exist; 400 for a non-numeric id', async () => {
    for (const id of [999999, 2147483647, 2147483648]) {
      const res = await dev().get(`/screens/${id}`);
      assert.equal(res.status, 404, String(id));
      assert.equal(bodyOf(res).code, 'NOT_FOUND');
      assert.equal(bodyOf(res).message, "This screen doesn't exist. It may have been deleted.");
    }
    assert.equal((await dev().get('/screens/abc')).status, 400);
  });

  it('401 without a token', async () => {
    assert.equal((await t.http.get('/api/v1/screens/1')).status, 401);
  });

  it('the six operations are implemented; review and Jira still answer NOT_IMPLEMENTED', () => {
    const implemented = [
      'listScreens',
      'createScreen',
      'getScreen',
      'updateScreen',
      'deleteScreen',
      'changeScreenStatus',
    ];
    for (const operationId of implemented) assert.ok(!t.built.notImplemented.includes(operationId), operationId);
    for (const operationId of ['reviewScreen', 'createJiraTicket', 'listJiraTickets']) {
      assert.ok(t.built.notImplemented.includes(operationId), operationId);
    }
  });
});
