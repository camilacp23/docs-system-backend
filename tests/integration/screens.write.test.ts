/**
 * Module 4, POST /screens (FR-10, FR-11, FR-13; SDD Table 50; D-62 to D-65, D-81, D-84, D-85): the screen, its
 * components, uses, links and navigations are written in one audited transaction, the initial status follows the
 * template, and every error carries its code and details in the order of the service.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { auditRows } from '../helpers/collections.js';
import {
  insertApplication,
  insertCollection,
  insertScreen,
  insertVariable,
  setApplicationStatus,
} from '../helpers/fixtures.js';
import { createBodyOf, detailsOf, emptyTemplate, screenOf, templateWith } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

describe('screens: POST /screens', () => {
  let t: TestApp;
  let app: { id: number; name: string };
  let other: { id: number; name: string };
  let gA: { id: number; name: string };
  let colA: { id: number; name: string };
  let target: { id: number; name: string };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Screen writers' });
    other = await insertApplication(t, { name: 'Other app' });
    gA = await insertVariable(t, app.id, { name: 'gA' });
    colA = await insertCollection(t, app.id, { name: 'colA' });
    target = await insertScreen(t, app.id, { name: 'Target' });
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const reader = () => asUser(t, t.users.reader.token);
  const count = async (sql: string) => Number((await t.owner.query<{ n: string }>(sql)).rows[0]!.n);
  const screens = () => count(`SELECT count(*) AS n FROM screen`);
  const use = (targetType: string, targetId: number) => ({ targetType, targetId });

  describe('success', () => {
    it('201 + Location + ETag; the caller is the author; an empty template starts UNDOCUMENTED (D-81)', async () => {
      const res = await dev().post('/screens', createBodyOf(app.id, { name: 'Empty' }));
      assert.equal(res.status, 201);
      const screen = screenOf(res);
      assert.equal(res.headers.location, `/api/v1/screens/${screen.id}`);
      assert.equal(res.headers.etag, `W/"${new Date(screen.updatedAt).getTime()}"`);
      assert.equal(screen.documentationStatus, 'UNDOCUMENTED');
      assert.deepEqual(screen.author, { id: t.users.developer.id, name: 'Dev Eloper' });
      assert.equal(screen.isAppContext, false);
      assert.equal(screen.miroLink, null);
      assert.deepEqual(screen.template, emptyTemplate());
    });

    it('a template with content in any field starts DRAFT; blank text does not count (D-81)', async () => {
      const draft = await dev().post(
        '/screens',
        createBodyOf(app.id, { name: 'Draft', template: templateWith({ risks: 'Fragile.' }) }),
      );
      assert.equal(screenOf(draft).documentationStatus, 'DRAFT');
      const blank = await dev().post(
        '/screens',
        createBodyOf(app.id, { name: 'Blank', template: templateWith({ onStart: '   ', risks: '\n' }) }),
      );
      assert.equal(screenOf(blank).documentationStatus, 'UNDOCUMENTED');
      assert.equal(screenOf(blank).template.onStart, '   ', 'the text is stored as it arrives');
    });

    it('writes components, uses, links and navigations; the element rows share the application', async () => {
      const res = await dev().post(
        '/screens',
        createBodyOf(app.id, {
          name: 'Full',
          miroLink: 'https://miro.com/app/board/uXj/',
          components: [
            {
              name: 'btnA',
              type: 'Button',
              onSelect: 'Set(gA, 1)',
              uses: [{ ...use('VARIABLE', gA.id), description: 'sets' }, use('COLLECTION', colA.id)],
            },
            { name: 'galB', type: 'Gallery' },
          ],
          variableLinks: [{ variableId: gA.id, accessMode: 'READ_WRITE', usedIn: 'btnA.OnSelect' }],
          collectionLinks: [{ collectionId: colA.id, accessMode: 'READ', usedIn: 'galB.Items' }],
          navigations: [{ targetScreenId: target.id, description: 'Go' }],
        }),
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const s = screenOf(res);
      assert.deepEqual(
        s.components.map((c) => c.name),
        ['btnA', 'galB'],
      );
      assert.deepEqual(
        s.components[0]!.uses.map((u) => [u.targetType, u.target.id, u.description]),
        [
          ['COLLECTION', colA.id, null],
          ['VARIABLE', gA.id, 'sets'],
        ],
      );
      assert.equal(s.variableLinks.length, 1);
      assert.equal(s.collectionLinks.length, 1);
      assert.equal(s.navigations.length, 1);
      const elements = await t.owner.query(`SELECT type, application_id FROM documented_element WHERE id = ANY($1)`, [
        [s.id, ...s.components.map((c) => c.id)],
      ]);
      assert.deepEqual(
        elements.rows.map((r: { type: string; application_id: number }) => [r.type, r.application_id]).sort(),
        [
          ['COMPONENT', app.id],
          ['COMPONENT', app.id],
          ['SCREEN', app.id],
        ],
      );
    });

    it('the creation is audited with the actor: the screen, its components, links and dependencies', async () => {
      const res = await dev().post(
        '/screens',
        createBodyOf(app.id, {
          name: 'Audited',
          components: [{ name: 'c1', type: 'Button', uses: [use('VARIABLE', gA.id)] }],
          variableLinks: [{ variableId: gA.id, accessMode: 'READ', usedIn: 'c1.OnSelect' }],
          navigations: [{ targetScreenId: target.id }],
        }),
      );
      const s = screenOf(res);
      const actors = async (entity: string, id: number) =>
        (await auditRows(t, entity, String(id))).map((r) => [r.action, r.actor_user_id]);
      const created = [['CREATE', t.users.developer.id]];
      assert.deepEqual(await actors('screen', s.id), created);
      assert.deepEqual(await actors('component', s.components[0]!.id), created);
      assert.deepEqual(await actors('screen_variable', s.variableLinks[0]!.id), created);
      assert.deepEqual(await actors('dependency', s.components[0]!.uses[0]!.id), created);
      assert.deepEqual(await actors('dependency', s.navigations[0]!.id), created);
    });

    it('a context variable of another screen accepts WRITE links', async () => {
      const origin = await insertScreen(t, app.id, { name: 'CtxOrigin' });
      const ctx = await insertVariable(t, app.id, { name: 'locCtx', scope: 'CONTEXT', originScreenId: origin.id });
      const res = await dev().post(
        '/screens',
        createBodyOf(app.id, {
          name: 'Navigates',
          variableLinks: [{ variableId: ctx.id, accessMode: 'WRITE', usedIn: 'btn.OnSelect' }],
        }),
      );
      assert.equal(res.status, 201);
    });

    it('the ids of nested items in a POST are ignored (there is nothing to match them with)', async () => {
      const res = await dev().post(
        '/screens',
        createBodyOf(app.id, { name: 'Ids ignored', components: [{ id: 999999, name: 'x', type: 'Label' }] }),
      );
      assert.equal(res.status, 201);
      assert.notEqual(screenOf(res).components[0]!.id, 999999);
    });
  });

  describe('400 VALIDATION_ERROR', () => {
    const fieldsOf = (res: { body: unknown }) => bodyOf(res).details.fields.map((f) => [f.field, f.rule]);

    it('repeated values name each repeated position and nothing is written', async () => {
      const before = await screens();
      const res = await dev().post(
        '/screens',
        createBodyOf(app.id, {
          name: 'Repeats',
          components: [
            { name: 'dup', type: 'Button', uses: [use('VARIABLE', gA.id), use('VARIABLE', gA.id)] },
            { name: 'dup', type: 'Label' },
          ],
          variableLinks: [
            { variableId: gA.id, accessMode: 'READ', usedIn: 'a.B' },
            { variableId: gA.id, accessMode: 'WRITE', usedIn: 'a.B' },
          ],
          collectionLinks: [
            { collectionId: colA.id, accessMode: 'READ', usedIn: 'a.B' },
            { collectionId: colA.id, accessMode: 'READ', usedIn: 'a.B' },
          ],
          navigations: [{ targetScreenId: target.id }, { targetScreenId: target.id }],
        }),
      );
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      assert.deepEqual(fieldsOf(res).sort(), [
        ['collectionLinks[1].usedIn', 'unique'],
        ['components[0].uses[1].targetId', 'unique'],
        ['components[1].name', 'unique'],
        ['navigations[1].targetScreenId', 'unique'],
        ['variableLinks[1].usedIn', 'unique'],
      ]);
      assert.equal(await screens(), before);
    });

    it('the same variable with different usedIn is allowed; the same nested id twice is 400 at its position', async () => {
      const ok = await dev().post(
        '/screens',
        createBodyOf(app.id, {
          name: 'Two usedIn',
          variableLinks: [
            { variableId: gA.id, accessMode: 'READ', usedIn: 'a.B' },
            { variableId: gA.id, accessMode: 'READ', usedIn: 'a.C' },
          ],
        }),
      );
      assert.equal(ok.status, 201);
      const res = await dev().post(
        '/screens',
        createBodyOf(app.id, {
          name: 'Ids twice',
          components: [
            { id: 5, name: 'a', type: 'T' },
            { id: 5, name: 'b', type: 'T' },
          ],
          variableLinks: [
            { id: 8, variableId: gA.id, accessMode: 'READ', usedIn: 'a.B' },
            { id: 8, variableId: gA.id, accessMode: 'READ', usedIn: 'a.C' },
          ],
          collectionLinks: [
            { id: 8, collectionId: colA.id, accessMode: 'READ', usedIn: 'a.B' },
            { id: 8, collectionId: colA.id, accessMode: 'READ', usedIn: 'a.C' },
          ],
          navigations: [{ id: 3, targetScreenId: target.id }],
        }),
      );
      assert.equal(res.status, 400);
      assert.deepEqual(fieldsOf(res).sort(), [
        ['collectionLinks[1].id', 'unique'],
        ['components[1].id', 'unique'],
        ['variableLinks[1].id', 'unique'],
      ]);
    });

    it('usedIn "origin" is reserved: 400 at its position (D-84)', async () => {
      const res = await dev().post(
        '/screens',
        createBodyOf(app.id, {
          variableLinks: [
            { variableId: gA.id, accessMode: 'READ', usedIn: 'ok.B' },
            { variableId: gA.id, accessMode: 'WRITE', usedIn: 'origin' },
          ],
        }),
      );
      assert.equal(res.status, 400);
      assert.deepEqual(fieldsOf(res), [['variableLinks[1].usedIn', 'pattern']]);
    });

    it('the contract validator rejects a missing array, an invalid component name and a non-https Miro link', async () => {
      const { navigations: _navigations, ...withoutNavigations } = createBodyOf(app.id);
      assert.equal((await dev().post('/screens', withoutNavigations)).status, 400);
      const bad = await dev().post(
        '/screens',
        createBodyOf(app.id, { miroLink: 'http://x', components: [{ name: '1bad name', type: 'T' }] }),
      );
      assert.equal(bad.status, 400);
      assert.deepEqual(
        fieldsOf(bad)
          .map(([f]) => f)
          .sort(),
        ['components[0].name', 'miroLink'],
      );
    });
  });

  describe('404 NOT_FOUND, each with element, id and field', () => {
    const notFound = async (over: Record<string, unknown>, element: string, id: number, field: string) => {
      const res = await dev().post('/screens', createBodyOf(app.id, { name: 'Missing refs', ...over }));
      assert.equal(res.status, 404, JSON.stringify(res.body));
      assert.equal(bodyOf(res).code, 'NOT_FOUND');
      assert.equal(bodyOf(res).message, `This ${element} doesn't exist. It may have been deleted.`);
      assert.deepEqual(detailsOf(res), { element, id, field });
    };

    it('the application, including an id that cannot exist', async () => {
      for (const id of [999999, 2147483648]) {
        const res = await dev().post('/screens', createBodyOf(id));
        assert.equal(res.status, 404, String(id));
        assert.equal(bodyOf(res).details.element, 'application');
      }
    });

    it('variables, collections, use targets and target screens, with the position', async () => {
      await notFound(
        {
          variableLinks: [
            { variableId: gA.id, accessMode: 'READ', usedIn: 'a.B' },
            { variableId: 999999, accessMode: 'READ', usedIn: 'a.C' },
          ],
        },
        'variable',
        999999,
        'variableLinks[1].variableId',
      );
      await notFound(
        { collectionLinks: [{ collectionId: 2147483648, accessMode: 'READ', usedIn: 'a.B' }] },
        'collection',
        2147483648,
        'collectionLinks[0].collectionId',
      );
      await notFound(
        { components: [{ name: 'a', type: 'T', uses: [use('VARIABLE', colA.id)] }] },
        'variable',
        colA.id,
        'components[0].uses[0].targetId',
      );
      await notFound(
        {
          components: [
            { name: 'a', type: 'T' },
            { name: 'b', type: 'T', uses: [use('COLLECTION', 999999)] },
          ],
        },
        'collection',
        999999,
        'components[1].uses[0].targetId',
      );
      await notFound({ navigations: [{ targetScreenId: 999999 }] }, 'screen', 999999, 'navigations[0].targetScreenId');
    });
  });

  describe('422 and 409', () => {
    it('APPLICATION_ARCHIVED for every role that can write', async () => {
      const archived = await insertApplication(t, { name: 'Archived apps' });
      await setApplicationStatus(t, archived.id, 'ARCHIVED');
      for (const api of [dev(), asUser(t, t.users.admin.token)]) {
        const res = await api.post('/screens', createBodyOf(archived.id));
        assert.equal(res.status, 422);
        assert.equal(bodyOf(res).code, 'APPLICATION_ARCHIVED');
        assert.deepEqual(detailsOf(res), { applicationId: archived.id });
      }
    });

    it('CROSS_APPLICATION names the first offending item of each array', async () => {
      const foreignVar = await insertVariable(t, other.id, { name: 'gForeign' });
      const foreignCol = await insertCollection(t, other.id, { name: 'colForeign' });
      const foreignScreen = await insertScreen(t, other.id, { name: 'Foreign' });
      const cross = async (over: Record<string, unknown>, field: string) => {
        const res = await dev().post('/screens', createBodyOf(app.id, { name: 'Cross', ...over }));
        assert.equal(res.status, 422, JSON.stringify(res.body));
        assert.equal(bodyOf(res).code, 'CROSS_APPLICATION');
        assert.equal(bodyOf(res).message, 'You can only link elements of the same application.');
        assert.deepEqual(detailsOf(res), { field });
      };
      await cross(
        {
          variableLinks: [
            { variableId: gA.id, accessMode: 'READ', usedIn: 'a.B' },
            { variableId: foreignVar.id, accessMode: 'READ', usedIn: 'a.C' },
          ],
        },
        'variableLinks[1].variableId',
      );
      await cross(
        { collectionLinks: [{ collectionId: foreignCol.id, accessMode: 'READ', usedIn: 'a.B' }] },
        'collectionLinks[0].collectionId',
      );
      await cross({ navigations: [{ targetScreenId: foreignScreen.id }] }, 'navigations[0].targetScreenId');
      await cross(
        { components: [{ name: 'a', type: 'T', uses: [use('COLLECTION', foreignCol.id)] }] },
        'components[0].uses[0].targetId',
      );
    });

    it('CONTEXT_SCREEN_MISMATCH: with origin and without origin; the new screen has no id yet (screenId null)', async () => {
      const origin = await insertScreen(t, app.id, { name: 'CtxOwner' });
      const ctx = await insertVariable(t, app.id, { name: 'locOwned', scope: 'CONTEXT', originScreenId: origin.id });
      const free = await insertVariable(t, app.id, { name: 'locFree', scope: 'CONTEXT' });
      const withOrigin = await dev().post(
        '/screens',
        createBodyOf(app.id, {
          name: 'Mismatch',
          variableLinks: [{ variableId: ctx.id, accessMode: 'READ', usedIn: 'a.B' }],
        }),
      );
      assert.equal(withOrigin.status, 422);
      assert.equal(bodyOf(withOrigin).code, 'CONTEXT_SCREEN_MISMATCH');
      assert.equal(
        bodyOf(withOrigin).message,
        'locOwned belongs to CtxOwner. From here you can only write it with Navigate.',
      );
      assert.deepEqual(detailsOf(withOrigin), {
        variableId: ctx.id,
        variable: 'locOwned',
        originScreenId: origin.id,
        screen: 'CtxOwner',
        screenId: null,
        targetScreen: 'Mismatch',
        field: 'variableLinks[0].variableId',
      });
      const withoutOrigin = await dev().post(
        '/screens',
        createBodyOf(app.id, {
          name: 'Mismatch',
          variableLinks: [{ variableId: free.id, accessMode: 'WRITE', usedIn: 'a.B' }],
        }),
      );
      assert.equal(withoutOrigin.status, 422);
      assert.equal(
        bodyOf(withoutOrigin).message,
        'locFree has no origin screen. Set its origin screen before linking it.',
      );
      assert.deepEqual(detailsOf(withoutOrigin), {
        variableId: free.id,
        variable: 'locFree',
        originScreenId: null,
        screenId: null,
        targetScreen: 'Mismatch',
        field: 'variableLinks[0].variableId',
      });
    });

    it('409 DUPLICATE_NAME with container "application" (D-63); the same name in another application is free', async () => {
      await dev().post('/screens', createBodyOf(app.id, { name: 'Taken' }));
      const res = await dev().post('/screens', createBodyOf(app.id, { name: 'Taken' }));
      assert.equal(res.status, 409);
      assert.equal(bodyOf(res).code, 'DUPLICATE_NAME');
      assert.equal(bodyOf(res).message, 'A screen named Taken already exists in Screen writers.');
      assert.deepEqual(detailsOf(res), {
        field: 'name',
        type: 'screen',
        name: 'Taken',
        application: 'Screen writers',
        container: 'application',
      });
      assert.equal((await dev().post('/screens', createBodyOf(other.id, { name: 'Taken' }))).status, 201);
    });

    it('the name "App (OnStart)" is already taken by the reserved screen of every application', async () => {
      const res = await dev().post('/screens', createBodyOf(app.id, { name: 'App (OnStart)' }));
      assert.equal(res.status, 409);
      assert.equal(bodyOf(res).code, 'DUPLICATE_NAME');
    });
  });

  describe('order of errors', () => {
    it('404 before APPLICATION_ARCHIVED before CROSS_APPLICATION before CONTEXT_SCREEN_MISMATCH before 409', async () => {
      const archived = await insertApplication(t, { name: 'Order archived' });
      await insertScreen(t, archived.id, { name: 'Dup' });
      await setApplicationStatus(t, archived.id, 'ARCHIVED');
      const missing = { name: 'Dup', variableLinks: [{ variableId: 999999, accessMode: 'READ', usedIn: 'a.B' }] };
      assert.equal(bodyOf(await dev().post('/screens', createBodyOf(archived.id, missing))).code, 'NOT_FOUND');
      assert.equal(
        bodyOf(await dev().post('/screens', createBodyOf(archived.id, { name: 'Dup' }))).code,
        'APPLICATION_ARCHIVED',
      );

      const foreign = await insertVariable(t, other.id, { name: 'gOrderForeign' });
      const origin = await insertScreen(t, app.id, { name: 'OrderOrigin' });
      const ctx = await insertVariable(t, app.id, { name: 'locOrder', scope: 'CONTEXT', originScreenId: origin.id });
      const links = [
        { variableId: ctx.id, accessMode: 'READ', usedIn: 'a.B' },
        { variableId: foreign.id, accessMode: 'READ', usedIn: 'a.C' },
      ];
      // The context mismatch is at [0] and the cross-application link at [1]: the cross rule is judged first.
      const cross = await dev().post('/screens', createBodyOf(app.id, { name: 'Taken2', variableLinks: links }));
      assert.equal(bodyOf(cross).code, 'CROSS_APPLICATION');
      assert.deepEqual(detailsOf(cross), { field: 'variableLinks[1].variableId' });
      await dev().post('/screens', createBodyOf(app.id, { name: 'Taken2' }));
      // With only the context mismatch left, it still wins over the duplicate name.
      const context = await dev().post('/screens', createBodyOf(app.id, { name: 'Taken2', variableLinks: [links[0]] }));
      assert.equal(bodyOf(context).code, 'CONTEXT_SCREEN_MISMATCH');
      const duplicate = await dev().post('/screens', createBodyOf(app.id, { name: 'Taken2' }));
      assert.equal(bodyOf(duplicate).code, 'DUPLICATE_NAME');
    });

    it('a rejected POST writes nothing: no screen, component or audit row of the attempt', async () => {
      const screensBefore = await screens();
      const componentsBefore = await count(`SELECT count(*) AS n FROM component`);
      const auditBefore = await count(`SELECT count(*) AS n FROM audit_log`);
      const res = await dev().post(
        '/screens',
        createBodyOf(app.id, {
          name: 'Nothing',
          components: [{ name: 'a', type: 'T' }],
          navigations: [{ targetScreenId: 999999 }],
        }),
      );
      assert.equal(res.status, 404);
      assert.equal(await screens(), screensBefore);
      assert.equal(await count(`SELECT count(*) AS n FROM component`), componentsBefore);
      assert.equal(await count(`SELECT count(*) AS n FROM audit_log`), auditBefore);
    });
  });

  describe('roles', () => {
    it('401 without a token; 403 for a Reader with requiredRoles and nothing written', async () => {
      assert.equal((await t.http.post('/api/v1/screens').send(createBodyOf(app.id))).status, 401);
      const before = await screens();
      const res = await reader().post('/screens', createBodyOf(app.id, { name: 'Reader' }));
      assert.equal(res.status, 403);
      assert.equal(bodyOf(res).code, 'FORBIDDEN');
      assert.deepEqual(bodyOf(res).details, { requiredRoles: ['ADMINISTRATOR', 'DEVELOPER'] });
      assert.equal(await screens(), before);
    });
  });
});
