/**
 * Module 3, PUT /collections/{id} (FR-08, FR-09; SDD Table 49; D-26, D-47, D-62, D-65, D-71 for the shared
 * "write only what changes" semantics, D-74 to D-76): reconciliation by id, swaps under non-deferrable unique
 * indexes, derivations, If-Match and the order of the errors.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import {
  auditCount,
  auditRows,
  collectionOf,
  createBodyOf,
  putBodyOf,
  type CollectionBody,
} from '../helpers/collections.js';
import { insertApplication, insertScreen, insertVariable, setApplicationStatus } from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';
import { detailsOf } from '../helpers/variables.js';

type Ref = { id: number; name: string };

describe('collections: update', () => {
  let t: TestApp;
  let app: { id: number; name: string };
  let s1: Ref;
  let s2: Ref;
  let gA: Ref;
  let gB: Ref;
  let ctxS1: Ref;
  let foreignApp: { id: number };
  let foreignVar: Ref;

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Collections editors' });
    foreignApp = await insertApplication(t, { name: 'Foreign app' });
    s1 = await insertScreen(t, app.id, { name: 'Solicitudes' });
    s2 = await insertScreen(t, app.id, { name: 'Detalle' });
    gA = await insertVariable(t, app.id, { name: 'gA' });
    gB = await insertVariable(t, app.id, { name: 'gB' });
    ctxS1 = await insertVariable(t, app.id, { name: 'locS1', scope: 'CONTEXT', originScreenId: s1.id });
    foreignVar = await insertVariable(t, foreignApp.id, { name: 'gForeign' });
  });
  after(async () => {
    await t.close();
  });

  const admin = () => asUser(t, t.users.admin.token);
  const dev = () => asUser(t, t.users.developer.token);
  const reader = () => asUser(t, t.users.reader.token);

  const field = (name: string, over: Record<string, unknown> = {}) => ({ name, dataType: 'TEXT', ...over });
  const assignment = (variableId: number, screenId: number, over: Record<string, unknown> = {}) => ({
    variableId,
    screenId,
    assignmentFunction: 'SET',
    usedIn: 'OnVisible',
    ...over,
  });

  /** Creates a collection through the API as the developer and returns it with its ETag. */
  async function create(over: Record<string, unknown> = {}, applicationId = app.id) {
    const res = await dev().post('/collections', createBodyOf(applicationId, over));
    if (res.status !== 201) throw new Error(`fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { c: collectionOf(res), etag: res.headers.etag as string };
  }
  const fetchCollection = async (id: number): Promise<CollectionBody> =>
    collectionOf(await admin().get(`/collections/${id}`));

  /** Actions recorded for one nested row. */
  const actions = async (entityType: string, id: number) =>
    (await auditRows(t, entityType, String(id))).map((r) => r.action);

  async function withArchivedApplication<T>(fn: (a: { id: number; name: string }) => Promise<T>): Promise<T> {
    const a = await insertApplication(t);
    try {
      return await fn(a);
    } finally {
      await setApplicationStatus(t, a.id, 'ACTIVE');
    }
  }

  describe('basic semantics', () => {
    it('200 replaces the representation, returns a new ETag and audits the actor', async () => {
      const { c, etag } = await create({
        description: 'old',
        environments: [{ environment: 'DEV', notes: 'n' }, { environment: 'PROD' }],
      });
      const res = await dev().put(
        `/collections/${c.id}`,
        putBodyOf(c, {
          name: 'colRenamed',
          description: 'new',
          creationCondition: 'ClearCollect',
          environments: [{ environment: 'PROD', notes: 'only prod' }],
        }),
        etag,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const updated = collectionOf(res);
      assert.equal(updated.id, c.id);
      assert.equal(updated.name, 'colRenamed');
      assert.equal(updated.creationCondition, 'ClearCollect');
      assert.deepEqual(updated.environmentDetails, [{ environment: 'PROD', notes: 'only prod' }]);
      assert.notEqual(res.headers.etag, etag);
      assert.equal(res.headers.etag, `W/"${new Date(updated.updatedAt).getTime()}"`);
      assert.equal((await fetchCollection(c.id)).name, 'colRenamed');
      const audit = await auditRows(t, 'collection', String(c.id));
      assert.deepEqual(
        audit.map((r) => [r.action, r.actor_user_id]),
        [
          ['CREATE', t.users.developer.id],
          ['UPDATE', t.users.developer.id],
        ],
      );
    });

    it('a PUT that changes nothing writes nothing: same ETag, no audit rows', async () => {
      const { c, etag } = await create({
        fields: [field('Id'), field('Nombre')],
        variableAssignments: [assignment(gA.id, s1.id)],
      });
      const rows = await auditCount(t);
      const res = await dev().put(`/collections/${c.id}`, putBodyOf(c), etag);
      assert.equal(res.status, 200);
      assert.equal(res.headers.etag, etag);
      assert.deepEqual(collectionOf(res), c);
      assert.equal(await auditCount(t), rows, 'no row in audit_log');
      // The same without If-Match, and with the fields left in another order of keys: still nothing.
      assert.equal((await dev().put(`/collections/${c.id}`, putBodyOf(c))).headers.etag, etag);
      assert.equal(await auditCount(t), rows);
    });

    it('changing only a nested field moves the ETag of the collection (D-62), for every nested array', async () => {
      const { c } = await create({
        fields: [field('Id')],
        variableAssignments: [assignment(gA.id, s1.id)],
        environments: [{ environment: 'DEV' }],
      });
      const other = (await create()).c;
      let current = c;
      const steps: [string, (x: CollectionBody) => Record<string, unknown>][] = [
        ['field description', (x) => putBodyOf(x, { fields: [{ ...putBodyOf(x).fields[0], description: 'changed' }] })],
        [
          'assignment table function',
          (x) =>
            putBodyOf(x, { variableAssignments: [{ ...putBodyOf(x).variableAssignments[0], tableFunction: 'First' }] }),
        ],
        ['environment notes', () => putBodyOf(current, { environments: [{ environment: 'DEV', notes: 'n' }] })],
        ['a derivation', () => putBodyOf(current, { derivedFrom: [other.id] })],
      ];
      for (const [label, body] of steps) {
        await new Promise((r) => setTimeout(r, 5));
        const res = await dev().put(
          `/collections/${c.id}`,
          body(current),
          `W/"${new Date(current.updatedAt).getTime()}"`,
        );
        assert.equal(res.status, 200, label);
        const next = collectionOf(res);
        assert.notEqual(next.updatedAt, current.updatedAt, label);
        assert.notEqual(res.headers.etag, `W/"${new Date(current.updatedAt).getTime()}"`, label);
        current = next;
      }
    });

    it('If-Match is verified ALWAYS, also when nothing changes: 412 with details.currentETag, nothing written', async () => {
      const { c, etag } = await create({ fields: [field('Id')] });
      const rows = await auditCount(t);
      const res = await dev().put(`/collections/${c.id}`, putBodyOf(c), 'W/"1"');
      assert.equal(res.status, 412);
      assert.equal(bodyOf(res).code, 'PRECONDITION_FAILED');
      assert.deepEqual(detailsOf(res), { element: 'collection', currentETag: etag });
      const changing = await dev().put(`/collections/${c.id}`, putBodyOf(c, { name: 'colNotWritten' }), 'W/"1"');
      assert.equal(changing.status, 412);
      assert.equal((await fetchCollection(c.id)).name, c.name);
      assert.equal(await auditCount(t), rows);
      // Stale after somebody else's write.
      await dev().put(`/collections/${c.id}`, putBodyOf(c, { description: 'first' }), etag);
      const stale = await dev().put(`/collections/${c.id}`, putBodyOf(c, { description: 'second' }), etag);
      assert.equal(stale.status, 412);
    });

    it('omitted arrays mean empty arrays: the fields, assignments and derivations left out are deleted', async () => {
      const base = (await create()).c;
      const { c, etag } = await create({
        fields: [field('Id')],
        variableAssignments: [assignment(gA.id, s1.id)],
        derivedFrom: [base.id],
      });
      const { fields: _f, variableAssignments: _a, derivedFrom: _d, ...bare } = putBodyOf(c);
      const res = await dev().put(`/collections/${c.id}`, bare, etag);
      assert.equal(res.status, 200);
      const updated = collectionOf(res);
      assert.deepEqual([updated.fields, updated.variableAssignments, updated.derivedFrom], [[], [], []]);
      assert.equal(updated.fieldCount, 0);
    });

    it('403 for a Reader, 401 without token, 400 for applicationId in the body or a bad body, 404 for an unknown id', async () => {
      const { c } = await create();
      assert.equal((await reader().put(`/collections/${c.id}`, putBodyOf(c))).status, 403);
      assert.equal((await t.http.put(`/api/v1/collections/${c.id}`).send(putBodyOf(c))).status, 401);
      assert.equal((await dev().put(`/collections/${c.id}`, putBodyOf(c, { applicationId: app.id }))).status, 400);
      assert.equal((await dev().put(`/collections/${c.id}`, putBodyOf(c, { name: '1bad' }))).status, 400);
      assert.equal((await dev().put(`/collections/${c.id}`, putBodyOf(c, { environments: [] }))).status, 400);
      assert.equal((await dev().put('/collections/abc', putBodyOf(c))).status, 400);
      assert.equal((await dev().put('/collections/999999', putBodyOf(c))).status, 404);
      const huge = await dev().put('/collections/99999999999', putBodyOf(c));
      assert.equal(huge.status, 404);
      assert.equal(bodyOf(huge).details.element, 'collection');
      assert.equal((await admin().put(`/collections/${c.id}`, putBodyOf(c, { description: 'admin' }))).status, 200);
    });

    it('renaming: 409 on a taken name with container application; the own name is not a duplicate', async () => {
      const { c } = await create({ name: 'colRenameMe' });
      const taken = (await create({ name: 'colTakenName' })).c;
      const dup = await dev().put(`/collections/${c.id}`, putBodyOf(c, { name: taken.name }));
      assert.equal(dup.status, 409);
      assert.equal(bodyOf(dup).code, 'DUPLICATE_NAME');
      assert.equal(bodyOf(dup).message, 'A collection named colTakenName already exists in Collections editors.');
      assert.equal((detailsOf(dup) as { container: string }).container, 'application');
      assert.equal((await dev().put(`/collections/${c.id}`, putBodyOf(c, { name: 'colRenameMe' }))).status, 200);
      assert.equal((await dev().put(`/collections/${c.id}`, putBodyOf(c, { name: 'colFreeName' }))).status, 200);
    });
  });

  describe('reconciliation by id (D-26)', () => {
    it('updates, creates and deletes in one PUT; an updated item keeps its id and is audited as UPDATE', async () => {
      const { c, etag } = await create({
        fields: [field('Id', { dataType: 'NUMBER' }), field('Nombre'), field('Zona')],
        variableAssignments: [
          assignment(gA.id, s1.id, { usedIn: 'OnVisible' }),
          assignment(gB.id, s1.id, { usedIn: 'OnVisible' }),
          assignment(ctxS1.id, s1.id, { assignmentFunction: 'UPDATE_CONTEXT', usedIn: 'OnHidden' }),
        ],
      });
      const [fId, fNombre, fZona] = c.fields;
      const [aA, aB, aCtx] = c.variableAssignments;
      const res = await dev().put(
        `/collections/${c.id}`,
        putBodyOf(c, {
          fields: [
            { id: fId!.id, name: 'Id', dataType: 'NUMBER', description: 'primary key', position: 0 }, // update
            { id: fNombre!.id, name: 'Nombre completo', dataType: 'TEXT', position: 1 }, // rename
            { name: 'Alta', dataType: 'DATE' }, // create (fZona omitted = delete)
          ],
          variableAssignments: [
            {
              id: aA!.id,
              variableId: gA.id,
              screenId: s1.id,
              assignmentFunction: 'SET',
              tableFunction: 'CountRows',
              usedIn: 'OnVisible',
            }, // update
            {
              id: aCtx!.id,
              variableId: ctxS1.id,
              screenId: s1.id,
              assignmentFunction: 'UPDATE_CONTEXT',
              usedIn: 'OnHidden',
            }, // same
            assignment(gB.id, s2.id, { usedIn: 'OnSelect' }), // create (aB omitted = delete)
          ],
        }),
        etag,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const u = collectionOf(res);
      assert.deepEqual(
        u.fields.map((f) => f.name),
        ['Id', 'Nombre completo', 'Alta'],
      );
      assert.equal(u.fields[0]!.id, fId!.id);
      assert.equal(u.fields[1]!.id, fNombre!.id, 'the renamed field keeps its row');
      assert.ok(u.fields[2]!.id > fZona!.id, 'the new field is a new row');
      assert.equal(u.fields[0]!.description, 'primary key');
      assert.equal(u.variableAssignments.length, 3);
      const kept = u.variableAssignments.find((a) => a.id === aA!.id)!;
      assert.equal(kept.tableFunction, 'CountRows');
      assert.ok(u.variableAssignments.some((a) => a.id === aCtx!.id));
      assert.ok(!u.variableAssignments.some((a) => a.id === aB!.id));

      // The audit log keeps ONE history per row: UPDATE for the updated rows, DELETE for the omitted ones.
      assert.deepEqual(await actions('collection_field', fId!.id), ['CREATE', 'UPDATE']);
      assert.deepEqual(await actions('collection_field', fNombre!.id), ['CREATE', 'UPDATE']);
      assert.deepEqual(await actions('collection_field', fZona!.id), ['CREATE', 'DELETE']);
      assert.deepEqual(await actions('collection_field', u.fields[2]!.id), ['CREATE']);
      assert.deepEqual(await actions('variable_collection', aA!.id), ['CREATE', 'UPDATE']);
      assert.deepEqual(await actions('variable_collection', aCtx!.id), ['CREATE'], 'an identical item is not written');
      assert.deepEqual(await actions('variable_collection', aB!.id), ['CREATE', 'DELETE']);
      const actors = await auditRows(t, 'collection_field', String(fId!.id));
      assert.ok(actors.every((r) => r.actor_user_id === t.users.developer.id));
    });

    it('swaps the names of two fields in one PUT: 200, same ids, UPDATE (never DELETE + CREATE)', async () => {
      const { c, etag } = await create({ fields: [field('Alfa'), field('Beta')] });
      const [f1, f2] = c.fields;
      const res = await dev().put(
        `/collections/${c.id}`,
        putBodyOf(c, {
          fields: [
            { id: f1!.id, name: 'Beta', dataType: 'TEXT', position: 0 },
            { id: f2!.id, name: 'Alfa', dataType: 'TEXT', position: 1 },
          ],
        }),
        etag,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const u = collectionOf(res);
      assert.deepEqual(
        u.fields.map((f) => [f.id, f.name]),
        [
          [f1!.id, 'Beta'],
          [f2!.id, 'Alfa'],
        ],
      );
      for (const f of [f1!, f2!]) {
        const a = await actions('collection_field', f.id);
        assert.equal(a[0], 'CREATE');
        assert.ok(a.slice(1).every((x) => x === 'UPDATE') && a.length >= 2 && a.length <= 3, a.join());
      }
      // No temporary name survives.
      assert.ok(u.fields.every((f) => !f.name.startsWith('~swap~')));
    });

    it('rotates the names of three fields, and reorders positions', async () => {
      const { c, etag } = await create({ fields: [field('A'), field('B'), field('C')] });
      const [fa, fb, fc] = c.fields;
      const res = await dev().put(
        `/collections/${c.id}`,
        putBodyOf(c, {
          fields: [
            { id: fa!.id, name: 'B', dataType: 'TEXT', position: 2 },
            { id: fb!.id, name: 'C', dataType: 'TEXT', position: 1 },
            { id: fc!.id, name: 'A', dataType: 'TEXT', position: 0 },
          ],
        }),
        etag,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const u = collectionOf(res);
      assert.deepEqual(
        u.fields.map((f) => [f.id, f.name, f.position]),
        [
          [fc!.id, 'A', 0],
          [fb!.id, 'C', 1],
          [fa!.id, 'B', 2],
        ],
      );
      assert.ok(u.fields.every((f) => !f.name.startsWith('~swap~')));
    });

    it('a swap together with a delete and a create that reuse the freed names', async () => {
      const { c, etag } = await create({ fields: [field('P'), field('Q'), field('R')] });
      const [fp, fq] = c.fields;
      const res = await dev().put(
        `/collections/${c.id}`,
        putBodyOf(c, {
          fields: [
            { id: fp!.id, name: 'Q', dataType: 'TEXT', position: 0 },
            { id: fq!.id, name: 'P', dataType: 'TEXT', position: 1 },
            field('R', { position: 2 }), // R was deleted (omitted with its id) and is created again
          ],
        }),
        etag,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        collectionOf(res).fields.map((f) => f.name),
        ['Q', 'P', 'R'],
      );
    });

    it('swaps the usedIn of two assignments of a CONTEXT variable (unique index), keeping both rows', async () => {
      const { c, etag } = await create({
        variableAssignments: [
          assignment(ctxS1.id, s1.id, { assignmentFunction: 'UPDATE_CONTEXT', usedIn: 'OnVisible' }),
          assignment(ctxS1.id, s1.id, {
            assignmentFunction: 'UPDATE_CONTEXT',
            usedIn: 'OnHidden',
            tableFunction: 'First',
          }),
        ],
      });
      const [a1, a2] = c.variableAssignments.slice().sort((x, y) => x.id - y.id);
      const res = await dev().put(
        `/collections/${c.id}`,
        putBodyOf(c, {
          variableAssignments: [
            {
              id: a1!.id,
              variableId: ctxS1.id,
              screenId: s1.id,
              assignmentFunction: 'UPDATE_CONTEXT',
              tableFunction: null,
              usedIn: a2!.usedIn,
            },
            {
              id: a2!.id,
              variableId: ctxS1.id,
              screenId: s1.id,
              assignmentFunction: 'UPDATE_CONTEXT',
              tableFunction: 'First',
              usedIn: a1!.usedIn,
            },
          ],
        }),
        etag,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const u = collectionOf(res);
      assert.equal(u.variableAssignments.find((a) => a.id === a1!.id)!.usedIn, a2!.usedIn);
      assert.equal(u.variableAssignments.find((a) => a.id === a2!.id)!.usedIn, a1!.usedIn);
      assert.ok(u.variableAssignments.every((a) => !a.usedIn.startsWith('~swap~')));
      for (const a of [a1!, a2!]) {
        const log = await actions('variable_collection', a.id);
        assert.ok(!log.includes('DELETE'), log.join());
      }
    });

    it('swaps the variables of two assignments of the same screen and event; the stored scope follows the variable', async () => {
      const { c, etag } = await create({
        variableAssignments: [
          assignment(gA.id, s1.id, { usedIn: 'OnVisible' }),
          assignment(gB.id, s1.id, { usedIn: 'OnVisible' }),
        ],
      });
      const [a1, a2] = c.variableAssignments.slice().sort((x, y) => x.id - y.id);
      const res = await dev().put(
        `/collections/${c.id}`,
        putBodyOf(c, {
          variableAssignments: [
            {
              id: a1!.id,
              variableId: a2!.variable.id,
              screenId: s1.id,
              assignmentFunction: 'SET',
              tableFunction: null,
              usedIn: 'OnVisible',
            },
            {
              id: a2!.id,
              variableId: a1!.variable.id,
              screenId: s1.id,
              assignmentFunction: 'SET',
              tableFunction: null,
              usedIn: 'OnVisible',
            },
          ],
        }),
        etag,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const u = collectionOf(res);
      assert.equal(u.variableAssignments.find((a) => a.id === a1!.id)!.variable.id, a2!.variable.id);
      assert.equal(u.variableAssignments.find((a) => a.id === a2!.id)!.variable.id, a1!.variable.id);
      const scopes = await t.owner.query<{ variable_scope: string }>(
        'SELECT variable_scope FROM variable_collection WHERE collection_id = $1',
        [c.id],
      );
      assert.ok(scopes.rows.every((r) => r.variable_scope === 'GLOBAL'));
    });

    it('404 for a nested id that is not of this collection, with its position (D-75); a repeated id is 400', async () => {
      const { c: mine, etag } = await create({
        fields: [field('Id')],
        variableAssignments: [assignment(gA.id, s1.id)],
      });
      const { c: theirs } = await create({
        fields: [field('Other')],
        variableAssignments: [assignment(gB.id, s1.id)],
      });
      const fieldOfOthers = await dev().put(
        `/collections/${mine.id}`,
        putBodyOf(mine, {
          fields: [...putBodyOf(mine).fields, { id: theirs.fields[0]!.id, name: 'Stolen', dataType: 'TEXT' }],
        }),
        etag,
      );
      assert.equal(fieldOfOthers.status, 404);
      assert.equal(bodyOf(fieldOfOthers).code, 'NOT_FOUND');
      assert.deepEqual(detailsOf(fieldOfOthers), {
        element: 'collection field',
        id: theirs.fields[0]!.id,
        field: 'fields[1].id',
      });

      const assignmentOfOthers = await dev().put(
        `/collections/${mine.id}`,
        putBodyOf(mine, {
          variableAssignments: [{ ...assignment(gB.id, s1.id), id: theirs.variableAssignments[0]!.id }],
        }),
        etag,
      );
      assert.equal(assignmentOfOthers.status, 404);
      assert.deepEqual(detailsOf(assignmentOfOthers), {
        element: 'variable assignment',
        id: theirs.variableAssignments[0]!.id,
        field: 'variableAssignments[0].id',
      });

      const missing = await dev().put(
        `/collections/${mine.id}`,
        putBodyOf(mine, { fields: [{ id: 99999999999, name: 'Id', dataType: 'TEXT' }] }),
      );
      assert.equal(missing.status, 404);

      const repeated = await dev().put(
        `/collections/${mine.id}`,
        putBodyOf(mine, { fields: [...putBodyOf(mine).fields, { ...putBodyOf(mine).fields[0], name: 'Again' }] }),
      );
      assert.equal(repeated.status, 400);
      assert.deepEqual(
        bodyOf(repeated).details.fields.map((f) => f.field),
        ['fields[1].id'],
      );
      // The other collection was not touched.
      assert.equal((await fetchCollection(theirs.id)).fields[0]!.name, 'Other');
    });

    it('400 names the position of repeated names and combinations after the reconciliation is computed', async () => {
      const { c } = await create({ fields: [field('A'), field('B')] });
      const res = await dev().put(
        `/collections/${c.id}`,
        putBodyOf(c, {
          fields: [
            { id: c.fields[0]!.id, name: 'B', dataType: 'TEXT' },
            { id: c.fields[1]!.id, name: 'B', dataType: 'TEXT' },
          ],
        }),
      );
      assert.equal(res.status, 400);
      assert.deepEqual(
        bodyOf(res).details.fields.map((f) => [f.field, f.rule]),
        [['fields[1].name', 'unique']],
      );
    });
  });

  describe('derivations (D-74)', () => {
    it('reconciles the derived collections by difference; the rows that stay keep their id and history', async () => {
      const x = (await create()).c;
      const y = (await create()).c;
      const z = (await create()).c;
      const { c, etag } = await create({ derivedFrom: [x.id, y.id] });
      const rowsOf = async () =>
        (
          await t.owner.query<{ id: number; target_id: number }>(
            `SELECT id, target_id FROM dependency WHERE source_id = $1 AND relation_type = 'DERIVES_FROM' ORDER BY target_id`,
            [c.id],
          )
        ).rows;
      const before = await rowsOf();
      assert.equal(before.length, 2);
      assert.deepEqual(
        c.derivedFrom.map((d) => d.id),
        [x.id, y.id].sort((p, q) =>
          c.derivedFrom.find((d) => d.id === p)!.name < c.derivedFrom.find((d) => d.id === q)!.name ? -1 : 1,
        ),
      );

      const res = await dev().put(`/collections/${c.id}`, putBodyOf(c, { derivedFrom: [y.id, z.id] }), etag);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const after = await rowsOf();
      assert.deepEqual(after.map((r) => r.target_id).sort(), [y.id, z.id].sort());
      const kept = before.find((r) => r.target_id === y.id)!;
      assert.equal(after.find((r) => r.target_id === y.id)!.id, kept.id, 'the unchanged derivation is not recreated');
      assert.deepEqual(await actions('dependency', kept.id), ['CREATE']);
      const dropped = before.find((r) => r.target_id === x.id)!;
      assert.deepEqual(await actions('dependency', dropped.id), ['CREATE', 'DELETE']);
      assert.deepEqual(
        collectionOf(res)
          .derivedFrom.map((d) => d.id)
          .sort(),
        [y.id, z.id].sort(),
      );
      // Direction: the edited collection is the source, so the sources do not list it.
      assert.deepEqual((await fetchCollection(y.id)).derivedFrom, []);
    });

    it('400 VALIDATION_ERROR rule "self" at derivedFrom[i] when a collection derives from itself', async () => {
      const other = (await create()).c;
      const { c, etag } = await create();
      const res = await dev().put(`/collections/${c.id}`, putBodyOf(c, { derivedFrom: [other.id, c.id] }), etag);
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      assert.deepEqual(bodyOf(res).details.fields, [
        { field: 'derivedFrom[1]', rule: 'self', message: 'A collection cannot derive from itself.' },
      ]);
      assert.deepEqual((await fetchCollection(c.id)).derivedFrom, []);
      // The self reference is checked before If-Match, as every payload error is.
      assert.equal(
        (await dev().put(`/collections/${c.id}`, putBodyOf(c, { derivedFrom: [c.id] }), 'W/"1"')).status,
        400,
      );
    });

    it('allows cycles: A derives from B and B derives from A', async () => {
      const a = await create();
      const b = await create({ derivedFrom: [a.c.id] });
      const res = await dev().put(`/collections/${a.c.id}`, putBodyOf(a.c, { derivedFrom: [b.c.id] }), a.etag);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(
        collectionOf(res).derivedFrom.map((d) => d.id),
        [b.c.id],
      );
      assert.deepEqual(
        (await fetchCollection(b.c.id)).derivedFrom.map((d) => d.id),
        [a.c.id],
      );
    });

    it('404 for a source that does not exist and 422 CROSS_APPLICATION for one of another application', async () => {
      const { c } = await create();
      const foreignCol = (await create({}, foreignApp.id)).c;
      const missing = await dev().put(`/collections/${c.id}`, putBodyOf(c, { derivedFrom: [999999] }));
      assert.equal(missing.status, 404);
      assert.deepEqual(detailsOf(missing), { element: 'collection', id: 999999, field: 'derivedFrom[0]' });
      const cross = await dev().put(`/collections/${c.id}`, putBodyOf(c, { derivedFrom: [foreignCol.id] }));
      assert.equal(cross.status, 422);
      assert.equal(bodyOf(cross).code, 'CROSS_APPLICATION');
      assert.deepEqual(detailsOf(cross), { field: 'derivedFrom[0]' });
    });
  });

  describe('order of the errors', () => {
    it('400 -> 404 -> 422 archived -> 412 -> 422 rule -> 409', async () => {
      const { c, etag } = await create({ name: 'colOrder' });
      const taken = (await create({ name: 'colOrderTaken' })).c;
      const stale = 'W/"1"';
      const put = (over: Record<string, unknown>, ifMatch?: string) =>
        dev().put(`/collections/${c.id}`, putBodyOf(c, over), ifMatch);
      const rule = { variableAssignments: [assignment(gA.id, s1.id, { assignmentFunction: 'UPDATE_CONTEXT' })] };

      // 412 beats the duplicate and the business rule.
      assert.equal((await put({ name: taken.name }, stale)).status, 412);
      assert.equal((await put({ name: taken.name, ...rule }, stale)).status, 412);
      // The business rule beats the duplicate.
      const businessFirst = await put({ name: taken.name, ...rule }, etag);
      assert.equal(businessFirst.status, 422);
      assert.equal(bodyOf(businessFirst).code, 'SCOPE_MISMATCH');
      // The duplicate is the last check.
      assert.equal((await put({ name: taken.name }, etag)).status, 409);
      // 404 beats 412.
      assert.equal((await put({ variableAssignments: [assignment(999999, s1.id)] }, stale)).status, 404);
      // 400 beats everything.
      const bad = await put(
        { fields: [field('X'), field('X')], variableAssignments: [assignment(999999, s1.id)] },
        stale,
      );
      assert.equal(bad.status, 400);
    });

    it('422 APPLICATION_ARCHIVED beats 412, the business rule and the duplicate; the collection stays', async () => {
      await withArchivedApplication(async (archived) => {
        const mk = async (name: string) => {
          const res = await dev().post('/collections', createBodyOf(archived.id, { name }));
          return collectionOf(res);
        };
        const target = await mk('colArchA');
        const other = await mk('colArchB');
        const variable = await insertVariable(t, archived.id, { name: 'gArchV' });
        const screen = await insertScreen(t, archived.id);
        await setApplicationStatus(t, archived.id, 'ARCHIVED');
        const body = putBodyOf(target, {
          name: other.name,
          variableAssignments: [assignment(variable.id, screen.id, { assignmentFunction: 'UPDATE_CONTEXT' })],
        });
        for (const ifMatch of [undefined, 'W/"1"']) {
          const res = await dev().put(`/collections/${target.id}`, body, ifMatch);
          assert.equal(res.status, 422);
          assert.equal(bodyOf(res).code, 'APPLICATION_ARCHIVED');
          assert.deepEqual(detailsOf(res), { applicationId: archived.id });
        }
        // Even an unchanged PUT is refused: the application is read-only.
        assert.equal((await dev().put(`/collections/${target.id}`, putBodyOf(target))).status, 422);
        assert.equal((await fetchCollection(target.id)).name, 'colArchA');
        // A missing reference is still a 404, before the guard.
        assert.equal(
          (await dev().put(`/collections/${target.id}`, putBodyOf(target, { derivedFrom: [999999] }))).status,
          404,
        );
      });
    });

    it('a cross-application item with a duplicate name reports the rule, not the name', async () => {
      const { c } = await create();
      const taken = (await create()).c;
      const res = await dev().put(
        `/collections/${c.id}`,
        putBodyOf(c, { name: taken.name, variableAssignments: [assignment(foreignVar.id, s1.id)] }),
      );
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'CROSS_APPLICATION');
    });
  });
});
