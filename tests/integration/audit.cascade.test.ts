/**
 * Cascaded deletes in the audit log (FR-20, FR-21, NFR-20): documents the CURRENT behavior of `audit_row_change()`.
 *
 * When a collection or a screen is deleted through the API, the database cascades to the rows that hang from it
 * (fields, environments, links, assignments, dependencies, components, comments). Every one of them is audited as a
 * DELETE, so the records exist and are found by `entityType` + `entityId` or by date. But the function derives the
 * application of a row that has no `application_id` column by reading `documented_element`, and that row is already
 * gone when the trigger of the cascaded row runs (an AFTER trigger): `application_id` is NULL, and `applicationId`
 * does not find them. This test passes today and is meant to FAIL when someone fixes the derivation, so that the
 * documentation (Bruno README, D-108) is updated with it. The elements deleted directly keep their `application_id`.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { createApplication } from '../helpers/applications.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { asUser } from '../helpers/users.js';
import { collectionOf, createBodyOf as collectionBody } from '../helpers/collections.js';
import { createBodyOf as screenBody, screenOf } from '../helpers/screens.js';
import { createBodyOf as variableBody, variableOf } from '../helpers/variables.js';

type Row = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  application_id: number | null;
  entity_label: string | null;
};
type Entry = { id: string; entityType: string; entityId: string; applicationId: number | null; action: string };

describe('audit: cascaded deletes (current behavior)', () => {
  let t: TestApp;
  let applicationId: number;
  let deleted: Row[];
  let tableText = '';

  const adminGet = (query: Record<string, string | number>) =>
    t.http.get('/api/v1/audit-log').query(query).set('Authorization', `Bearer ${t.users.admin.token}`);

  before(async () => {
    t = await startTestApp();
    try {
      const admin = asUser(t, t.users.admin.token);
      applicationId = (await createApplication(t, t.users.admin.token)).application.id;
      const appScreen = (
        await t.owner.query<{ id: number }>('SELECT id FROM screen WHERE application_id = $1 AND is_app_context', [
          applicationId,
        ])
      ).rows[0]!.id;
      const variable = variableOf(await admin.post('/variables', variableBody(applicationId, { name: 'gCascade' })));
      const base = collectionOf(await admin.post('/collections', collectionBody(applicationId, { name: 'colBase' })));
      // A collection with fields, environments, an assignment of a variable on a screen, and a derivation.
      const collection = await admin.post(
        '/collections',
        collectionBody(applicationId, {
          name: 'colCascade',
          environments: [{ environment: 'DEV' }, { environment: 'PROD' }],
          fields: [
            { name: 'colA', dataType: 'TEXT', position: 1 },
            { name: 'colB', dataType: 'NUMBER', position: 2 },
          ],
          variableAssignments: [
            {
              variableId: variable.id,
              screenId: appScreen,
              assignmentFunction: 'SET',
              tableFunction: 'First',
              usedIn: 'OnStart',
            },
          ],
          derivedFrom: [base.id],
        }),
      );
      assert.equal(collection.status, 201, JSON.stringify(collection.body));
      const colId = collectionOf(collection).id;
      // A screen with a component that uses the variable, a variable link and a collection link.
      const screen = await admin.post(
        '/screens',
        screenBody(applicationId, {
          name: 'scrCascade',
          components: [
            {
              name: 'btnGo',
              type: 'Button',
              onSelect: null,
              description: null,
              uses: [{ targetType: 'VARIABLE', targetId: variable.id, description: null }],
            },
          ],
          variableLinks: [{ variableId: variable.id, accessMode: 'READ', usedIn: 'OnVisible' }],
          collectionLinks: [{ collectionId: colId, accessMode: 'READ', usedIn: 'Gallery.Items' }],
        }),
      );
      assert.equal(screen.status, 201, JSON.stringify(screen.body));
      const scrId = screenOf(screen).id;

      const mark = Number(
        (await t.owner.query<{ m: string }>('SELECT coalesce(max(id), 0) AS m FROM audit_log')).rows[0]!.m,
      );
      assert.equal((await admin.delete(`/collections/${colId}`)).status, 204);
      assert.equal((await admin.delete(`/screens/${scrId}`)).status, 204);
      deleted = (
        await t.owner.query<Row>(
          `SELECT id::text, entity_type, entity_id, action, application_id, entity_label
             FROM audit_log WHERE id > $1 ORDER BY id`,
          [mark],
        )
      ).rows;
      const pad = (v: string | number | null, n: number) => String(v ?? 'NULL').padEnd(n);
      tableText = [
        `${pad('entity_type', 20)}${pad('action', 8)}${pad('application_id', 16)}entity_label`,
        ...deleted.map(
          (r) => `${pad(r.entity_type, 20)}${pad(r.action, 8)}${pad(r.application_id, 16)}${r.entity_label}`,
        ),
      ].join('\n');
      console.log(`CASCADE AUDIT TABLE (application ${applicationId})\n${tableText}`);
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    await t.close();
  });

  const OWN = new Set(['collection', 'screen']);

  it('every row removed by the two deletes is audited as a DELETE', () => {
    assert.ok(deleted.length >= 10, `${deleted.length} records`);
    assert.ok(deleted.every((r) => r.action === 'DELETE'));
    const types = new Set(deleted.map((r) => r.entity_type));
    for (const type of [
      'collection',
      'collection_field',
      'element_environment',
      'variable_collection',
      'dependency',
      'screen',
      'component',
      'screen_variable',
      'screen_collection',
    ]) {
      assert.ok(types.has(type), `${type} is audited`);
    }
  });

  it('the elements deleted directly keep their application', () => {
    const own = deleted.filter((r) => OWN.has(r.entity_type));
    assert.equal(own.length, 2);
    assert.ok(own.every((r) => r.application_id === applicationId));
  });

  it('the rows removed by cascade have a NULL application_id today (the derivation cannot find the deleted parent)', () => {
    const cascaded = deleted.filter((r) => !OWN.has(r.entity_type));
    assert.ok(cascaded.length >= 8);
    // The rows that look the application up in documented_element through an element deleted by the same cascade do not
    // find it. When a fix makes this list empty, this test fails on purpose: update D-108 and the Bruno README.
    const withoutApplication = cascaded.filter((r) => r.application_id === null).map((r) => r.entity_type);
    assert.ok(withoutApplication.length > 0, 'a fix of the derivation changed this behavior: update D-108');
    assert.deepEqual([...new Set(withoutApplication)].sort(), [
      'collection_field',
      'dependency',
      'element_environment',
      'screen_variable',
    ]);
    // The rows whose lookup still finds a living element keep the application: a link row is found through the screen
    // that was not deleted yet (screen_collection, variable_collection), and `component` has the column itself.
    for (const type of ['screen_collection', 'variable_collection', 'component']) {
      assert.ok(
        cascaded.filter((r) => r.entity_type === type).every((r) => r.application_id === applicationId),
        type,
      );
    }
  });

  it('by entityType and entityId the cascaded records are found', async () => {
    for (const row of deleted.filter((r) => !OWN.has(r.entity_type))) {
      const res = await adminGet({ entityType: row.entity_type, entityId: row.entity_id, action: 'DELETE' });
      assert.equal(res.status, 200);
      await assertConformsToContract(res);
      const found = (res.body as { data: Entry[] }).data.filter((e) => e.id === row.id);
      assert.equal(found.length, 1, `${row.entity_type} ${row.entity_id}`);
      assert.equal(found[0]!.applicationId, row.application_id);
    }
  });

  it('by date the cascaded records are found', async () => {
    const first = (
      await t.owner.query<{ at: Date }>('SELECT created_at AS at FROM audit_log WHERE id = $1', [deleted[0]!.id])
    ).rows[0]!.at;
    const res = await adminGet({ from: first.toISOString(), action: 'DELETE', pageSize: 100 });
    const ids = new Set((res.body as { data: Entry[] }).data.map((e) => e.id));
    for (const row of deleted) assert.ok(ids.has(row.id), `${row.entity_type} ${row.entity_id}`);
  });

  it('by applicationId only the records that have an application appear', async () => {
    const res = await adminGet({ applicationId, action: 'DELETE', pageSize: 100 });
    assert.equal(res.status, 200);
    const ids = new Set((res.body as { data: Entry[] }).data.map((e) => e.id));
    for (const row of deleted) {
      assert.equal(ids.has(row.id), row.application_id === applicationId, `${row.entity_type} ${row.entity_id}`);
    }
    const missing = deleted.filter((r) => r.application_id === null);
    assert.ok(missing.length > 0 && missing.every((r) => !ids.has(r.id)));
  });
});
