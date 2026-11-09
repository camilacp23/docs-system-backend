/**
 * Module 3, DELETE /collections/{id} (FR-08; SDD Table 49; D-47) and the integration with Module 2: the database
 * cascades fields, assignments, screen links and dependencies in both directions, the deletion is audited with the
 * actor, and the assignments written through a collection are visible and protected from the variable side.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { collectionOf, createBodyOf, putBodyOf, type CollectionBody } from '../helpers/collections.js';
import {
  insertApplication,
  insertScreen,
  insertScreenCollection,
  insertVariable,
  setApplicationStatus,
} from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';
import {
  createBodyOf as variableBodyOf,
  dependenciesOf,
  detailsOf,
  putBodyOf as variablePutBody,
  variableOf,
} from '../helpers/variables.js';

type Ref = { id: number; name: string };

describe('collections: delete and Module 2 integration', () => {
  let t: TestApp;
  let app: { id: number; name: string };
  let s1: Ref;
  let s2: Ref;
  let gA: Ref;

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Collections deleters' });
    s1 = await insertScreen(t, app.id, { name: 'Solicitudes' });
    s2 = await insertScreen(t, app.id, { name: 'Detalle' });
    gA = await insertVariable(t, app.id, { name: 'gA' });
  });
  after(async () => {
    await t.close();
  });

  const admin = () => asUser(t, t.users.admin.token);
  const dev = () => asUser(t, t.users.developer.token);
  const reader = () => asUser(t, t.users.reader.token);

  async function create(over: Record<string, unknown> = {}, applicationId = app.id): Promise<CollectionBody> {
    const res = await dev().post('/collections', createBodyOf(applicationId, over));
    if (res.status !== 201) throw new Error(`fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
    return collectionOf(res);
  }
  const count = async (sql: string, id: number) => (await t.owner.query(sql, [id])).rowCount;

  describe('DELETE /collections/{id}', () => {
    it('204; fields, assignments, screen links and dependencies in BOTH directions cascade, audited with the actor', async () => {
      const source = await create({ name: 'colSource' });
      const sibling = await create({ name: 'colSibling' });
      const victim = await create({
        name: 'colVictim',
        environments: [{ environment: 'DEV' }, { environment: 'PROD' }],
        fields: [
          { name: 'Id', dataType: 'NUMBER' },
          { name: 'Nombre', dataType: 'TEXT' },
        ],
        variableAssignments: [
          { variableId: gA.id, screenId: s1.id, assignmentFunction: 'SET', usedIn: 'OnVisible' },
          { variableId: gA.id, screenId: s2.id, assignmentFunction: 'SET', usedIn: 'OnVisible' },
        ],
        derivedFrom: [source.id], // the victim derives from `source` (outgoing)
      });
      // `sibling` derives from the victim (incoming): the victim is the SOURCE of another collection's derivation.
      const siblingPut = await dev().put(
        `/collections/${sibling.id}`,
        putBodyOf(sibling, { derivedFrom: [victim.id] }),
      );
      assert.equal(siblingPut.status, 200, JSON.stringify(siblingPut.body));
      await insertScreenCollection(t, {
        screenId: s1.id,
        collectionId: victim.id,
        accessMode: 'READ',
        usedIn: 'Gallery1.Items',
      });

      const dependencyCount = (
        await t.owner.query('SELECT 1 FROM dependency WHERE source_id = $1 OR target_id = $1', [victim.id])
      ).rowCount;
      assert.equal(dependencyCount, 2);
      assert.equal(await count('SELECT 1 FROM screen_collection WHERE collection_id = $1', victim.id), 1);

      const res = await dev().delete(`/collections/${victim.id}`);
      assert.equal(res.status, 204);
      assert.equal(res.text, '');
      for (const sql of [
        'SELECT 1 FROM documented_element WHERE id = $1',
        'SELECT 1 FROM collection WHERE id = $1',
        'SELECT 1 FROM element_environment WHERE element_id = $1',
        'SELECT 1 FROM collection_field WHERE collection_id = $1',
        'SELECT 1 FROM variable_collection WHERE collection_id = $1',
        'SELECT 1 FROM screen_collection WHERE collection_id = $1',
        'SELECT 1 FROM dependency WHERE source_id = $1 OR target_id = $1',
      ]) {
        assert.equal(await count(sql, victim.id), 0, sql);
      }
      // What it pointed at, and what pointed at it, survives.
      assert.equal(await count('SELECT 1 FROM collection WHERE id = $1', source.id), 1);
      assert.equal(await count('SELECT 1 FROM collection WHERE id = $1', sibling.id), 1);
      assert.equal(await count('SELECT 1 FROM variable WHERE id = $1', gA.id), 1);
      assert.equal(await count('SELECT 1 FROM screen WHERE id = $1', s1.id), 1);
      assert.deepEqual(collectionOf(await admin().get(`/collections/${sibling.id}`)).derivedFrom, []);
      assert.equal((await admin().get(`/collections/${victim.id}`)).status, 404);

      const deleted = async (entityType: string, sql: string) =>
        (
          await t.owner.query<{ actor_user_id: number | null }>(
            `SELECT actor_user_id FROM audit_log WHERE action = 'DELETE' AND entity_type = $1 AND ${sql}`,
            [entityType, String(victim.id)],
          )
        ).rows;
      for (const [entityType, where, expected] of [
        ['collection', `old_value ->> 'id' = $2`, 1],
        ['element_environment', `old_value ->> 'element_id' = $2`, 2],
        ['collection_field', `old_value ->> 'collection_id' = $2`, 2],
        ['variable_collection', `old_value ->> 'collection_id' = $2`, 2],
        ['screen_collection', `old_value ->> 'collection_id' = $2`, 1],
        ['dependency', `(old_value ->> 'source_id' = $2 OR old_value ->> 'target_id' = $2)`, 2],
      ] as const) {
        const rows = await deleted(entityType, where);
        assert.equal(rows.length, expected, entityType);
        assert.ok(
          rows.every((r) => r.actor_user_id === t.users.developer.id),
          `${entityType}: actor`,
        );
      }
    });

    it('the administrator may delete; 403 for a Reader and 401 without token', async () => {
      const c = await create();
      assert.equal((await reader().delete(`/collections/${c.id}`)).status, 403);
      assert.equal((await t.http.delete(`/api/v1/collections/${c.id}`)).status, 401);
      assert.equal(await count('SELECT 1 FROM collection WHERE id = $1', c.id), 1);
      assert.equal((await admin().delete(`/collections/${c.id}`)).status, 204);
    });

    it('404 for an unknown id, also outside the integer range, and for a second delete', async () => {
      assert.equal((await dev().delete('/collections/999999')).status, 404);
      const huge = await dev().delete('/collections/99999999999');
      assert.equal(huge.status, 404);
      assert.equal(bodyOf(huge).details.element, 'collection');
      assert.equal((await dev().delete('/collections/abc')).status, 400);
      const c = await create();
      assert.equal((await dev().delete(`/collections/${c.id}`)).status, 204);
      assert.equal((await dev().delete(`/collections/${c.id}`)).status, 404);
    });

    it('422 APPLICATION_ARCHIVED on an archived application, and the collection stays', async () => {
      const archived = await insertApplication(t);
      try {
        const res = await dev().post(
          '/collections',
          createBodyOf(archived.id, { fields: [{ name: 'Id', dataType: 'TEXT' }] }),
        );
        const c = collectionOf(res);
        await setApplicationStatus(t, archived.id, 'ARCHIVED');
        const del = await dev().delete(`/collections/${c.id}`);
        assert.equal(del.status, 422);
        assert.equal(bodyOf(del).code, 'APPLICATION_ARCHIVED');
        assert.deepEqual(detailsOf(del), { applicationId: archived.id });
        assert.equal(await count('SELECT 1 FROM collection WHERE id = $1', c.id), 1);
        assert.equal(await count('SELECT 1 FROM collection_field WHERE collection_id = $1', c.id), 1);
      } finally {
        await setApplicationStatus(t, archived.id, 'ACTIVE');
      }
    });
  });

  describe('integration with Module 2', () => {
    it('an assignment created by PUT /collections appears in GET /variables/{id}/dependencies', async () => {
      const variable = variableOf(await dev().post('/variables', variableBodyOf(app.id, { name: 'gViaCollection' })));
      const c = await create({ name: 'colFeeds' });
      const res = await dev().put(
        `/collections/${c.id}`,
        putBodyOf(c, {
          variableAssignments: [
            {
              variableId: variable.id,
              screenId: s1.id,
              assignmentFunction: 'SET',
              tableFunction: 'CountRows',
              usedIn: 'OnVisible',
            },
          ],
        }),
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const dependencies = dependenciesOf(await admin().get(`/variables/${variable.id}/dependencies`));
      assert.equal(dependencies.collections.length, 1);
      assert.equal(dependencies.collections[0]!.collection.name, 'colFeeds');
      assert.equal(dependencies.collections[0]!.screen.id, s1.id);
      assert.equal(dependencies.collections[0]!.assignmentFunction, 'SET');
      assert.equal(dependencies.collections[0]!.tableFunction, 'CountRows');
      assert.equal(dependencies.collections[0]!.id, collectionOf(res).variableAssignments[0]!.id);
    });

    it('a PUT /variables that changes the scope while such an assignment exists still gives SCOPE_CONFLICT', async () => {
      const variable = variableOf(await dev().post('/variables', variableBodyOf(app.id, { name: 'gProtected' })));
      const c = await create({
        variableAssignments: [
          { variableId: variable.id, screenId: s1.id, assignmentFunction: 'SET', usedIn: 'OnVisible' },
        ],
      });
      const res = await dev().put(
        `/variables/${variable.id}`,
        variablePutBody(variable, { scope: 'CONTEXT', originScreenId: s1.id }),
      );
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'SCOPE_CONFLICT');
      assert.deepEqual(detailsOf(res), { function: 'Set' });
      // Once the assignment is gone the scope can change.
      const cleared = await dev().put(`/collections/${c.id}`, putBodyOf(c, { variableAssignments: [] }));
      assert.equal(cleared.status, 200);
      const changed = await dev().put(
        `/variables/${variable.id}`,
        variablePutBody(variable, { scope: 'CONTEXT', originScreenId: s1.id }),
      );
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
    });

    it('deleting a collection frees its variables: they show no collections afterwards', async () => {
      const variable = variableOf(await dev().post('/variables', variableBodyOf(app.id, { name: 'gFreed' })));
      const c = await create({
        variableAssignments: [
          { variableId: variable.id, screenId: s1.id, assignmentFunction: 'SET', usedIn: 'OnVisible' },
        ],
      });
      assert.equal(dependenciesOf(await admin().get(`/variables/${variable.id}/dependencies`)).collections.length, 1);
      assert.equal((await dev().delete(`/collections/${c.id}`)).status, 204);
      assert.equal(dependenciesOf(await admin().get(`/variables/${variable.id}/dependencies`)).collections.length, 0);
    });
  });

  it('the six collection operations are implemented (no NOT_IMPLEMENTED)', () => {
    for (const operationId of [
      'listCollections',
      'createCollection',
      'getCollection',
      'updateCollection',
      'deleteCollection',
      'listCollectionFields',
    ]) {
      assert.ok(!t.built.notImplemented.includes(operationId), operationId);
    }
  });
});
