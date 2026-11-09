/**
 * Rows removed by cascade in the audit log (FR-20, FR-21, NFR-20): documents the CURRENT behavior of
 * `audit_row_change()` for every way an element can disappear with rows hanging from it.
 *
 * Every row the database removes is audited as a DELETE, so the records exist and are found by `entityType` +
 * `entityId` or by date. But a table without an `application_id` column gets its application from `documented_element`,
 * looked up by the first non-null of `screen_id`, `element_id`, `source_id`, `collection_id`, `variable_id`; when the
 * element behind that id was removed by the same cascade the lookup finds nothing and `application_id` is NULL, so the
 * `applicationId` filter does not return the record. The test fixes the EXACT set of (case, entity type) pairs with a
 * NULL application, taken from the runs below. It passes with the current derivation and FAILS when someone corrects
 * it, to force the documentation (D-108, Bruno README) to be updated.
 *
 * Cases: (a) a screen with components that have uses, navigations to and from it, links, assignments, Jira tickets,
 * comments and a variable whose origin it is; (b) a variable with environments, links, assignments and uses;
 * (c) a collection; (d) a `PUT` of a screen that removes a component that has uses (the element is not deleted by
 * `DELETE`, its rows are removed in cascade just the same).
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import {
  insertApplication,
  insertCollection,
  insertComments,
  insertComponent,
  insertDependency,
  insertScreen,
  insertScreenCollection,
  insertScreenVariable,
  insertSubtasks,
  insertVariable,
  insertVariableCollection,
} from '../helpers/fixtures.js';
import { collectionOf, createBodyOf as collectionBody } from '../helpers/collections.js';
import { createBodyOf as screenBody, putBodyOf as screenPut, screenOf } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';
import { createBodyOf as variableBody, variableOf } from '../helpers/variables.js';

type Row = {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  application_id: number | null;
  entity_label: string | null;
};
type Entry = { id: string; applicationId: number | null };
type Case = { label: string; applicationId: number; rows: Row[] };

/** The exact (case, entity_type) pairs whose records have a NULL application_id today. */
const EXPECTED_NULL: Record<string, string[]> = {
  a: ['comment', 'dependency', 'jira_ticket', 'screen_collection', 'screen_variable', 'variable_collection'],
  b: ['element_environment'],
  c: ['collection_field', 'dependency', 'element_environment'],
  d: ['dependency'],
};

describe('audit: rows removed by cascade (current behavior)', () => {
  let t: TestApp;
  const cases: Case[] = [];
  const tables: string[] = [];

  const adminGet = (query: Record<string, string | number>) =>
    t.http.get('/api/v1/audit-log').query(query).set('Authorization', `Bearer ${t.users.admin.token}`);

  /** Runs `act` and keeps the audit rows written meanwhile (this database is used by one test file at a time). */
  async function capture(label: string, applicationId: number, act: () => Promise<void>): Promise<void> {
    const mark = Number(
      (await t.owner.query<{ m: string }>('SELECT coalesce(max(id), 0) AS m FROM audit_log')).rows[0]!.m,
    );
    await act();
    const rows = (
      await t.owner.query<Row>(
        `SELECT id::text, entity_type, entity_id, action, application_id, entity_label
           FROM audit_log WHERE id > $1 ORDER BY id`,
        [mark],
      )
    ).rows;
    const pad = (v: string | number | null, n: number) => String(v ?? 'NULL').padEnd(n);
    tables.push(
      [
        `CASE ${label} (application ${applicationId})`,
        `${pad('entity_type', 20)}${pad('action', 8)}${pad('application_id', 16)}entity_label`,
        ...rows.map((r) => `${pad(r.entity_type, 20)}${pad(r.action, 8)}${pad(r.application_id, 16)}${r.entity_label}`),
      ].join('\n'),
    );
    cases.push({ label, applicationId, rows });
  }

  before(async () => {
    t = await startTestApp();
    try {
      const admin = asUser(t, t.users.admin.token);

      // (a) A screen with everything that hangs from it.
      {
        const app = await insertApplication(t, { name: 'Cascade screen' });
        const screen = await insertScreen(t, app.id, { name: 'scrA' });
        const other = await insertScreen(t, app.id, { name: 'scrOther' });
        const variable = await insertVariable(t, app.id, { name: 'gA', environments: [{ environment: 'DEV' }] });
        await insertVariable(t, app.id, { name: 'locA', scope: 'CONTEXT', originScreenId: screen.id });
        const collection = await insertCollection(t, app.id, { name: 'colA' });
        const k1 = await insertComponent(t, app.id, screen.id, { name: 'btnA1' });
        const k2 = await insertComponent(t, app.id, screen.id, { name: 'btnA2' });
        await insertDependency(t, { sourceId: k1.id, targetId: variable.id, relationType: 'USES' });
        await insertDependency(t, { sourceId: k2.id, targetId: collection.id, relationType: 'USES' });
        await insertDependency(t, { sourceId: screen.id, targetId: other.id, relationType: 'NAVIGATES_TO' });
        await insertDependency(t, { sourceId: other.id, targetId: screen.id, relationType: 'NAVIGATES_TO' });
        await insertScreenVariable(t, {
          screenId: screen.id,
          variableId: variable.id,
          accessMode: 'READ',
          usedIn: 'svA',
        });
        await insertScreenCollection(t, {
          screenId: screen.id,
          collectionId: collection.id,
          accessMode: 'READ',
          usedIn: 'scA',
        });
        await insertVariableCollection(t, {
          variableId: variable.id,
          collectionId: collection.id,
          screenId: screen.id,
          usedIn: 'vcA',
          assignmentFunction: 'SET',
          tableFunction: 'First',
        });
        await insertSubtasks(t, screen.id, ['TO_DO', 'DONE']);
        await insertComments(t, screen.id, 2);
        await capture('a', app.id, async () => {
          assert.equal((await admin.delete(`/screens/${screen.id}`)).status, 204);
        });
      }

      // (b) A variable with environments, links from screens, an assignment and a use.
      {
        const app = await insertApplication(t, { name: 'Cascade variable' });
        const screen = await insertScreen(t, app.id, { name: 'scrB' });
        const other = await insertScreen(t, app.id, { name: 'scrB2' });
        const variable = await insertVariable(t, app.id, {
          name: 'gB',
          environments: [{ environment: 'DEV' }, { environment: 'PROD' }],
        });
        const collection = await insertCollection(t, app.id, { name: 'colB' });
        const component = await insertComponent(t, app.id, screen.id, { name: 'btnB' });
        await insertScreenVariable(t, {
          screenId: screen.id,
          variableId: variable.id,
          accessMode: 'READ',
          usedIn: 'svB1',
        });
        await insertScreenVariable(t, {
          screenId: other.id,
          variableId: variable.id,
          accessMode: 'WRITE',
          usedIn: 'svB2',
        });
        await insertVariableCollection(t, {
          variableId: variable.id,
          collectionId: collection.id,
          screenId: screen.id,
          usedIn: 'vcB',
          assignmentFunction: 'SET',
        });
        await insertDependency(t, { sourceId: component.id, targetId: variable.id, relationType: 'USES' });
        await capture('b', app.id, async () => {
          assert.equal((await admin.delete(`/variables/${variable.id}`)).status, 204);
        });
      }

      // (c) A collection with fields, environments, an assignment, a link from a screen and a derivation.
      {
        const app = await insertApplication(t, { name: 'Cascade collection' });
        const variable = variableOf(await admin.post('/variables', variableBody(app.id, { name: 'gC' })));
        const base = collectionOf(await admin.post('/collections', collectionBody(app.id, { name: 'colBase' })));
        const created = await admin.post(
          '/collections',
          collectionBody(app.id, {
            name: 'colC',
            environments: [{ environment: 'DEV' }, { environment: 'PROD' }],
            fields: [
              { name: 'colA', dataType: 'TEXT', position: 1 },
              { name: 'colB', dataType: 'NUMBER', position: 2 },
            ],
            variableAssignments: [
              {
                variableId: variable.id,
                screenId: app.appContextScreenId,
                assignmentFunction: 'SET',
                tableFunction: 'First',
                usedIn: 'OnStart',
              },
            ],
            derivedFrom: [base.id],
          }),
        );
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const colId = collectionOf(created).id;
        const screen = await insertScreen(t, app.id, { name: 'scrC' });
        await insertScreenCollection(t, {
          screenId: screen.id,
          collectionId: colId,
          accessMode: 'READ',
          usedIn: 'Gallery.Items',
        });
        await capture('c', app.id, async () => {
          assert.equal((await admin.delete(`/collections/${colId}`)).status, 204);
        });
      }

      // (d) A PUT of a screen that removes a component with uses.
      {
        const app = await insertApplication(t, { name: 'Cascade put' });
        const variable = variableOf(await admin.post('/variables', variableBody(app.id, { name: 'gD' })));
        const created = await admin.post(
          '/screens',
          screenBody(app.id, {
            name: 'scrD',
            components: [
              {
                name: 'btnD',
                type: 'Button',
                onSelect: null,
                description: null,
                uses: [{ targetType: 'VARIABLE', targetId: variable.id, description: null }],
              },
              { name: 'btnKeep', type: 'Button', onSelect: null, description: null, uses: [] },
            ],
          }),
        );
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const screen = screenOf(created);
        const kept = screen.components.filter((c) => c.name === 'btnKeep');
        await capture('d', app.id, async () => {
          const put = await admin.put(`/screens/${screen.id}`, screenPut(screen, { components: kept }));
          assert.equal(put.status, 200, JSON.stringify(put.body));
        });
      }
      console.log(`CASCADE AUDIT TABLES\n${tables.join('\n\n')}`);
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    await t.close();
  });

  const all = () =>
    cases.flatMap((c) => c.rows.map((r) => ({ ...r, label: c.label, caseApplicationId: c.applicationId })));
  const typesOf = (label: string) =>
    new Set(cases.find((c) => c.label === label)!.rows.map((r) => `${r.action} ${r.entity_type}`));

  it('every row removed in the four cases is audited', () => {
    const expected: Record<string, string[]> = {
      a: [
        'DELETE screen',
        'DELETE component',
        'DELETE dependency',
        'DELETE screen_variable',
        'DELETE screen_collection',
        'DELETE variable_collection',
        'DELETE jira_ticket',
        'DELETE comment',
        'UPDATE variable',
      ],
      b: [
        'DELETE variable',
        'DELETE element_environment',
        'DELETE screen_variable',
        'DELETE variable_collection',
        'DELETE dependency',
      ],
      c: [
        'DELETE collection',
        'DELETE collection_field',
        'DELETE element_environment',
        'DELETE variable_collection',
        'DELETE dependency',
        'DELETE screen_collection',
      ],
      d: ['DELETE component', 'DELETE dependency'],
    };
    for (const [label, wanted] of Object.entries(expected)) {
      for (const type of wanted) assert.ok(typesOf(label).has(type), `(${label}) ${type}`);
    }
  });

  it('the elements deleted directly keep their application', () => {
    for (const [label, type] of [
      ['a', 'screen'],
      ['b', 'variable'],
      ['c', 'collection'],
    ] as const) {
      const own = cases
        .find((c) => c.label === label)!
        .rows.filter((r) => r.entity_type === type && r.action === 'DELETE');
      assert.ok(own.length >= 1 && own.every((r) => r.application_id !== null), `${label} ${type}`);
    }
  });

  it('the exact (case, entity_type) pairs with a NULL application_id', () => {
    const actual: Record<string, string[]> = {};
    for (const c of cases) {
      actual[c.label] = [...new Set(c.rows.filter((r) => r.application_id === null).map((r) => r.entity_type))].sort();
    }
    assert.deepEqual(actual, EXPECTED_NULL, 'a fix of the derivation changed this behavior: update D-108');
  });

  it('by entityType and entityId every record is found, with the application it has', async () => {
    for (const row of all()) {
      const res = await adminGet({ entityType: row.entity_type, entityId: row.entity_id, action: row.action });
      assert.equal(res.status, 200);
      await assertConformsToContract(res);
      const found = (res.body as { data: Entry[] }).data.filter((e) => e.id === row.id);
      assert.equal(found.length, 1, `${row.label} ${row.entity_type} ${row.entity_id}`);
      assert.equal(found[0]!.applicationId, row.application_id);
    }
  });

  /** Every id the API returns for a filter, page by page. */
  async function idsOf(query: Record<string, string | number>): Promise<Set<string>> {
    const ids = new Set<string>();
    const first = (await adminGet({ ...query, pageSize: 100 })).body as { total: number };
    for (let page = 1; ids.size < first.total; page += 1) {
      const body = (await adminGet({ ...query, pageSize: 100, page })).body as { data: Entry[] };
      for (const e of body.data) ids.add(e.id);
    }
    return ids;
  }

  it('by date every record is found', async () => {
    const first = (
      await t.owner.query<{ at: Date }>('SELECT created_at AS at FROM audit_log WHERE id = $1', [all()[0]!.id])
    ).rows[0]!.at;
    const ids = await idsOf({ from: first.toISOString() });
    for (const row of all()) assert.ok(ids.has(row.id), `${row.label} ${row.entity_type} ${row.entity_id}`);
  });

  it('by applicationId only the records that have an application appear', async () => {
    for (const c of cases) {
      const ids = await idsOf({ applicationId: c.applicationId });
      for (const row of c.rows) {
        assert.equal(
          ids.has(row.id),
          row.application_id === c.applicationId,
          `${c.label} ${row.entity_type} ${row.entity_id}`,
        );
      }
    }
  });
});
