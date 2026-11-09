/**
 * Module 5, GET /dependencies/graph (FR-15, FR-16, NFR-11; D-70, D-72, D-104): variants and their fields, the cases of
 * tests/09_dependency_graph_tests.sql, filters, isolation between applications, order, ETag, errors and roles. Every
 * response goes through the contract's response validator. Data are fixtures inserted as docs_owner.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import {
  assertNoDanglingEdges,
  edgeKinds,
  graphOf,
  keyOf,
  seedSar,
  type EdgeBody,
  type NodeBody,
  type SarFixture,
} from '../helpers/dependencies.js';
import {
  deleteScreen,
  insertApplication,
  insertCollection,
  insertScreen,
  insertVariable,
  setApplicationStatus,
} from '../helpers/fixtures.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { asUser } from '../helpers/users.js';

describe('dependencies: GET /dependencies/graph', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();
  let f: SarFixture;
  const admin = () => asUser(t, t.users.admin.token);
  /** GET the graph of an application with extra query text, checking the contract on every 200. */
  const graphOfApp = async (applicationId: number, query = '') => {
    const res = await admin().get(`/dependencies/graph?applicationId=${applicationId}${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertConformsToContract(res);
    const graph = graphOf(res);
    assertNoDanglingEdges(graph);
    return { res, graph };
  };
  const node = (nodes: NodeBody[], key: string) => nodes.find((n) => n.key === key)!;
  const edge = (edges: EdgeBody[], id: string) => edges.find((e) => e.id === id)!;

  before(async () => {
    t = await startTestApp();
    try {
      f = await seedSar(t);
      await t.owner.query(`UPDATE screen SET miro_link = 'https://miro.com/app/board/x/' WHERE id = $1`, [
        f.solicitudes,
      ]);
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  describe('the cases of test 09', () => {
    it('G01 the SAR graph has 9 nodes (3 screens with App (OnStart), 2 variables, 2 collections, 2 components)', async () => {
      const { graph } = await graphOfApp(f.sar.id);
      assert.equal(graph.nodes.length, 9);
      const count = (type: string) => graph.nodes.filter((n) => n.type === type).length;
      assert.deepEqual([count('SCREEN'), count('VARIABLE'), count('COLLECTION'), count('COMPONENT')], [3, 2, 2, 2]);
    });

    it('G02 and G03 it has 11 edges: ACCESSES=2, CONTAINS=2, CREATES=2, DERIVES_FROM=1, FEEDS=1, NAVIGATES_TO=1, USES=2', async () => {
      const { graph } = await graphOfApp(f.sar.id);
      assert.equal(graph.edges.length, 11);
      assert.equal(
        edgeKinds(graph),
        'ACCESSES=2, CONTAINS=2, CREATES=2, DERIVES_FROM=1, FEEDS=1, NAVIGATES_TO=1, USES=2',
      );
    });

    it('G04 the origin rows are not repeated as ACCESSES (they exist in the database, CREATES represents them)', async () => {
      const origin = await t.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM screen_variable sv JOIN screen s ON s.id = sv.screen_id
          WHERE s.application_id = $1 AND sv.used_in = 'origin'`,
        [f.sar.id],
      );
      assert.ok(origin.rows[0]!.n >= 2, 'the fixture must have origin rows for the check to mean something');
      const { graph } = await graphOfApp(f.sar.id);
      const accesses = graph.edges.filter((e) => e.kind === 'ACCESSES');
      assert.deepEqual(accesses.map((e) => e.id).sort(), [`sc:${f.rows.sc}`, `sv:${f.rows.sv}`].sort());
      assert.ok(!graph.edges.some((e) => e.usedIn === 'origin'));
    });

    it('G05 every edge ends in a node of the same graph (also for the other application)', async () => {
      await graphOfApp(f.sar.id);
      await graphOfApp(f.otra.id);
    });

    it('G06 the other application is isolated: App (OnStart), Inicio, gOtra and one CREATES edge', async () => {
      const { graph } = await graphOfApp(f.otra.id);
      assert.deepEqual(
        graph.nodes.map((n) => n.key),
        [keyOf('screen', f.otra.appScreen), keyOf('screen', f.otra.inicio), keyOf('variable', f.otra.gOtra)],
      );
      assert.equal(edgeKinds(graph), 'CREATES=1');
    });

    it('G07 gUsuario and locFiltro have an origin, so no variable is untraced', async () => {
      const { graph } = await graphOfApp(f.sar.id);
      assert.deepEqual(
        graph.nodes.filter((n) => n.type === 'VARIABLE').map((n) => n.untraced),
        [false, false],
      );
    });
  });

  describe('variants: each node and edge has its own fields and none of the others', () => {
    it('nodes', async () => {
      const { graph } = await graphOfApp(f.sar.id);
      assert.deepEqual(node(graph.nodes, keyOf('screen', f.solicitudes)), {
        key: keyOf('screen', f.solicitudes),
        id: f.solicitudes,
        type: 'SCREEN',
        name: 'Solicitudes',
        documentationStatus: 'UNDOCUMENTED',
        isAppContext: false,
        miroLink: 'https://miro.com/app/board/x/',
      });
      assert.equal(node(graph.nodes, keyOf('screen', f.detalle)).miroLink, null);
      assert.deepEqual(node(graph.nodes, keyOf('screen', f.sar.appScreen)), {
        key: keyOf('screen', f.sar.appScreen),
        id: f.sar.appScreen,
        type: 'SCREEN',
        name: 'App (OnStart)',
        documentationStatus: 'UNDOCUMENTED',
        isAppContext: true,
        miroLink: null,
      });
      assert.deepEqual(node(graph.nodes, keyOf('variable', f.locFiltro)), {
        key: keyOf('variable', f.locFiltro),
        id: f.locFiltro,
        type: 'VARIABLE',
        name: 'locFiltro',
        scope: 'CONTEXT',
        untraced: false,
      });
      assert.deepEqual(node(graph.nodes, keyOf('collection', f.colActivas)), {
        key: keyOf('collection', f.colActivas),
        id: f.colActivas,
        type: 'COLLECTION',
        name: 'colActivas',
      });
      assert.deepEqual(node(graph.nodes, keyOf('component', f.btnFiltrar)), {
        key: keyOf('component', f.btnFiltrar),
        id: f.btnFiltrar,
        type: 'COMPONENT',
        name: 'btnFiltrar',
        screenId: f.solicitudes,
      });
    });

    it('edges', async () => {
      const { graph } = await graphOfApp(f.sar.id);
      const s = keyOf('screen', f.solicitudes);
      assert.deepEqual(edge(graph.edges, `sc:${f.rows.sc}`), {
        id: `sc:${f.rows.sc}`,
        source: s,
        target: keyOf('collection', f.colSolicitudes),
        kind: 'ACCESSES',
        accessMode: 'READ',
        usedIn: 'galSolicitudes.Items',
      });
      assert.equal(edge(graph.edges, `sv:${f.rows.sv}`).target, keyOf('variable', f.locFiltro));
      assert.deepEqual(edge(graph.edges, `vc:${f.rows.vc}`), {
        id: `vc:${f.rows.vc}`,
        source: keyOf('collection', f.colSolicitudes),
        target: keyOf('variable', f.gUsuario),
        kind: 'FEEDS',
        usedIn: 'OnStart',
        assignmentFunction: 'SET',
        tableFunction: 'First',
      });
      const structure: [string, string, string, string][] = [
        [`ct:${f.btnFiltrar}`, 'CONTAINS', s, keyOf('component', f.btnFiltrar)],
        [`cr:${f.locFiltro}`, 'CREATES', s, keyOf('variable', f.locFiltro)],
        [`d:${f.rows.usesBtn}`, 'USES', keyOf('component', f.btnFiltrar), keyOf('variable', f.locFiltro)],
        [
          `d:${f.rows.derives}`,
          'DERIVES_FROM',
          keyOf('collection', f.colActivas),
          keyOf('collection', f.colSolicitudes),
        ],
        [`d:${f.rows.navigates}`, 'NAVIGATES_TO', s, keyOf('screen', f.detalle)],
      ];
      for (const [id, kind, source, target] of structure) {
        assert.deepEqual(edge(graph.edges, id), { id, source, target, kind });
      }
    });

    it('a FEEDS edge without table function carries tableFunction null', async () => {
      const app = await insertApplication(t, { name: 'Feeds app' });
      const col = await insertCollection(t, app.id, { name: 'colSinTabla' });
      const v = await insertVariable(t, app.id, { name: 'gSinTabla', originScreenId: app.appContextScreenId });
      await t.owner.query(
        `INSERT INTO variable_collection (variable_id, variable_scope, collection_id, screen_id, assignment_function, used_in)
         VALUES ($1, 'GLOBAL', $2, $3, 'SET', 'OnVisible')`,
        [v.id, col.id, app.appContextScreenId],
      );
      const { graph } = await graphOfApp(app.id);
      const feed = graph.edges.find((e) => e.kind === 'FEEDS')!;
      assert.equal(feed.tableFunction, null);
      assert.ok('tableFunction' in feed);
    });
  });

  describe('a variable without trace', () => {
    it('has untraced true and no CREATES edge, also the one left without origin when its screen was deleted', async () => {
      const app = await insertApplication(t, { name: 'Untraced app' });
      const screen = await insertScreen(t, app.id, { name: 'Efimera' });
      const loose = await insertVariable(t, app.id, { name: 'gSuelta' });
      const orphan = await insertVariable(t, app.id, { name: 'gHuerfana', originScreenId: screen.id });
      const first = (await graphOfApp(app.id)).graph;
      assert.equal(node(first.nodes, keyOf('variable', orphan.id)).untraced, false);
      assert.ok(first.edges.some((e) => e.id === `cr:${orphan.id}`));

      await deleteScreen(t, screen.id);
      const { graph } = await graphOfApp(app.id);
      assert.equal(node(graph.nodes, keyOf('variable', loose.id)).untraced, true);
      assert.equal(node(graph.nodes, keyOf('variable', orphan.id)).untraced, true);
      assert.ok(!graph.nodes.some((n) => n.key === keyOf('screen', screen.id)));
      assert.ok(!graph.edges.some((e) => e.kind === 'CREATES'));
    });
  });

  describe('applications', () => {
    it('an application with only App (OnStart) has one node and no edges', async () => {
      const app = await insertApplication(t, { name: 'Solo App' });
      const { graph } = await graphOfApp(app.id);
      assert.equal(graph.nodes.length, 1);
      assert.equal(graph.nodes[0]!.name, 'App (OnStart)');
      assert.equal(graph.nodes[0]!.isAppContext, true);
      assert.deepEqual(graph.edges, []);
    });

    it('an archived application is read normally', async () => {
      const app = await insertApplication(t, { name: 'Archived app' });
      await insertScreen(t, app.id, { name: 'Vieja' });
      await setApplicationStatus(t, app.id, 'ARCHIVED');
      const { graph } = await graphOfApp(app.id);
      assert.equal(graph.nodes.length, 2);
    });

    it('two applications with the same names do not leak into each other', async () => {
      const a = await insertApplication(t, { name: 'Gemela A' });
      const b = await insertApplication(t, { name: 'Gemela B' });
      const mine = new Map<number, string[]>();
      for (const app of [a, b]) {
        const screen = await insertScreen(t, app.id, { name: 'Inicio' });
        const variable = await insertVariable(t, app.id, { name: 'gUsuario', originScreenId: screen.id });
        const col = await insertCollection(t, app.id, { name: 'colDatos' });
        mine.set(app.id, [
          keyOf('screen', app.appContextScreenId),
          keyOf('screen', screen.id),
          keyOf('variable', variable.id),
          keyOf('collection', col.id),
        ]);
      }
      for (const app of [a, b]) {
        const { graph } = await graphOfApp(app.id);
        assert.deepEqual(graph.nodes.map((n) => n.key).sort(), [...mine.get(app.id)!].sort());
        assert.equal(graph.nodes.filter((n) => n.name === 'Inicio').length, 1);
      }
    });
  });

  describe('filters', () => {
    const keys = (g: { nodes: NodeBody[] }) => g.nodes.map((n) => n.key);

    it('types keeps only those nodes and the edges between them', async () => {
      const { graph } = await graphOfApp(f.sar.id, '&types=SCREEN');
      assert.ok(graph.nodes.every((n) => n.type === 'SCREEN'));
      assert.equal(graph.nodes.length, 3);
      assert.deepEqual(
        graph.edges.map((e) => e.kind),
        ['NAVIGATES_TO'],
      );
      const two = (await graphOfApp(f.sar.id, '&types=VARIABLE,COLLECTION')).graph;
      assert.ok(two.nodes.every((n) => ['VARIABLE', 'COLLECTION'].includes(n.type)));
      assert.deepEqual(
        two.edges.map((e) => e.kind),
        ['FEEDS', 'DERIVES_FROM'],
      );
    });

    it('types without SCREEN still gives the screen of each component in screenId', async () => {
      const { graph } = await graphOfApp(f.sar.id, '&types=COMPONENT');
      assert.deepEqual(
        graph.nodes.map((n) => n.screenId),
        [f.solicitudes, f.solicitudes],
      );
      assert.deepEqual(graph.edges, []);
    });

    it('environment keeps the variables and collections present in it, and never filters screens or components', async () => {
      const dev = (await graphOfApp(f.sar.id, '&environment=DEV')).graph;
      assert.deepEqual(
        dev.nodes.filter((n) => n.type === 'VARIABLE' || n.type === 'COLLECTION').map((n) => n.name),
        ['gUsuario', 'locFiltro', 'colSolicitudes'],
      );
      assert.equal(dev.nodes.filter((n) => n.type === 'SCREEN').length, 3);
      assert.equal(dev.nodes.filter((n) => n.type === 'COMPONENT').length, 2);
      assert.ok(!dev.edges.some((e) => e.kind === 'DERIVES_FROM'), 'colActivas is PROD only: its edge goes with it');

      const prod = (await graphOfApp(f.sar.id, '&environment=PROD')).graph;
      assert.deepEqual(
        prod.nodes.filter((n) => n.type === 'VARIABLE' || n.type === 'COLLECTION').map((n) => n.name),
        ['gUsuario', 'colActivas'],
      );
      assert.ok(!prod.edges.some((e) => e.kind === 'FEEDS' || e.kind === 'USES'));
    });

    it('types and environment combine', async () => {
      const { graph } = await graphOfApp(f.sar.id, '&types=VARIABLE&environment=PROD');
      assert.deepEqual(keys(graph), [keyOf('variable', f.gUsuario)]);
      assert.deepEqual(graph.edges, []);
      const mixed = (await graphOfApp(f.sar.id, '&types=COMPONENT,COLLECTION&environment=PROD')).graph;
      assert.deepEqual(keys(mixed), [
        keyOf('collection', f.colActivas),
        keyOf('component', f.btnFiltrar),
        keyOf('component', f.galSolicitudes),
      ]);
      assert.deepEqual(mixed.edges, []);
    });

    it('every combination keeps the invariant', async () => {
      for (const types of ['', '&types=SCREEN', '&types=SCREEN,COMPONENT', '&types=VARIABLE,COLLECTION,COMPONENT']) {
        for (const env of ['', '&environment=DEV', '&environment=PROD']) {
          await graphOfApp(f.sar.id, types + env);
        }
      }
    });
  });

  describe('order and ETag', () => {
    it('nodes go by type and id, edges by kind', async () => {
      const { graph } = await graphOfApp(f.sar.id);
      const rank: Record<string, number> = { SCREEN: 0, VARIABLE: 1, COLLECTION: 2, COMPONENT: 3 };
      for (let i = 1; i < graph.nodes.length; i += 1) {
        const a = graph.nodes[i - 1]!;
        const b = graph.nodes[i]!;
        assert.ok(rank[a.type]! < rank[b.type]! || (a.type === b.type && a.id < b.id), `${a.key} before ${b.key}`);
      }
      assert.deepEqual(
        graph.edges.map((e) => e.kind),
        [
          'CONTAINS',
          'CONTAINS',
          'CREATES',
          'CREATES',
          'ACCESSES',
          'ACCESSES',
          'FEEDS',
          'USES',
          'USES',
          'DERIVES_FROM',
          'NAVIGATES_TO',
        ],
      );
    });

    it('two reads in a row give the same body and the same ETag, and If-None-Match answers 304 without body', async () => {
      const first = await graphOfApp(f.sar.id);
      const second = await graphOfApp(f.sar.id);
      assert.equal(JSON.stringify(second.res.body), JSON.stringify(first.res.body));
      const etag = String(first.res.headers['etag']);
      assert.match(etag, /^W\/"/);
      assert.equal(second.res.headers['etag'], etag);

      const cached = await admin().get(`/dependencies/graph?applicationId=${f.sar.id}`).set('If-None-Match', etag);
      assert.equal(cached.status, 304);
      assert.equal(cached.text, '');

      const stale = await admin()
        .get(`/dependencies/graph?applicationId=${f.sar.id}`)
        .set('If-None-Match', 'W/"other"');
      assert.equal(stale.status, 200);
    });

    it('the ETag changes when the data does', async () => {
      const app = await insertApplication(t, { name: 'Etag app' });
      const first = (await graphOfApp(app.id)).res.headers['etag'];
      await insertScreen(t, app.id, { name: 'Nueva' });
      const second = (await graphOfApp(app.id)).res.headers['etag'];
      assert.notEqual(second, first);
    });
  });

  describe('errors', () => {
    it('404 for an application that does not exist or whose id cannot exist', async () => {
      for (const id of [999_999, 2_147_483_647, 2_147_483_648, 99_999_999_999]) {
        const res = await admin().get(`/dependencies/graph?applicationId=${id}`);
        assert.equal(res.status, 404, String(id));
        await assertConformsToContract(res);
        assert.equal(bodyOf(res).code, 'NOT_FOUND');
        assert.equal(bodyOf(res).message, "This application doesn't exist. It may have been deleted.");
        assert.equal(bodyOf(res).details.element, 'application');
      }
    });

    it('400 for invalid parameters, naming the field', async () => {
      const cases: [string, string][] = [
        ['', 'applicationId'],
        ['?applicationId=abc', 'applicationId'],
        ['?applicationId=0', 'applicationId'],
        [`?applicationId=${f.sar.id}&types=SCREEN,NOPE`, 'types'],
        [`?applicationId=${f.sar.id}&environment=STAGING`, 'environment'],
      ];
      for (const [query, field] of cases) {
        const res = await admin().get(`/dependencies/graph${query}`);
        assert.equal(res.status, 400, query);
        await assertConformsToContract(res);
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
        assert.ok(
          bodyOf(res).details.fields.some((x) => x.field.startsWith(field)),
          `${query}: ${JSON.stringify(bodyOf(res).details.fields)}`,
        );
      }
    });

    it('401 without a token or with a bad one', async () => {
      const none = await t.http.get(`/api/v1/dependencies/graph?applicationId=${f.sar.id}`);
      assert.equal(none.status, 401);
      await assertConformsToContract(none);
      const bad = await t.http
        .get(`/api/v1/dependencies/graph?applicationId=${f.sar.id}`)
        .set('Authorization', 'Bearer not.a.jwt');
      assert.equal(bad.status, 401);
    });
  });

  describe('roles', () => {
    it('administrator, developer and reader all get 200 with the same graph', async () => {
      const bodies: string[] = [];
      for (const user of [t.users.admin, t.users.developer, t.users.reader]) {
        const res = await asUser(t, user.token).get(`/dependencies/graph?applicationId=${f.sar.id}`);
        assert.equal(res.status, 200);
        await assertConformsToContract(res);
        bodies.push(JSON.stringify(res.body));
      }
      assert.equal(new Set(bodies).size, 1);
    });
  });

  it('never sends two statements at once on one database connection (no pg deprecation notice)', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(pgOverlap.stop(), []);
  });
});
