/**
 * Module 3, read operations (FR-08, FR-09, FR-19; SDD Table 49; D-14, D-62, D-70, D-72): GET /collections,
 * GET /collections/{id} and GET /collections/{id}/fields. Collections are created through the API; links to screens
 * are fixtures inserted as docs_owner.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import {
  collectionNames,
  collectionOf,
  collectionsPageOf,
  createBodyOf,
  fieldsPageOf,
  type CollectionBody,
} from '../helpers/collections.js';
import { insertApplication, insertScreen, insertScreenCollection, insertVariable } from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';

describe('collections: read', () => {
  let t: TestApp;
  let app: { id: number; name: string; appContextScreenId: number };
  let foreign: { id: number };
  let s1: { id: number; name: string };
  const c: Record<string, CollectionBody> = {};

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Collections app' });
    foreign = await insertApplication(t, { name: 'Foreign app' });
    s1 = await insertScreen(t, app.id, { name: 'Solicitudes' });
    const gVar = await insertVariable(t, app.id, { name: 'gTotal', dataType: 'NUMBER' });
    const dev = asUser(t, t.users.developer.token);
    const make = async (name: string, over: Record<string, unknown> = {}) => {
      const res = await dev.post('/collections', createBodyOf(app.id, { name, ...over }));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      c[name] = collectionOf(res);
    };
    await make('colClientes', {
      description: 'Customers',
      creationCondition: 'ClearCollect on visible',
      environments: [{ environment: 'DEV', notes: 'Mock' }, { environment: 'PROD' }],
      fields: [
        { name: 'Zona', dataType: 'TEXT', position: 2 },
        { name: 'Id', dataType: 'NUMBER', position: 0 },
        { name: 'Nombre', dataType: 'TEXT', position: 1, description: 'Full name' },
      ],
      variableAssignments: [
        {
          variableId: gVar.id,
          screenId: s1.id,
          assignmentFunction: 'SET',
          tableFunction: 'CountRows',
          usedIn: 'OnVisible',
        },
      ],
    });
    await make('colActivos', { environments: [{ environment: 'PROD' }] });
    await make('colZeta');
    await make('colBeta_x', { environments: [{ environment: 'DEV' }] });
    await insertScreenCollection(t, {
      screenId: s1.id,
      collectionId: c['colClientes']!.id,
      accessMode: 'READ',
      usedIn: 'Gallery1.Items',
    });
    const other = await asUser(t, t.users.admin.token).post(
      '/collections',
      createBodyOf(foreign.id, { name: 'colForeign' }),
    );
    assert.equal(other.status, 201);
  });
  after(async () => {
    await t.close();
  });

  const admin = () => asUser(t, t.users.admin.token);
  const list = (query = '', token = t.users.admin.token) =>
    asUser(t, token).get(`/collections?applicationId=${app.id}${query}`);

  describe('GET /collections', () => {
    it('200 page of the application only, ordered by name, with documented and fieldCount; a Reader may read', async () => {
      const res = await list('', t.users.reader.token);
      assert.equal(res.status, 200);
      const page = collectionsPageOf(res);
      assert.deepEqual(collectionNames(res), ['colActivos', 'colBeta_x', 'colClientes', 'colZeta']);
      assert.deepEqual([page.page, page.pageSize, page.total], [1, 20, 4]);
      const clientes = page.data.find((x) => x.name === 'colClientes')!;
      assert.equal(clientes.documented, true);
      assert.equal(clientes.fieldCount, 3);
      assert.deepEqual(clientes.environments, ['DEV', 'PROD']);
      assert.equal(page.data.find((x) => x.name === 'colZeta')!.documented, false);
      assert.ok(!('fields' in clientes), 'the summary carries no nested arrays');
    });

    it('400 without applicationId, with an invalid pageSize, sort outside the whitelist or an unknown environment', async () => {
      assert.equal((await admin().get('/collections')).status, 400);
      assert.equal((await list('&pageSize=101')).status, 400);
      assert.equal((await list('&sort=scope')).status, 400);
      assert.equal((await list('&environment=QA')).status, 400);
    });

    it('401 without token', async () => {
      assert.equal((await t.http.get(`/api/v1/collections?applicationId=${app.id}`)).status, 401);
    });

    it('404 for an unknown application, also outside the integer range (D-70)', async () => {
      for (const id of [999999, 99999999999]) {
        const res = await admin().get(`/collections?applicationId=${id}`);
        assert.equal(res.status, 404);
        assert.equal(bodyOf(res).details.element, 'application');
      }
    });

    it('q is a case-insensitive contains, and % is not a wildcard', async () => {
      assert.deepEqual(collectionNames(await list('&q=COLQ')), []);
      assert.deepEqual(collectionNames(await list('&q=col')), ['colActivos', 'colBeta_x', 'colClientes', 'colZeta']);
      assert.deepEqual(collectionNames(await list('&q=ACTIV')), ['colActivos']);
      assert.deepEqual(collectionNames(await list('&q=a_x')), ['colBeta_x']);
      assert.deepEqual(collectionNames(await list('&q=%25')), []);
    });

    it('filters by environment', async () => {
      assert.deepEqual(collectionNames(await list('&environment=DEV')), ['colBeta_x', 'colClientes', 'colZeta']);
      assert.deepEqual(collectionNames(await list('&environment=PROD')), ['colActivos', 'colClientes']);
    });

    it('undocumented=true returns collections without any screen link (D-14); false equals omitting it', async () => {
      const only = await list('&undocumented=true');
      assert.deepEqual(collectionNames(only), ['colActivos', 'colBeta_x', 'colZeta']);
      assert.equal(collectionsPageOf(only).total, 3);
      assert.deepEqual(collectionNames(await list('&undocumented=false')), collectionNames(await list('')));
    });

    it('sorts by name and updatedAt, ascending and descending, with id as tie-breaker', async () => {
      assert.deepEqual(collectionNames(await list('&sort=-name')), [
        'colZeta',
        'colClientes',
        'colBeta_x',
        'colActivos',
      ]);
      const asc = collectionsPageOf(await list('&sort=updatedAt')).data.map((x) => x.id);
      assert.deepEqual(
        asc,
        [...asc].sort((a, b) => a - b),
        'creation order = updatedAt order here',
      );
      const desc = collectionsPageOf(await list('&sort=-updatedAt')).data.map((x) => x.id);
      assert.deepEqual(
        desc,
        [...desc].sort((a, b) => b - a),
      );
    });

    it('paginates with a stable order and an exact total', async () => {
      const p1 = await list('&pageSize=3&page=1');
      const p2 = await list('&pageSize=3&page=2');
      assert.deepEqual(collectionNames(p1), ['colActivos', 'colBeta_x', 'colClientes']);
      assert.deepEqual(collectionNames(p2), ['colZeta']);
      assert.equal(collectionsPageOf(p2).total, 4);
      assert.deepEqual(collectionNames(await list('&pageSize=3&page=3')), []);
    });

    it('sends an ETag and answers 304 to a matching If-None-Match (D-72)', async () => {
      const res = await list();
      const etag = res.headers.etag as string;
      assert.match(etag, /^W\//);
      const again = await t.http
        .get(`/api/v1/collections?applicationId=${app.id}`)
        .set('Authorization', `Bearer ${t.users.admin.token}`)
        .set('If-None-Match', etag);
      assert.equal(again.status, 304);
    });
  });

  describe('GET /collections/{id}', () => {
    it('200 with environments, fields by position, assignments and derivations; a Reader may read', async () => {
      const res = await asUser(t, t.users.reader.token).get(`/collections/${c['colClientes']!.id}`);
      assert.equal(res.status, 200);
      const got = collectionOf(res);
      assert.equal(got.name, 'colClientes');
      assert.equal(got.description, 'Customers');
      assert.equal(got.creationCondition, 'ClearCollect on visible');
      assert.deepEqual(got.environmentDetails, [
        { environment: 'DEV', notes: 'Mock' },
        { environment: 'PROD', notes: null },
      ]);
      assert.deepEqual(
        got.fields.map((f) => [f.name, f.position]),
        [
          ['Id', 0],
          ['Nombre', 1],
          ['Zona', 2],
        ],
      );
      assert.equal(got.fields[1]!.description, 'Full name');
      assert.equal(got.variableAssignments.length, 1);
      assert.equal(got.variableAssignments[0]!.variable.name, 'gTotal');
      assert.equal(got.variableAssignments[0]!.collection.name, 'colClientes');
      assert.equal(got.variableAssignments[0]!.screen.id, s1.id);
      assert.deepEqual(got.derivedFrom, []);
      assert.equal(got.documented, true);
      assert.equal(got.fieldCount, 3);
    });

    it('sends the ETag derived from updatedAt and 304 for a matching If-None-Match (D-62, D-72)', async () => {
      const id = c['colClientes']!.id;
      const res = await admin().get(`/collections/${id}`);
      assert.equal(res.headers.etag, `W/"${new Date(collectionOf(res).updatedAt).getTime()}"`);
      const again = await t.http
        .get(`/api/v1/collections/${id}`)
        .set('Authorization', `Bearer ${t.users.admin.token}`)
        .set('If-None-Match', res.headers.etag);
      assert.equal(again.status, 304);
    });

    it('404 for an unknown id, also outside the integer range; 400 for a non-numeric id; 401 without token', async () => {
      assert.equal((await admin().get('/collections/999999')).status, 404);
      const huge = await admin().get('/collections/99999999999');
      assert.equal(huge.status, 404);
      assert.equal(bodyOf(huge).details.element, 'collection');
      assert.equal((await admin().get('/collections/abc')).status, 400);
      assert.equal((await t.http.get(`/api/v1/collections/${c['colClientes']!.id}`)).status, 401);
    });
  });

  describe('GET /collections/{id}/fields', () => {
    it('200 ordered by position then id, with pageSize 100 by default; a Reader may read', async () => {
      const res = await asUser(t, t.users.reader.token).get(`/collections/${c['colClientes']!.id}/fields`);
      assert.equal(res.status, 200);
      const page = fieldsPageOf(res);
      assert.deepEqual(
        page.data.map((f) => f.name),
        ['Id', 'Nombre', 'Zona'],
      );
      assert.deepEqual([page.page, page.pageSize, page.total], [1, 100, 3]);
    });

    it('breaks position ties by id', async () => {
      const res = await asUser(t, t.users.developer.token).post(
        '/collections',
        createBodyOf(app.id, {
          fields: [
            { name: 'B', dataType: 'TEXT', position: 5 },
            { name: 'A', dataType: 'TEXT', position: 5 },
            { name: 'C', dataType: 'TEXT', position: 1 },
          ],
        }),
      );
      const created = collectionOf(res);
      const fields = fieldsPageOf(await admin().get(`/collections/${created.id}/fields`)).data;
      assert.deepEqual(
        fields.map((f) => f.name),
        ['C', 'B', 'A'],
      );
    });

    it('paginates', async () => {
      const id = c['colClientes']!.id;
      const p1 = fieldsPageOf(await admin().get(`/collections/${id}/fields?pageSize=2&page=1`));
      const p2 = fieldsPageOf(await admin().get(`/collections/${id}/fields?pageSize=2&page=2`));
      assert.deepEqual(
        p1.data.map((f) => f.name),
        ['Id', 'Nombre'],
      );
      assert.deepEqual(
        p2.data.map((f) => f.name),
        ['Zona'],
      );
      assert.equal(p2.total, 3);
      assert.equal(p1.pageSize, 2);
    });

    it('400 for pageSize over the limit; 404 for an unknown collection, also outside the integer range', async () => {
      const id = c['colClientes']!.id;
      assert.equal((await admin().get(`/collections/${id}/fields?pageSize=101`)).status, 400);
      assert.equal((await admin().get('/collections/999999/fields')).status, 404);
      assert.equal((await admin().get('/collections/99999999999/fields')).status, 404);
    });
  });

  it('the six collection operations are implemented (no NOT_IMPLEMENTED)', async () => {
    const id = c['colClientes']!.id;
    const responses = [
      await admin().get(`/collections?applicationId=${app.id}`),
      await admin().get(`/collections/${id}`),
      await admin().get(`/collections/${id}/fields`),
      await admin().get('/collections/999999'),
    ];
    for (const r of responses) assert.notEqual(bodyOf(r).details?.reason, 'NOT_IMPLEMENTED');
  });
});
