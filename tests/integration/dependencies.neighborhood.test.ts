/**
 * Module 5, GET /dependencies/{type}/{id} (FR-15, FR-16; D-103, D-104, D-74): depth 1 to 3, both directions, the
 * induced subgraph, cycles of DERIVES_FROM and NAVIGATES_TO without repeats, the 404 of every case, the 400 of invalid
 * parameters, roles and ETag. Also the 404 messages of the other routes, which must not change when the dependency
 * routes name the element in the singular. Every response goes through the contract's response validator.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import {
  assertNoDanglingEdges,
  graphOf,
  keyOf,
  seedSar,
  type GraphBody,
  type SarFixture,
} from '../helpers/dependencies.js';
import {
  insertApplication,
  insertCollection,
  insertDependency,
  insertScreen,
  insertScreenCollection,
  insertScreenVariable,
  insertVariable,
  setApplicationStatus,
} from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';

describe('dependencies: GET /dependencies/{type}/{id}', () => {
  let t: TestApp;
  let f: SarFixture;
  let derivesBack = 0;
  let navigatesBack = 0;
  const admin = () => asUser(t, t.users.admin.token);
  /** The neighborhood of an element, checked against the contract. */
  const around = async (path: string) => {
    const res = await admin().get(`/dependencies/${path}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertConformsToContract(res);
    const graph = graphOf(res);
    assertNoDanglingEdges(graph);
    return { res, graph };
  };
  const nodeKeys = (g: GraphBody) => g.nodes.map((n) => n.key);
  const edgeIds = (g: GraphBody) => g.edges.map((e) => e.id);

  before(async () => {
    t = await startTestApp();
    try {
      f = await seedSar(t);
      // Cycles: colSolicitudes also derives from colActivas, and Detalle navigates back to Solicitudes.
      derivesBack = await insertDependency(t, {
        sourceId: f.colSolicitudes,
        targetId: f.colActivas,
        relationType: 'DERIVES_FROM',
      });
      navigatesBack = await insertDependency(t, {
        sourceId: f.detalle,
        targetId: f.solicitudes,
        relationType: 'NAVIGATES_TO',
      });
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    await t.close();
  });

  const k = keyOf;

  describe('depth', () => {
    it('depth 1 is the default and follows the edges in both directions', async () => {
      const { graph } = await around(`variables/${f.locFiltro}`);
      // locFiltro: created by Solicitudes (incoming), accessed by Solicitudes (incoming), used by btnFiltrar (incoming).
      assert.deepEqual(nodeKeys(graph), [
        k('screen', f.solicitudes),
        k('variable', f.locFiltro),
        k('component', f.btnFiltrar),
      ]);
      const explicit = await around(`variables/${f.locFiltro}?depth=1`);
      assert.deepEqual(explicit.graph, graph);
    });

    it('includes the edge between two neighbors, not only the ones walked', async () => {
      const { graph } = await around(`variables/${f.locFiltro}?depth=1`);
      assert.deepEqual(edgeIds(graph), [
        `ct:${f.btnFiltrar}`, // Solicitudes -> btnFiltrar: both are neighbors, the edge is not on the walk from locFiltro
        `cr:${f.locFiltro}`,
        `sv:${f.rows.sv}`,
        `d:${f.rows.usesBtn}`,
      ]);
    });

    it('depth 2 reaches further and depth 3 reaches the whole connected graph', async () => {
      const d2 = (await around(`collections/${f.colActivas}?depth=2`)).graph;
      assert.deepEqual(nodeKeys(d2), [
        k('screen', f.solicitudes),
        k('variable', f.gUsuario),
        k('collection', f.colSolicitudes),
        k('collection', f.colActivas),
        k('component', f.galSolicitudes),
      ]);
      const d1 = (await around(`collections/${f.colActivas}?depth=1`)).graph;
      assert.deepEqual(nodeKeys(d1), [k('collection', f.colSolicitudes), k('collection', f.colActivas)]);

      const d3 = (await around(`collections/${f.colActivas}?depth=3`)).graph;
      assert.equal(d3.nodes.length, 9);
      const whole = graphOf(await admin().get(`/dependencies/graph?applicationId=${f.sar.id}`));
      assert.deepEqual(d3.nodes, whole.nodes);
      assert.deepEqual(d3.edges, whole.edges);
    });

    it('every element type can be the center', async () => {
      for (const path of [
        `screens/${f.solicitudes}`,
        `variables/${f.gUsuario}`,
        `collections/${f.colSolicitudes}`,
        `components/${f.btnFiltrar}`,
      ]) {
        const { graph } = await around(path);
        assert.ok(graph.nodes.length >= 2, path);
      }
      const { graph } = await around(`components/${f.btnFiltrar}`);
      assert.deepEqual(nodeKeys(graph), [
        k('screen', f.solicitudes),
        k('variable', f.locFiltro),
        k('component', f.btnFiltrar),
      ]);
    });
  });

  describe('cycles', () => {
    it('a DERIVES_FROM cycle gives each collection once and both edges, at any depth', async () => {
      for (const depth of [1, 2, 3]) {
        const { graph } = await around(`collections/${f.colSolicitudes}?depth=${depth}`);
        assert.equal(graph.nodes.filter((n) => n.key === k('collection', f.colActivas)).length, 1);
        const derives = graph.edges.filter((e) => e.kind === 'DERIVES_FROM');
        assert.deepEqual(
          derives.map((e) => e.id),
          [`d:${f.rows.derives}`, `d:${derivesBack}`],
        );
      }
    });

    it('a NAVIGATES_TO cycle gives each screen once and both edges', async () => {
      const { graph } = await around(`screens/${f.detalle}?depth=3`);
      assert.equal(graph.nodes.filter((n) => n.key === k('screen', f.solicitudes)).length, 1);
      assert.deepEqual(
        graph.edges.filter((e) => e.kind === 'NAVIGATES_TO').map((e) => e.id),
        [`d:${f.rows.navigates}`, `d:${navigatesBack}`],
      );
    });

    it('a longer ring of three collections does not loop either', async () => {
      const app = await insertApplication(t, { name: 'Ring app' });
      const [a, b, c] = [
        await insertCollection(t, app.id, { name: 'colA' }),
        await insertCollection(t, app.id, { name: 'colB' }),
        await insertCollection(t, app.id, { name: 'colC' }),
      ];
      await insertDependency(t, { sourceId: a.id, targetId: b.id, relationType: 'DERIVES_FROM' });
      await insertDependency(t, { sourceId: b.id, targetId: c.id, relationType: 'DERIVES_FROM' });
      await insertDependency(t, { sourceId: c.id, targetId: a.id, relationType: 'DERIVES_FROM' });
      const { graph } = await around(`collections/${a.id}?depth=3`);
      assert.deepEqual(nodeKeys(graph), [k('collection', a.id), k('collection', b.id), k('collection', c.id)]);
      assert.equal(graph.edges.length, 3);
    });
  });

  describe('Used by screens of a collection (depth 1)', () => {
    it('the screens are the SCREEN nodes with an ACCESSES edge to the collection, one edge per link', async () => {
      const app = await insertApplication(t, { name: 'Used by app' });
      const home = await insertScreen(t, app.id, { name: 'scrHome' });
      const col = await insertCollection(t, app.id, { name: 'colClients' });
      const a = await insertScreenCollection(t, {
        screenId: app.appContextScreenId,
        collectionId: col.id,
        accessMode: 'READ_WRITE',
        usedIn: 'OnStart',
      });
      const b = await insertScreenCollection(t, {
        screenId: home.id,
        collectionId: col.id,
        accessMode: 'READ',
        usedIn: 'OnVisible',
      });
      const c = await insertScreenCollection(t, {
        screenId: home.id,
        collectionId: col.id,
        accessMode: 'READ_WRITE',
        usedIn: 'btnSave.OnSelect',
      });
      const { graph } = await around(`collections/${col.id}?depth=1`);
      const accesses = graph.edges.filter((e) => e.kind === 'ACCESSES');
      assert.deepEqual(
        accesses.map((e) => [e.id, e.accessMode, e.usedIn]),
        [
          [`sc:${a}`, 'READ_WRITE', 'OnStart'],
          [`sc:${b}`, 'READ', 'OnVisible'],
          [`sc:${c}`, 'READ_WRITE', 'btnSave.OnSelect'],
        ],
      );
      assert.equal(new Set(accesses.map((e) => e.source)).size, 2);
      assert.deepEqual(
        graph.nodes.filter((n) => n.type === 'SCREEN').map((n) => n.name),
        ['App (OnStart)', 'scrHome'],
      );
    });
  });

  describe('one application only', () => {
    it('never leaves the application of the element', async () => {
      const { graph } = await around(`screens/${f.otra.inicio}?depth=3`);
      // App (OnStart) of OTRA is in the application but not connected to Inicio, so it is not reachable.
      assert.deepEqual(nodeKeys(graph), [k('screen', f.otra.inicio), k('variable', f.otra.gOtra)]);
    });

    it('an archived application is read normally, and an application with only App (OnStart) is one node', async () => {
      const app = await insertApplication(t, { name: 'Neighborhood archived' });
      const screen = await insertScreen(t, app.id, { name: 'Vieja' });
      await insertScreenVariable(t, {
        screenId: screen.id,
        variableId: (await insertVariable(t, app.id, { name: 'gVieja', originScreenId: screen.id })).id,
        accessMode: 'READ',
        usedIn: 'OnVisible',
      });
      await setApplicationStatus(t, app.id, 'ARCHIVED');
      assert.equal((await around(`screens/${screen.id}?depth=2`)).graph.nodes.length, 2);
      const alone = await insertApplication(t, { name: 'Neighborhood alone' });
      const { graph } = await around(`screens/${alone.appContextScreenId}?depth=3`);
      assert.equal(graph.nodes.length, 1);
      assert.deepEqual(graph.edges, []);
    });
  });

  describe('errors', () => {
    it('404 for an element that does not exist, in the singular', async () => {
      for (const [segment, element] of [
        ['screens', 'screen'],
        ['variables', 'variable'],
        ['collections', 'collection'],
        ['components', 'component'],
      ] as const) {
        const res = await admin().get(`/dependencies/${segment}/999999`);
        assert.equal(res.status, 404, segment);
        await assertConformsToContract(res);
        assert.equal(bodyOf(res).code, 'NOT_FOUND');
        assert.equal(bodyOf(res).message, `This ${element} doesn't exist. It may have been deleted.`);
        assert.equal(bodyOf(res).details.element, element);
      }
    });

    it('404 for an id outside the integer range, with the same message', async () => {
      for (const [segment, element] of [
        ['screens', 'screen'],
        ['variables', 'variable'],
        ['collections', 'collection'],
        ['components', 'component'],
      ] as const) {
        for (const id of ['2147483648', '99999999999']) {
          const res = await admin().get(`/dependencies/${segment}/${id}?depth=2`);
          assert.equal(res.status, 404, `${segment}/${id}`);
          await assertConformsToContract(res);
          assert.equal(bodyOf(res).message, `This ${element} doesn't exist. It may have been deleted.`);
        }
      }
    });

    it('404 when the type of the route does not match the element', async () => {
      for (const path of [
        `variables/${f.solicitudes}`,
        `screens/${f.locFiltro}`,
        `collections/${f.btnFiltrar}`,
        `components/${f.colActivas}`,
      ]) {
        const res = await admin().get(`/dependencies/${path}`);
        assert.equal(res.status, 404, path);
        await assertConformsToContract(res);
      }
    });

    it('400 for invalid parameters, naming the field', async () => {
      const cases: [string, string][] = [
        [`variables/${f.locFiltro}?depth=0`, 'depth'],
        [`variables/${f.locFiltro}?depth=4`, 'depth'],
        [`variables/${f.locFiltro}?depth=abc`, 'depth'],
        [`variables/${f.locFiltro}?depth=1.5`, 'depth'],
        [`things/${f.locFiltro}`, 'type'],
        ['variables/abc', 'id'],
        [`variables/0`, 'id'],
      ];
      for (const [path, field] of cases) {
        const res = await admin().get(`/dependencies/${path}`);
        assert.equal(res.status, 400, path);
        await assertConformsToContract(res);
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
        assert.ok(
          bodyOf(res).details.fields.some((x) => x.field.startsWith(field)),
          `${path}: ${JSON.stringify(bodyOf(res).details.fields)}`,
        );
      }
    });

    it('it accepts no types or environment filter', async () => {
      for (const query of ['types=SCREEN', 'environment=DEV']) {
        const res = await admin().get(`/dependencies/variables/${f.locFiltro}?${query}`);
        assert.equal(res.status, 400, query);
        await assertConformsToContract(res);
      }
    });

    it('401 without a token', async () => {
      const res = await t.http.get(`/api/v1/dependencies/variables/${f.locFiltro}`);
      assert.equal(res.status, 401);
      await assertConformsToContract(res);
    });
  });

  describe('order, ETag and roles', () => {
    it('two reads give the same body and ETag, and If-None-Match answers 304 without body', async () => {
      const path = `collections/${f.colSolicitudes}?depth=2`;
      const first = await around(path);
      const second = await around(path);
      assert.equal(JSON.stringify(second.res.body), JSON.stringify(first.res.body));
      const etag = String(first.res.headers['etag']);
      assert.match(etag, /^W\/"/);
      assert.equal(second.res.headers['etag'], etag);
      const cached = await admin().get(`/dependencies/${path}`).set('If-None-Match', etag);
      assert.equal(cached.status, 304);
      assert.equal(cached.text, '');
    });

    it('nodes and edges follow the order of the graph', async () => {
      const { graph } = await around(`collections/${f.colSolicitudes}?depth=3`);
      const whole = graphOf(await admin().get(`/dependencies/graph?applicationId=${f.sar.id}`));
      const keep = new Set(nodeKeys(graph));
      assert.deepEqual(
        graph.nodes,
        whole.nodes.filter((n) => keep.has(n.key)),
      );
      assert.deepEqual(
        graph.edges,
        whole.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
      );
    });

    it('the three roles get 200', async () => {
      for (const user of [t.users.admin, t.users.developer, t.users.reader]) {
        const res = await asUser(t, user.token).get(`/dependencies/screens/${f.solicitudes}?depth=2`);
        assert.equal(res.status, 200);
        await assertConformsToContract(res);
      }
    });
  });

  describe('404 messages of the other routes do not change', () => {
    it('name the element as before, for an id that does not exist and for one that cannot exist', async () => {
      const cases: [string, string][] = [
        ['/users', 'user'],
        ['/applications', 'application'],
        ['/variables', 'variable'],
        ['/collections', 'collection'],
        ['/screens', 'screen'],
      ];
      for (const [base, element] of cases) {
        for (const id of ['999999', '2147483648']) {
          const res = await admin().get(`${base}/${id}`);
          assert.equal(res.status, 404, `${base}/${id}`);
          assert.equal(
            bodyOf(res).message,
            `This ${element} doesn't exist. It may have been deleted.`,
            `${base}/${id}`,
          );
          assert.equal(bodyOf(res).details.element, element);
        }
      }
      for (const sub of [
        '/variables/2147483648/dependencies',
        '/collections/2147483648/fields',
        '/screens/2147483648/jira-tickets',
      ]) {
        const res = await admin().get(sub);
        assert.equal(res.status, 404, sub);
        assert.match(
          bodyOf(res).message,
          /^This (variable|collection|screen) doesn't exist\. It may have been deleted\.$/,
        );
      }
    });
  });
});
