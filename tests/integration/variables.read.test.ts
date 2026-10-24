/**
 * Module 2, read operations (FR-05, FR-06, FR-07, FR-19; SDD Table 48; D-62, D-70): GET /variables,
 * GET /variables/{id} and GET /variables/{id}/dependencies. Screens, collections, components, links and
 * dependencies are fixtures inserted as docs_owner.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import {
  deleteScreen,
  insertApplication,
  insertCollection,
  insertComponent,
  insertDependency,
  insertScreen,
  insertScreenVariable,
  insertVariable,
  insertVariableCollection,
} from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';
import { dependenciesOf, variableNames, variableOf, variablesPageOf } from '../helpers/variables.js';

describe('variables: read', () => {
  let t: TestApp;
  let app: { id: number; name: string; appContextScreenId: number };
  let foreign: { id: number };
  let s1: { id: number; name: string };
  let s2: { id: number; name: string };
  const v: Record<string, number> = {};

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Variables app' });
    foreign = await insertApplication(t, { name: 'Foreign app' });
    s1 = await insertScreen(t, app.id, { name: 'Solicitudes' });
    s2 = await insertScreen(t, app.id, { name: 'Detalle' });
    const add = async (name: string, over: Parameters<typeof insertVariable>[2]) => {
      v[name] = (await insertVariable(t, app.id, { name, ...over })).id;
    };
    await add('gUser', {
      dataType: 'RECORD',
      originScreenId: s1.id,
      description: 'Signed-in user',
      environments: [{ environment: 'DEV', notes: 'Mock user' }, { environment: 'PROD' }],
    });
    await add('gMode', { dataType: 'BOOLEAN', environments: [{ environment: 'PROD' }] });
    await add('locFilter', { scope: 'CONTEXT', originScreenId: s1.id });
    await add('locOther', { scope: 'CONTEXT', dataType: 'NUMBER', originScreenId: s2.id });
    await add('gCount', { dataType: 'NUMBER', originScreenId: s2.id });
    await add('zUnder_x', { dataType: 'TEXT' });
    await insertVariable(t, foreign.id, { name: 'gForeign' });
  });
  after(async () => {
    await t.close();
  });

  const admin = () => asUser(t, t.users.admin.token);
  const list = (query = '', token = t.users.admin.token) =>
    asUser(t, token).get(`/variables?applicationId=${app.id}${query}`);

  describe('GET /variables', () => {
    it('every role reads (200); the envelope has page, pageSize and total; only the application is listed', async () => {
      for (const user of [t.users.admin, t.users.developer, t.users.reader]) {
        const res = await list('', user.token);
        assert.equal(res.status, 200);
        const page = variablesPageOf(res);
        assert.deepEqual([page.page, page.pageSize, page.total], [1, 20, 6]);
        assert.ok(page.data.every((x) => x.applicationId === app.id));
      }
    });

    it('returns the VariableSummary shape and orders by name ascending by default', async () => {
      const res = await list();
      assert.deepEqual(variableNames(res), ['gCount', 'gMode', 'gUser', 'locFilter', 'locOther', 'zUnder_x']);
      const gUser = variablesPageOf(res).data.find((x) => x.name === 'gUser')!;
      assert.deepEqual(gUser.originScreen, { id: s1.id, name: s1.name });
      assert.equal(gUser.fullTraceability, true);
      assert.deepEqual(gUser.environments, ['DEV', 'PROD']);
      assert.equal(gUser.dataType, 'RECORD');
      assert.equal('description' in gUser, false);
      const gMode = variablesPageOf(res).data.find((x) => x.name === 'gMode')!;
      assert.equal(gMode.originScreen, null);
      assert.equal(gMode.fullTraceability, false);
      assert.deepEqual(gMode.environments, ['PROD']);
    });

    it('sorts by every field of the contract whitelist in both directions, with id as tie-breaker', async () => {
      assert.deepEqual(variableNames(await list('&sort=-name')), [
        'zUnder_x',
        'locOther',
        'locFilter',
        'gUser',
        'gMode',
        'gCount',
      ]);
      // scope: GLOBAL (insertion order = id order) then CONTEXT
      assert.deepEqual(variableNames(await list('&sort=scope')), [
        'gUser',
        'gMode',
        'gCount',
        'zUnder_x',
        'locFilter',
        'locOther',
      ]);
      assert.deepEqual(variableNames(await list('&sort=-scope')).slice(0, 2), ['locFilter', 'locOther']);
      assert.equal(variableNames(await list('&sort=dataType'))[0], 'gMode'); // BOOLEAN first
      assert.equal(variableNames(await list('&sort=-dataType'))[0], 'locFilter'); // TEXT is last in enum order; id breaks the tie
      await t.owner.query(`UPDATE variable SET updated_at = now() + interval '1 hour' WHERE id = $1`, [v.gCount]);
      assert.equal(variableNames(await list('&sort=-updatedAt'))[0], 'gCount');
      assert.equal(variableNames(await list('&sort=updatedAt')).at(-1), 'gCount');
    });

    it('paginates stably: pages of two reproduce the full order for sorts with ties', async () => {
      for (const sort of ['scope', '-scope', 'dataType', 'name']) {
        const full = variableNames(await list(`&sort=${sort}`));
        const pages: string[] = [];
        for (const page of [1, 2, 3]) pages.push(...variableNames(await list(`&sort=${sort}&pageSize=2&page=${page}`)));
        assert.deepEqual(pages, full, sort);
      }
      const beyond = await list('&pageSize=2&page=9');
      assert.deepEqual([variablesPageOf(beyond).data.length, variablesPageOf(beyond).total], [0, 6]);
    });

    it('filters by q (case-insensitive, LIKE wildcards literal), scope, dataType and environment', async () => {
      assert.deepEqual(variableNames(await list('&q=LOC')), ['locFilter', 'locOther']);
      assert.deepEqual(variableNames(await list('&q=_')), ['zUnder_x']);
      assert.deepEqual(variableNames(await list('&q=%25')), []);
      assert.deepEqual(variableNames(await list('&scope=CONTEXT')), ['locFilter', 'locOther']);
      assert.deepEqual(variableNames(await list('&dataType=NUMBER')), ['gCount', 'locOther']);
      assert.deepEqual(variableNames(await list('&environment=PROD')), ['gMode', 'gUser']);
      assert.equal(variablesPageOf(await list('&environment=DEV')).total, 5);
      assert.deepEqual(variableNames(await list('&scope=GLOBAL&dataType=NUMBER&q=count')), ['gCount']);
    });

    it('filters by originScreenId and by untraced (true = no origin screen, false = no filter)', async () => {
      assert.deepEqual(variableNames(await list(`&originScreenId=${s1.id}`)), ['gUser', 'locFilter']);
      assert.deepEqual(variableNames(await list('&untraced=true')), ['gMode', 'zUnder_x']);
      assert.equal(variablesPageOf(await list('&untraced=false')).total, 6);
      assert.deepEqual(variableNames(await list(`&originScreenId=${s1.id}&untraced=true`)), []);
      const untraced = variablesPageOf(await list('&untraced=true')).data;
      assert.ok(untraced.every((x) => x.originScreen === null && !x.fullTraceability));
    });

    it('a filter id that matches nothing or cannot exist gives an empty page (D-70)', async () => {
      for (const originScreenId of [987654, 2147483648]) {
        const res = await list(`&originScreenId=${originScreenId}`);
        assert.equal(res.status, 200);
        assert.deepEqual([variablesPageOf(res).data.length, variablesPageOf(res).total], [0, 0]);
      }
    });

    it('400 for a missing applicationId and for invalid filters, page, sort or unknown parameters', async () => {
      const missing = await admin().get('/variables');
      assert.equal(missing.status, 400);
      assert.equal(bodyOf(missing).code, 'VALIDATION_ERROR');
      assert.ok(bodyOf(missing).details.fields.some((f) => f.field === 'applicationId'));
      for (const query of [
        '&scope=LOCAL',
        '&dataType=STRING',
        '&environment=QA',
        '&untraced=maybe',
        '&originScreenId=0',
        '&pageSize=101',
        '&pageSize=0',
        '&page=0',
        '&q=',
        '&unknown=1',
      ]) {
        assert.equal((await list(query)).status, 400, query);
      }
      const badSort = await list('&sort=description');
      assert.equal(badSort.status, 400);
      assert.equal(bodyOf(badSort).details.fields[0]?.field, 'sort');
    });

    it('404 NOT_FOUND application when it does not exist or its id is out of range (D-70)', async () => {
      for (const id of [999999, 2147483648]) {
        const res = await admin().get(`/variables?applicationId=${id}`);
        assert.equal(res.status, 404, String(id));
        assert.equal(bodyOf(res).message, "This application doesn't exist. It may have been deleted.");
      }
    });

    it('401 without a token, and the operation is implemented', async () => {
      assert.equal((await t.http.get(`/api/v1/variables?applicationId=${app.id}`)).status, 401);
      assert.ok(!t.built.notImplemented.includes('listVariables'));
    });
  });

  describe('GET /variables/{id}', () => {
    it('200 with the full Variable, its environment notes and an ETag derived from updatedAt (D-62)', async () => {
      const res = await admin().get(`/variables/${v.gUser}`);
      assert.equal(res.status, 200);
      const variable = variableOf(res);
      assert.equal(variable.id, v.gUser);
      assert.equal(variable.description, 'Signed-in user');
      assert.deepEqual(variable.environmentDetails, [
        { environment: 'DEV', notes: 'Mock user' },
        { environment: 'PROD', notes: null },
      ]);
      assert.deepEqual(variable.environments, ['DEV', 'PROD']);
      assert.equal(variable.fullTraceability, true);
      assert.equal(res.headers.etag, `W/"${new Date(variable.updatedAt).getTime()}"`);
    });

    it('a variable without origin has originScreen null and fullTraceability false', async () => {
      const variable = variableOf(await admin().get(`/variables/${v.gMode}`));
      assert.equal(variable.originScreen, null);
      assert.equal(variable.fullTraceability, false);
      assert.equal(variable.description, null);
    });

    it('every role reads (200)', async () => {
      for (const user of [t.users.developer, t.users.reader]) {
        assert.equal((await asUser(t, user.token).get(`/variables/${v.gUser}`)).status, 200);
      }
    });

    it('404 for an unknown id and for an id outside the integer range; 400 for a non-numeric id; 401 without token', async () => {
      for (const id of [999999, 2147483648]) {
        const res = await admin().get(`/variables/${id}`);
        assert.equal(res.status, 404, String(id));
        assert.equal(bodyOf(res).message, "This variable doesn't exist. It may have been deleted.");
      }
      assert.equal((await admin().get('/variables/abc')).status, 400);
      assert.equal((await t.http.get(`/api/v1/variables/${v.gUser}`)).status, 401);
      // An element of another type is not a variable.
      assert.equal((await admin().get(`/variables/${s1.id}`)).status, 404);
    });

    it('deleting the origin screen leaves the variable untraced and without full traceability', async () => {
      const doomed = await insertScreen(t, app.id, { name: 'Doomed' });
      const global = await insertVariable(t, app.id, { name: 'gDoomed', originScreenId: doomed.id });
      const context = await insertVariable(t, app.id, {
        name: 'locDoomed',
        scope: 'CONTEXT',
        originScreenId: doomed.id,
      });
      await deleteScreen(t, doomed.id);
      for (const id of [global.id, context.id]) {
        const variable = variableOf(await admin().get(`/variables/${id}`));
        assert.equal(variable.originScreen, null);
        assert.equal(variable.fullTraceability, false);
      }
      const untraced = variableNames(await list('&untraced=true'));
      assert.ok(untraced.includes('gDoomed') && untraced.includes('locDoomed'));
    });
  });

  describe('GET /variables/{id}/dependencies', () => {
    it('screens come from screen_variable WITHOUT the origin row; collections and components are filled', async () => {
      const col = await insertCollection(t, app.id, { name: 'colClientes' });
      const cmp = await insertComponent(t, app.id, s2.id, { name: 'btnGuardar' });
      const other = await insertVariable(t, app.id, { name: 'gOther' });
      await insertScreenVariable(t, { screenId: s2.id, variableId: v.gUser!, accessMode: 'READ', usedIn: 'OnVisible' });
      await insertScreenVariable(t, {
        screenId: s2.id,
        variableId: v.gUser!,
        accessMode: 'READ_WRITE',
        usedIn: 'btnGuardar.OnSelect',
      });
      await insertVariableCollection(t, {
        variableId: v.gUser!,
        collectionId: col.id,
        screenId: s1.id,
        usedIn: 'OnVisible',
        assignmentFunction: 'SET',
        tableFunction: 'First',
      });
      await insertDependency(t, {
        sourceId: cmp.id,
        targetId: v.gUser!,
        relationType: 'USES',
        description: 'Saves the user',
      });
      await insertDependency(t, { sourceId: cmp.id, targetId: other.id, relationType: 'USES' });
      await insertDependency(t, { sourceId: cmp.id, targetId: col.id, relationType: 'USES' });

      // The database holds the origin row, which the response must not repeat as a screen link.
      const origin = await t.owner.query(
        `SELECT 1 FROM screen_variable WHERE variable_id = $1 AND screen_id = $2 AND used_in = 'origin'`,
        [v.gUser, s1.id],
      );
      assert.equal(origin.rowCount, 1);

      const res = await admin().get(`/variables/${v.gUser}/dependencies`);
      assert.equal(res.status, 200);
      const dependencies = dependenciesOf(res);
      assert.deepEqual(dependencies.variable, { id: v.gUser, name: 'gUser' });
      assert.deepEqual(dependencies.originScreen, { id: s1.id, name: s1.name });
      // The order within a screen follows the database collation, so compare without relying on it.
      assert.deepEqual(
        [...dependencies.screens].sort((a, b) => a.usedIn.localeCompare(b.usedIn)),
        [
          { screen: { id: s2.id, name: s2.name }, accessMode: 'READ_WRITE', usedIn: 'btnGuardar.OnSelect' },
          { screen: { id: s2.id, name: s2.name }, accessMode: 'READ', usedIn: 'OnVisible' },
        ].sort((a, b) => a.usedIn.localeCompare(b.usedIn)),
      );
      assert.equal(dependencies.collections.length, 1);
      assert.deepEqual(
        { ...dependencies.collections[0], id: undefined },
        {
          id: undefined,
          variable: { id: v.gUser, name: 'gUser' },
          collection: { id: col.id, name: 'colClientes' },
          screen: { id: s1.id, name: s1.name },
          assignmentFunction: 'SET',
          tableFunction: 'First',
          usedIn: 'OnVisible',
        },
      );
      assert.deepEqual(dependencies.components, [
        {
          component: { id: cmp.id, name: 'btnGuardar' },
          screen: { id: s2.id, name: s2.name },
          description: 'Saves the user',
        },
      ]);
    });

    it('always returns the three arrays (empty = []) and originScreen null when there is no origin', async () => {
      const res = await admin().get(`/variables/${v.gMode}/dependencies`);
      assert.equal(res.status, 200);
      assert.deepEqual((res.body as { data: unknown }).data, {
        variable: { id: v.gMode, name: 'gMode' },
        originScreen: null,
        screens: [],
        collections: [],
        components: [],
      });
    });

    it('a variable with only its origin row has no screens; every role reads', async () => {
      const res = await asUser(t, t.users.reader.token).get(`/variables/${v.locFilter}/dependencies`);
      assert.equal(res.status, 200);
      assert.deepEqual(dependenciesOf(res).screens, []);
      assert.equal(dependenciesOf(res).originScreen?.id, s1.id);
    });

    it('404 for an unknown id or one outside the integer range; 400 non-numeric; 401 without token', async () => {
      for (const id of [999999, 2147483648]) {
        assert.equal((await admin().get(`/variables/${id}/dependencies`)).status, 404, String(id));
      }
      assert.equal((await admin().get('/variables/abc/dependencies')).status, 400);
      assert.equal((await t.http.get(`/api/v1/variables/${v.gUser}/dependencies`)).status, 401);
      assert.ok(!t.built.notImplemented.includes('getVariableDependencies'));
    });
  });
});
