/**
 * Module 3, POST /collections and the rules shared with PUT (FR-08, FR-09; SDD Table 49; D-47, D-62, D-63, D-65,
 * D-74 to D-76): payload errors, 404s, the three 422 rules, DUPLICATE_NAME and the order between them.
 * Screens, variables and applications are fixtures inserted as docs_owner.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { auditRows, collectionOf, createBodyOf, putBodyOf, type CollectionBody } from '../helpers/collections.js';
import { insertApplication, insertScreen, insertVariable, setApplicationStatus } from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';
import { detailsOf } from '../helpers/variables.js';

type Ref = { id: number; name: string };

describe('collections: create and rules', () => {
  let t: TestApp;
  let app: { id: number; name: string; appContextScreenId: number };
  let foreignApp: { id: number; name: string };
  let s1: Ref;
  let s2: Ref;
  let foreignScreen: Ref;
  let gA: Ref;
  let gB: Ref;
  let ctxS1: Ref;
  let ctxNoOrigin: Ref;
  let foreignVar: Ref;

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Collections writers' });
    foreignApp = await insertApplication(t, { name: 'Foreign app' });
    s1 = await insertScreen(t, app.id, { name: 'Solicitudes' });
    s2 = await insertScreen(t, app.id, { name: 'Detalle' });
    foreignScreen = await insertScreen(t, foreignApp.id, { name: 'Pantalla ajena' });
    gA = await insertVariable(t, app.id, { name: 'gA' });
    gB = await insertVariable(t, app.id, { name: 'gB' });
    ctxS1 = await insertVariable(t, app.id, { name: 'locS1', scope: 'CONTEXT', originScreenId: s1.id });
    ctxNoOrigin = await insertVariable(t, app.id, { name: 'locNoOrigin', scope: 'CONTEXT' });
    foreignVar = await insertVariable(t, foreignApp.id, { name: 'gForeign' });
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const reader = () => asUser(t, t.users.reader.token);

  const assignment = (variableId: number, screenId: number, over: Record<string, unknown> = {}) => ({
    variableId,
    screenId,
    assignmentFunction: 'SET',
    usedIn: 'OnVisible',
    ...over,
  });

  async function create(over: Record<string, unknown> = {}, applicationId = app.id): Promise<CollectionBody> {
    const res = await dev().post('/collections', createBodyOf(applicationId, over));
    if (res.status !== 201) throw new Error(`fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
    return collectionOf(res);
  }

  async function withArchivedApplication<T>(fn: (a: { id: number; name: string }) => Promise<T>): Promise<T> {
    const a = await insertApplication(t);
    try {
      return await fn(a);
    } finally {
      await setApplicationStatus(t, a.id, 'ACTIVE');
    }
  }

  describe('POST /collections', () => {
    it('201 + Location + ETag with nested fields, assignments and derivations; the actor is audited (R-1)', async () => {
      const base = await create();
      for (const [who, user] of [
        ['developer', t.users.developer],
        ['admin', t.users.admin],
      ] as const) {
        const body = createBodyOf(app.id, {
          description: 'Created by ' + who,
          creationCondition: 'ClearCollect',
          environments: [{ environment: 'DEV', notes: 'Mock' }, { environment: 'PROD' }],
          fields: [
            { name: 'Id', dataType: 'NUMBER' },
            { name: 'Estado', dataType: 'TEXT', description: 'Status' },
            { name: 'Alta', dataType: 'DATE', position: 9 },
          ],
          variableAssignments: [
            assignment(gA.id, s1.id, { tableFunction: 'CountRows' }),
            assignment(ctxS1.id, s1.id, { assignmentFunction: 'UPDATE_CONTEXT', usedIn: 'btnGuardar.OnSelect' }),
          ],
          derivedFrom: [base.id],
        });
        const res = await asUser(t, user.token).post('/collections', body);
        assert.equal(res.status, 201, who + JSON.stringify(res.body));
        const c = collectionOf(res);
        assert.equal(res.headers.location, `/api/v1/collections/${c.id}`);
        assert.equal(res.headers.etag, `W/"${new Date(c.updatedAt).getTime()}"`);
        assert.equal(c.applicationId, app.id);
        assert.deepEqual(c.environments, ['DEV', 'PROD']);
        assert.deepEqual(
          c.fields.map((f) => [f.name, f.position]),
          [
            ['Id', 0],
            ['Estado', 1],
            ['Alta', 9],
          ],
          'position defaults to the order of the array',
        );
        assert.equal(c.fieldCount, 3);
        assert.equal(c.documented, false);
        assert.equal(c.variableAssignments.length, 2);
        assert.deepEqual(c.derivedFrom, [{ id: base.id, name: base.name }]);

        const rows = [
          ['collection', String(c.id), 1],
          ['collection_field', '%', 0],
        ] as const;
        assert.deepEqual(
          (await auditRows(t, rows[0][0], rows[0][1])).map((r) => [r.action, r.actor_user_id]),
          [['CREATE', user.id]],
        );
        for (const f of c.fields) {
          assert.deepEqual(
            (await auditRows(t, 'collection_field', String(f.id))).map((r) => [r.action, r.actor_user_id]),
            [['CREATE', user.id]],
          );
        }
        for (const a of c.variableAssignments) {
          assert.deepEqual(
            (await auditRows(t, 'variable_collection', String(a.id))).map((r) => [r.action, r.actor_user_id]),
            [['CREATE', user.id]],
          );
        }
        const dep = await t.owner.query<{ id: number }>(
          `SELECT id FROM dependency WHERE source_id = $1 AND relation_type = 'DERIVES_FROM'`,
          [c.id],
        );
        assert.equal(dep.rowCount, 1);
        assert.deepEqual(
          (await auditRows(t, 'dependency', String(dep.rows[0]!.id))).map((r) => [r.action, r.actor_user_id]),
          [['CREATE', user.id]],
        );
      }
    });

    it('creates a collection with only name and one environment (PROD), and an empty representation', async () => {
      const c = await create({ environments: [{ environment: 'PROD' }] });
      assert.deepEqual(c.environments, ['PROD']);
      assert.deepEqual([c.fields, c.variableAssignments, c.derivedFrom], [[], [], []]);
      assert.deepEqual([c.description, c.creationCondition], [null, null]);
    });

    it('403 for a Reader and 401 without token; nothing is written', async () => {
      const name = 'colReaderTry';
      const res = await reader().post('/collections', createBodyOf(app.id, { name }));
      assert.equal(res.status, 403);
      assert.equal(bodyOf(res).code, 'FORBIDDEN');
      assert.equal((await t.http.post('/api/v1/collections').send(createBodyOf(app.id, { name }))).status, 401);
      const rows = await t.owner.query('SELECT 1 FROM collection WHERE name = $1', [name]);
      assert.equal(rows.rowCount, 0);
    });

    it('400 for missing or invalid fields, extra properties and out-of-range environments', async () => {
      const bad: Record<string, unknown>[] = [
        { name: undefined },
        { name: '1bad' },
        { name: 'has space' },
        { name: 'x'.repeat(151) },
        { environments: [] },
        { environments: undefined },
        { environments: [{ environment: 'QA' }] },
        { environments: [{ environment: 'DEV' }, { environment: 'PROD' }, { environment: 'DEV', notes: 'x' }] },
        { unknown: 1 },
        { fields: [{ name: 'F' }] },
        { fields: [{ name: 'F', dataType: 'NOPE' }] },
        { fields: [{ name: 'F', dataType: 'TEXT', position: -1 }] },
        { fields: [{ name: 'F', dataType: 'TEXT', position: 32768 }] },
        { fields: [{ name: '', dataType: 'TEXT' }] },
        { variableAssignments: [{ variableId: gA.id, screenId: s1.id, assignmentFunction: 'SET' }] },
        { variableAssignments: [assignment(gA.id, s1.id, { usedIn: 'origin' })] },
        { variableAssignments: [assignment(gA.id, s1.id, { assignmentFunction: 'GET' })] },
        { derivedFrom: [0] },
      ];
      for (const over of bad) {
        const res = await dev().post('/collections', createBodyOf(app.id, over));
        assert.equal(res.status, 400, JSON.stringify(over));
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      }
      const noApp = await dev().post('/collections', { name: 'colNoApp', environments: [{ environment: 'DEV' }] });
      assert.equal(noApp.status, 400);
    });

    it('400 names the POSITION of every repeated value in the payload (D-65)', async () => {
      const res = await dev().post(
        '/collections',
        createBodyOf(app.id, {
          environments: [{ environment: 'DEV' }, { environment: 'DEV', notes: 'other' }],
          fields: [
            { name: 'Id', dataType: 'NUMBER' },
            { name: 'Nombre', dataType: 'TEXT' },
            { name: 'Id', dataType: 'TEXT' },
          ],
          variableAssignments: [
            assignment(gA.id, s1.id),
            assignment(gB.id, s1.id),
            assignment(gA.id, s1.id, { tableFunction: 'First' }),
          ],
        }),
      );
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      const fields = bodyOf(res).details.fields;
      assert.deepEqual(fields.map((f) => [f.field, f.rule]).sort(), [
        ['environments[1].environment', 'unique'],
        ['fields[2].name', 'unique'],
        ['variableAssignments[2].usedIn', 'unique'],
      ]);
    });

    it('400 names the POSITION of the same derivation twice and of an environment repeated with identical content', async () => {
      const other = await create();
      const unique = (field: string) => ({
        field,
        rule: 'unique',
        message: 'This value is repeated. Each one must be unique.',
      });
      const derived = await dev().post('/collections', createBodyOf(app.id, { derivedFrom: [other.id, other.id] }));
      assert.equal(derived.status, 400);
      assert.deepEqual(bodyOf(derived).details.fields, [unique('derivedFrom[1]')]);

      const environments = await dev().post(
        '/collections',
        createBodyOf(app.id, { environments: [{ environment: 'PROD' }, { environment: 'PROD' }] }),
      );
      assert.equal(environments.status, 400);
      assert.deepEqual(bodyOf(environments).details.fields, [unique('environments[1].environment')]);
    });

    it('404 for an unknown application, variable, screen or source of a derivation, with the position (D-75)', async () => {
      const unknownApp = await dev().post('/collections', createBodyOf(999999));
      assert.equal(unknownApp.status, 404);
      assert.equal(bodyOf(unknownApp).details.element, 'application');
      assert.equal((await dev().post('/collections', createBodyOf(99999999999))).status, 404);

      const cases: [Record<string, unknown>, string, string][] = [
        [
          { variableAssignments: [assignment(gA.id, s1.id), assignment(999999, s1.id, { usedIn: 'X' })] },
          'variable',
          'variableAssignments[1].variableId',
        ],
        [{ variableAssignments: [assignment(gA.id, 999999)] }, 'screen', 'variableAssignments[0].screenId'],
        [{ derivedFrom: [999999] }, 'collection', 'derivedFrom[0]'],
        [{ variableAssignments: [assignment(99999999999, s1.id)] }, 'variable', 'variableAssignments[0].variableId'],
        [{ variableAssignments: [assignment(gA.id, 99999999999)] }, 'screen', 'variableAssignments[0].screenId'],
        [{ derivedFrom: [99999999999] }, 'collection', 'derivedFrom[0]'],
      ];
      for (const [over, element, field] of cases) {
        const res = await dev().post('/collections', createBodyOf(app.id, over));
        assert.equal(res.status, 404, field);
        assert.equal(bodyOf(res).code, 'NOT_FOUND');
        assert.equal(bodyOf(res).details.element, element);
        assert.equal((detailsOf(res) as { field: string }).field, field);
      }
    });

    it('422 CROSS_APPLICATION for a variable, a screen or a source collection of another application', async () => {
      const foreignCol = await create({}, foreignApp.id);
      const cases: [Record<string, unknown>, string][] = [
        [
          { variableAssignments: [assignment(gA.id, s1.id), assignment(foreignVar.id, s1.id, { usedIn: 'X' })] },
          'variableAssignments[1].variableId',
        ],
        [{ variableAssignments: [assignment(gA.id, foreignScreen.id)] }, 'variableAssignments[0].screenId'],
        [{ derivedFrom: [foreignCol.id] }, 'derivedFrom[0]'],
      ];
      for (const [over, field] of cases) {
        const res = await dev().post('/collections', createBodyOf(app.id, over));
        assert.equal(res.status, 422, field);
        assert.equal(bodyOf(res).code, 'CROSS_APPLICATION');
        assert.equal(bodyOf(res).message, 'You can only link elements of the same application.');
        assert.deepEqual(detailsOf(res), { field });
      }
    });

    it('422 SCOPE_MISMATCH with both functions; the scope comes from the database, never from the client', async () => {
      const setOnContext = await dev().post(
        '/collections',
        createBodyOf(app.id, {
          variableAssignments: [assignment(gA.id, s1.id), assignment(ctxS1.id, s1.id, { usedIn: 'X' })],
        }),
      );
      assert.equal(setOnContext.status, 422);
      assert.equal(bodyOf(setOnContext).code, 'SCOPE_MISMATCH');
      assert.equal(
        bodyOf(setOnContext).message,
        'Set applies to global variables and UpdateContext to context variables.',
      );
      assert.deepEqual(detailsOf(setOnContext), { field: 'variableAssignments[1].assignmentFunction' });

      const updateOnGlobal = await dev().post(
        '/collections',
        createBodyOf(app.id, {
          variableAssignments: [assignment(gA.id, s1.id, { assignmentFunction: 'UPDATE_CONTEXT' })],
        }),
      );
      assert.equal(updateOnGlobal.status, 422);
      assert.equal(bodyOf(updateOnGlobal).code, 'SCOPE_MISMATCH');
      assert.deepEqual(detailsOf(updateOnGlobal), { field: 'variableAssignments[0].assignmentFunction' });

      // A client claiming the scope is rejected by the schema (extra property), it cannot override the database.
      const claim = await dev().post(
        '/collections',
        createBodyOf(app.id, { variableAssignments: [assignment(ctxS1.id, s1.id, { variableScope: 'GLOBAL' })] }),
      );
      assert.equal(claim.status, 400);
    });

    it('422 CONTEXT_SCREEN_MISMATCH: a context variable only from its origin screen (D-52, D-64)', async () => {
      const elsewhere = await dev().post(
        '/collections',
        createBodyOf(app.id, {
          variableAssignments: [assignment(ctxS1.id, s2.id, { assignmentFunction: 'UPDATE_CONTEXT' })],
        }),
      );
      assert.equal(elsewhere.status, 422);
      assert.equal(bodyOf(elsewhere).code, 'CONTEXT_SCREEN_MISMATCH');
      assert.equal(
        bodyOf(elsewhere).message,
        'locS1 belongs to Solicitudes. From here you can only write it with Navigate.',
      );
      assert.deepEqual(detailsOf(elsewhere), {
        variableId: ctxS1.id,
        variable: 'locS1',
        originScreenId: s1.id,
        screen: 'Solicitudes',
        screenId: s2.id,
        targetScreen: 'Detalle',
        field: 'variableAssignments[0].screenId',
      });

      const orphan = await dev().post(
        '/collections',
        createBodyOf(app.id, {
          variableAssignments: [
            assignment(ctxS1.id, s1.id, { assignmentFunction: 'UPDATE_CONTEXT' }),
            assignment(ctxNoOrigin.id, s2.id, { assignmentFunction: 'UPDATE_CONTEXT' }),
          ],
        }),
      );
      assert.equal(orphan.status, 422);
      assert.equal(bodyOf(orphan).code, 'CONTEXT_SCREEN_MISMATCH');
      assert.equal(
        bodyOf(orphan).message,
        'locNoOrigin has no origin screen. Set its origin screen before linking it.',
      );
      assert.deepEqual(detailsOf(orphan), {
        variableId: ctxNoOrigin.id,
        variable: 'locNoOrigin',
        originScreenId: null,
        screenId: s2.id,
        targetScreen: 'Detalle',
        field: 'variableAssignments[1].screenId',
      });
    });

    it('rule order is rule by rule: CROSS_APPLICATION, then SCOPE_MISMATCH, then CONTEXT_SCREEN_MISMATCH (D-76)', async () => {
      const contextMismatch = assignment(ctxS1.id, s2.id, { assignmentFunction: 'UPDATE_CONTEXT', usedIn: 'a' });
      const scopeMismatch = assignment(gA.id, s1.id, { assignmentFunction: 'UPDATE_CONTEXT', usedIn: 'b' });
      const cross = assignment(foreignVar.id, s1.id, { usedIn: 'c' });

      // Item 0 breaks the context rule, item 1 the scope rule: the scope rule is reported, at its position.
      const scopeFirst = await dev().post(
        '/collections',
        createBodyOf(app.id, { variableAssignments: [contextMismatch, scopeMismatch] }),
      );
      assert.equal(bodyOf(scopeFirst).code, 'SCOPE_MISMATCH');
      assert.deepEqual(detailsOf(scopeFirst), { field: 'variableAssignments[1].assignmentFunction' });

      // The cross-application item comes last but its rule goes first.
      const crossFirst = await dev().post(
        '/collections',
        createBodyOf(app.id, { variableAssignments: [contextMismatch, scopeMismatch, cross] }),
      );
      assert.equal(bodyOf(crossFirst).code, 'CROSS_APPLICATION');
      assert.deepEqual(detailsOf(crossFirst), { field: 'variableAssignments[2].variableId' });
    });

    it('allows the context variable from its origin screen and a global one from any screen of the application', async () => {
      const c = await create({
        variableAssignments: [
          assignment(ctxS1.id, s1.id, { assignmentFunction: 'UPDATE_CONTEXT' }),
          assignment(gA.id, s2.id),
          assignment(gA.id, app.appContextScreenId, { usedIn: 'OnStart' }),
        ],
      });
      assert.equal(c.variableAssignments.length, 3);
    });

    it('409 DUPLICATE_NAME with container = the application; free in another application', async () => {
      const first = await create({ name: 'colDup' });
      const res = await dev().post('/collections', createBodyOf(app.id, { name: first.name }));
      assert.equal(res.status, 409);
      assert.equal(bodyOf(res).code, 'DUPLICATE_NAME');
      assert.equal(bodyOf(res).message, 'A collection named colDup already exists in Collections writers.');
      assert.deepEqual(detailsOf(res), {
        field: 'name',
        type: 'collection',
        name: 'colDup',
        application: 'Collections writers',
        container: 'application',
      });
      assert.equal((await dev().post('/collections', createBodyOf(foreignApp.id, { name: 'colDup' }))).status, 201);
      assert.equal(
        (await dev().post('/collections', createBodyOf(app.id, { name: 'COLDUP' }))).status,
        201,
        'names are case-sensitive, as in the database',
      );
    });

    it('error order: 404 -> archived -> business rule -> duplicate; archived + duplicate -> 422 APPLICATION_ARCHIVED', async () => {
      await withArchivedApplication(async (archived) => {
        const screen = await insertScreen(t, archived.id);
        const variable = await insertVariable(t, archived.id, { name: 'gArch' });
        const dupBody = createBodyOf(archived.id, { name: 'colDupArchived' });
        assert.equal((await dev().post('/collections', dupBody)).status, 201);
        await setApplicationStatus(t, archived.id, 'ARCHIVED');

        const res = await dev().post('/collections', dupBody);
        assert.equal(res.status, 422);
        assert.equal(bodyOf(res).code, 'APPLICATION_ARCHIVED');
        assert.deepEqual(detailsOf(res), { applicationId: archived.id });

        // A missing variable (404) comes before the archived guard.
        const missing = await dev().post(
          '/collections',
          createBodyOf(archived.id, { variableAssignments: [assignment(999999, screen.id)] }),
        );
        assert.equal(missing.status, 404);

        // Archived + business rule: archived first.
        const rule = await dev().post(
          '/collections',
          createBodyOf(archived.id, {
            variableAssignments: [assignment(variable.id, screen.id, { assignmentFunction: 'UPDATE_CONTEXT' })],
          }),
        );
        assert.equal(bodyOf(rule).code, 'APPLICATION_ARCHIVED');
        const rows = await t.owner.query('SELECT 1 FROM collection WHERE application_id = $1', [archived.id]);
        assert.equal(rows.rowCount, 1, 'nothing was written');
      });

      // Business rule + duplicate: the rule answers first.
      const existing = await create({ name: 'colRuleThenDup' });
      const res = await dev().post(
        '/collections',
        createBodyOf(app.id, {
          name: existing.name,
          variableAssignments: [assignment(gA.id, s1.id, { assignmentFunction: 'UPDATE_CONTEXT' })],
        }),
      );
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'SCOPE_MISMATCH');
    });

    it('a failing nested write leaves nothing behind (one transaction)', async () => {
      const before = await t.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM collection');
      const res = await dev().post(
        '/collections',
        createBodyOf(app.id, {
          name: 'colAtomic',
          variableAssignments: [assignment(gA.id, s1.id, { assignmentFunction: 'UPDATE_CONTEXT' })],
        }),
      );
      assert.equal(res.status, 422);
      const after = await t.owner.query<{ n: number }>('SELECT count(*)::int AS n FROM collection');
      assert.equal(after.rows[0]!.n, before.rows[0]!.n);
      assert.equal(
        (
          await t.owner.query(
            `SELECT 1 FROM documented_element e WHERE NOT EXISTS (SELECT 1 FROM collection c WHERE c.id = e.id) AND e.type = 'COLLECTION'`,
          )
        ).rowCount,
        0,
      );
    });
  });

  describe('rules shared by PUT', () => {
    it('400 names the position of a repeated derivation and of identical environments on PUT too', async () => {
      const c = await create();
      const other = await create();
      const res = await dev().put(
        `/collections/${c.id}`,
        putBodyOf(c, {
          derivedFrom: [other.id, other.id],
          environments: [{ environment: 'DEV' }, { environment: 'DEV' }],
        }),
      );
      assert.equal(res.status, 400);
      assert.deepEqual(
        bodyOf(res)
          .details.fields.map((f) => [f.field, f.rule])
          .sort(),
        [
          ['derivedFrom[1]', 'unique'],
          ['environments[1].environment', 'unique'],
        ],
      );
    });

    it('applies the same 404, 422 and 409 checks on PUT, with positions', async () => {
      const c = await create({ fields: [{ name: 'F', dataType: 'TEXT' }] });
      const other = await create();
      const put = (over: Record<string, unknown>) => dev().put(`/collections/${c.id}`, putBodyOf(c, over));

      const missing = await put({ variableAssignments: [assignment(999999, s1.id)] });
      assert.equal(missing.status, 404);
      assert.equal((detailsOf(missing) as { field: string }).field, 'variableAssignments[0].variableId');

      const cross = await put({ variableAssignments: [assignment(foreignVar.id, s1.id)] });
      assert.equal(bodyOf(cross).code, 'CROSS_APPLICATION');

      const scope = await put({ variableAssignments: [assignment(ctxS1.id, s1.id)] });
      assert.equal(bodyOf(scope).code, 'SCOPE_MISMATCH');

      const context = await put({
        variableAssignments: [assignment(ctxS1.id, s2.id, { assignmentFunction: 'UPDATE_CONTEXT' })],
      });
      assert.equal(bodyOf(context).code, 'CONTEXT_SCREEN_MISMATCH');
      assert.equal((detailsOf(context) as { field: string }).field, 'variableAssignments[0].screenId');

      const dup = await put({ name: other.name });
      assert.equal(dup.status, 409);
      assert.equal(bodyOf(dup).code, 'DUPLICATE_NAME');

      const unchanged = await dev().get(`/collections/${c.id}`);
      assert.equal(collectionOf(unchanged).variableAssignments.length, 0);
    });
  });
});
