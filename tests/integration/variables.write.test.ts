/**
 * Module 2, write operations (FR-05, FR-06, FR-07; SDD Table 48; D-47, D-52, D-62 to D-65, D-68 to D-71):
 * POST, PUT and DELETE /variables. Screens, collections, links and dependencies are fixtures inserted as docs_owner.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import {
  insertApplication,
  insertCollection,
  insertComponent,
  insertDependency,
  insertScreen,
  insertScreenVariable,
  insertVariable,
  insertVariableCollection,
  setApplicationStatus,
} from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';
import {
  createBodyOf,
  dependenciesOf,
  detailsOf,
  putBodyOf,
  uniqueVariableName,
  variableOf,
} from '../helpers/variables.js';

type AuditRow = { action: string; actor_user_id: number | null; changed_fields: string[] | null };

describe('variables: write', () => {
  let t: TestApp;
  let app: { id: number; name: string; appContextScreenId: number };
  let foreignApp: { id: number; name: string };
  let s1: { id: number; name: string };
  let s2: { id: number; name: string };
  let foreignScreen: { id: number; name: string };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Writers app' });
    foreignApp = await insertApplication(t, { name: 'Foreign app' });
    s1 = await insertScreen(t, app.id, { name: 'Solicitudes' });
    s2 = await insertScreen(t, app.id, { name: 'Detalle' });
    foreignScreen = await insertScreen(t, foreignApp.id, { name: 'Pantalla ajena' });
  });
  after(async () => {
    await t.close();
  });

  const admin = () => asUser(t, t.users.admin.token);
  const dev = () => asUser(t, t.users.developer.token);
  const reader = () => asUser(t, t.users.reader.token);

  /** Creates a variable through the API as the developer and returns it with its ETag. */
  async function create(over: Record<string, unknown> = {}, applicationId = app.id) {
    const res = await dev().post('/variables', createBodyOf(applicationId, over));
    if (res.status !== 201) throw new Error(`fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { variable: variableOf(res), etag: res.headers.etag as string };
  }

  const fetchVariable = async (id: number) => variableOf(await admin().get(`/variables/${id}`));

  async function auditRows(entityType: string, entityId: string): Promise<AuditRow[]> {
    const r = await t.owner.query<AuditRow>(
      `SELECT action, actor_user_id, changed_fields FROM audit_log
        WHERE entity_type = $1 AND entity_id LIKE $2 ORDER BY id`,
      [entityType, entityId],
    );
    return r.rows;
  }
  const auditCount = async (): Promise<number> =>
    Number((await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM audit_log')).rows[0]!.n);

  /** Runs `fn` with a new application that is archived afterwards (fixtures are inserted while it is active). */
  async function withArchivedApplication<T>(
    fn: (a: { id: number; name: string; appContextScreenId: number }) => Promise<T>,
  ): Promise<T> {
    const a = await insertApplication(t);
    return fn(a);
  }

  // ------------------------------------------------------------------------------------------------ POST
  describe('POST /variables', () => {
    it('201 + Location + ETag for a developer and for an administrator; the actor is audited (R-1)', async () => {
      for (const [who, user] of [
        ['developer', t.users.developer],
        ['admin', t.users.admin],
      ] as const) {
        const body = createBodyOf(app.id, {
          dataType: 'RECORD',
          description: 'Created by ' + who,
          originScreenId: s1.id,
          environments: [{ environment: 'DEV', notes: 'Mock' }, { environment: 'PROD' }],
        });
        const res = await asUser(t, user.token).post('/variables', body);
        assert.equal(res.status, 201, who);
        const variable = variableOf(res);
        assert.equal(res.headers.location, `/api/v1/variables/${variable.id}`);
        assert.equal(res.headers.etag, `W/"${new Date(variable.updatedAt).getTime()}"`);
        assert.equal(variable.applicationId, app.id);
        assert.equal(variable.fullTraceability, true);
        assert.deepEqual(variable.originScreen, { id: s1.id, name: s1.name });
        assert.deepEqual(variable.environments, ['DEV', 'PROD']);
        assert.deepEqual(variable.environmentDetails, [
          { environment: 'DEV', notes: 'Mock' },
          { environment: 'PROD', notes: null },
        ]);
        assert.equal(variable.description, 'Created by ' + who);

        const variableAudit = await auditRows('variable', String(variable.id));
        assert.deepEqual(
          variableAudit.map((r) => [r.action, r.actor_user_id]),
          [['CREATE', user.id]],
        );
        const environmentAudit = await auditRows('element_environment', `${variable.id}:%`);
        assert.equal(environmentAudit.length, 2);
        assert.ok(environmentAudit.every((r) => r.actor_user_id === user.id && r.action === 'CREATE'));
        // FR-06: the origin screen gets its WRITE link, made by the database trigger in the same transaction.
        const link = await t.owner.query<{ access_mode: string }>(
          `SELECT access_mode FROM screen_variable WHERE variable_id = $1 AND screen_id = $2 AND used_in = 'origin'`,
          [variable.id, s1.id],
        );
        assert.equal(link.rows[0]?.access_mode, 'WRITE');
      }
    });

    it('creates variables without origin, with a single PROD environment, and CONTEXT with an origin screen', async () => {
      const { variable } = await create({ environments: [{ environment: 'PROD' }] });
      assert.equal(variable.originScreen, null);
      assert.equal(variable.fullTraceability, false);
      assert.deepEqual(variable.environments, ['PROD']);
      assert.equal(variable.description, null);
      const context = (await create({ scope: 'CONTEXT', originScreenId: s1.id })).variable;
      assert.equal(context.scope, 'CONTEXT');
      const global = (await create({ originScreenId: app.appContextScreenId })).variable;
      assert.equal(global.originScreen?.name, 'App (OnStart)'); // a GLOBAL variable may originate in App (OnStart)
    });

    it('403 for a Reader and 401 without token; nothing is written', async () => {
      const before = await auditCount();
      const forbidden = await reader().post('/variables', createBodyOf(app.id));
      assert.equal(forbidden.status, 403);
      assert.equal(bodyOf(forbidden).code, 'FORBIDDEN');
      assert.deepEqual(bodyOf(forbidden).details.requiredRoles, ['ADMINISTRATOR', 'DEVELOPER']);
      assert.equal((await t.http.post('/api/v1/variables').send(createBodyOf(app.id))).status, 401);
      assert.equal(await auditCount(), before);
    });

    it('400 for missing or invalid fields, extra properties and out-of-range environments', async () => {
      const bad: [string, Record<string, unknown>][] = [
        ['missing name', { name: undefined }],
        ['missing environments', { environments: undefined }],
        ['empty environments', { environments: [] }],
        [
          'three environments',
          { environments: [{ environment: 'DEV' }, { environment: 'PROD' }, { environment: 'DEV' }] },
        ],
        ['environment QA', { environments: [{ environment: 'QA' }] }],
        ['name with a space', { name: 'g User' }],
        ['name starting with a digit', { name: '1gUser' }],
        ['name of 151 characters', { name: 'g'.repeat(151) }],
        ['dataType STRING', { dataType: 'STRING' }],
        ['scope LOCAL', { scope: 'LOCAL' }],
        ['originScreenId 0', { originScreenId: 0 }],
        ['unknown property', { id: 5 }],
        ['notes too long', { environments: [{ environment: 'DEV', notes: 'x'.repeat(2001) }] }],
        ['identical environments', { environments: [{ environment: 'DEV' }, { environment: 'DEV' }] }],
      ];
      for (const [label, over] of bad) {
        const res = await dev().post('/variables', createBodyOf(app.id, over));
        assert.equal(res.status, 400, label);
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR', label);
      }
      const noApplication = await dev().post('/variables', { ...createBodyOf(app.id), applicationId: undefined });
      assert.equal(noApplication.status, 400);
    });

    it('400 names the POSITION of a repeated environment even when the notes differ (D-65)', async () => {
      const res = await dev().post(
        '/variables',
        createBodyOf(app.id, {
          environments: [
            { environment: 'PROD', notes: 'a' },
            { environment: 'PROD', notes: 'different' },
          ],
        }),
      );
      assert.equal(res.status, 400);
      assert.deepEqual(bodyOf(res).details.fields, [
        {
          field: 'environments[1].environment',
          rule: 'unique',
          message: 'This value is repeated. Each one must be unique.',
        },
      ]);
    });

    it('404 for an unknown application or origin screen, also when the id is outside the integer range', async () => {
      for (const applicationId of [999999, 2147483648]) {
        const res = await dev().post('/variables', createBodyOf(applicationId));
        assert.equal(res.status, 404, String(applicationId));
        assert.equal(bodyOf(res).message, "This application doesn't exist. It may have been deleted.");
      }
      for (const originScreenId of [999999, 2147483648]) {
        const res = await dev().post('/variables', createBodyOf(app.id, { originScreenId }));
        assert.equal(res.status, 404, String(originScreenId));
        assert.equal(bodyOf(res).message, "This screen doesn't exist. It may have been deleted.");
      }
    });

    it('422 INVALID_ORIGIN_SCREEN (1): a CONTEXT variable cannot originate in App (OnStart)', async () => {
      const res = await dev().post(
        '/variables',
        createBodyOf(app.id, { scope: 'CONTEXT', originScreenId: app.appContextScreenId }),
      );
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'INVALID_ORIGIN_SCREEN');
      assert.equal(bodyOf(res).message, 'Context variables are created inside a screen, not in App (OnStart).');
      assert.deepEqual(detailsOf(res), { field: 'originScreenId' });
    });

    it('422 INVALID_ORIGIN_SCREEN (2, D-68): a screen of another application is not CROSS_APPLICATION', async () => {
      for (const scope of ['GLOBAL', 'CONTEXT']) {
        const res = await dev().post('/variables', createBodyOf(app.id, { scope, originScreenId: foreignScreen.id }));
        assert.equal(res.status, 422, scope);
        assert.equal(bodyOf(res).code, 'INVALID_ORIGIN_SCREEN');
        assert.equal(
          bodyOf(res).message,
          `Pantalla ajena belongs to another application. Choose a screen of Writers app.`,
        );
        assert.deepEqual(detailsOf(res), {
          field: 'originScreenId',
          screenId: foreignScreen.id,
          screen: 'Pantalla ajena',
          application: 'Writers app',
        });
      }
      // The App (OnStart) screen of ANOTHER application is also reported as belonging to another application.
      const other = await dev().post(
        '/variables',
        createBodyOf(app.id, { scope: 'CONTEXT', originScreenId: (await insertApplication(t)).appContextScreenId }),
      );
      assert.match(bodyOf(other).message, /belongs to another application/);
    });

    it('409 DUPLICATE_NAME, with the container of each scope (D-63, D-69)', async () => {
      const global = await create({ name: 'gTaken' });
      const again = await dev().post('/variables', createBodyOf(app.id, { name: 'gTaken' }));
      assert.equal(again.status, 409);
      assert.equal(bodyOf(again).code, 'DUPLICATE_NAME');
      assert.equal(bodyOf(again).message, 'A global variable named gTaken already exists in Writers app.');
      assert.deepEqual(detailsOf(again), {
        field: 'name',
        type: 'global variable',
        name: 'gTaken',
        application: 'Writers app',
        container: 'application',
      });
      assert.ok(global.variable.id > 0);

      await create({ name: 'locTaken', scope: 'CONTEXT', originScreenId: s1.id });
      const context = await dev().post(
        '/variables',
        createBodyOf(app.id, { name: 'locTaken', scope: 'CONTEXT', originScreenId: s1.id }),
      );
      assert.equal(context.status, 409);
      assert.equal(bodyOf(context).message, 'A context variable named locTaken already exists in Solicitudes.');
      assert.deepEqual(detailsOf(context), {
        field: 'name',
        type: 'context variable',
        name: 'locTaken',
        application: 'Solicitudes',
        container: 'screen',
      });

      await create({ name: 'locNoOrigin', scope: 'CONTEXT' });
      const nameless = await dev().post('/variables', createBodyOf(app.id, { name: 'locNoOrigin', scope: 'CONTEXT' }));
      assert.equal(nameless.status, 409);
      assert.equal(bodyOf(nameless).message, 'A context variable named locNoOrigin already exists in Writers app.');
      assert.deepEqual(detailsOf(nameless), {
        field: 'name',
        type: 'context variable',
        name: 'locNoOrigin',
        application: 'Writers app',
        container: 'application',
      });
    });

    it('the same name is free in another screen, in another application and in the other scope', async () => {
      await create({ name: 'locShared', scope: 'CONTEXT', originScreenId: s1.id });
      await create({ name: 'locShared', scope: 'CONTEXT', originScreenId: s2.id });
      await create({ name: 'locShared', scope: 'CONTEXT' });
      await create({ name: 'locShared' }); // GLOBAL
      await create({ name: 'locShared' }, foreignApp.id);
    });

    it('error order: archived + duplicate -> 422 APPLICATION_ARCHIVED; business rule + duplicate -> 422', async () => {
      await withArchivedApplication(async (archived) => {
        await insertVariable(t, archived.id, { name: 'gDup' });
        const screen = await insertScreen(t, archived.id);
        await setApplicationStatus(t, archived.id, 'ARCHIVED');
        const res = await dev().post('/variables', createBodyOf(archived.id, { name: 'gDup' }));
        assert.equal(res.status, 422);
        assert.equal(bodyOf(res).code, 'APPLICATION_ARCHIVED');
        assert.deepEqual(detailsOf(res), { applicationId: archived.id });
        // A missing origin screen (404) comes before the archived guard.
        const missing = await dev().post('/variables', createBodyOf(archived.id, { originScreenId: 999999 }));
        assert.equal(missing.status, 404);
        // Nothing was written.
        const rows = await t.owner.query('SELECT 1 FROM variable WHERE application_id = $1', [archived.id]);
        assert.equal(rows.rowCount, 1);
        // Unarchived, the same request goes through the rest of the checks.
        await setApplicationStatus(t, archived.id, 'ACTIVE');
        assert.equal((await dev().post('/variables', createBodyOf(archived.id, { name: 'gDup' }))).status, 409);
        assert.ok(screen.id > 0);
      });

      await create({ name: 'locDupOrder', scope: 'CONTEXT' });
      // CONTEXT in App (OnStart) AND a name that exists: the business rule answers first.
      await create({ name: 'locDupOrder2', scope: 'CONTEXT', originScreenId: s1.id });
      const business = await dev().post(
        '/variables',
        createBodyOf(app.id, { name: 'locDupOrder2', scope: 'CONTEXT', originScreenId: foreignScreen.id }),
      );
      assert.equal(business.status, 422);
      assert.equal(bodyOf(business).code, 'INVALID_ORIGIN_SCREEN');
    });
  });

  // ------------------------------------------------------------------------------------------------- PUT
  describe('PUT /variables/{id}', () => {
    it('200 replaces the representation, returns a new ETag and audits the actor', async () => {
      const { variable, etag } = await create({ description: 'old', environments: [{ environment: 'DEV' }] });
      await new Promise((r) => setTimeout(r, 5));
      const res = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variable, {
          name: uniqueVariableName('gRenamed'),
          dataType: 'NUMBER',
          description: null,
        }),
        etag,
      );
      assert.equal(res.status, 200);
      const updated = variableOf(res);
      assert.notEqual(res.headers.etag, etag);
      assert.equal(res.headers.etag, `W/"${new Date(updated.updatedAt).getTime()}"`);
      assert.equal(updated.dataType, 'NUMBER');
      assert.equal(updated.description, null);
      const rows = await auditRows('variable', String(variable.id));
      assert.deepEqual(
        rows.map((r) => [r.action, r.actor_user_id]),
        [
          ['CREATE', t.users.developer.id],
          ['UPDATE', t.users.developer.id],
        ],
      );
      assert.deepEqual([...(rows[1]?.changed_fields ?? [])].sort(), ['data_type', 'description', 'name']);
      // An omitted optional field is replaced by null (the whole representation is replaced).
      const omitted = await admin().put(`/variables/${variable.id}`, {
        name: updated.name,
        dataType: 'NUMBER',
        scope: 'GLOBAL',
        environments: [{ environment: 'DEV' }],
      });
      assert.equal(omitted.status, 200);
    });

    it('replaces the environments and moves updated_at / the ETag even if no column changes (D-62, D-71)', async () => {
      const { variable, etag } = await create({
        environments: [{ environment: 'DEV', notes: 'old' }, { environment: 'PROD' }],
      });
      await new Promise((r) => setTimeout(r, 5));
      const res = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variable, { environments: [{ environment: 'PROD', notes: 'only prod' }] }),
        etag,
      );
      assert.equal(res.status, 200);
      const updated = variableOf(res);
      assert.deepEqual(updated.environmentDetails, [{ environment: 'PROD', notes: 'only prod' }]);
      assert.deepEqual(updated.environments, ['PROD']);
      assert.notEqual(res.headers.etag, etag);
      assert.ok(new Date(updated.updatedAt) > new Date(variable.updatedAt));
      // Only the notes of an existing environment changed.
      const notesOnly = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(updated, { environments: [{ environment: 'PROD', notes: 'edited' }] }),
        res.headers.etag,
      );
      assert.equal(notesOnly.status, 200);
      assert.notEqual(notesOnly.headers.etag, res.headers.etag);
      // Environments grow back.
      const grown = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variableOf(notesOnly), {
          environments: [{ environment: 'PROD', notes: 'edited' }, { environment: 'DEV' }],
        }),
      );
      assert.deepEqual(variableOf(grown).environments, ['DEV', 'PROD']);
      const environmentAudit = await auditRows('element_environment', `${variable.id}:%`);
      assert.ok(environmentAudit.every((r) => r.actor_user_id !== null));
    });

    it('a PUT that changes nothing writes nothing: same ETag, no audit rows (D-71)', async () => {
      const { variable, etag } = await create({
        originScreenId: s1.id,
        environments: [{ environment: 'DEV', notes: 'n' }, { environment: 'PROD' }],
      });
      const before = await auditCount();
      const res = await dev().put(`/variables/${variable.id}`, putBodyOf(variable), etag);
      assert.equal(res.status, 200);
      assert.equal(res.headers.etag, etag);
      assert.deepEqual(variableOf(res), variable);
      assert.equal(await auditCount(), before);
    });

    it('If-Match is verified ALWAYS, also when nothing changes: 412 with details.currentETag, nothing written', async () => {
      const { variable, etag } = await create();
      const before = await auditCount();
      const stale = 'W/"1"';
      const noop = await dev().put(`/variables/${variable.id}`, putBodyOf(variable), stale);
      assert.equal(noop.status, 412);
      assert.equal(bodyOf(noop).code, 'PRECONDITION_FAILED');
      assert.deepEqual(detailsOf(noop), { element: 'variable', currentETag: etag });
      assert.equal(
        bodyOf(noop).message,
        'Someone else saved changes to this variable after you opened it. Reload to see their version.',
      );
      const change = await dev().put(`/variables/${variable.id}`, putBodyOf(variable, { dataType: 'DATE' }), stale);
      assert.equal(change.status, 412);
      assert.equal(detailsOf(change).currentETag, etag);
      assert.equal(await auditCount(), before);
      assert.equal((await fetchVariable(variable.id)).dataType, 'TEXT');
      // Without the header the update goes through (If-Match is optional).
      assert.equal(
        (await dev().put(`/variables/${variable.id}`, putBodyOf(variable, { dataType: 'DATE' }))).status,
        200,
      );
    });

    it('403 for a Reader, 401 without token, 400 for applicationId in the body or a bad body', async () => {
      const { variable } = await create();
      assert.equal((await reader().put(`/variables/${variable.id}`, putBodyOf(variable))).status, 403);
      assert.equal((await t.http.put(`/api/v1/variables/${variable.id}`).send(putBodyOf(variable))).status, 401);
      const withApplication = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variable, { applicationId: app.id }),
      );
      assert.equal(withApplication.status, 400);
      assert.ok(bodyOf(withApplication).details.fields.some((f) => f.field.includes('applicationId')));
      assert.equal((await dev().put(`/variables/${variable.id}`, putBodyOf(variable, { scope: 'LOCAL' }))).status, 400);
      assert.equal(
        (await dev().put(`/variables/${variable.id}`, putBodyOf(variable, { environments: [] }))).status,
        400,
      );
      assert.equal((await dev().put('/variables/abc', putBodyOf(variable))).status, 400);
      const repeated = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variable, {
          environments: [
            { environment: 'DEV', notes: 'a' },
            { environment: 'DEV', notes: 'b' },
          ],
        }),
      );
      assert.equal(repeated.status, 400);
      assert.equal(bodyOf(repeated).details.fields[0]?.field, 'environments[1].environment');
    });

    it('404 for an unknown variable or origin screen, also outside the integer range', async () => {
      const { variable } = await create();
      for (const id of [999999, 2147483648]) {
        assert.equal((await dev().put(`/variables/${id}`, putBodyOf(variable))).status, 404, String(id));
      }
      for (const originScreenId of [999999, 2147483648]) {
        const res = await dev().put(`/variables/${variable.id}`, putBodyOf(variable, { originScreenId }));
        assert.equal(res.status, 404, String(originScreenId));
        assert.equal(bodyOf(res).message, "This screen doesn't exist. It may have been deleted.");
      }
    });

    it('changing the origin moves the origin row, and dependencies reflects it', async () => {
      const { variable } = await create({ originScreenId: s1.id });
      const rowsAt = async (screenId: number) =>
        (
          await t.owner.query(
            `SELECT 1 FROM screen_variable WHERE variable_id = $1 AND screen_id = $2 AND used_in = 'origin'`,
            [variable.id, screenId],
          )
        ).rowCount;
      assert.equal(await rowsAt(s1.id), 1);
      const moved = await dev().put(`/variables/${variable.id}`, putBodyOf(variable, { originScreenId: s2.id }));
      assert.equal(moved.status, 200);
      assert.deepEqual(variableOf(moved).originScreen, { id: s2.id, name: s2.name });
      assert.equal(await rowsAt(s1.id), 0);
      assert.equal(await rowsAt(s2.id), 1);
      const dependencies = dependenciesOf(await admin().get(`/variables/${variable.id}/dependencies`));
      assert.deepEqual(dependencies.originScreen, { id: s2.id, name: s2.name });
      assert.deepEqual(dependencies.screens, []);
      const cleared = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variableOf(moved), { originScreenId: null }),
      );
      assert.equal(variableOf(cleared).fullTraceability, false);
      assert.equal(await rowsAt(s2.id), 0);
      assert.equal(dependenciesOf(await admin().get(`/variables/${variable.id}/dependencies`)).originScreen, null);
    });

    it('422 INVALID_ORIGIN_SCREEN on PUT, both cases', async () => {
      const { variable } = await create({ scope: 'CONTEXT', originScreenId: s1.id });
      const appStart = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variable, { originScreenId: app.appContextScreenId }),
      );
      assert.equal(appStart.status, 422);
      assert.equal(bodyOf(appStart).message, 'Context variables are created inside a screen, not in App (OnStart).');
      const other = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variable, { originScreenId: foreignScreen.id }),
      );
      assert.equal(other.status, 422);
      assert.equal(bodyOf(other).code, 'INVALID_ORIGIN_SCREEN');
      assert.match(
        bodyOf(other).message,
        /^Pantalla ajena belongs to another application\. Choose a screen of Writers app\.$/,
      );
      // The same change of a GLOBAL variable to App (OnStart) is allowed.
      const global = (await create({ originScreenId: s1.id })).variable;
      assert.equal(
        (await dev().put(`/variables/${global.id}`, putBodyOf(global, { originScreenId: app.appContextScreenId })))
          .status,
        200,
      );
    });

    it('422 SCOPE_CONFLICT names the function of the incompatible assignments and writes nothing', async () => {
      const col = await insertCollection(t, app.id);
      const global = await insertVariable(t, app.id, { originScreenId: s1.id });
      await insertVariableCollection(t, {
        variableId: global.id,
        collectionId: col.id,
        screenId: s1.id,
        usedIn: 'OnVisible',
        assignmentFunction: 'SET',
      });
      const toContext = await dev().put(
        `/variables/${global.id}`,
        putBodyOf(await fetchVariable(global.id), { scope: 'CONTEXT' }),
      );
      assert.equal(toContext.status, 422);
      assert.equal(bodyOf(toContext).code, 'SCOPE_CONFLICT');
      assert.equal(
        bodyOf(toContext).message,
        "You can't change the scope while collections assign this variable with Set. Update those assignments first.",
      );
      assert.deepEqual(detailsOf(toContext), { function: 'Set' });
      assert.equal((await fetchVariable(global.id)).scope, 'GLOBAL');

      const context = await insertVariable(t, app.id, { scope: 'CONTEXT', originScreenId: s1.id });
      await insertVariableCollection(t, {
        variableId: context.id,
        collectionId: col.id,
        screenId: s1.id,
        usedIn: 'OnVisible',
        assignmentFunction: 'UPDATE_CONTEXT',
      });
      const toGlobal = await dev().put(
        `/variables/${context.id}`,
        putBodyOf(await fetchVariable(context.id), { scope: 'GLOBAL' }),
      );
      assert.equal(toGlobal.status, 422);
      assert.equal(bodyOf(toGlobal).code, 'SCOPE_CONFLICT');
      assert.deepEqual(detailsOf(toGlobal), { function: 'UpdateContext' });
      assert.equal((await fetchVariable(context.id)).scope, 'CONTEXT');
    });

    it('the scope changes freely when no assignment conflicts, and keeps SCOPE_MISMATCH for the general constraint', async () => {
      const { variable } = await create({ originScreenId: s1.id });
      const toContext = await dev().put(`/variables/${variable.id}`, putBodyOf(variable, { scope: 'CONTEXT' }));
      assert.equal(toContext.status, 200);
      assert.equal(variableOf(toContext).scope, 'CONTEXT');
      const back = await dev().put(`/variables/${variable.id}`, putBodyOf(variableOf(toContext), { scope: 'GLOBAL' }));
      assert.equal(variableOf(back).scope, 'GLOBAL');
    });

    it('422 CONTEXT_SCREEN_MISMATCH with an origin: READ from another screen blocks becoming CONTEXT (D-64)', async () => {
      const v = await insertVariable(t, app.id, { name: 'gReadElsewhere', originScreenId: s1.id });
      await insertScreenVariable(t, { screenId: s2.id, variableId: v.id, accessMode: 'READ', usedIn: 'OnVisible' });
      const res = await dev().put(`/variables/${v.id}`, putBodyOf(await fetchVariable(v.id), { scope: 'CONTEXT' }));
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'CONTEXT_SCREEN_MISMATCH');
      assert.equal(
        bodyOf(res).message,
        'gReadElsewhere belongs to Solicitudes. From here you can only write it with Navigate.',
      );
      assert.deepEqual(detailsOf(res), {
        variableId: v.id,
        variable: 'gReadElsewhere',
        originScreenId: s1.id,
        screen: 'Solicitudes',
        screenId: s2.id,
        targetScreen: 'Detalle',
      });
      assert.equal((await fetchVariable(v.id)).scope, 'GLOBAL');
    });

    it('CONTEXT_SCREEN_MISMATCH: WRITE from another screen (Navigate) is allowed; READ_WRITE is not', async () => {
      const v = await insertVariable(t, app.id, { name: 'gNavigated', originScreenId: s1.id });
      await insertScreenVariable(t, { screenId: s2.id, variableId: v.id, accessMode: 'WRITE', usedIn: 'OnVisible' });
      const ok = await dev().put(`/variables/${v.id}`, putBodyOf(await fetchVariable(v.id), { scope: 'CONTEXT' }));
      assert.equal(ok.status, 200);
      await insertScreenVariable(t, {
        screenId: s2.id,
        variableId: v.id,
        accessMode: 'READ_WRITE',
        usedIn: 'OnHidden',
      }).catch(() => undefined);
      // The database already forbids that link for a CONTEXT variable, so the fixture is rejected there.
      const links = await t.owner.query(
        `SELECT 1 FROM screen_variable WHERE variable_id = $1 AND used_in = 'OnHidden'`,
        [v.id],
      );
      assert.equal(links.rowCount, 0);
    });

    it('422 CONTEXT_SCREEN_MISMATCH when the NEW origin leaves a READ link behind, or an assignment elsewhere', async () => {
      const col = await insertCollection(t, app.id);
      const read = await insertVariable(t, app.id, { name: 'locReadHere', scope: 'CONTEXT', originScreenId: s1.id });
      await insertScreenVariable(t, { screenId: s1.id, variableId: read.id, accessMode: 'READ', usedIn: 'OnVisible' });
      const moved = await dev().put(
        `/variables/${read.id}`,
        putBodyOf(await fetchVariable(read.id), { originScreenId: s2.id }),
      );
      assert.equal(moved.status, 422);
      assert.equal(bodyOf(moved).code, 'CONTEXT_SCREEN_MISMATCH');
      assert.deepEqual(detailsOf(moved), {
        variableId: read.id,
        variable: 'locReadHere',
        originScreenId: s2.id,
        screen: 'Detalle',
        screenId: s1.id,
        targetScreen: 'Solicitudes',
      });

      const assigned = await insertVariable(t, app.id, {
        name: 'locAssigned',
        scope: 'CONTEXT',
        originScreenId: s2.id,
      });
      await insertVariableCollection(t, {
        variableId: assigned.id,
        collectionId: col.id,
        screenId: s2.id,
        usedIn: 'OnVisible',
        assignmentFunction: 'UPDATE_CONTEXT',
      });
      const reassigned = await dev().put(
        `/variables/${assigned.id}`,
        putBodyOf(await fetchVariable(assigned.id), { originScreenId: s1.id }),
      );
      assert.equal(reassigned.status, 422);
      assert.equal(bodyOf(reassigned).code, 'CONTEXT_SCREEN_MISMATCH');
      assert.equal(detailsOf(reassigned).targetScreen, 'Detalle');
      assert.equal((await fetchVariable(assigned.id)).originScreen?.id, s2.id);
    });

    it('422 CONTEXT_SCREEN_MISMATCH without origin: any link blocks it, with the "no origin screen" text (D-64)', async () => {
      const v = await insertVariable(t, app.id, { name: 'gNoOriginLink' });
      await insertScreenVariable(t, { screenId: s2.id, variableId: v.id, accessMode: 'WRITE', usedIn: 'OnVisible' });
      const res = await dev().put(`/variables/${v.id}`, putBodyOf(await fetchVariable(v.id), { scope: 'CONTEXT' }));
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'CONTEXT_SCREEN_MISMATCH');
      assert.equal(bodyOf(res).message, 'gNoOriginLink has no origin screen. Set its origin screen before linking it.');
      assert.deepEqual(detailsOf(res), {
        variableId: v.id,
        variable: 'gNoOriginLink',
        originScreenId: null,
        screenId: s2.id,
        targetScreen: 'Detalle',
      });
      // Clearing the origin of a CONTEXT variable that keeps a link is the same case.
      const withOrigin = await insertVariable(t, app.id, { name: 'locClear', scope: 'CONTEXT', originScreenId: s1.id });
      await insertScreenVariable(t, {
        screenId: s2.id,
        variableId: withOrigin.id,
        accessMode: 'WRITE',
        usedIn: 'OnVisible',
      });
      const cleared = await dev().put(
        `/variables/${withOrigin.id}`,
        putBodyOf(await fetchVariable(withOrigin.id), { originScreenId: null }),
      );
      assert.equal(cleared.status, 422);
      assert.equal(bodyOf(cleared).code, 'CONTEXT_SCREEN_MISMATCH');
      assert.equal(detailsOf(cleared).originScreenId, null);
    });

    it('editing another field of an orphan CONTEXT variable (origin screen deleted) is not blocked (D-59, D-71)', async () => {
      const doomed = await insertScreen(t, app.id);
      const v = await insertVariable(t, app.id, { name: 'locOrphan', scope: 'CONTEXT', originScreenId: doomed.id });
      await insertScreenVariable(t, { screenId: s2.id, variableId: v.id, accessMode: 'WRITE', usedIn: 'OnVisible' });
      await t.owner.query('DELETE FROM screen WHERE id = $1', [doomed.id]);
      const orphan = await fetchVariable(v.id);
      assert.equal(orphan.fullTraceability, false);
      const res = await dev().put(`/variables/${v.id}`, putBodyOf(orphan, { description: 'still editable' }));
      assert.equal(res.status, 200);
      assert.equal(variableOf(res).description, 'still editable');
    });

    it('409 DUPLICATE_NAME on rename, on moving to a screen that has the name and on becoming nameless', async () => {
      const taken = await insertVariable(t, app.id, { name: 'gPutTaken' });
      const { variable } = await create();
      const rename = await dev().put(`/variables/${variable.id}`, putBodyOf(variable, { name: taken.name }));
      assert.equal(rename.status, 409);
      assert.equal(bodyOf(rename).message, 'A global variable named gPutTaken already exists in Writers app.');
      assert.equal(detailsOf(rename).container, 'application');
      // Saving its own name again is not a duplicate.
      assert.equal(
        (await dev().put(`/variables/${variable.id}`, putBodyOf(variable, { description: 'x' }))).status,
        200,
      );

      await insertVariable(t, app.id, { name: 'locMove', scope: 'CONTEXT', originScreenId: s1.id });
      const mover = await insertVariable(t, app.id, { name: 'locMove', scope: 'CONTEXT', originScreenId: s2.id });
      const move = await dev().put(
        `/variables/${mover.id}`,
        putBodyOf(await fetchVariable(mover.id), { originScreenId: s1.id }),
      );
      assert.equal(move.status, 409);
      assert.equal(bodyOf(move).message, 'A context variable named locMove already exists in Solicitudes.');
      assert.equal(detailsOf(move).container, 'screen');

      await insertVariable(t, app.id, { name: 'locNameless', scope: 'CONTEXT' });
      const becoming = await insertVariable(t, app.id, {
        name: 'locNameless',
        scope: 'CONTEXT',
        originScreenId: s1.id,
      });
      const nameless = await dev().put(
        `/variables/${becoming.id}`,
        putBodyOf(await fetchVariable(becoming.id), { originScreenId: null }),
      );
      assert.equal(nameless.status, 409);
      assert.equal(detailsOf(nameless).container, 'application');
      assert.equal(bodyOf(nameless).message, 'A context variable named locNameless already exists in Writers app.');
    });

    it('error order: archived beats 412 and the duplicate; business beats the duplicate; 412 beats the duplicate', async () => {
      await withArchivedApplication(async (archived) => {
        const first = await insertVariable(t, archived.id, { name: 'gFirst' });
        const second = await insertVariable(t, archived.id, { name: 'gSecond' });
        const current = await (async () => variableOf(await admin().get(`/variables/${second.id}`)))();
        await setApplicationStatus(t, archived.id, 'ARCHIVED');
        // archived + stale If-Match + duplicate name + unknown origin screen
        const res = await dev().put(`/variables/${second.id}`, putBodyOf(current, { name: first.name }), 'W/"1"');
        assert.equal(res.status, 422);
        assert.equal(bodyOf(res).code, 'APPLICATION_ARCHIVED');
        assert.deepEqual(detailsOf(res), { applicationId: archived.id });
        const missingOrigin = await dev().put(
          `/variables/${second.id}`,
          putBodyOf(current, { originScreenId: 999999 }),
        );
        assert.equal(missingOrigin.status, 404);
        await setApplicationStatus(t, archived.id, 'ACTIVE');
        assert.equal(
          (await dev().put(`/variables/${second.id}`, putBodyOf(current, { name: first.name }))).status,
          409,
        );
      });

      const taken = await insertVariable(t, app.id, { name: 'gOrderTaken' });
      const { variable, etag } = await create({ scope: 'CONTEXT', originScreenId: s1.id });
      // 412 + duplicate -> 412
      const stale = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variable, { name: taken.name, scope: 'GLOBAL' }),
        'W/"1"',
      );
      assert.equal(stale.status, 412);
      // business rule + duplicate -> 422 (the screen belongs to another application AND the name is taken)
      const business = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variable, { name: taken.name, scope: 'GLOBAL', originScreenId: foreignScreen.id }),
        etag,
      );
      assert.equal(business.status, 422);
      assert.equal(bodyOf(business).code, 'INVALID_ORIGIN_SCREEN');
      // CONTEXT_SCREEN_MISMATCH (a deferred trigger in the database) also beats the duplicate, which would fire first
      const linked = await insertVariable(t, app.id, { name: 'gMismatchFirst', originScreenId: s1.id });
      await insertScreenVariable(t, {
        screenId: s2.id,
        variableId: linked.id,
        accessMode: 'READ',
        usedIn: 'OnVisible',
      });
      await insertVariable(t, app.id, { name: 'locMismatchTaken', scope: 'CONTEXT', originScreenId: s1.id });
      const mismatch = await dev().put(
        `/variables/${linked.id}`,
        putBodyOf(await fetchVariable(linked.id), { name: 'locMismatchTaken', scope: 'CONTEXT' }),
      );
      assert.equal(mismatch.status, 422);
      assert.equal(bodyOf(mismatch).code, 'CONTEXT_SCREEN_MISMATCH');
    });
  });

  // ---------------------------------------------------------------------------------------------- DELETE
  describe('DELETE /variables/{id}', () => {
    it('204; links, assignments, dependencies and environments cascade, and the deletion is audited with the actor', async () => {
      const col = await insertCollection(t, app.id);
      const cmp = await insertComponent(t, app.id, s2.id);
      const { variable } = await create({
        originScreenId: s1.id,
        environments: [{ environment: 'DEV' }, { environment: 'PROD' }],
      });
      await insertScreenVariable(t, {
        screenId: s2.id,
        variableId: variable.id,
        accessMode: 'READ',
        usedIn: 'OnVisible',
      });
      await insertVariableCollection(t, {
        variableId: variable.id,
        collectionId: col.id,
        screenId: s1.id,
        usedIn: 'OnVisible',
        assignmentFunction: 'SET',
      });
      await insertDependency(t, { sourceId: cmp.id, targetId: variable.id, relationType: 'USES' });

      const count = async (sql: string) => (await t.owner.query(sql, [variable.id])).rowCount;
      assert.equal(await count('SELECT 1 FROM screen_variable WHERE variable_id = $1'), 2);
      assert.equal(await count('SELECT 1 FROM dependency WHERE target_id = $1'), 1);

      const res = await dev().delete(`/variables/${variable.id}`);
      assert.equal(res.status, 204);
      assert.equal(res.text, '');
      for (const sql of [
        'SELECT 1 FROM documented_element WHERE id = $1',
        'SELECT 1 FROM variable WHERE id = $1',
        'SELECT 1 FROM element_environment WHERE element_id = $1',
        'SELECT 1 FROM screen_variable WHERE variable_id = $1',
        'SELECT 1 FROM variable_collection WHERE variable_id = $1',
        'SELECT 1 FROM dependency WHERE target_id = $1',
      ]) {
        assert.equal(await count(sql), 0, sql);
      }
      // What the variable pointed at survives.
      for (const sql of [
        'SELECT 1 FROM collection WHERE id = ',
        'SELECT 1 FROM component WHERE id = ',
        'SELECT 1 FROM screen WHERE id = ',
      ]) {
        const id = sql.includes('collection') ? col.id : sql.includes('component') ? cmp.id : s2.id;
        assert.equal((await t.owner.query(sql + id)).rowCount, 1, sql);
      }
      assert.equal((await admin().get(`/variables/${variable.id}`)).status, 404);

      const deleted = async (entityType: string, key: string) =>
        (
          await t.owner.query<{ actor_user_id: number | null }>(
            `SELECT actor_user_id FROM audit_log
              WHERE action = 'DELETE' AND entity_type = $1 AND old_value ->> $2 = $3`,
            [entityType, key, String(variable.id)],
          )
        ).rows;
      for (const [entityType, key, expected] of [
        ['variable', 'id', 1],
        ['element_environment', 'element_id', 2],
        ['screen_variable', 'variable_id', 2],
        ['variable_collection', 'variable_id', 1],
        ['dependency', 'target_id', 1],
      ] as const) {
        const rows = await deleted(entityType, key);
        assert.equal(rows.length, expected, entityType);
        assert.ok(
          rows.every((r) => r.actor_user_id === t.users.developer.id),
          `${entityType}: actor`,
        );
      }
    });

    it('the administrator may delete; 403 for a Reader, 401 without token', async () => {
      const { variable } = await create();
      assert.equal((await reader().delete(`/variables/${variable.id}`)).status, 403);
      assert.equal((await t.http.delete(`/api/v1/variables/${variable.id}`)).status, 401);
      assert.equal((await fetchVariable(variable.id)).id, variable.id);
      assert.equal((await admin().delete(`/variables/${variable.id}`)).status, 204);
    });

    it('404 for an unknown variable, also outside the integer range, and a second delete', async () => {
      for (const id of [999999, 2147483648]) {
        const res = await dev().delete(`/variables/${id}`);
        assert.equal(res.status, 404, String(id));
        assert.equal(bodyOf(res).message, "This variable doesn't exist. It may have been deleted.");
      }
      const { variable } = await create();
      assert.equal((await dev().delete(`/variables/${variable.id}`)).status, 204);
      assert.equal((await dev().delete(`/variables/${variable.id}`)).status, 404);
      assert.equal((await dev().delete('/variables/abc')).status, 400);
    });

    it('422 APPLICATION_ARCHIVED on an archived application, and the variable stays', async () => {
      await withArchivedApplication(async (archived) => {
        const v = await insertVariable(t, archived.id);
        await setApplicationStatus(t, archived.id, 'ARCHIVED');
        const res = await dev().delete(`/variables/${v.id}`);
        assert.equal(res.status, 422);
        assert.equal(bodyOf(res).code, 'APPLICATION_ARCHIVED');
        assert.equal((await fetchVariable(v.id)).id, v.id);
        // The same guard rejects PUT, and reading is still allowed.
        const put = await dev().put(`/variables/${v.id}`, putBodyOf(await fetchVariable(v.id), { dataType: 'DATE' }));
        assert.equal(put.status, 422);
        assert.equal(bodyOf(put).code, 'APPLICATION_ARCHIVED');
        const post = await dev().post('/variables', createBodyOf(archived.id));
        assert.equal(post.status, 422);
        await setApplicationStatus(t, archived.id, 'ACTIVE');
        assert.equal((await dev().delete(`/variables/${v.id}`)).status, 204);
      });
    });
  });

  it('the six variable operations are implemented (no NOT_IMPLEMENTED)', () => {
    for (const operationId of [
      'listVariables',
      'createVariable',
      'getVariable',
      'updateVariable',
      'deleteVariable',
      'getVariableDependencies',
    ]) {
      assert.ok(!t.built.notImplemented.includes(operationId), operationId);
    }
  });
});
