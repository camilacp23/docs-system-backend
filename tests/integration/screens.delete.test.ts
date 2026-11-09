/**
 * Module 4, DELETE /screens/{id} (FR-10; SDD Table 50; D-52, D-82, D-83): the database cascades components, links,
 * dependencies in both directions, comments and tickets; the variables created in the screen keep existing without
 * origin; the App (OnStart) screen, a screen in review and an archived application are protected.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import {
  auditRows,
  collectionOf,
  createBodyOf as collectionBody,
  putBodyOf as collectionPut,
} from '../helpers/collections.js';
import {
  insertApplication,
  insertCollection,
  insertComments,
  insertScreen,
  insertSubtasks,
  insertVariable,
  setApplicationStatus,
} from '../helpers/fixtures.js';
import { createScreenVia, detailsOf, putBodyOf, screenOf } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';
import { createBodyOf as variableBody, putBodyOf as variablePut, variableOf } from '../helpers/variables.js';

describe('screens: DELETE /screens/{id}', () => {
  let t: TestApp;
  let app: { id: number; name: string; appContextScreenId: number };
  let gA: { id: number; name: string };
  let colA: { id: number; name: string };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Screen deleters' });
    gA = await insertVariable(t, app.id, { name: 'gA' });
    colA = await insertCollection(t, app.id, { name: 'colA' });
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const admin = () => asUser(t, t.users.admin.token);
  const reader = () => asUser(t, t.users.reader.token);
  const rows = async (sql: string, params: unknown[]) => (await t.owner.query(sql, params)).rowCount;

  describe('success', () => {
    it('204; components, links, dependencies in BOTH directions, comments and tickets cascade; audited with the actor', async () => {
      const other = (await createScreenVia(dev(), app.id, { name: 'Other' })).screen;
      const { screen } = await createScreenVia(dev(), app.id, {
        name: 'Doomed',
        components: [{ name: 'c', type: 'T', uses: [{ targetType: 'VARIABLE', targetId: gA.id }] }],
        variableLinks: [{ variableId: gA.id, accessMode: 'READ', usedIn: 'c.OnSelect' }],
        collectionLinks: [{ collectionId: colA.id, accessMode: 'READ', usedIn: 'g.Items' }],
        navigations: [{ targetScreenId: other.id }],
      });
      // Another screen navigates to the doomed one: that dependency goes too.
      const otherRead = await dev().get(`/screens/${other.id}`);
      const back = await dev().put(
        `/screens/${other.id}`,
        putBodyOf(screenOf(otherRead), { navigations: [{ targetScreenId: screen.id }] }),
        String(otherRead.headers.etag),
      );
      assert.equal(back.status, 200, JSON.stringify(back.body));
      await insertComments(t, screen.id, 2);
      await insertSubtasks(t, screen.id, ['TO_DO']);
      const componentId = screen.components[0]!.id;

      const res = await dev().delete(`/screens/${screen.id}`);
      assert.equal(res.status, 204);
      assert.deepEqual(res.body, {});
      assert.equal((await dev().get(`/screens/${screen.id}`)).status, 404);
      for (const [sql, id] of [
        ['SELECT 1 FROM documented_element WHERE id = $1', screen.id],
        ['SELECT 1 FROM documented_element WHERE id = $1', componentId],
        ['SELECT 1 FROM component WHERE screen_id = $1', screen.id],
        ['SELECT 1 FROM screen_variable WHERE screen_id = $1', screen.id],
        ['SELECT 1 FROM screen_collection WHERE screen_id = $1', screen.id],
        ['SELECT 1 FROM dependency WHERE source_id = $1 OR target_id = $1', screen.id],
        ['SELECT 1 FROM dependency WHERE source_id = $1 OR target_id = $1', componentId],
        ['SELECT 1 FROM comment WHERE screen_id = $1', screen.id],
        ['SELECT 1 FROM jira_ticket WHERE screen_id = $1', screen.id],
      ] as const) {
        assert.equal(await rows(sql, [id]), 0, sql);
      }
      assert.deepEqual(screenOf(await dev().get(`/screens/${other.id}`)).navigations, []);
      // The variable and the collection they pointed at are untouched.
      assert.equal((await dev().get(`/variables/${gA.id}`)).status, 200);
      assert.equal((await dev().get(`/collections/${colA.id}`)).status, 200);
      const history = await auditRows(t, 'screen', String(screen.id));
      assert.deepEqual(history.map((r) => [r.action, r.actor_user_id]).at(-1), ['DELETE', t.users.developer.id]);
    });

    it('the variables created in the screen keep existing without origin; a link from another screen survives', async () => {
      const origin = (await createScreenVia(dev(), app.id, { name: 'Origin to delete' })).screen;
      const ctx = variableOf(
        await dev().post(
          '/variables',
          variableBody(app.id, { name: 'locKept', scope: 'CONTEXT', originScreenId: origin.id }),
        ),
      );
      const holder = await createScreenVia(dev(), app.id, {
        name: 'Holder',
        variableLinks: [{ variableId: ctx.id, accessMode: 'WRITE', usedIn: 'nav.Go' }],
      });
      assert.equal((await dev().delete(`/screens/${origin.id}`)).status, 204);
      const after = variableOf(await dev().get(`/variables/${ctx.id}`));
      assert.equal(after.originScreen, null);
      assert.equal(after.fullTraceability, false);
      assert.deepEqual(screenOf(await dev().get(`/screens/${holder.screen.id}`)).variableLinks.length, 1);
    });

    it('an administrator can delete too, and a second DELETE is 404', async () => {
      const { screen } = await createScreenVia(dev(), app.id, { name: 'Twice' });
      assert.equal((await admin().delete(`/screens/${screen.id}`)).status, 204);
      const again = await admin().delete(`/screens/${screen.id}`);
      assert.equal(again.status, 404);
      assert.equal(bodyOf(again).code, 'NOT_FOUND');
    });
  });

  describe('errors', () => {
    it('404 for a screen that does not exist or whose id cannot exist', async () => {
      for (const id of [999999, 2147483648]) {
        const res = await dev().delete(`/screens/${id}`);
        assert.equal(res.status, 404, String(id));
        assert.equal(bodyOf(res).message, "This screen doesn't exist. It may have been deleted.");
      }
    });

    it('422 APP_CONTEXT_PROTECTED for the App (OnStart) screen; it stays', async () => {
      const res = await dev().delete(`/screens/${app.appContextScreenId}`);
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'APP_CONTEXT_PROTECTED');
      assert.equal(bodyOf(res).message, "The App (OnStart) screen can't be deleted.");
      assert.equal((res.body as { details: unknown }).details, null);
      assert.equal((await dev().get(`/screens/${app.appContextScreenId}`)).status, 200);
    });

    it('422 SCREEN_IN_REVIEW (D-82); the screen stays', async () => {
      const s = await insertScreen(t, app.id, { name: 'Reviewed', documentationStatus: 'IN_REVIEW' });
      const res = await dev().delete(`/screens/${s.id}`);
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'SCREEN_IN_REVIEW');
      assert.equal((res.body as { details: unknown }).details, null);
      assert.equal((await dev().get(`/screens/${s.id}`)).status, 200);
      await t.owner.query(`UPDATE screen SET documentation_status = 'IN_PROGRESS' WHERE id = $1`, [s.id]);
      assert.equal((await dev().delete(`/screens/${s.id}`)).status, 204);
    });

    it('422 APPLICATION_ARCHIVED with details.applicationId', async () => {
      const archived = await insertApplication(t, { name: 'Archived deleters' });
      const s = await insertScreen(t, archived.id, { name: 'Archived screen' });
      await setApplicationStatus(t, archived.id, 'ARCHIVED');
      const res = await dev().delete(`/screens/${s.id}`);
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'APPLICATION_ARCHIVED');
      assert.deepEqual(detailsOf(res), { applicationId: archived.id });
      assert.equal((await dev().get(`/screens/${s.id}`)).status, 200);
    });

    it('the order is 404 -> APPLICATION_ARCHIVED -> APP_CONTEXT_PROTECTED -> SCREEN_IN_REVIEW', async () => {
      const archived = await insertApplication(t, { name: 'Order archived deleters' });
      await setApplicationStatus(t, archived.id, 'ARCHIVED');
      // The App (OnStart) screen of an archived application: the archive wins.
      assert.equal(bodyOf(await dev().delete(`/screens/${archived.appContextScreenId}`)).code, 'APPLICATION_ARCHIVED');
      // The App (OnStart) screen in review: the protection of the screen wins over the review.
      const active = await insertApplication(t, { name: 'Order active deleters' });
      await t.owner.query(`UPDATE screen SET documentation_status = 'IN_REVIEW' WHERE id = $1`, [
        active.appContextScreenId,
      ]);
      assert.equal(bodyOf(await dev().delete(`/screens/${active.appContextScreenId}`)).code, 'APP_CONTEXT_PROTECTED');
    });

    it('401 without a token; 403 for a Reader with requiredRoles and the screen stays', async () => {
      const { screen } = await createScreenVia(dev(), app.id, { name: 'Protected from readers' });
      assert.equal((await t.http.delete(`/api/v1/screens/${screen.id}`)).status, 401);
      const res = await reader().delete(`/screens/${screen.id}`);
      assert.equal(res.status, 403);
      assert.deepEqual(bodyOf(res).details, { requiredRoles: ['ADMINISTRATOR', 'DEVELOPER'] });
      assert.equal((await dev().get(`/screens/${screen.id}`)).status, 200);
    });
  });

  describe('D-83: variables left without origin by a deletion', () => {
    it('two context variables without origin may share a name; editing one is free, renaming to a taken name is 409', async () => {
      const names = ['locTwin', 'locTwin', 'locSolo'];
      const variables = [];
      for (const [i, name] of names.entries()) {
        const screen = (await createScreenVia(dev(), app.id, { name: `D83 origin ${i}` })).screen;
        const v = variableOf(
          await dev().post('/variables', variableBody(app.id, { name, scope: 'CONTEXT', originScreenId: screen.id })),
        );
        variables.push(v);
        assert.equal((await dev().delete(`/screens/${screen.id}`)).status, 204);
      }
      const [twinA, twinB, solo] = await Promise.all(
        variables.map(async (v) => variableOf(await dev().get(`/variables/${v.id}`))),
      );
      assert.deepEqual([twinA!.originScreen, twinB!.originScreen, solo!.originScreen], [null, null, null]);

      const describeOne = await dev().put(
        `/variables/${twinA!.id}`,
        variablePut(twinA!, { description: 'Edited after the deletion.' }),
      );
      assert.equal(describeOne.status, 200, JSON.stringify(describeOne.body));
      assert.equal(variableOf(describeOne).description, 'Edited after the deletion.');

      const clash = await dev().put(`/variables/${twinB!.id}`, variablePut(twinB!, { name: 'locSolo' }));
      assert.equal(clash.status, 409);
      assert.equal(bodyOf(clash).code, 'DUPLICATE_NAME');
      assert.deepEqual(detailsOf(clash), {
        field: 'name',
        type: 'context variable',
        name: 'locSolo',
        application: 'Screen deleters',
        container: 'application',
      });
      const free = await dev().put(`/variables/${twinB!.id}`, variablePut(twinB!, { name: 'locTwinRenamed' }));
      assert.equal(free.status, 200);
    });
  });

  describe('Module 3 regression: a collection that assigns a context variable whose origin screen is deleted', () => {
    it('editing another part of the collection afterwards still works', async () => {
      const origin = (await createScreenVia(dev(), app.id, { name: 'Assigner origin' })).screen;
      const ctx = variableOf(
        await dev().post(
          '/variables',
          variableBody(app.id, { name: 'locAssigned', scope: 'CONTEXT', originScreenId: origin.id }),
        ),
      );
      const created = await dev().post('/collections', collectionBody(app.id, { name: 'colAssigner' }));
      const collection = collectionOf(created);
      const assigned = await dev().put(
        `/collections/${collection.id}`,
        collectionPut(collection, {
          variableAssignments: [
            { variableId: ctx.id, screenId: origin.id, assignmentFunction: 'UPDATE_CONTEXT', usedIn: 'OnVisible' },
          ],
        }),
        String(created.headers.etag),
      );
      assert.equal(assigned.status, 200, JSON.stringify(assigned.body));

      assert.equal((await dev().delete(`/screens/${origin.id}`)).status, 204);

      const current = await dev().get(`/collections/${collection.id}`);
      const edited = await dev().put(
        `/collections/${collection.id}`,
        collectionPut(collectionOf(current), { description: 'Edited after the origin was deleted.' }),
        String(current.headers.etag),
      );
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(collectionOf(edited).description, 'Edited after the origin was deleted.');
    });
  });
});
